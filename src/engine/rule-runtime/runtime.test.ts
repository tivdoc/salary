import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "./canonical.ts";
import {
  runtimeExecutionEnvelopeSchema,
  syntheticCalculationTraceSchema,
  syntheticRuleDefinitionSchema,
} from "./contracts.ts";
import {
  addExactDecimals,
  addMoneyMinorUnits,
  formatExactDecimal,
  multiplyExactDecimals,
  parseExactDecimal,
  roundExactDecimal,
} from "./decimal.ts";
import { SyntheticRuleRegistry } from "./registry.ts";
import { DeterministicSyntheticRuleRuntime } from "./runtime.ts";
import {
  allSyntheticRules,
  guardedSyntheticRule,
  openSyntheticRule,
  staleEvidenceSyntheticExecution,
  successfulSyntheticExecution,
  syntheticRuntimePolicy,
} from "./synthetic-fixtures.ts";

const originalTimezone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimezone;
});

function runtime(policy = syntheticRuntimePolicy): DeterministicSyntheticRuleRuntime {
  return new DeterministicSyntheticRuleRuntime(new SyntheticRuleRegistry(allSyntheticRules), policy);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("exact decimal and money primitives", () => {
  it("adds and multiplies decimal strings without binary floating point", () => {
    expect(
      formatExactDecimal(addExactDecimals(parseExactDecimal("0.1"), parseExactDecimal("0.2"))),
    ).toBe("0.3");
    expect(
      formatExactDecimal(multiplyExactDecimals(parseExactDecimal("1.25"), parseExactDecimal("0.8"))),
    ).toBe("1");
  });

  it("records explicit half-even rounding decisions", () => {
    const rounded = roundExactDecimal(parseExactDecimal("2.675"), 2, "half_even");
    expect(formatExactDecimal(rounded.value)).toBe("2.68");
    expect(rounded.trace).toEqual({
      mode: "half_even",
      from_scale: 3,
      to_scale: 2,
      input: "2.675",
      output: "2.68",
      discarded_digits: "5",
      tie: true,
      incremented: true,
    });
  });

  it("adds minor units exactly and rejects mixed currencies or unsafe results", () => {
    expect(
      addMoneyMinorUnits(
        { currency: "XTS", minor_units: 9_007_199_254_740_000 },
        { currency: "XTS", minor_units: 991 },
      ),
    ).toEqual({ currency: "XTS", minor_units: Number.MAX_SAFE_INTEGER });
    expect(() =>
      addMoneyMinorUnits(
        { currency: "XTS", minor_units: Number.MAX_SAFE_INTEGER },
        { currency: "XTS", minor_units: 1 },
      ),
    ).toThrow("money_minor_units_out_of_safe_range");
    expect(() =>
      addMoneyMinorUnits(
        { currency: "XTS", minor_units: 1 },
        { currency: "XXX", minor_units: 1 },
      ),
    ).toThrow("money_currency_mismatch");
    expect(() =>
      addMoneyMinorUnits(
        { currency: "XTS", minor_units: 1.5 },
        { currency: "XTS", minor_units: 1 },
      ),
    ).toThrow("money_minor_units_not_safe_integers");
  });
});

describe("versioned synthetic rule registry", () => {
  it("validates stable versions, canonicalizes input order, and freezes entries", () => {
    const registry = new SyntheticRuleRegistry([openSyntheticRule]);
    const registered = registry.get(openSyntheticRule.rule_id, openSyntheticRule.rule_version);
    expect(registered?.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(registered?.definition.inputs.map((input) => input.input_id)).toEqual([
      "signal.alpha",
      "signal.beta",
    ]);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered?.definition.inputs)).toBe(true);
    expect(syntheticRuleDefinitionSchema.safeParse(registered?.definition).success).toBe(true);
  });

  it("fails closed on duplicate rule versions and unavailable operation references", () => {
    expect(() => new SyntheticRuleRegistry([openSyntheticRule, openSyntheticRule])).toThrow(
      "duplicate_rule_version",
    );
    expect(
      () =>
        new SyntheticRuleRegistry([
          {
            ...openSyntheticRule,
            operations: [
              {
                step_id: "signal.product",
                operation: "decimal.multiply",
                left_ref: "signal.absent",
                right_ref: "signal.beta",
                result_unit: "synthetic.point",
              },
            ],
            output_ref: "signal.product",
          },
        ]),
    ).toThrow("runtime_reference_not_available:signal.absent");
  });
});

describe("deterministic synthetic rule execution", () => {
  it("returns an immutable success with full inputs, formula, rounding, and output trace", () => {
    const input = clone(successfulSyntheticExecution);
    const before = JSON.stringify(input);
    const execution = runtime().execute(input);

    expect(execution.result.status).toBe("succeeded");
    expect(execution.result.rejection_codes).toEqual([]);
    expect(execution.trace?.runtime_kind).toBe("synthetic_only");
    expect(execution.trace?.inputs.map((fact) => fact.input_id)).toEqual([
      "signal.alpha",
      "signal.beta",
    ]);
    expect(execution.trace?.steps[1]?.rounding).toMatchObject({
      mode: "half_even",
      input: "2.675",
      output: "2.68",
      tie: true,
      incremented: true,
    });
    expect(execution.trace?.output).toEqual({
      kind: "decimal",
      value: "2.68",
      unit: "synthetic.point",
    });
    expect(execution.result.output_hash).toBe(canonicalSha256(execution.trace));
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.trace?.steps)).toBe(true);
    expect(runtimeExecutionEnvelopeSchema.safeParse(execution).success).toBe(true);
  });

  it("round-trips the trace through JSON with the same canonical hash", () => {
    const execution = runtime().execute(successfulSyntheticExecution);
    expect(execution.trace).not.toBeNull();
    const parsed = syntheticCalculationTraceSchema.parse(
      JSON.parse(JSON.stringify(execution.trace)),
    );
    expect(canonicalSha256(parsed)).toBe(execution.result.output_hash);
  });

  it("replays identically across input order, host timezone, and locale operations", () => {
    process.env.TZ = "Pacific/Honolulu";
    new Intl.NumberFormat("ar-EG").format(1234.5);
    const first = runtime().execute(successfulSyntheticExecution);

    process.env.TZ = "Asia/Tokyo";
    new Intl.NumberFormat("de-DE").format(1234.5);
    const reordered = {
      ...successfulSyntheticExecution,
      facts: [...successfulSyntheticExecution.facts].reverse(),
    };
    const second = runtime().execute(reordered);

    expect(second).toEqual(first);
    expect(second.result.output_hash).toBe(first.result.output_hash);
  });

  it("canonicalizes provenance order before deriving trace identity", () => {
    const extraProvenance = {
      provenance_id: "synthetic:provenance:extra",
      kind: "synthetic_fixture" as const,
      reference_sha256: "e".repeat(64),
    };
    const firstFacts = successfulSyntheticExecution.facts.map((fact) => ({
      ...fact,
      provenance: [...fact.provenance, extraProvenance],
    }));
    const secondFacts = firstFacts.map((fact) => ({
      ...fact,
      provenance: [...fact.provenance].reverse(),
    }));
    const first = runtime().execute({ ...successfulSyntheticExecution, facts: firstFacts });
    const second = runtime().execute({ ...successfulSyntheticExecution, facts: secondFacts });
    expect(second).toEqual(first);
  });

  it.each([
    ["missing input", { ...successfulSyntheticExecution, facts: successfulSyntheticExecution.facts.slice(1) }, "FACT_MISSING"],
    [
      "conflicted input",
      {
        ...successfulSyntheticExecution,
        facts: [
          { ...successfulSyntheticExecution.facts[0], status: "conflicted" as const, value: null },
          successfulSyntheticExecution.facts[1],
        ],
      },
      "FACT_CONFLICTED",
    ],
    [
      "low-confidence input",
      {
        ...successfulSyntheticExecution,
        facts: [
          { ...successfulSyntheticExecution.facts[0], confidence_basis_points: 8_999 },
          successfulSyntheticExecution.facts[1],
        ],
      },
      "FACT_LOW_CONFIDENCE",
    ],
    [
      "unconfirmed input",
      {
        ...successfulSyntheticExecution,
        facts: [
          { ...successfulSyntheticExecution.facts[0], status: "unconfirmed" as const },
          successfulSyntheticExecution.facts[1],
        ],
      },
      "FACT_UNCONFIRMED",
    ],
  ])("fails closed for %s without a partial trace", (_label, input, code) => {
    const execution = runtime().execute(input);
    expect(execution.result.status).toBe("rejected");
    expect(execution.result.rejection_codes).toContain(code);
    expect(execution.result.output_hash).toBeNull();
    expect(execution.trace).toBeNull();
  });

  it("rejects stale, inactive, unreviewed evidence", () => {
    const execution = runtime().execute(staleEvidenceSyntheticExecution);
    expect(execution.result.status).toBe("rejected");
    expect(execution.result.rejection_codes).toEqual(["LEGAL_EVIDENCE_NOT_REVIEWED_ACTIVE"]);
    expect(execution.trace).toBeNull();
  });

  it("rejects a wrong rule version", () => {
    const input = {
      ...successfulSyntheticExecution,
      request: { ...successfulSyntheticExecution.request, rule_version: "9.9.9" },
    };
    const execution = runtime().execute(input);
    expect(execution.result.status).toBe("rejected");
    expect(execution.result.rejection_codes).toEqual(["RULE_VERSION_NOT_FOUND"]);
    expect(execution.trace).toBeNull();
  });

  it("rejects a fact whose snapshot link does not match the immutable request", () => {
    const input = {
      ...successfulSyntheticExecution,
      facts: successfulSyntheticExecution.facts.map((fact, index) =>
        index === 0
          ? {
              ...fact,
              snapshot: { ...fact.snapshot, snapshot_sha256: "f".repeat(64) },
            }
          : fact,
      ),
    };
    const execution = runtime().execute(input);
    expect(execution.result.rejection_codes).toEqual(["FACT_SNAPSHOT_MISMATCH"]);
    expect(execution.trace).toBeNull();
  });

  it("cancels atomically and exposes no partial trace", () => {
    let checks = 0;
    const execution = runtime().execute(successfulSyntheticExecution, {
      isCancelled: () => ++checks >= 3,
    });
    expect(execution.result.status).toBe("cancelled");
    expect(execution.result.rejection_codes).toEqual(["EXECUTION_CANCELLED"]);
    expect(execution.result.output_hash).toBeNull();
    expect(execution.trace).toBeNull();
  });

  it("enforces deterministic step and decimal resource ceilings", () => {
    const stepLimited = runtime({ ...syntheticRuntimePolicy, max_steps: 1 }).execute(
      successfulSyntheticExecution,
    );
    expect(stepLimited.result.rejection_codes).toEqual(["RESOURCE_STEP_LIMIT_EXCEEDED"]);
    expect(stepLimited.trace).toBeNull();

    const digitLimited = runtime({ ...syntheticRuntimePolicy, max_decimal_digits: 3 }).execute(
      successfulSyntheticExecution,
    );
    expect(digitLimited.result.rejection_codes).toEqual([
      "RESOURCE_DECIMAL_DIGIT_LIMIT_EXCEEDED",
    ]);
    expect(digitLimited.trace).toBeNull();
  });

  it("requires declared evidence but never creates active fixture evidence", () => {
    const input = {
      ...successfulSyntheticExecution,
      request: { ...successfulSyntheticExecution.request, rule_id: guardedSyntheticRule.rule_id },
    };
    const execution = runtime().execute(input);
    expect(execution.result.rejection_codes).toEqual(["LEGAL_EVIDENCE_REQUIRED"]);
    expect(execution.trace).toBeNull();
    expect(
      JSON.stringify([allSyntheticRules, staleEvidenceSyntheticExecution]).includes(
        '"activation_state":"active"',
      ),
    ).toBe(false);
  });
});
