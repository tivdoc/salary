import { describe, expect, it } from "vitest";
import { legalOperationsSha256 } from "./canonical.ts";
import { createRuleSpecPackage, executeRuleSpec, ruleSpecPackageSchema, validateGoldenCaseSet, validateRuleSpecPackage, type RuleSpecDraft } from "./rulespec.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "./synthetic-fixtures.ts";

function draft(index = 0) {
  const candidate = { ...SYNTHETIC_SEVEN_TOPIC_FIXTURES[index].rule } as Record<string, unknown>;
  delete candidate.content_sha256;
  return candidate as RuleSpecDraft;
}

describe("bounded non-Turing RuleSpec", () => {
  it("validates and executes all seven neutral golden catalogs deterministically", () => {
    for (const fixture of SYNTHETIC_SEVEN_TOPIC_FIXTURES) {
      expect(validateRuleSpecPackage(fixture.rule).catalog_boundary).toBe("synthetic_test_only");
      expect(validateGoldenCaseSet(fixture.golden_cases).content_sha256).toBe(fixture.rule.golden_case_set_sha256);
      const testCase = fixture.golden_cases.cases[0];
      const first = executeRuleSpec({ rule: fixture.rule, facts: testCase.facts, parameters: testCase.parameters });
      const replay = executeRuleSpec({ rule: fixture.rule, facts: [...testCase.facts].reverse(), parameters: [...testCase.parameters].reverse() });
      expect(first.output).toEqual(testCase.expected_output);
      expect(first).toEqual(replay);
    }
  });

  it("rejects arbitrary operations, unknown keys, forward references, and invalid units", () => {
    const base = draft();
    expect(() => ruleSpecPackageSchema.parse({ ...SYNTHETIC_SEVEN_TOPIC_FIXTURES[0].rule, eval: "globalThis" })).toThrow();
    expect(() => createRuleSpecPackage({ ...base, nodes: [{ node_id: "bad.node", operation: "javascript.eval", expression: "1" }] as never })).toThrow();
    expect(() => createRuleSpecPackage({ ...base, nodes: [{ node_id: "bad.node", operation: "add", refs: ["later.node", "fact.signal"] }] })).toThrow("RULESPEC_FORWARD_OR_MISSING_REF");
    expect(() => createRuleSpecPackage({ ...base, facts: [{ ref_id: "fact.signal", value_kind: "rational", unit: "hours" }] })).toThrow("RULESPEC_MONEY_SCALE_UNIT_MISMATCH");
  });

  it("enforces step, depth, aggregation, and undeclared-input bounds", () => {
    const base = draft();
    expect(() => createRuleSpecPackage({ ...base, nodes: [{ node_id: "constant.one", operation: "constant.rational", value: "1", unit: "ratio" }, ...base.nodes], resource_policy: { ...base.resource_policy, max_steps: 1 } })).toThrow("RULESPEC_STEP_LIMIT_EXCEEDED");
    expect(() => createRuleSpecPackage({ ...base, nodes: [...base.nodes, { node_id: "result.twice", operation: "money.scale", money_ref: "result.amount", rational_ref: "fact.signal", rounding: "exact" }], output_ref: "result.twice", resource_policy: { ...base.resource_policy, max_depth: 1 } })).toThrow("RULESPEC_DEPTH_LIMIT_EXCEEDED");
    expect(() => createRuleSpecPackage({ ...base, nodes: [{ node_id: "result.amount", operation: "aggregate.bounded", refs: ["parameter.amount", "parameter.amount"] }], resource_policy: { ...base.resource_policy, max_aggregate_items: 1 } })).toThrow("RULESPEC_AGGREGATE_BOUND_EXCEEDED");
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    expect(() => executeRuleSpec({ rule: fixture.rule, facts: [...fixture.facts, { ref_id: "fact.undeclared", value: { kind: "rational", numerator: "1", denominator: "1", unit: "ratio" } }], parameters: fixture.parameters })).toThrow("RULESPEC_INPUT_UNDECLARED");
  });

  it("uses exact rational rounding policies and safe Money", () => {
    const base = draft();
    const scaleNode = { node_id: "result.amount", operation: "money.scale" as const, money_ref: "parameter.amount", rational_ref: "fact.signal" };
    const exact = createRuleSpecPackage({ ...base, nodes: [{ ...scaleNode, rounding: "exact" }] });
    const halfEven = createRuleSpecPackage({ ...base, nodes: [{ ...scaleNode, rounding: "half_even" }] });
    const facts = [{ ref_id: "fact.signal", value: { kind: "rational" as const, numerator: "1", denominator: "2", unit: "ratio" } }];
    const parameters = [{ ref_id: "parameter.amount", value: { kind: "money" as const, currency: "ZZZ", minor_units: 101 } }];
    expect(() => executeRuleSpec({ rule: exact, facts, parameters })).toThrow("RULESPEC_EXACT_ROUNDING_REQUIRED");
    expect(executeRuleSpec({ rule: halfEven, facts, parameters }).output).toEqual({ kind: "money", currency: "ZZZ", minor_units: 50 });
    const moneyAdd = createRuleSpecPackage({
      ...base,
      facts: [],
      parameters: [
        { ref_id: "parameter.left", parameter_id: "syn.parameter.left", parameter_version: "1.0.0", value_kind: "money", unit: "currency.zzz" },
        { ref_id: "parameter.right", parameter_id: "syn.parameter.right", parameter_version: "1.0.0", value_kind: "money", unit: "currency.zzz" },
      ],
      nodes: [{ node_id: "result.amount", operation: "add", refs: ["parameter.left", "parameter.right"] }],
    });
    expect(() => executeRuleSpec({ rule: moneyAdd, facts: [], parameters: [
      { ref_id: "parameter.left", value: { kind: "money", currency: "ZZZ", minor_units: Number.MAX_SAFE_INTEGER } },
      { ref_id: "parameter.right", value: { kind: "money", currency: "ZZZ", minor_units: 1 } },
    ] })).toThrow("RULESPEC_MONEY_OVERFLOW");
  });

  it("detects byte mutation in golden and RuleSpec hashes", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    expect(() => validateRuleSpecPackage({ ...fixture.rule, topic: "travel" })).toThrow("RULESPEC_CONTENT_HASH_MISMATCH");
    expect(() => validateGoldenCaseSet({ ...fixture.golden_cases, cases: [{ ...fixture.golden_cases.cases[0], case_id: "syn.case.mutated" }] })).toThrow("GOLDEN_CASE_SET_CONTENT_HASH_MISMATCH");
    expect(fixture.rule.content_sha256).toBe(legalOperationsSha256(draft()));
  });
});
