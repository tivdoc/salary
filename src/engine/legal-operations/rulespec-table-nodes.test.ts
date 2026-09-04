// L4-2 / D1. `band.lookup` and `tiered.rate` — the two shape-only nodes.
//
// Everything here is synthetic: currency ZZZ, synthetic sector and population,
// numbers chosen to make arithmetic visible rather than to state any rate that
// exists in law. What the real drafts bind to these nodes is a separate
// question, answered in `sensitivity-rulespecs.ts` and proved against the
// registered parameters.
import { describe, expect, it } from "vitest";
import { createRuleSpecPackage, executeRuleSpec, executeRuleSpecAtomic, refs, RULE_SPEC_OPERATIONS, type RuleSpecDraft, type RuleSpecInputValue } from "./rulespec.ts";
import { createRuleSpecDependencyManifest } from "./rulespec-lifecycle.ts";
import { ruleSpecNodeSchema } from "./rulespec.ts";

const SHELL = {
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_version: "1.0.0",
  catalog_boundary: "synthetic_test_only",
  source_version_ids: ["synthetic.source@v0"],
  effective_period: { from: "2040-01-01", to: null },
  sectors: ["synthetic.sector"],
  populations: ["synthetic.population"],
  golden_case_set_sha256: "0".repeat(64),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
} as const;

/** Three seniority bands over an integer year, each band naming its own day count. */
function bandDraft(overrides: Partial<Record<"bands", unknown>> = {}): RuleSpecDraft {
  return {
    ...SHELL,
    rule_spec_id: "synthetic.rulespec.band.lookup",
    topic: "vacation",
    facts: [{ ref_id: "fact.seniority.year", value_kind: "integer", unit: "count.years" }],
    parameters: [
      { ref_id: "parameter.days.band.one", parameter_id: "synthetic.days.one", parameter_version: "1.0.0", value_kind: "integer", unit: "count.days" },
      { ref_id: "parameter.days.band.two", parameter_id: "synthetic.days.two", parameter_version: "1.0.0", value_kind: "integer", unit: "count.days" },
      { ref_id: "parameter.days.band.three", parameter_id: "synthetic.days.three", parameter_version: "1.0.0", value_kind: "integer", unit: "count.days" },
    ],
    nodes: [{
      node_id: "entitlement.days",
      operation: "band.lookup",
      input_ref: "fact.seniority.year",
      bands: [
        { from_inclusive: 1, to_exclusive: 5, value_ref: "parameter.days.band.one" },
        { from_inclusive: 5, to_exclusive: 9, value_ref: "parameter.days.band.two" },
        { from_inclusive: 9, to_exclusive: null, value_ref: "parameter.days.band.three" },
      ],
      ...overrides,
    }],
    output_ref: "entitlement.days",
  } as unknown as RuleSpecDraft;
}

const BAND_PARAMETERS: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.days.band.one", value: { kind: "integer", value: 12, unit: "count.days" } },
  { ref_id: "parameter.days.band.two", value: { kind: "integer", value: 14, unit: "count.days" } },
  { ref_id: "parameter.days.band.three", value: { kind: "integer", value: 21, unit: "count.days" } },
];

const seniority = (year: number): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.seniority.year", value: { kind: "integer", value: year, unit: "count.years" } },
];

/** Two tiers of a per-unit money base, cumulative. */
function tierDraft(tiers?: unknown): RuleSpecDraft {
  return {
    ...SHELL,
    rule_spec_id: "synthetic.rulespec.tiered.rate",
    topic: "working_time",
    facts: [{ ref_id: "fact.overtime.hours", value_kind: "integer", unit: "count.hours" }],
    parameters: [
      { ref_id: "parameter.hourly.base", parameter_id: "synthetic.hourly", parameter_version: "1.0.0", value_kind: "money", unit: "currency.zzz" },
      { ref_id: "parameter.rate.first", parameter_id: "synthetic.rate.first", parameter_version: "1.0.0", value_kind: "rational", unit: "ratio" },
      { ref_id: "parameter.rate.second", parameter_id: "synthetic.rate.second", parameter_version: "1.0.0", value_kind: "rational", unit: "ratio" },
    ],
    nodes: [{
      node_id: "overtime.amount",
      operation: "tiered.rate",
      input_ref: "fact.overtime.hours",
      base_ref: "parameter.hourly.base",
      rounding: "half_up",
      tiers: tiers ?? [
        { from_inclusive: 0, to_exclusive: 2, rate_ref: "parameter.rate.first" },
        { from_inclusive: 2, to_exclusive: null, rate_ref: "parameter.rate.second" },
      ],
    }],
    output_ref: "overtime.amount",
  } as unknown as RuleSpecDraft;
}

const TIER_PARAMETERS: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.hourly.base", value: { kind: "money", currency: "ZZZ", minor_units: 5000 } },
  { ref_id: "parameter.rate.first", value: { kind: "rational", numerator: "5", denominator: "4", unit: "ratio" } },
  { ref_id: "parameter.rate.second", value: { kind: "rational", numerator: "3", denominator: "2", unit: "ratio" } },
];

const hours = (count: number): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.overtime.hours", value: { kind: "integer", value: count, unit: "count.hours" } },
];

describe("band.lookup", () => {
  it("selects the band covering the input and returns that band's parameter", () => {
    const rule = createRuleSpecPackage(bandDraft());
    for (const [year, expected] of [[1, 12], [4, 12], [5, 14], [8, 14], [9, 21], [40, 21]] as const) {
      const execution = executeRuleSpec({ rule, facts: seniority(year), parameters: BAND_PARAMETERS });
      expect(execution.output).toEqual({ kind: "integer", value: expected, unit: "count.days" });
    }
  });

  it("is deterministic and independent of input order", () => {
    const rule = createRuleSpecPackage(bandDraft());
    const first = executeRuleSpec({ rule, facts: seniority(6), parameters: BAND_PARAMETERS });
    const replay = executeRuleSpec({ rule, facts: seniority(6), parameters: [...BAND_PARAMETERS].reverse() });
    expect(replay.result_sha256).toBe(first.result_sha256);
    expect(replay.trace_sha256).toBe(first.trace_sha256);
  });

  it("refuses fail-closed when the input falls outside every band", () => {
    const rule = createRuleSpecPackage(bandDraft());
    const outcome = executeRuleSpecAtomic({ rule, facts: seniority(0), parameters: BAND_PARAMETERS });
    expect(outcome).toMatchObject({ status: "failed", error_code: "RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE", execution: null, output_visible: false, partial_output_visible: false });
  });

  it("refuses fail-closed when a band's parameter is unbound", () => {
    const rule = createRuleSpecPackage(bandDraft());
    const outcome = executeRuleSpecAtomic({ rule, facts: seniority(6), parameters: BAND_PARAMETERS.slice(0, 2) });
    expect(outcome.status).toBe("failed");
    expect(outcome.error_code).toBe("RULESPEC_INPUT_MISSING");
  });

  it("rejects non-contiguous, overlapping, inverted and prematurely open bands", () => {
    const cases = [
      [{ from_inclusive: 1, to_exclusive: 5, value_ref: "parameter.days.band.one" }, { from_inclusive: 6, to_exclusive: 9, value_ref: "parameter.days.band.two" }, { from_inclusive: 9, to_exclusive: null, value_ref: "parameter.days.band.three" }],
      [{ from_inclusive: 1, to_exclusive: 6, value_ref: "parameter.days.band.one" }, { from_inclusive: 5, to_exclusive: 9, value_ref: "parameter.days.band.two" }, { from_inclusive: 9, to_exclusive: null, value_ref: "parameter.days.band.three" }],
      [{ from_inclusive: 5, to_exclusive: 5, value_ref: "parameter.days.band.one" }, { from_inclusive: 5, to_exclusive: 9, value_ref: "parameter.days.band.two" }, { from_inclusive: 9, to_exclusive: null, value_ref: "parameter.days.band.three" }],
      [{ from_inclusive: 1, to_exclusive: null, value_ref: "parameter.days.band.one" }, { from_inclusive: 5, to_exclusive: 9, value_ref: "parameter.days.band.two" }, { from_inclusive: 9, to_exclusive: null, value_ref: "parameter.days.band.three" }],
    ];
    for (const bands of cases) {
      expect(() => createRuleSpecPackage(bandDraft({ bands }))).toThrow("RULESPEC_BAND_LOOKUP_BANDS_NOT_CONTIGUOUS");
    }
  });

  it("rejects a non-integer selector and bands of mixed type", () => {
    const rational = bandDraft() as unknown as Record<string, unknown>;
    expect(() => createRuleSpecPackage({ ...rational, facts: [{ ref_id: "fact.seniority.year", value_kind: "rational", unit: "ratio" }] } as unknown as RuleSpecDraft)).toThrow("RULESPEC_BAND_LOOKUP_INPUT_NOT_INTEGER");
    const mixed = bandDraft() as unknown as Record<string, unknown>;
    const parameters = (mixed.parameters as Record<string, unknown>[]).map((parameter, index) => index === 1 ? { ...parameter, value_kind: "money", unit: "currency.zzz" } : parameter);
    expect(() => createRuleSpecPackage({ ...mixed, parameters } as unknown as RuleSpecDraft)).toThrow("RULESPEC_BAND_LOOKUP_VALUE_TYPE_MISMATCH");
  });

  it("counts bands against the aggregate bound", () => {
    const bands = Array.from({ length: 9 }, (_unused, index) => ({ from_inclusive: index + 1, to_exclusive: index === 8 ? null : index + 2, value_ref: "parameter.days.band.one" }));
    expect(() => createRuleSpecPackage(bandDraft({ bands }))).toThrow("RULESPEC_AGGREGATE_BOUND_EXCEEDED");
  });
});

describe("tiered.rate", () => {
  it("pays each tier for the units inside it and sums them", () => {
    const rule = createRuleSpecPackage(tierDraft());
    // base 50.00, first tier 125% for 2 units, second 150% beyond.
    for (const [count, expected] of [[0, 0], [1, 6250], [2, 12500], [3, 20000], [5, 35000]] as const) {
      const execution = executeRuleSpec({ rule, facts: hours(count), parameters: TIER_PARAMETERS });
      expect(execution.output).toEqual({ kind: "money", currency: "ZZZ", minor_units: expected });
    }
  });

  it("rounds once at the end rather than per tier", () => {
    // A base of 1 agora at 1/3 and 1/3 over two units is 2/3 of an agora: one
    // rounding gives 1, rounding each tier separately would give 0.
    const rule = createRuleSpecPackage(tierDraft());
    const parameters: readonly RuleSpecInputValue[] = [
      { ref_id: "parameter.hourly.base", value: { kind: "money", currency: "ZZZ", minor_units: 1 } },
      { ref_id: "parameter.rate.first", value: { kind: "rational", numerator: "1", denominator: "3", unit: "ratio" } },
      { ref_id: "parameter.rate.second", value: { kind: "rational", numerator: "1", denominator: "3", unit: "ratio" } },
    ];
    const execution = executeRuleSpec({ rule, facts: hours(2), parameters });
    expect(execution.output).toEqual({ kind: "money", currency: "ZZZ", minor_units: 1 });
  });

  it("is deterministic and independent of input order", () => {
    const rule = createRuleSpecPackage(tierDraft());
    const first = executeRuleSpec({ rule, facts: hours(4), parameters: TIER_PARAMETERS });
    const replay = executeRuleSpec({ rule, facts: hours(4), parameters: [...TIER_PARAMETERS].reverse() });
    expect(replay.result_sha256).toBe(first.result_sha256);
    expect(replay.output).toEqual(first.output);
  });

  it("refuses fail-closed below the first tier and above a closed last tier", () => {
    const open = createRuleSpecPackage(tierDraft());
    expect(executeRuleSpecAtomic({ rule: open, facts: hours(-1), parameters: TIER_PARAMETERS }).error_code).toBe("RULESPEC_TIERED_RATE_INPUT_OUT_OF_RANGE");
    const closed = createRuleSpecPackage(tierDraft([
      { from_inclusive: 0, to_exclusive: 2, rate_ref: "parameter.rate.first" },
      { from_inclusive: 2, to_exclusive: 4, rate_ref: "parameter.rate.second" },
    ]));
    expect(executeRuleSpec({ rule: closed, facts: hours(4), parameters: TIER_PARAMETERS }).output).toEqual({ kind: "money", currency: "ZZZ", minor_units: 27500 });
    expect(executeRuleSpecAtomic({ rule: closed, facts: hours(5), parameters: TIER_PARAMETERS }).error_code).toBe("RULESPEC_TIERED_RATE_INPUT_OUT_OF_RANGE");
  });

  it("refuses fail-closed when a tier's rate is unbound", () => {
    const rule = createRuleSpecPackage(tierDraft());
    const outcome = executeRuleSpecAtomic({ rule, facts: hours(3), parameters: TIER_PARAMETERS.slice(0, 2) });
    expect(outcome.status).toBe("failed");
    expect(outcome.error_code).toBe("RULESPEC_INPUT_MISSING");
    expect(outcome.execution).toBeNull();
  });

  it("rejects a money invariant violation: a rate that is not a dimensionless ratio", () => {
    const draft = tierDraft() as unknown as Record<string, unknown>;
    const parameters = (draft.parameters as Record<string, unknown>[]).map((parameter, index) => index === 1 ? { ...parameter, unit: "currency.zzz", value_kind: "money" } : parameter);
    expect(() => createRuleSpecPackage({ ...draft, parameters } as unknown as RuleSpecDraft)).toThrow("RULESPEC_TIERED_RATE_RATE_NOT_RATIO");
  });

  it("rejects a non-money base and a negative first tier", () => {
    const draft = tierDraft() as unknown as Record<string, unknown>;
    const parameters = (draft.parameters as Record<string, unknown>[]).map((parameter, index) => index === 0 ? { ...parameter, value_kind: "rational", unit: "ratio" } : parameter);
    expect(() => createRuleSpecPackage({ ...draft, parameters } as unknown as RuleSpecDraft)).toThrow("RULESPEC_TIERED_RATE_BASE_NOT_MONEY");
    expect(() => createRuleSpecPackage(tierDraft([
      { from_inclusive: -1, to_exclusive: 2, rate_ref: "parameter.rate.first" },
      { from_inclusive: 2, to_exclusive: null, rate_ref: "parameter.rate.second" },
    ]))).toThrow("RULESPEC_TIERED_RATE_TIERS_NOT_CONTIGUOUS");
  });

  it("keeps money in integer minor units — the output never carries a fraction", () => {
    const rule = createRuleSpecPackage(tierDraft());
    const parameters: readonly RuleSpecInputValue[] = [
      { ref_id: "parameter.hourly.base", value: { kind: "money", currency: "ZZZ", minor_units: 3337 } },
      { ref_id: "parameter.rate.first", value: { kind: "rational", numerator: "7", denominator: "3", unit: "ratio" } },
      { ref_id: "parameter.rate.second", value: { kind: "rational", numerator: "11", denominator: "7", unit: "ratio" } },
    ];
    const output = executeRuleSpec({ rule, facts: hours(3), parameters }).output;
    expect(output.kind).toBe("money");
    expect(Number.isSafeInteger((output as { minor_units: number }).minor_units)).toBe(true);
    // 2 * 3337 * 7/3 + 1 * 3337 * 11/7 = 46718/3 + 36707/7 = (326_( 46718*7 + 36707*3 )) / 21
    expect((output as { minor_units: number }).minor_units).toBe(Math.round((2 * 3337 * 7) / 3 + (3337 * 11) / 7));
  });
});

describe("node vocabulary is closed", () => {
  it("enumerates exactly the operations the schema accepts", () => {
    const accepted = new Set<string>();
    for (const operation of RULE_SPEC_OPERATIONS) accepted.add(operation);
    expect([...accepted].sort()).toEqual([
      "add", "aggregate.bounded", "band.lookup", "compare.gte", "constant.integer", "constant.rational",
      "divide", "max", "min", "money.scale", "multiply", "select", "subtract", "tiered.rate",
    ]);
    expect(() => ruleSpecNodeSchema.parse({ node_id: "n", operation: "band_lookup", input_ref: "a", bands: [] })).toThrow();
  });

  it("reports the input refs of the new nodes to the executor and the manifest alike", () => {
    const band = createRuleSpecPackage(bandDraft());
    expect(refs(band.nodes[0])).toEqual(["fact.seniority.year", "parameter.days.band.one", "parameter.days.band.two", "parameter.days.band.three"]);
    const tier = createRuleSpecPackage(tierDraft());
    expect(refs(tier.nodes[0])).toEqual(["fact.overtime.hours", "parameter.hourly.base", "parameter.rate.first", "parameter.rate.second"]);
    // The manifest is where a forgotten node kind used to hide: an empty
    // `input_refs` would have been hashed into `operation_graph_sha256` without
    // anything complaining.
    const manifest = createRuleSpecDependencyManifest(tier);
    expect(manifest.operation_graph[0].input_refs).toEqual(["fact.overtime.hours", "parameter.hourly.base", "parameter.rate.first", "parameter.rate.second"]);
    expect(createRuleSpecDependencyManifest(band).operation_graph[0].input_refs).toEqual(["fact.seniority.year", "parameter.days.band.one", "parameter.days.band.three", "parameter.days.band.two"]);
  });
});
