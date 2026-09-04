import { describe, expect, it } from "vitest";
import { executeRuleSpec } from "../legal-operations/rulespec.ts";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import { GOLDEN_SCENARIOS } from "./golden-case-templates.ts";
import { buildAllScenarioFixtures, buildScenarioFixture, scenarioFixture } from "./scenario-fixtures.ts";
import { MINIMUM_WAGE_HOURLY_SPEC, SENSITIVITY_SPECS } from "./sensitivity-rulespecs.ts";

// E3-6 and E3-7 acceptance.

describe("E3-6 scenario input fixtures", () => {
  it("builds 7 x 6, each hashed and marked synthetic", () => {
    const fixtures = buildAllScenarioFixtures();
    expect(fixtures).toHaveLength(42);
    expect(new Set(fixtures.map((entry) => entry.fixture_id)).size).toBe(42);
    for (const fixture of fixtures) {
      expect(fixture.synthetic).toBe(true);
      expect(fixture.legal_ground_truth).toBe(false);
      const { content_sha256: pinned, ...content } = fixture;
      expect(canonicalSha256(content)).toBe(pinned);
    }
    expect(new Set(fixtures.map((entry) => entry.topic))).toEqual(new Set(WAVE3_TOPICS));
    expect(new Set(fixtures.map((entry) => entry.scenario))).toEqual(new Set(GOLDEN_SCENARIOS));
  });

  it("has no expected field anywhere — not filled, and not there to fill", () => {
    // D1's line: the input half is synthetic data, the expected half is a legal
    // determination. A fixture that could hold an expectation would eventually
    // hold one, so the schema has no room for it.
    for (const fixture of buildAllScenarioFixtures()) {
      const keys = Object.keys(fixture);
      expect(keys, fixture.fixture_id).not.toContain("expected");
      expect(keys, fixture.fixture_id).not.toContain("expected_output");
      expect(JSON.stringify(fixture)).not.toMatch(/"expected/u);
    }
  });

  it("the missing/conflicted scenario really withholds an input, in every topic", () => {
    for (const topic of WAVE3_TOPICS) {
      const fixture = scenarioFixture(topic, "missing_conflicted_facts")!;
      expect(fixture.inputs, topic).toEqual([]);
      expect(fixture.omitted_refs.length, topic).toBeGreaterThan(0);
      expect(fixture.conflicted_refs.length, topic).toBeGreaterThan(0);
    }
    // And every other scenario supplies exactly what its topic's rule needs.
    for (const topic of WAVE3_TOPICS) {
      for (const scenario of GOLDEN_SCENARIOS.filter((entry) => entry !== "missing_conflicted_facts")) {
        expect(scenarioFixture(topic, scenario)!.inputs.length, `${topic}/${scenario}`).toBe(1);
      }
    }
  });

  it("is deterministic: the same fixture built twice is the same bytes", () => {
    for (const topic of WAVE3_TOPICS) {
      for (const scenario of GOLDEN_SCENARIOS) {
        expect(buildScenarioFixture(topic, scenario)).toEqual(buildScenarioFixture(topic, scenario));
      }
    }
  });
});

describe("E3-7 executable sensitivity specs", () => {
  it("are real_inactive and bind real parameter ids, never synthetic ones", () => {
    for (const entry of SENSITIVITY_SPECS) {
      expect(entry.spec.catalog_boundary, entry.spec.rule_spec_id).toBe("real_inactive");
      expect(entry.spec.parameters[0].parameter_id, entry.spec.rule_spec_id).toMatch(/^il\./u);
      expect(entry.spec.rule_spec_id).toMatch(/^il\.rulespec\./u);
    }
  });

  it("compute and refuse: a supplied input produces a trace, a withheld one produces a refusal", () => {
    const parameters = [{ ref_id: "parameter.hourly.floor", value: { kind: "money" as const, currency: "ILS", minor_units: 3540 } }];
    const current = scenarioFixture("minimum_wage", "current")!;
    const execution = executeRuleSpec({ rule: MINIMUM_WAGE_HOURLY_SPEC, facts: current.inputs as never, parameters });
    // 35.40 x 182 = 6442.80. The arithmetic is the point: this is the number
    // the 182/186 question actually moves.
    expect(String((execution.output as { minor_units: unknown }).minor_units)).toBe("644280");
    expect(execution.trace).toHaveLength(1);

    const missing = scenarioFixture("minimum_wage", "missing_conflicted_facts")!;
    expect(() => executeRuleSpec({ rule: MINIMUM_WAGE_HOURLY_SPEC, facts: missing.inputs as never, parameters }))
      .toThrow("RULESPEC_INPUT_MISSING");
  });

  it("the two branches of the divisor question give different answers", () => {
    const current = scenarioFixture("minimum_wage", "current")!;
    const run = (minorUnits: number) => executeRuleSpec({
      rule: MINIMUM_WAGE_HOURLY_SPEC, facts: current.inputs as never,
      parameters: [{ ref_id: "parameter.hourly.floor", value: { kind: "money", currency: "ILS", minor_units: minorUnits } }],
    });
    const at182 = BigInt(String((run(3540).output as { minor_units: unknown }).minor_units));
    const at186 = BigInt(String((run(3464).output as { minor_units: unknown }).minor_units));
    expect(at182).not.toBe(at186);
    expect(at182 - at186).toBe(BigInt(13832));
  });

  it("declares where it is narrower than the draft it stands in for", () => {
    const pension = SENSITIVITY_SPECS.find((entry) => entry.spec.topic === "pension")!;
    // The pension draft has an unbound slot; this spec binds only the cap. That
    // has to be said in the artifact, not just in a commit message, or the
    // report reads as if the whole pension question had been run.
    expect(pension.narrower_than_draft).toContain("employee_contribution_rate");
    expect(SENSITIVITY_SPECS.find((entry) => entry.spec.topic === "minimum_wage")!.narrower_than_draft).toBeNull();
  });
});
