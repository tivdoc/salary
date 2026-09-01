import { describe, expect, it } from "vitest";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "../legal-operations/synthetic-fixtures.ts";
import { RuleSpecAuthoringQueue } from "./authoring-queue.ts";
import { buildSevenRuleSpecAuthoringSkeletons } from "./rulespec-authoring.ts";
import { runRuleSpecMutationSuite } from "./mutation-runner.ts";

describe("RuleSpec authoring and mutation controls", () => {
  it("runs deterministic structural mutations without permitting activation", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const report = runRuleSpecMutationSuite({ rule: fixture.rule, golden_case_set: fixture.golden_cases });
    expect(report.all_mechanical_checks_passed).toBe(true);
    expect(report.eligible_for_human_review).toBe(true);
    expect(report.activation_allowed).toBe(false);
    expect(report.activation_blockers).toEqual([
      "GENUINE_HUMAN_RULE_APPROVAL_REQUIRED",
      "GENUINE_HUMAN_GOLDEN_APPROVAL_REQUIRED",
      "EXPLICIT_SIGNED_ACTIVATION_REQUIRED",
    ]);
    expect(new Set(report.results.map((result) => result.category))).toEqual(new Set(["baseline", "order", "missing_input", "duplicate_input", "undeclared_input", "unit_type", "resource_bound", "content_hash"]));
    expect(report.results.every((result) => result.passed)).toBe(true);
    expect(report.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("queues all seven blank authoring templates append-only and non-operative", () => {
    const queue = new RuleSpecAuthoringQueue();
    const skeletons = buildSevenRuleSpecAuthoringSkeletons();
    skeletons.forEach((skeleton, index) => {
      const first = queue.enqueueBlank({ skeleton, idempotency_key: `rulespec-authoring-${index + 1}`, reason_code: "BLANK_TEMPLATE_QUEUED" });
      const replay = queue.enqueueBlank({ skeleton, idempotency_key: `rulespec-authoring-${index + 1}`, reason_code: "BLANK_TEMPLATE_QUEUED" });
      expect(first).toMatchObject({ revision: 1, state: "blank_non_operative", activation_allowed: false, execution_allowed: false, idempotent_replay: false });
      expect(replay.idempotent_replay).toBe(true);
    });
    expect(queue.events()).toHaveLength(7);
    const first = skeletons[0];
    expect(queue.invalidateDependencies({ skeleton_id: first.skeleton_id, expected_skeleton_sha256: first.content_sha256, dependency_sha256: "d".repeat(64), idempotency_key: "rulespec-authoring-invalidate-1", reason_code: "DEPENDENCY_CHANGED" })).toMatchObject({ revision: 2, state: "invalidated_non_operative", activation_allowed: false });
    expect(queue.verifyAuditChain()).toMatchObject({ valid: true, event_count: 8 });
  });
});
