import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import { buildSevenRuleSpecAuthoringSkeletons, lintRuleSpecForActivation } from "./rulespec-authoring.ts";

function rehash(candidate: Record<string, unknown>) {
  const content = { ...candidate };
  delete content.content_sha256;
  return { ...content, content_sha256: canonicalSha256(content) };
}

describe("V07-P4-RULESPEC authoring skeletons", () => {
  it("builds exactly one non-operative versioned skeleton for each topic", () => {
    const skeletons = buildSevenRuleSpecAuthoringSkeletons();
    expect(skeletons).toHaveLength(7);
    expect(skeletons.map((item) => item.topic)).toEqual(WAVE3_TOPICS);
    for (const skeleton of skeletons) {
      const report = lintRuleSpecForActivation(skeleton);
      expect(report.activation_allowed).toBe(false);
      expect(report.execution_allowed).toBe(false);
      expect(report.blockers).toEqual(expect.arrayContaining([
        "RULESPEC_UNRESOLVED_PLACEHOLDER",
        "RULESPEC_CITATION_UNVERIFIED",
        "RULESPEC_APPROVAL_MISSING",
        "RULESPEC_DEPENDENCY_UNAPPROVED",
        "RULESPEC_MONEY_OR_RATIONAL_BOUNDS_UNPROVEN",
      ]));
    }
  });

  it("rejects direct literals, arbitrary execution hooks and dynamic imports", () => {
    const base = buildSevenRuleSpecAuthoringSkeletons()[0];
    const literal = rehash({ ...base, operations: [{ ...base.operations[0], legal_value: 12 }] });
    expect(lintRuleSpecForActivation(literal).blockers).toContain("RULESPEC_DIRECT_LEGAL_LITERAL_FORBIDDEN");
    expect(lintRuleSpecForActivation({ ...base, callback: "eval(input)" }).blockers).toContain("RULESPEC_ARBITRARY_CODE_FORBIDDEN");
    expect(lintRuleSpecForActivation({ ...base, loader: "dynamic_import(module)" }).blockers).toContain("RULESPEC_DYNAMIC_IMPORT_FORBIDDEN");
  });

  it("rejects cycles, excessive depth, unsafe units, undeclared Facts and dependencies", () => {
    const base = buildSevenRuleSpecAuthoringSkeletons()[0];
    const cycle = rehash({ ...base, operations: [
      { ...base.operations[0], operation_id: "operation.cycle.a", input_refs: ["operation.cycle.b"] },
      { ...base.operations[0], operation_id: "operation.cycle.b", input_refs: ["operation.cycle.a"] },
    ] });
    expect(lintRuleSpecForActivation(cycle).blockers).toContain("RULESPEC_CYCLE_DETECTED");
    const chain = Array.from({ length: 17 }, (_, index) => ({ ...base.operations[0], operation_id: `operation.depth.${index}`, input_refs: index === 0 ? [base.available_fact_paths[0]] : [`operation.depth.${index - 1}`] }));
    expect(lintRuleSpecForActivation(rehash({ ...base, operations: chain })).blockers).toContain("RULESPEC_DEPTH_LIMIT_EXCEEDED");
    expect(lintRuleSpecForActivation(rehash({ ...base, operations: [{ ...base.operations[0], unit: "unsafe.person_specific_unit" }] })).blockers).toContain("RULESPEC_UNSAFE_UNIT");
    expect(lintRuleSpecForActivation(rehash({ ...base, available_fact_paths: ["unknown.private.fact"] })).blockers).toContain("RULESPEC_FACT_PATH_UNDECLARED");
    expect(lintRuleSpecForActivation(base).blockers).toContain("RULESPEC_DEPENDENCY_UNAPPROVED");
  });
});
