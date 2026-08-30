import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import { canonicalLegalOperationsJson, frozen, legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { SYNTHETIC_CATALOG_BOUNDARY, realCatalogStatusMatrix, syntheticSevenTopicCatalogMatrix } from "../../../engine/legal-operations/catalog.ts";
import type { DependencyBindings, LifecycleCommand, SignedLifecycleAction } from "../../../engine/legal-operations/contracts.ts";
import { buildAllReviewPacketBundles, buildOwnerHandoffIndex } from "../../../engine/legal-operations/review-packets.ts";
import { executeRuleSpec } from "../../../engine/legal-operations/rulespec.ts";
import { assessDependencyInvalidation, BINDING_DIMENSIONS, type ImportArtifactCommand } from "../../../engine/legal-operations/state-machine.ts";
import { SYNTHETIC_CATALOG_TIMESTAMP, SYNTHETIC_SEVEN_TOPIC_FIXTURES, type SyntheticLegalFixture } from "../../../engine/legal-operations/synthetic-fixtures.ts";
import { LegalOperationsApplicationService } from "./service.ts";

function actor(topic: string, stage: string) { return `syn.human.${stage}.${topic}`; }
function digest(label: string) { return legalOperationsSha256({ synthetic_test_only: true, label }); }

function importCommand(fixture: SyntheticLegalFixture, artifactKind: ImportArtifactCommand["artifact_kind"], artifactId: string, content: unknown): ImportArtifactCommand {
  return {
    artifact_id: artifactId,
    artifact_version: "1.0.0",
    artifact_kind: artifactKind,
    content,
    content_sha256: legalOperationsSha256(content),
    bindings: fixture.parameter.bindings,
    idempotency_key: `syn.import.${artifactKind}.${fixture.topic}`,
    imported_at: SYNTHETIC_CATALOG_TIMESTAMP,
  };
}

function command(fixture: SyntheticLegalFixture, artifactKind: LifecycleCommand["artifact_kind"], artifactId: string, expected: string, target: string, stage: string): LifecycleCommand {
  const content = artifactKind === "source" ? { schema_version: "tivdoc-synthetic-source-v0.6.0", source_version_id: fixture.source_version_id, synthetic_test_only: true } : artifactKind === "parameter" ? fixture.parameter : fixture.rule;
  return {
    schema_version: "tivdoc-legal-lifecycle-command-v0.6.0",
    command_id: `syn.command.${artifactKind}.${fixture.topic}.${stage}`,
    idempotency_key: `syn.transition.${artifactKind}.${fixture.topic}.${stage}`,
    artifact_id: artifactId,
    artifact_version: "1.0.0",
    artifact_kind: artifactKind,
    expected_state: expected,
    target_state: target,
    actor_id: actor(fixture.topic, `${artifactKind}.${stage}`),
    actor_role: stage === "activate" ? "human_activation_approver" : "human_authority_reviewer",
    occurred_at: SYNTHETIC_CATALOG_TIMESTAMP,
    reason: "Synthetic-test-only deterministic lifecycle acceptance step.",
    bound_content_sha256: legalOperationsSha256(content),
    bindings: fixture.parameter.bindings,
    action_signature_sha256: null,
  };
}

function signedAction(fixture: SyntheticLegalFixture, artifactKind: "source" | "parameter" | "rule_package", artifactId: string, action: "propose_activation" | "activate" | "revoke" | "supersede", expected: SignedLifecycleAction["expected_state"]): SignedLifecycleAction {
  const content = artifactKind === "source" ? { schema_version: "tivdoc-synthetic-source-v0.6.0", source_version_id: fixture.source_version_id, synthetic_test_only: true } : artifactKind === "parameter" ? fixture.parameter : fixture.rule;
  const target = action === "propose_activation" ? "eligible" : action === "activate" ? "active" : action === "revoke" ? "revoked" : "superseded";
  return {
    schema_version: "tivdoc-signed-lifecycle-action-v0.6.0",
    action_id: `syn.action.${action}.${artifactKind}.${fixture.topic}`,
    idempotency_key: `syn.action.idempotency.${action}.${artifactKind}.${fixture.topic}`,
    artifact_id: artifactId,
    artifact_version: "1.0.0",
    artifact_kind: artifactKind,
    action,
    expected_state: expected,
    target_state: target,
    actor_id: actor(fixture.topic, `${artifactKind}.${action}`),
    actor_role: action === "activate" ? "human_activation_approver" : "human_authority_reviewer",
    occurred_at: SYNTHETIC_CATALOG_TIMESTAMP,
    reason: "Synthetic-test-only signed lifecycle acceptance action.",
    bound_content_sha256: legalOperationsSha256(content),
    bindings: fixture.parameter.bindings,
    signature_sha256: digest(`${fixture.topic}:${artifactKind}:${action}:signature`),
  } as SignedLifecycleAction;
}

function activateFixture(fixture: SyntheticLegalFixture) {
  const service = new LegalOperationsApplicationService();
  const sourceContent = frozen({ schema_version: "tivdoc-synthetic-source-v0.6.0", source_version_id: fixture.source_version_id, synthetic_test_only: true });
  const sourceImport = importCommand(fixture, "source", fixture.source_version_id, sourceContent);
  const firstImport = service.importArtifact(sourceImport);
  const replayImport = service.importArtifact(sourceImport);
  for (const attestation of fixture.source_attestations) service.importSignedSourceDecision(fixture.source_version_id, "1.0.0", attestation);
  service.transition(command(fixture, "source", fixture.source_version_id, "needs_review", "content_verified", "content"));
  service.transition(command(fixture, "source", fixture.source_version_id, "content_verified", "applicability_verified", "applicability"));
  service.transition(command(fixture, "source", fixture.source_version_id, "applicability_verified", "eligible", "eligibility"));
  service.activate(signedAction(fixture, "source", fixture.source_version_id, "activate", "eligible") as Extract<SignedLifecycleAction, { action: "activate" }>);

  service.importArtifact(importCommand(fixture, "parameter", fixture.parameter.parameter_id, fixture.parameter));
  service.transition(command(fixture, "parameter", fixture.parameter.parameter_id, "candidate", "structurally_valid", "structure"));
  service.transition(command(fixture, "parameter", fixture.parameter.parameter_id, "structurally_valid", "awaiting_attestations", "awaiting"));
  for (const attestation of fixture.parameter_attestations) service.importParameterAttestation(fixture.parameter.parameter_id, "1.0.0", attestation);
  service.transition(command(fixture, "parameter", fixture.parameter.parameter_id, "awaiting_attestations", "approved", "approval"));
  service.proposeActivation(signedAction(fixture, "parameter", fixture.parameter.parameter_id, "propose_activation", "approved") as Extract<SignedLifecycleAction, { action: "propose_activation" }>);
  service.activate(signedAction(fixture, "parameter", fixture.parameter.parameter_id, "activate", "eligible") as Extract<SignedLifecycleAction, { action: "activate" }>);

  service.importArtifact(importCommand(fixture, "rule_package", fixture.rule.rule_spec_id, fixture.rule));
  service.importGoldenCaseSet(fixture.golden_cases, `syn.import.golden.${fixture.topic}`);
  service.transition(command(fixture, "rule_package", fixture.rule.rule_spec_id, "candidate", "structurally_valid", "structure"));
  service.transition(command(fixture, "rule_package", fixture.rule.rule_spec_id, "structurally_valid", "awaiting_attestations", "awaiting"));
  for (const approval of fixture.semantic_approvals) service.importRuleOrGoldenApproval(fixture.rule.rule_spec_id, "1.0.0", approval);
  service.transition(command(fixture, "rule_package", fixture.rule.rule_spec_id, "awaiting_attestations", "approved", "approval"));
  service.proposeActivation(signedAction(fixture, "rule_package", fixture.rule.rule_spec_id, "propose_activation", "approved") as Extract<SignedLifecycleAction, { action: "propose_activation" }>);
  service.activate(signedAction(fixture, "rule_package", fixture.rule.rule_spec_id, "activate", "eligible") as Extract<SignedLifecycleAction, { action: "activate" }>);

  const goldenResults = fixture.golden_cases.cases.map((testCase) => executeRuleSpec({ rule: fixture.rule, facts: testCase.facts, parameters: testCase.parameters }));
  const activationObserved = [
    service.history(fixture.source_version_id, "1.0.0"),
    service.history(fixture.parameter.parameter_id, "1.0.0"),
    service.history(fixture.rule.rule_spec_id, "1.0.0"),
  ].every((history) => history.some((receipt) => receipt.state === "active"));
  service.supersede(signedAction(fixture, "source", fixture.source_version_id, "supersede", "active") as Extract<SignedLifecycleAction, { action: "supersede" }>);
  service.revoke(signedAction(fixture, "parameter", fixture.parameter.parameter_id, "revoke", "active") as Extract<SignedLifecycleAction, { action: "revoke" }>);
  service.supersede(signedAction(fixture, "rule_package", fixture.rule.rule_spec_id, "supersede", "active") as Extract<SignedLifecycleAction, { action: "supersede" }>);
  const terminalStates = [
    service.status(fixture.source_version_id, "1.0.0").state,
    service.status(fixture.parameter.parameter_id, "1.0.0").state,
    service.status(fixture.rule.rule_spec_id, "1.0.0").state,
  ];
  return frozen({
    topic: fixture.topic,
    source_state: terminalStates[0],
    parameter_state: terminalStates[1],
    rule_state: terminalStates[2],
    activation_observed: activationObserved,
    revocation_observed: terminalStates.includes("revoked"),
    supersession_observed: terminalStates.includes("superseded"),
    import_idempotency_passed: !firstImport.idempotent_replay && replayImport.idempotent_replay && firstImport.receipt.receipt_sha256 === replayImport.receipt.receipt_sha256,
    golden_case_count: goldenResults.length,
    golden_cases_passed: goldenResults.every((result, index) => legalOperationsSha256(result.output) === legalOperationsSha256(fixture.golden_cases.cases[index].expected_output)),
    deterministic_trace_sha256: goldenResults[0].trace_sha256,
    passed: activationObserved && terminalStates[0] === "superseded" && terminalStates[1] === "revoked" && terminalStates[2] === "superseded" && goldenResults.every((result, index) => legalOperationsSha256(result.output) === legalOperationsSha256(fixture.golden_cases.cases[index].expected_output)),
  });
}

export async function runLegalOperationsAcceptanceMatrix() {
  const packetBundles = buildAllReviewPacketBundles();
  const handoff = buildOwnerHandoffIndex("review-packets");
  const fixtureResults = SYNTHETIC_SEVEN_TOPIC_FIXTURES.map(activateFixture);
  const syntheticCatalog = await syntheticSevenTopicCatalogMatrix();
  const realCatalog = await realCatalogStatusMatrix();
  const baseline = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0].parameter.bindings;
  const dependencyInvalidation = BINDING_DIMENSIONS.map((dimension) => {
    const mutated = { ...baseline, [dimension]: digest(`mutated:${dimension}`) } as DependencyBindings;
    const invalidated = assessDependencyInvalidation(baseline, mutated);
    return frozen({ dimension, invalidated, passed: invalidated.length === 1 && invalidated[0] === dimension });
  });
  const packetPairHashes = packetBundles.map((bundle) => frozen({
    topic: bundle.topic,
    packet_sha256: bundle.packet.packet_sha256,
    json_sha256: legalOperationsSha256(JSON.parse(bundle.json)),
    markdown_sha256: legalOperationsSha256(bundle.markdown),
    blank_decision_sha256: legalOperationsSha256(bundle.blank_decision),
  }));
  const invariants = frozen({
    seven_packet_pairs: packetBundles.length === 7 && packetBundles.every((bundle) => bundle.json.length > 0 && bundle.markdown.length > 0 && bundle.blank_decision.required_decisions.length === 5),
    owner_handoff_seven: handoff.packet_count === 7 && handoff.packets.every((packet) => packet.required_signatures.length === 5),
    all_synthetic_lifecycles_activated_then_terminal: fixtureResults.length === 7 && fixtureResults.every((entry) => entry.passed),
    all_golden_cases_passed: fixtureResults.every((entry) => entry.golden_cases_passed),
    synthetic_catalog_seven_ready: syntheticCatalog.ready_count === 7 && syntheticCatalog.active_parameter_count === 7 && syntheticCatalog.active_rule_count === 7,
    real_catalog_zero_ready: realCatalog.ready_count === 0 && realCatalog.active_parameter_count === 0 && realCatalog.active_rule_count === 0,
    all_eight_dependency_mutations_fail_closed: dependencyInvalidation.length === 8 && dependencyInvalidation.every((entry) => entry.passed),
    synthetic_fixture_production_reachable: SYNTHETIC_CATALOG_BOUNDARY.production_manifest_reachable,
  });
  const passed = Object.entries(invariants).every(([key, value]) => key === "synthetic_fixture_production_reachable" ? value === false : value === true);
  const report = frozen({
    schema_version: "tivdoc-legal-operations-acceptance-matrix-v0.6.0",
    generated_at: SYNTHETIC_CATALOG_TIMESTAMP,
    topic_count: WAVE3_TOPICS.length,
    packet_pair_hashes: packetPairHashes,
    fixture_results: fixtureResults,
    dependency_invalidation: dependencyInvalidation,
    synthetic_catalog: syntheticCatalog,
    real_catalog: realCatalog,
    invariants,
    passed,
  });
  return frozen({ report, canonical_json: canonicalLegalOperationsJson(report), report_sha256: legalOperationsSha256(report) });
}
