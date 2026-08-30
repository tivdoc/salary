import { frozen, legalOperationsSha256 } from "./canonical.ts";
import {
  auditReceiptSchema,
  dependencyBindingsSchema,
  lifecycleCommandSchema,
  parameterAttestationSchema,
  parameterCandidateSchema,
  reviewPacketSchema,
  semanticApprovalSchema,
  sourceReviewAttestationSchema,
  type AuditReceipt,
  type DependencyBindings,
  type LifecycleCommand,
  type ParameterAttestation,
  type ParameterCandidate,
  type ReviewPacket,
  type SemanticApproval,
  type SourceReviewAttestation,
} from "./contracts.ts";
import { ruleSpecPackageSchema, validateGoldenCaseSet, validateRuleSpecPackage, type RuleSpecPackage } from "./rulespec.ts";

export type ReviewPacketState = "draft" | "ready_for_review" | "changes_requested" | "rejected" | "approved";
export type SourceLifecycleState = "needs_review" | "content_verified" | "applicability_verified" | "eligible" | "active" | "superseded" | "revoked";
export type PackageLifecycleState = "candidate" | "structurally_valid" | "awaiting_attestations" | "approved" | "eligible" | "active" | "superseded" | "revoked";
export type LegalLifecycleState = ReviewPacketState | SourceLifecycleState | PackageLifecycleState;

const ALLOWED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  draft: ["ready_for_review"],
  ready_for_review: ["changes_requested", "rejected", "approved"],
  changes_requested: ["ready_for_review", "rejected"],
  needs_review: ["content_verified", "revoked"],
  content_verified: ["applicability_verified", "revoked"],
  applicability_verified: ["eligible", "revoked"],
  candidate: ["structurally_valid", "revoked"],
  structurally_valid: ["awaiting_attestations", "revoked"],
  awaiting_attestations: ["approved", "revoked"],
  approved: ["eligible", "revoked"],
  eligible: ["active", "revoked"],
  active: ["superseded", "revoked"],
  superseded: [],
  revoked: [],
  rejected: [],
});

const KIND_STATES: Readonly<Record<LifecycleCommand["artifact_kind"], readonly LegalLifecycleState[]>> = Object.freeze({
  review_packet: Object.freeze<LegalLifecycleState[]>(["draft", "ready_for_review", "changes_requested", "rejected", "approved"]),
  source: Object.freeze<LegalLifecycleState[]>(["needs_review", "content_verified", "applicability_verified", "eligible", "active", "superseded", "revoked"]),
  parameter: Object.freeze<LegalLifecycleState[]>(["candidate", "structurally_valid", "awaiting_attestations", "approved", "eligible", "active", "superseded", "revoked"]),
  rule_package: Object.freeze<LegalLifecycleState[]>(["candidate", "structurally_valid", "awaiting_attestations", "approved", "eligible", "active", "superseded", "revoked"]),
});

export const BINDING_DIMENSIONS = Object.freeze([
  "source_bytes_sha256",
  "citations_sha256",
  "interval_sha256",
  "scope_sha256",
  "parameter_set_sha256",
  "rule_spec_sha256",
  "golden_cases_sha256",
  "reviewer_decisions_sha256",
] as const);

export function assessDependencyInvalidation(expected: DependencyBindings, observed: DependencyBindings) {
  return BINDING_DIMENSIONS.filter((dimension) => expected[dimension] !== observed[dimension]);
}

type ArtifactContent = ReviewPacket | ParameterCandidate | RuleSpecPackage | Readonly<Record<string, unknown>>;
type ArtifactRecord = {
  artifact_id: string;
  artifact_version: string;
  artifact_kind: LifecycleCommand["artifact_kind"];
  content: ArtifactContent;
  content_sha256: string;
  bindings: DependencyBindings;
  state: LegalLifecycleState;
  receipts: AuditReceipt[];
  source_attestations: SourceReviewAttestation[];
  parameter_attestations: ParameterAttestation[];
  semantic_approvals: SemanticApproval[];
  actor_ids: Set<string>;
};

export type ImportArtifactCommand = Readonly<{
  artifact_id: string;
  artifact_version: string;
  artifact_kind: LifecycleCommand["artifact_kind"];
  content: unknown;
  content_sha256: string;
  bindings: DependencyBindings;
  idempotency_key: string;
  imported_at: string;
}>;

function recordKey(id: string, version: string) { return `${id}@${version}`; }
function same(left: unknown, right: unknown) { return legalOperationsSha256(left) === legalOperationsSha256(right); }

function parseContent(kind: LifecycleCommand["artifact_kind"], content: unknown): ArtifactContent {
  if (kind === "review_packet") {
    const packet = reviewPacketSchema.parse(content);
    const { packet_sha256: packetSha256, ...seed } = packet;
    if (legalOperationsSha256(seed) !== packetSha256) throw new Error("REVIEW_PACKET_CONTENT_HASH_MISMATCH");
    return packet;
  }
  if (kind === "parameter") {
    const parameter = parameterCandidateSchema.parse(content);
    const { candidate_sha256: candidateSha256, ...seed } = parameter;
    if (legalOperationsSha256(seed) !== candidateSha256) throw new Error("PARAMETER_CANDIDATE_CONTENT_HASH_MISMATCH");
    return parameter;
  }
  if (kind === "rule_package") return validateRuleSpecPackage(ruleSpecPackageSchema.parse(content));
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("SOURCE_CONTENT_OBJECT_REQUIRED");
  return frozen({ ...(content as Record<string, unknown>) });
}

function initialState(kind: LifecycleCommand["artifact_kind"]): LegalLifecycleState {
  if (kind === "review_packet") return "draft";
  if (kind === "source") return "needs_review";
  return "candidate";
}

export class AppendOnlyLegalOperationsStore {
  readonly #records = new Map<string, ArtifactRecord>();
  readonly #idempotency = new Map<string, Readonly<{ command_sha256: string; receipt: AuditReceipt }>>();
  readonly #goldenCaseHashes = new Map<string, string>();

  importGoldenCaseSet(candidate: unknown) {
    const golden = validateGoldenCaseSet(candidate);
    const existing = this.#goldenCaseHashes.get(golden.golden_case_set_id);
    if (existing && existing !== golden.content_sha256) throw new Error("APPEND_ONLY_GOLDEN_CASE_SET_MUTATION_REJECTED");
    const idempotentReplay = existing === golden.content_sha256;
    this.#goldenCaseHashes.set(golden.golden_case_set_id, golden.content_sha256);
    return frozen({ golden_case_set_id: golden.golden_case_set_id, content_sha256: golden.content_sha256, idempotent_replay: idempotentReplay });
  }

  #hasGoldenCaseHash(contentSha256: string) { return [...this.#goldenCaseHashes.values()].includes(contentSha256); }

  importArtifact(input: ImportArtifactCommand): Readonly<{ receipt: AuditReceipt; idempotent_replay: boolean }> {
    const bindings = dependencyBindingsSchema.parse(input.bindings);
    const content = parseContent(input.artifact_kind, input.content);
    if (legalOperationsSha256(content) !== input.content_sha256) throw new Error("LEGAL_ARTIFACT_CONTENT_HASH_MISMATCH");
    const commandSha256 = legalOperationsSha256(input);
    const priorIdempotency = this.#idempotency.get(input.idempotency_key);
    if (priorIdempotency) {
      if (priorIdempotency.command_sha256 !== commandSha256) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_IMPORT");
      return frozen({ receipt: priorIdempotency.receipt, idempotent_replay: true });
    }
    const key = recordKey(input.artifact_id, input.artifact_version);
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.content_sha256 !== input.content_sha256 || existing.artifact_kind !== input.artifact_kind) throw new Error("APPEND_ONLY_ARTIFACT_MUTATION_REJECTED");
      const receipt = existing.receipts[0];
      this.#idempotency.set(input.idempotency_key, { command_sha256: commandSha256, receipt });
      return frozen({ receipt, idempotent_replay: true });
    }
    const state = initialState(input.artifact_kind);
    const body = { schema_version: "tivdoc-legal-operations-audit-receipt-v0.6.0", sequence: 1, artifact_id: input.artifact_id, artifact_version: input.artifact_version, prior_state: "unregistered", state, command_sha256: commandSha256, prior_receipt_sha256: null, occurred_at: input.imported_at, invalidated_gates: [] };
    const receipt = auditReceiptSchema.parse({ ...body, receipt_sha256: legalOperationsSha256(body) });
    this.#records.set(key, { artifact_id: input.artifact_id, artifact_version: input.artifact_version, artifact_kind: input.artifact_kind, content, content_sha256: input.content_sha256, bindings, state, receipts: [receipt], source_attestations: [], parameter_attestations: [], semantic_approvals: [], actor_ids: new Set() });
    this.#idempotency.set(input.idempotency_key, { command_sha256: commandSha256, receipt });
    return frozen({ receipt, idempotent_replay: false });
  }

  #record(id: string, version: string) {
    const record = this.#records.get(recordKey(id, version));
    if (!record) throw new Error("LEGAL_ARTIFACT_VERSION_NOT_FOUND");
    return record;
  }

  importSourceAttestation(id: string, version: string, candidate: unknown) {
    const record = this.#record(id, version);
    if (record.artifact_kind !== "source" && record.artifact_kind !== "review_packet") throw new Error("SOURCE_ATTESTATION_TARGET_INVALID");
    const attestation = sourceReviewAttestationSchema.parse(candidate);
    if (record.artifact_kind === "review_packet" && attestation.packet_sha256 !== reviewPacketSchema.parse(record.content).packet_sha256) throw new Error("SOURCE_ATTESTATION_PACKET_HASH_MISMATCH");
    if (record.artifact_kind === "source" && !attestation.source_version_ids.includes(record.artifact_id)) throw new Error("SOURCE_ATTESTATION_VERSION_BINDING_MISMATCH");
    if (!attestation.bound_artifact_sha256s.includes(record.bindings.source_bytes_sha256) || attestation.bound_citation_sha256 !== record.bindings.citations_sha256 || attestation.bound_interval_sha256 !== record.bindings.interval_sha256 || attestation.bound_scope_sha256 !== record.bindings.scope_sha256) throw new Error("SOURCE_ATTESTATION_DEPENDENCY_BINDING_MISMATCH");
    const duplicate = record.source_attestations.find((entry) => entry.attestation_id === attestation.attestation_id);
    if (duplicate) {
      if (!same(duplicate, attestation)) throw new Error("APPEND_ONLY_ATTESTATION_MUTATION_REJECTED");
      return frozen({ attestation, idempotent_replay: true });
    }
    if (record.source_attestations.some((entry) => entry.decision_kind === attestation.decision_kind)) throw new Error("SOURCE_DECISION_REVISION_REQUIRED");
    const expectedRole = {
      artifact_authenticity: "human_artifact_reviewer",
      content_transcription_accuracy: "human_content_reviewer",
      effective_interval: "human_effective_period_reviewer",
      sector_population_applicability: "human_applicability_reviewer",
      authority_precedence: "human_authority_reviewer",
    }[attestation.decision_kind];
    if (attestation.reviewer_role !== expectedRole) throw new Error("SOURCE_REVIEW_ROLE_MISMATCH");
    if (record.source_attestations.some((entry) => entry.reviewer_id === attestation.reviewer_id && entry.decision_kind !== attestation.decision_kind)) throw new Error("SOURCE_REVIEW_SEPARATION_OF_DUTIES_REQUIRED");
    record.source_attestations.push(attestation);
    record.actor_ids.add(attestation.reviewer_id);
    return frozen({ attestation, idempotent_replay: false });
  }

  importParameterAttestation(id: string, version: string, candidate: unknown) {
    const record = this.#record(id, version);
    if (record.artifact_kind !== "parameter") throw new Error("PARAMETER_ATTESTATION_TARGET_INVALID");
    const parameter = parameterCandidateSchema.parse(record.content);
    const attestation = parameterAttestationSchema.parse(candidate);
    const bindingsSha256 = legalOperationsSha256(parameter.bindings);
    if (attestation.candidate_id !== parameter.parameter_id || attestation.candidate_version !== parameter.parameter_version || attestation.candidate_sha256 !== parameter.candidate_sha256 || attestation.bindings_sha256 !== bindingsSha256 || attestation.unit !== parameter.unit || attestation.rounding_policy !== parameter.rounding_policy || !same(attestation.value, parameter.value) || !same(attestation.operative_source_version_ids, parameter.operative_source_version_ids)) throw new Error("PARAMETER_ATTESTATION_BINDING_MISMATCH");
    const duplicate = record.parameter_attestations.find((entry) => entry.attestation_id === attestation.attestation_id);
    if (duplicate) {
      if (!same(duplicate, attestation)) throw new Error("APPEND_ONLY_ATTESTATION_MUTATION_REJECTED");
      return frozen({ attestation, idempotent_replay: true });
    }
    if (record.parameter_attestations.some((entry) => entry.reviewer_id === attestation.reviewer_id)) throw new Error("TWO_INDEPENDENT_PARAMETER_ATTESTERS_REQUIRED");
    record.parameter_attestations.push(attestation);
    record.actor_ids.add(attestation.reviewer_id);
    return frozen({ attestation, idempotent_replay: false });
  }

  importSemanticApproval(id: string, version: string, candidate: unknown) {
    const record = this.#record(id, version);
    if (record.artifact_kind !== "rule_package") throw new Error("SEMANTIC_APPROVAL_TARGET_INVALID");
    const rule = ruleSpecPackageSchema.parse(record.content);
    const approval = semanticApprovalSchema.parse(candidate);
    if (approval.artifact_id !== rule.rule_spec_id || approval.artifact_version !== rule.rule_spec_version || (approval.approval_kind === "rule_semantics" && approval.artifact_sha256 !== rule.content_sha256) || (approval.approval_kind === "golden_case_outputs" && approval.artifact_sha256 !== rule.golden_case_set_sha256)) throw new Error("SEMANTIC_APPROVAL_BINDING_MISMATCH");
    if (approval.approval_kind === "golden_case_outputs" && !this.#hasGoldenCaseHash(approval.artifact_sha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
    const duplicate = record.semantic_approvals.find((entry) => entry.approval_id === approval.approval_id);
    if (duplicate) {
      if (!same(duplicate, approval)) throw new Error("APPEND_ONLY_APPROVAL_MUTATION_REJECTED");
      return frozen({ approval, idempotent_replay: true });
    }
    if (record.semantic_approvals.some((entry) => entry.approval_kind === approval.approval_kind)) throw new Error("SEMANTIC_APPROVAL_REVISION_REQUIRED");
    if (record.semantic_approvals.some((entry) => entry.reviewer_id === approval.reviewer_id)) throw new Error("RULE_AND_GOLDEN_APPROVAL_SEPARATION_REQUIRED");
    record.semantic_approvals.push(approval);
    record.actor_ids.add(approval.reviewer_id);
    return frozen({ approval, idempotent_replay: false });
  }

  transition(candidate: unknown): Readonly<{ receipt: AuditReceipt; idempotent_replay: boolean }> {
    const command = lifecycleCommandSchema.parse(candidate);
    const commandSha256 = legalOperationsSha256(command);
    const replay = this.#idempotency.get(command.idempotency_key);
    if (replay) {
      if (replay.command_sha256 !== commandSha256) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_COMMAND");
      return frozen({ receipt: replay.receipt, idempotent_replay: true });
    }
    const record = this.#record(command.artifact_id, command.artifact_version);
    if (record.artifact_kind !== command.artifact_kind) throw new Error("LEGAL_ARTIFACT_KIND_MISMATCH");
    if (record.state !== command.expected_state) throw new Error("LEGAL_LIFECYCLE_EXPECTED_STATE_MISMATCH");
    if (!KIND_STATES[record.artifact_kind].includes(command.target_state as LegalLifecycleState) || !ALLOWED[record.state]?.includes(command.target_state)) throw new Error("LEGAL_LIFECYCLE_TRANSITION_FORBIDDEN");
    if (command.bound_content_sha256 !== record.content_sha256) throw new Error("LEGAL_ARTIFACT_BOUND_CONTENT_STALE");
    const invalidations = assessDependencyInvalidation(record.bindings, command.bindings);
    if (invalidations.length > 0) throw new Error(`LEGAL_DEPENDENCY_BINDING_INVALIDATED:${invalidations.join(",")}`);
    this.#assertGates(record, command.target_state, command.actor_id, command.actor_role);
    const prior = record.receipts.at(-1)!;
    const body = { schema_version: "tivdoc-legal-operations-audit-receipt-v0.6.0", sequence: prior.sequence + 1, artifact_id: record.artifact_id, artifact_version: record.artifact_version, prior_state: record.state, state: command.target_state, command_sha256: commandSha256, prior_receipt_sha256: prior.receipt_sha256, occurred_at: command.occurred_at, invalidated_gates: [] };
    const receipt = auditReceiptSchema.parse({ ...body, receipt_sha256: legalOperationsSha256(body) });
    record.state = command.target_state as LegalLifecycleState;
    record.receipts.push(receipt);
    record.actor_ids.add(command.actor_id);
    this.#idempotency.set(command.idempotency_key, { command_sha256: commandSha256, receipt });
    return frozen({ receipt, idempotent_replay: false });
  }

  #assertGates(record: ArtifactRecord, target: string, actorId: string, actorRole: string) {
    if (target === "active") {
      if (actorRole !== "human_activation_approver") throw new Error("EXPLICIT_ACTIVATION_APPROVER_REQUIRED");
      if (record.actor_ids.has(actorId)) throw new Error("ACTIVATION_SELF_APPROVAL_FORBIDDEN");
    }
    if (record.artifact_kind === "review_packet" && target === "approved") {
      const packet = reviewPacketSchema.parse(record.content);
      if (packet.completeness_status !== "candidate_complete_unreviewed" || packet.sources.some((source) => source.hash_availability !== "verified_hashes_present")) throw new Error("REVIEW_PACKET_INCOMPLETE_OR_BLOCKED");
      const approved = record.source_attestations.filter((entry) => entry.decision === "approved");
      const kinds = new Set(approved.map((entry) => entry.decision_kind));
      if (kinds.size !== 5) throw new Error("ALL_SOURCE_REVIEW_DIMENSIONS_REQUIRED");
      if (new Set(approved.map((entry) => entry.reviewer_id)).size !== approved.length) throw new Error("SOURCE_REVIEW_SEPARATION_OF_DUTIES_REQUIRED");
    }
    if (record.artifact_kind === "source") {
      const kinds = new Set(record.source_attestations.filter((entry) => entry.decision === "approved").map((entry) => entry.decision_kind));
      if (target === "content_verified" && (!kinds.has("artifact_authenticity") || !kinds.has("content_transcription_accuracy"))) throw new Error("SOURCE_CONTENT_ATTESTATIONS_REQUIRED");
      if (target === "applicability_verified" && !(["effective_interval", "sector_population_applicability", "authority_precedence"] as const).every((kind) => kinds.has(kind))) throw new Error("SOURCE_APPLICABILITY_ATTESTATIONS_REQUIRED");
    }
    if (record.artifact_kind === "parameter" && target === "approved") {
      const parameter = parameterCandidateSchema.parse(record.content);
      if (record.parameter_attestations.length !== 2 || new Set(record.parameter_attestations.map((entry) => entry.reviewer_id)).size !== 2) throw new Error("TWO_INDEPENDENT_PARAMETER_ATTESTERS_REQUIRED");
      if (!parameter.support_roles.includes("primary_binding")) throw new Error("SECONDARY_OR_CORROBORATIVE_ONLY_MONETARY_SUPPORT_REJECTED");
    }
    if (record.artifact_kind === "rule_package" && target === "approved") {
      const rule = ruleSpecPackageSchema.parse(record.content);
      if (!this.#hasGoldenCaseHash(rule.golden_case_set_sha256)) throw new Error("GOLDEN_CASE_SET_IMPORT_REQUIRED");
      const kinds = new Set(record.semantic_approvals.map((entry) => entry.approval_kind));
      if (!kinds.has("rule_semantics") || !kinds.has("golden_case_outputs")) throw new Error("RULE_AND_GOLDEN_APPROVALS_REQUIRED");
      if (new Set(record.semantic_approvals.map((entry) => entry.reviewer_id)).size !== record.semantic_approvals.length) throw new Error("RULE_AND_GOLDEN_APPROVAL_SEPARATION_REQUIRED");
    }
  }

  status(id: string, version: string) {
    const record = this.#record(id, version);
    const missing: string[] = [];
    if (record.artifact_kind === "review_packet" && record.source_attestations.filter((entry) => entry.decision === "approved").length < 5) missing.push("source_review_dimensions");
    if (record.artifact_kind === "parameter" && record.parameter_attestations.length < 2) missing.push("dual_parameter_attestations");
    if (record.artifact_kind === "rule_package" && new Set(record.semantic_approvals.map((entry) => entry.approval_kind)).size < 2) missing.push("rule_and_golden_approvals");
    if (record.state !== "active") missing.push("explicit_activation");
    return frozen({ artifact_id: id, artifact_version: version, artifact_kind: record.artifact_kind, state: record.state, content_sha256: record.content_sha256, revision: record.receipts.length, missing_gates: missing.sort(), audit_head_sha256: record.receipts.at(-1)!.receipt_sha256 });
  }

  history(id: string, version: string) { return frozen([...this.#record(id, version).receipts]); }
}
