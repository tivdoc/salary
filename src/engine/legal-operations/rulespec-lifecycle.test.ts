import { describe, expect, it } from "vitest";

import { legalOperationsSha256 } from "./canonical.ts";
import {
  canonicalRuleSpecLifecycleJson,
  changedRuleSpecDependencyDimensions,
  createRuleSpecDependencyManifest,
  NonOperativeRuleSpecLifecycle,
  RULESPEC_DECISION_REFERENCE_SCHEMA,
  validateRuleSpecDecisionReference,
  validateRuleSpecDependencyManifest,
  type RuleSpecDecisionReference,
  type RuleSpecDependencyManifest,
} from "./rulespec-lifecycle.ts";
import { createRuleSpecPackage, type RuleSpecPackage } from "./rulespec.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES, syntheticBindings } from "./synthetic-fixtures.ts";

const NOW = "2040-01-01T00:00:00.000Z";

function reference(
  rule: RuleSpecPackage,
  manifest: RuleSpecDependencyManifest,
  kind: RuleSpecDecisionReference["decision_kind"],
  successor: RuleSpecDecisionReference["successor"] = null,
): RuleSpecDecisionReference {
  const role = kind === "rule_semantics_approval" ? "human_rule_reviewer" as const
    : kind === "golden_case_outputs_approval" ? "human_golden_case_reviewer" as const
      : "human_activation_approver" as const;
  const body = {
    schema_version: RULESPEC_DECISION_REFERENCE_SCHEMA,
    reference_id: `syn.reference.${kind}`,
    reference_version: "1.0.0",
    decision_kind: kind,
    trust_boundary: "synthetic_test_only" as const,
    verification_status: "synthetic_fixture_not_human" as const,
    rule_spec_id: rule.rule_spec_id,
    rule_spec_version: rule.rule_spec_version,
    rule_spec_sha256: rule.content_sha256,
    dependency_manifest_sha256: manifest.manifest_sha256,
    golden_case_set_sha256: rule.golden_case_set_sha256,
    reviewer_id: `syn.reviewer.${kind}`,
    reviewer_role: role,
    envelope_sha256: legalOperationsSha256({ kind, synthetic_envelope: true }),
    signature_sha256: legalOperationsSha256({ kind, synthetic_signature_bytes: true }),
    decided_at: NOW,
    successor,
    activation_allowed: false as const,
  };
  return validateRuleSpecDecisionReference({ ...body, reference_sha256: legalOperationsSha256(body) });
}

function lifecycle(rule: RuleSpecPackage, commandPrefix: string) {
  const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.rule.rule_spec_id === rule.rule_spec_id)!;
  const manifest = createRuleSpecDependencyManifest(rule);
  const instance = new NonOperativeRuleSpecLifecycle({
    rule_spec: rule,
    metadata: { command_id: `${commandPrefix}.draft`, occurred_at: NOW },
  });
  instance.bindDependencies({
    manifest,
    bindings: syntheticBindings(rule.topic, rule.content_sha256, rule.golden_case_set_sha256),
    metadata: { command_id: `${commandPrefix}.dependencies`, occurred_at: NOW },
  });
  instance.markGoldenReady({
    golden_case_set: fixture.golden_cases,
    metadata: { command_id: `${commandPrefix}.golden`, occurred_at: NOW },
  });
  instance.recordApprovalReferences({
    references: [reference(rule, manifest, "rule_semantics_approval"),
      reference(rule, manifest, "golden_case_outputs_approval")],
    metadata: { command_id: `${commandPrefix}.references`, occurred_at: NOW },
  });
  instance.markShadowEligible({ metadata: { command_id: `${commandPrefix}.shadow`, occurred_at: NOW } });
  return { instance, manifest };
}

describe("non-operative RuleSpec lifecycle", () => {
  it("binds canonical dependency/version digests and reaches only synthetic shadow eligibility", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const first = lifecycle(fixture.rule, "syn.command.lifecycle");
    const replay = lifecycle(fixture.rule, "syn.command.lifecycle");
    expect(first.instance.status()).toMatchObject({
      state: "shadow_eligible",
      revision: 5,
      approval_reference_count: 2,
      genuine_human_approval_count: 0,
      synthetic_reference_count: 2,
      activation_allowed: false,
      product_execution_allowed: false,
      customer_shadow_allowed: false,
    });
    expect(first.instance.events()).toEqual(replay.instance.events());
    expect(first.instance.verifyAuditChain()).toMatchObject({ valid: true, event_count: 5 });
    expect(canonicalRuleSpecLifecycleJson(first.manifest)).toBe(
      canonicalRuleSpecLifecycleJson({ ...first.manifest }),
    );
  });

  it("detects every changed manifest dimension without depending on object order", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const base = createRuleSpecDependencyManifest(fixture.rule);
    const { content_sha256: omitted, ...draft } = fixture.rule;
    void omitted;
    const changed = createRuleSpecPackage({
      ...draft,
      parameters: draft.parameters.map((parameter) => ({ ...parameter, parameter_version: "2.0.0" })),
    });
    const changedManifest = createRuleSpecDependencyManifest(changed);
    expect(changedRuleSpecDependencyDimensions(base, changedManifest)).toEqual(["parameter_versions"]);
    expect(validateRuleSpecDependencyManifest({ ...base })).toEqual(base);
  });

  it("supports hash-bound supersession and revocation while rejecting stale or unknown versions", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const first = lifecycle(fixture.rule, "syn.command.supersession");
    const { content_sha256: omitted, ...draft } = fixture.rule;
    void omitted;
    const successor = createRuleSpecPackage({ ...draft, rule_spec_version: "2.0.0" });
    const successorManifest = createRuleSpecDependencyManifest(successor);
    const successorBinding = {
      rule_spec_id: successor.rule_spec_id,
      rule_spec_version: successor.rule_spec_version,
      rule_spec_sha256: successor.content_sha256,
      dependency_manifest_sha256: successorManifest.manifest_sha256,
    };
    first.instance.supersede({
      successor_rule_spec: successor,
      successor_manifest: successorManifest,
      reference: reference(fixture.rule, first.manifest, "rulespec_supersession", successorBinding),
      metadata: { command_id: "syn.command.supersession.final", occurred_at: NOW },
    });
    expect(first.instance.status().state).toBe("superseded");
    expect(() => first.instance.revoke({
      reference: reference(fixture.rule, first.manifest, "rulespec_revocation"),
      metadata: { command_id: "syn.command.supersession.revoke", occurred_at: NOW },
    })).toThrow("RULESPEC_LIFECYCLE_TERMINAL");

    const revocable = lifecycle(fixture.rule, "syn.command.revocation");
    revocable.instance.revoke({
      reference: reference(fixture.rule, revocable.manifest, "rulespec_revocation"),
      metadata: { command_id: "syn.command.revocation.final", occurred_at: NOW },
    });
    expect(revocable.instance.status()).toMatchObject({ state: "revoked", activation_allowed: false });

    expect(() => validateRuleSpecDependencyManifest({ ...first.manifest, schema_version: "unknown-v99" }))
      .toThrow();
    expect(() => canonicalRuleSpecLifecycleJson({ schema_version: "unknown-v99" }))
      .toThrow("RULESPEC_LIFECYCLE_SCHEMA_VERSION_UNKNOWN");
    expect(() => validateRuleSpecDecisionReference({
      ...reference(fixture.rule, first.manifest, "rulespec_revocation"),
      signature_sha256: "f".repeat(64),
    })).toThrow("RULESPEC_DECISION_REFERENCE_HASH_MISMATCH");
  });

  it("does not let synthetic references advance a real inactive candidate", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const { content_sha256: omitted, ...draft } = fixture.rule;
    void omitted;
    const realInactive = createRuleSpecPackage({ ...draft, catalog_boundary: "real_inactive" });
    const manifest = createRuleSpecDependencyManifest(realInactive);
    const instance = new NonOperativeRuleSpecLifecycle({
      rule_spec: realInactive,
      metadata: { command_id: "syn.command.real.draft", occurred_at: NOW },
    });
    instance.bindDependencies({
      manifest,
      bindings: syntheticBindings(realInactive.topic, realInactive.content_sha256,
        realInactive.golden_case_set_sha256),
      metadata: { command_id: "syn.command.real.dependencies", occurred_at: NOW },
    });
    instance.markGoldenReady({
      golden_case_set: fixture.golden_cases,
      metadata: { command_id: "syn.command.real.golden", occurred_at: NOW },
    });
    expect(() => instance.recordApprovalReferences({
      references: [reference(realInactive, manifest, "rule_semantics_approval"),
        reference(realInactive, manifest, "golden_case_outputs_approval")],
      metadata: { command_id: "syn.command.real.references", occurred_at: NOW },
    })).toThrow("RULESPEC_VERIFIED_HUMAN_REFERENCE_REQUIRED_FOR_REAL_CANDIDATE");
    expect(instance.status()).toMatchObject({ state: "golden_ready", genuine_human_approval_count: 0,
      activation_allowed: false, customer_shadow_allowed: false });
  });
});
