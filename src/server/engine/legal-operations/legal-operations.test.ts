import { describe, expect, it } from "vitest";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import { legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { LegalOperationsCatalog, REAL_CATALOG_BOUNDARY, SYNTHETIC_CATALOG_BOUNDARY } from "../../../engine/legal-operations/catalog.ts";
import { parameterAttestationSchema, parameterCandidateSchema, reviewPacketSchema, sourceReviewAttestationSchema, type LifecycleCommand, type ReviewPacket } from "../../../engine/legal-operations/contracts.ts";
import { buildReviewPacket } from "../../../engine/legal-operations/review-packets.ts";
import { SYNTHETIC_CATALOG_DATE, SYNTHETIC_CATALOG_TIMESTAMP, SYNTHETIC_POPULATION, SYNTHETIC_SECTOR, SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "../../../engine/legal-operations/synthetic-fixtures.ts";
import { runLegalOperationsAcceptanceMatrix } from "./acceptance.ts";
import { LegalOperationsRuleSpecExecutor } from "./rulespec-executor.ts";
import { LegalOperationsApplicationService } from "./service.ts";

const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];

function lifecycle(artifactKind: LifecycleCommand["artifact_kind"], artifactId: string, content: unknown, expected: string, target: string, suffix: string): LifecycleCommand {
  return {
    schema_version: "tivdoc-legal-lifecycle-command-v0.6.0",
    command_id: `syn.command.test.${suffix}`,
    idempotency_key: `syn.command.test.key.${suffix}`,
    artifact_id: artifactId,
    artifact_version: "1.0.0",
    artifact_kind: artifactKind,
    expected_state: expected,
    target_state: target,
    actor_id: `syn.human.test.${suffix}`,
    actor_role: target === "active" ? "human_activation_approver" : "human_authority_reviewer",
    occurred_at: SYNTHETIC_CATALOG_TIMESTAMP,
    reason: "Synthetic-test-only lifecycle assertion.",
    bound_content_sha256: legalOperationsSha256(content),
    bindings: fixture.parameter.bindings,
    action_signature_sha256: null,
  };
}

describe("legal operations control plane", () => {
  it("passes the full all-seven acceptance and eight-dimension invalidation matrix", async () => {
    const { report, report_sha256 } = await runLegalOperationsAcceptanceMatrix();
    expect(report.passed).toBe(true);
    expect(report.topic_count).toBe(7);
    expect(report.fixture_results).toHaveLength(7);
    expect(report.fixture_results.every((entry) => entry.activation_observed && entry.revocation_observed && entry.supersession_observed)).toBe(true);
    expect(report.dependency_invalidation).toHaveLength(8);
    expect(report.dependency_invalidation.every((entry) => entry.passed)).toBe(true);
    expect(report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces every review transition and forbids kind crossover and skips", () => {
    const service = new LegalOperationsApplicationService();
    const blockedPacket = buildReviewPacket("minimum_wage");
    const blockedService = new LegalOperationsApplicationService();
    blockedService.importArtifact({ artifact_id: blockedPacket.packet_id, artifact_version: blockedPacket.packet_version, artifact_kind: "review_packet", content: blockedPacket, content_sha256: legalOperationsSha256(blockedPacket), bindings: fixture.parameter.bindings, idempotency_key: "syn.packet.blocked.import", imported_at: SYNTHETIC_CATALOG_TIMESTAMP });
    blockedService.transition(lifecycle("review_packet", blockedPacket.packet_id, blockedPacket, "draft", "ready_for_review", "blocked.packet.ready"));
    expect(() => blockedService.transition(lifecycle("review_packet", blockedPacket.packet_id, blockedPacket, "ready_for_review", "approved", "blocked.packet.approved"))).toThrow("REVIEW_PACKET_INCOMPLETE_OR_BLOCKED");
    const packetSeed = Object.fromEntries(Object.entries(blockedPacket).filter(([key]) => key !== "packet_sha256")) as Omit<ReviewPacket, "packet_sha256">;
    const completePacketSeed = {
      ...packetSeed,
      completeness_status: "candidate_complete_unreviewed" as const,
      sources: packetSeed.sources.map((source) => ({ ...source, artifact_sha256: fixture.parameter.bindings.source_bytes_sha256, chunk_sha256s: [fixture.parameter.bindings.citations_sha256], hash_availability: "verified_hashes_present" as const, lifecycle_blockers: [] })),
      known_conflicts: [],
      quarantines: [],
      parse_failures: [],
      missing_official_material: [],
    };
    const packet = reviewPacketSchema.parse({ ...completePacketSeed, packet_sha256: legalOperationsSha256(completePacketSeed) });
    service.importArtifact({ artifact_id: packet.packet_id, artifact_version: packet.packet_version, artifact_kind: "review_packet", content: packet, content_sha256: legalOperationsSha256(packet), bindings: fixture.parameter.bindings, idempotency_key: "syn.packet.import", imported_at: SYNTHETIC_CATALOG_TIMESTAMP });
    expect(() => service.transition(lifecycle("review_packet", packet.packet_id, packet, "draft", "approved", "packet.skip"))).toThrow("LEGAL_LIFECYCLE_TRANSITION_FORBIDDEN");
    service.transition(lifecycle("review_packet", packet.packet_id, packet, "draft", "ready_for_review", "packet.ready"));
    const packetSourceVersionIds = packet.sources.map((source) => source.source_version_id);
    for (const attestation of fixture.source_attestations) service.importSignedSourceDecision(packet.packet_id, packet.packet_version, sourceReviewAttestationSchema.parse({
      ...attestation,
      packet_id: packet.packet_id,
      packet_sha256: packet.packet_sha256,
      source_version_ids: packetSourceVersionIds,
      decision_payload: attestation.decision_payload.kind === "authority_precedence" ? { ...attestation.decision_payload, source_roles: packetSourceVersionIds.map((source_version_id) => ({ source_version_id, authority_role: "role_pending" })) } : attestation.decision_payload,
    }));
    service.transition(lifecycle("review_packet", packet.packet_id, packet, "ready_for_review", "approved", "packet.approved"));
    expect(() => service.transition(lifecycle("review_packet", packet.packet_id, packet, "approved", "eligible", "packet.kind.crossover"))).toThrow("LEGAL_LIFECYCLE_TRANSITION_FORBIDDEN");

    const branchService = new LegalOperationsApplicationService();
    branchService.importArtifact({ artifact_id: packet.packet_id, artifact_version: packet.packet_version, artifact_kind: "review_packet", content: packet, content_sha256: legalOperationsSha256(packet), bindings: fixture.parameter.bindings, idempotency_key: "syn.packet.branch.import", imported_at: SYNTHETIC_CATALOG_TIMESTAMP });
    branchService.transition(lifecycle("review_packet", packet.packet_id, packet, "draft", "ready_for_review", "branch.ready.1"));
    branchService.transition(lifecycle("review_packet", packet.packet_id, packet, "ready_for_review", "changes_requested", "branch.changes"));
    branchService.transition(lifecycle("review_packet", packet.packet_id, packet, "changes_requested", "ready_for_review", "branch.ready.2"));
    branchService.transition(lifecycle("review_packet", packet.packet_id, packet, "ready_for_review", "rejected", "branch.rejected"));
    expect(branchService.status(packet.packet_id, packet.packet_version).state).toBe("rejected");
  });

  it("requires two independent monetary attesters and rejects non-primary support", () => {
    const withoutHash = { ...fixture.parameter, support_roles: ["official_implementation" as const] } as Record<string, unknown>;
    delete withoutHash.candidate_sha256;
    const parameter = parameterCandidateSchema.parse({ ...withoutHash, candidate_sha256: legalOperationsSha256(withoutHash) });
    const service = new LegalOperationsApplicationService();
    service.importArtifact({ artifact_id: parameter.parameter_id, artifact_version: parameter.parameter_version, artifact_kind: "parameter", content: parameter, content_sha256: legalOperationsSha256(parameter), bindings: parameter.bindings, idempotency_key: "syn.secondary.parameter.import", imported_at: SYNTHETIC_CATALOG_TIMESTAMP });
    service.transition(lifecycle("parameter", parameter.parameter_id, parameter, "candidate", "structurally_valid", "secondary.structure"));
    service.transition(lifecycle("parameter", parameter.parameter_id, parameter, "structurally_valid", "awaiting_attestations", "secondary.awaiting"));
    const attestations = fixture.parameter_attestations.map((entry, index) => parameterAttestationSchema.parse({ ...entry, candidate_sha256: parameter.candidate_sha256, attestation_id: `syn.secondary.attestation.${index}`, bindings_sha256: legalOperationsSha256(parameter.bindings) }));
    service.importParameterAttestation(parameter.parameter_id, parameter.parameter_version, attestations[0]);
    expect(() => service.importParameterAttestation(parameter.parameter_id, parameter.parameter_version, { ...attestations[1], reviewer_id: attestations[0].reviewer_id })).toThrow("TWO_INDEPENDENT_PARAMETER_ATTESTERS_REQUIRED");
    service.importParameterAttestation(parameter.parameter_id, parameter.parameter_version, attestations[1]);
    expect(() => service.transition(lifecycle("parameter", parameter.parameter_id, parameter, "awaiting_attestations", "approved", "secondary.approval"))).toThrow("SECONDARY_OR_CORROBORATIVE_ONLY_MONETARY_SUPPORT_REJECTED");
  });

  it("keeps imports append-only and idempotent", () => {
    const service = new LegalOperationsApplicationService();
    const command = { artifact_id: fixture.parameter.parameter_id, artifact_version: fixture.parameter.parameter_version, artifact_kind: "parameter" as const, content: fixture.parameter, content_sha256: legalOperationsSha256(fixture.parameter), bindings: fixture.parameter.bindings, idempotency_key: "syn.parameter.idempotent", imported_at: SYNTHETIC_CATALOG_TIMESTAMP };
    const first = service.importArtifact(command);
    const replay = service.importArtifact(command);
    expect(first.idempotent_replay).toBe(false);
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    const mutatedSeed = Object.fromEntries(Object.entries({ ...fixture.parameter, effective_to: "2041-01-01" }).filter(([key]) => key !== "candidate_sha256"));
    const mutated = parameterCandidateSchema.parse({ ...mutatedSeed, candidate_sha256: legalOperationsSha256(mutatedSeed) });
    expect(() => service.importArtifact({ ...command, content: mutated, content_sha256: legalOperationsSha256(mutated) })).toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_IMPORT");
  });

  it("requires the exact immutable golden set before golden approval", () => {
    const service = new LegalOperationsApplicationService();
    service.importArtifact({ artifact_id: fixture.rule.rule_spec_id, artifact_version: fixture.rule.rule_spec_version, artifact_kind: "rule_package", content: fixture.rule, content_sha256: legalOperationsSha256(fixture.rule), bindings: fixture.parameter.bindings, idempotency_key: "syn.rule.golden.gate.import", imported_at: SYNTHETIC_CATALOG_TIMESTAMP });
    expect(() => service.importRuleOrGoldenApproval(fixture.rule.rule_spec_id, fixture.rule.rule_spec_version, fixture.semantic_approvals[1])).toThrow("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    service.importGoldenCaseSet(fixture.golden_cases, "syn.golden.gate.import");
    expect(service.importRuleOrGoldenApproval(fixture.rule.rule_spec_id, fixture.rule.rule_spec_version, fixture.semantic_approvals[1]).approval.approval_kind).toBe("golden_case_outputs");
  });

  it("isolates the synthetic catalog at compile and runtime while real remains 0/7", async () => {
    const catalog = new LegalOperationsCatalog();
    const real = await Promise.all(WAVE3_TOPICS.map((topic) => catalog.resolve({ topic, target_date: SYNTHETIC_CATALOG_DATE, as_of: SYNTHETIC_CATALOG_DATE, sector: SYNTHETIC_SECTOR, population: SYNTHETIC_POPULATION, mode: "real" })));
    const synthetic = await Promise.all(WAVE3_TOPICS.map((topic) => catalog.resolve({ topic, target_date: SYNTHETIC_CATALOG_DATE, as_of: SYNTHETIC_CATALOG_DATE, sector: SYNTHETIC_SECTOR, population: SYNTHETIC_POPULATION, mode: "synthetic_test" })));
    expect(real.every((entry) => entry.readiness.status === "BLOCKED_NOT_READY" && entry.rule_spec_id === null && entry.parameter_version_ids.length === 0)).toBe(true);
    expect(synthetic.every((entry) => entry.readiness.status === "READY" && entry.rule_spec_id !== null && entry.parameter_version_ids.length === 1)).toBe(true);
    expect(REAL_CATALOG_BOUNDARY).toMatchObject({ active_sources: 0, active_parameters: 0, active_rules: 0 });
    expect(SYNTHETIC_CATALOG_BOUNDARY.production_manifest_reachable).toBe(false);
    await expect(catalog.resolve({ topic: "minimum_wage", target_date: SYNTHETIC_CATALOG_DATE, as_of: SYNTHETIC_CATALOG_DATE, sector: SYNTHETIC_SECTOR, population: SYNTHETIC_POPULATION, mode: "production" } as never)).rejects.toThrow("LEGAL_CATALOG_MODE_FORBIDDEN");
  });

  it("executes only an exact registered synthetic snapshot and emits canonical CalculationTrace", async () => {
    const catalog = new LegalOperationsCatalog();
    const selection = await catalog.resolve({ topic: fixture.topic, target_date: SYNTHETIC_CATALOG_DATE, as_of: SYNTHETIC_CATALOG_DATE, sector: SYNTHETIC_SECTOR, population: SYNTHETIC_POPULATION, mode: "synthetic_test" });
    const snapshot = { snapshot_id: "syn.snapshot.minimum_wage", snapshot_version: "1.0.0", snapshot_sha256: legalOperationsSha256("snapshot") };
    const executor = new LegalOperationsRuleSpecExecutor();
    await expect(executor.execute({ selection, rule_input: snapshot, execution_id: "syn.execution.missing", calculated_at: SYNTHETIC_CATALOG_TIMESTAMP })).rejects.toThrow("RULE_INPUT_EXACT_SNAPSHOT_CONTEXT_MISSING");
    const registration = executor.registerFixtureSnapshot(fixture.topic, snapshot);
    expect(registration.idempotent_replay).toBe(false);
    expect(executor.registerFixtureSnapshot(fixture.topic, snapshot).idempotent_replay).toBe(true);
    const result = await executor.execute({ selection, rule_input: snapshot, execution_id: "syn.execution.minimum_wage", calculated_at: SYNTHETIC_CATALOG_TIMESTAMP });
    const replay = await executor.execute({ selection, rule_input: snapshot, execution_id: "syn.execution.minimum_wage", calculated_at: SYNTHETIC_CATALOG_TIMESTAMP });
    expect(result).toEqual(replay);
    expect(result.amount).toEqual({ currency: "ZZZ", minor_units: 100 });
    expect(result.trace.steps).toHaveLength(1);
    const realSelection = await catalog.resolve({ topic: fixture.topic, target_date: SYNTHETIC_CATALOG_DATE, as_of: SYNTHETIC_CATALOG_DATE, sector: SYNTHETIC_SECTOR, population: SYNTHETIC_POPULATION, mode: "real" });
    await expect(executor.execute({ selection: realSelection, rule_input: snapshot, execution_id: "syn.execution.real", calculated_at: SYNTHETIC_CATALOG_TIMESTAMP })).rejects.toThrow("RULESPEC_EXECUTION_CATALOG_NOT_READY_OR_FORBIDDEN");
  });
});
