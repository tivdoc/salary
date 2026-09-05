import { z } from "zod";
import { isoDateSchema, isoTimestampSchema, moneySchema, versionSchema } from "../domain/primitives.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";

export const LEGAL_OPERATIONS_SCHEMA_VERSION = "tivdoc-legal-operations-v0.6.0" as const;
export const legalOperationsTopicSchema = z.enum(WAVE3_TOPICS);
export const legalOperationsIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/);
export const legalOperationsSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const nonEmptyTextSchema = z.string().trim().min(1).max(4_000);

export const sourceAuthorityRoleSchema = z.enum([
  "primary_binding",
  "official_implementation",
  "official_guidance",
  "secondary_explanatory",
  "role_pending",
]);

export const reviewPacketSourceSchema = z.object({
  source_version_id: legalOperationsIdSchema,
  immutable_source_record_sha256: legalOperationsSha256Schema,
  artifact_sha256: legalOperationsSha256Schema.nullable(),
  chunk_sha256s: z.array(legalOperationsSha256Schema).max(500).readonly(),
  hash_availability: z.enum(["verified_hashes_present", "artifact_hash_missing", "chunks_unavailable", "technical_parse_failed"]),
  authority_role: sourceAuthorityRoleSchema,
  publication_metadata: z.object({ publication_reference: z.string().max(500).nullable(), published_at: isoDateSchema.nullable() }).strict(),
  proposed_effective_periods: z.array(z.object({ from: isoDateSchema.nullable(), to: isoDateSchema.nullable(), status: z.literal("unverified") }).strict()).max(50).readonly(),
  proposed_sectors: z.array(legalOperationsIdSchema).max(100).readonly(),
  proposed_populations: z.array(legalOperationsIdSchema).max(100).readonly(),
  lifecycle_blockers: z.array(nonEmptyTextSchema).readonly(),
}).strict().superRefine((source, context) => {
  if (source.hash_availability === "verified_hashes_present" && (source.artifact_sha256 === null || source.chunk_sha256s.length === 0)) context.addIssue({ code: "custom", message: "verified_source_requires_artifact_and_chunk_hashes" });
  if (source.hash_availability !== "verified_hashes_present" && source.lifecycle_blockers.length === 0) context.addIssue({ code: "custom", message: "unavailable_source_hash_requires_blocker" });
  for (const [index, interval] of source.proposed_effective_periods.entries()) if (interval.from !== null && interval.to !== null && interval.to < interval.from) context.addIssue({ code: "custom", message: "ambiguous_or_inverted_interval", path: ["proposed_effective_periods", index] });
}).readonly();

export const reviewPacketSchema = z.object({
  schema_version: z.literal("tivdoc-source-review-packet-v0.6.0"),
  packet_id: legalOperationsIdSchema,
  packet_version: versionSchema,
  topic: legalOperationsTopicSchema,
  generated_at: isoTimestampSchema,
  scope_complete_as_of: isoDateSchema,
  completeness_status: z.enum(["incomplete", "blocked", "candidate_complete_unreviewed"]),
  sources: z.array(reviewPacketSourceSchema).min(1).readonly(),
  known_conflicts: z.array(nonEmptyTextSchema).readonly(),
  quarantines: z.array(nonEmptyTextSchema).readonly(),
  parse_failures: z.array(nonEmptyTextSchema).readonly(),
  missing_official_material: z.array(nonEmptyTextSchema).readonly(),
  reviewer_questions: z.array(nonEmptyTextSchema).min(1).readonly(),
  decision_template_id: legalOperationsIdSchema,
  usable_for_rules: z.literal(false),
  packet_sha256: legalOperationsSha256Schema,
}).strict().superRefine((packet, context) => {
  if (packet.completeness_status === "candidate_complete_unreviewed" && (packet.sources.some((source) => source.hash_availability !== "verified_hashes_present" || source.lifecycle_blockers.length > 0) || packet.known_conflicts.length > 0 || packet.quarantines.length > 0 || packet.parse_failures.length > 0 || packet.missing_official_material.length > 0)) context.addIssue({ code: "custom", message: "candidate_complete_packet_requires_verified_unblocked_sources" });
}).readonly();

export const reviewDecisionKindSchema = z.enum([
  "artifact_authenticity",
  "content_transcription_accuracy",
  "effective_interval",
  "sector_population_applicability",
  "authority_precedence",
]);
export const reviewerRoleSchema = z.enum([
  "human_artifact_reviewer",
  "human_content_reviewer",
  "human_effective_period_reviewer",
  "human_applicability_reviewer",
  "human_authority_reviewer",
  "human_parameter_reviewer",
  "human_rule_reviewer",
  "human_golden_case_reviewer",
  "human_activation_approver",
]);

export const sourceDecisionPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("artifact_authenticity"),
    status: z.enum(["verified", "not_approved"]),
    artifact_sha256s: z.array(legalOperationsSha256Schema).readonly(),
  }).strict(),
  z.object({
    kind: z.literal("content_transcription_accuracy"),
    status: z.enum(["verified", "not_approved"]),
    artifact_sha256s: z.array(legalOperationsSha256Schema).readonly(),
    chunk_sha256s: z.array(legalOperationsSha256Schema).max(500).readonly(),
  }).strict(),
  z.object({
    kind: z.literal("effective_interval"),
    status: z.enum(["verified", "not_approved"]),
    intervals: z.array(z.object({ from: isoDateSchema, to: isoDateSchema.nullable() }).strict().refine((interval) => interval.to === null || interval.to >= interval.from, "source_decision_interval_inverted")).max(100).readonly(),
  }).strict(),
  z.object({
    kind: z.literal("sector_population_applicability"),
    status: z.enum(["verified", "not_approved"]),
    sectors: z.array(legalOperationsIdSchema).max(100).readonly(),
    populations: z.array(legalOperationsIdSchema).max(100).readonly(),
  }).strict(),
  z.object({
    kind: z.literal("authority_precedence"),
    status: z.enum(["verified", "not_approved"]),
    source_roles: z.array(z.object({ source_version_id: legalOperationsIdSchema, authority_role: sourceAuthorityRoleSchema }).strict()).max(100).readonly(),
  }).strict(),
]).readonly();

export const sourceReviewAttestationSchema = z.object({
  schema_version: z.literal("tivdoc-source-review-attestation-v0.6.0"),
  attestation_id: legalOperationsIdSchema,
  packet_id: legalOperationsIdSchema,
  packet_sha256: legalOperationsSha256Schema,
  source_version_ids: z.array(legalOperationsIdSchema).min(1).readonly(),
  decision_kind: reviewDecisionKindSchema,
  decision: z.enum(["approved", "rejected", "changes_requested"]),
  reviewer_id: legalOperationsIdSchema,
  reviewer_role: reviewerRoleSchema,
  decided_at: isoTimestampSchema,
  reason: nonEmptyTextSchema,
  decision_payload: sourceDecisionPayloadSchema,
  bound_artifact_sha256s: z.array(legalOperationsSha256Schema).readonly(),
  bound_citation_sha256: legalOperationsSha256Schema,
  bound_interval_sha256: legalOperationsSha256Schema,
  bound_scope_sha256: legalOperationsSha256Schema,
  signature_sha256: legalOperationsSha256Schema,
}).strict().superRefine((attestation, context) => {
  if (attestation.decision_payload.kind !== attestation.decision_kind) context.addIssue({ code: "custom", message: "source_decision_payload_kind_mismatch", path: ["decision_payload", "kind"] });
  if (attestation.decision === "approved" && attestation.decision_payload.status !== "verified") context.addIssue({ code: "custom", message: "approved_source_decision_requires_verified_payload", path: ["decision_payload", "status"] });
  if (attestation.decision === "approved") {
    const payload = attestation.decision_payload;
    if (payload.kind === "artifact_authenticity" && (payload.artifact_sha256s.length === 0 || payload.artifact_sha256s.some((hash) => !attestation.bound_artifact_sha256s.includes(hash)))) context.addIssue({ code: "custom", message: "artifact_authenticity_requires_bound_hashes", path: ["decision_payload", "artifact_sha256s"] });
    if (payload.kind === "content_transcription_accuracy" && (payload.artifact_sha256s.length === 0 || payload.chunk_sha256s.length === 0 || payload.artifact_sha256s.some((hash) => !attestation.bound_artifact_sha256s.includes(hash)))) context.addIssue({ code: "custom", message: "content_accuracy_requires_bound_artifact_and_chunk_hashes", path: ["decision_payload"] });
    if (payload.kind === "effective_interval" && payload.intervals.length === 0) context.addIssue({ code: "custom", message: "effective_interval_decision_requires_interval", path: ["decision_payload", "intervals"] });
    if (payload.kind === "sector_population_applicability" && (payload.sectors.length === 0 || payload.populations.length === 0)) context.addIssue({ code: "custom", message: "scope_decision_requires_sector_and_population", path: ["decision_payload"] });
    if (payload.kind === "authority_precedence" && (payload.source_roles.length === 0 || payload.source_roles.map((entry) => entry.source_version_id).sort().join("\n") !== [...attestation.source_version_ids].sort().join("\n"))) context.addIssue({ code: "custom", message: "authority_decision_requires_exact_source_roles", path: ["decision_payload", "source_roles"] });
  }
}).readonly();

export const blankSourceDecisionTemplateSchema = z.object({
  schema_version: z.literal("tivdoc-blank-source-decision-template-v0.6.0"),
  template_id: legalOperationsIdSchema,
  packet_id: legalOperationsIdSchema,
  packet_sha256: legalOperationsSha256Schema,
  required_decisions: z.array(reviewDecisionKindSchema).length(5).readonly(),
  reviewer_id: z.null(),
  reviewer_role: z.null(),
  decision: z.null(),
  decided_at: z.null(),
  reason: z.null(),
  signature_sha256: z.null(),
}).strict().readonly();

export const reviewOwnerHandoffIndexSchema = z.object({
  schema_version: z.literal("tivdoc-review-owner-handoff-index-v0.6.0"),
  generated_at: isoTimestampSchema,
  packet_count: z.literal(7),
  packets: z.array(z.object({
    topic: legalOperationsTopicSchema,
    packet_id: legalOperationsIdSchema,
    packet_sha256: legalOperationsSha256Schema,
    json_path: nonEmptyTextSchema,
    markdown_path: nonEmptyTextSchema,
    blank_decision_path: nonEmptyTextSchema,
    completeness_status: z.enum(["incomplete", "blocked", "candidate_complete_unreviewed"]),
    required_signatures: z.array(z.object({
      decision_kind: reviewDecisionKindSchema,
      reviewer_role: reviewerRoleSchema,
      status: z.literal("pending_human_signature"),
    }).strict()).length(5).readonly(),
  }).strict()).length(7).readonly(),
  real_catalog_activation_permitted: z.literal(false),
}).strict().readonly();

export const exactRationalSchema = z.object({
  kind: z.literal("rational"),
  numerator: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
  denominator: z.string().regex(/^[1-9]\d*$/),
  unit: legalOperationsIdSchema,
}).strict().readonly();
export const parameterValueSchema = z.discriminatedUnion("kind", [
  exactRationalSchema,
  z.object({ kind: z.literal("money"), value: moneySchema }).strict().readonly(),
  z.object({ kind: z.literal("integer"), value: z.number().int().safe(), unit: legalOperationsIdSchema }).strict().readonly(),
]);

export const dependencyBindingsSchema = z.object({
  source_bytes_sha256: legalOperationsSha256Schema,
  citations_sha256: legalOperationsSha256Schema,
  interval_sha256: legalOperationsSha256Schema,
  scope_sha256: legalOperationsSha256Schema,
  parameter_set_sha256: legalOperationsSha256Schema,
  rule_spec_sha256: legalOperationsSha256Schema,
  golden_cases_sha256: legalOperationsSha256Schema,
  reviewer_decisions_sha256: legalOperationsSha256Schema,
}).strict().readonly();

// L11-5 / D3.6: agreement_interpretation joins the ladder, below administrative.
export const PROVENANCE_GRADES = ["text_verified", "lexicon", "selection", "inferred_visual", "administrative", "agreement_interpretation"] as const;
export const provenanceGradeSchema = z.enum(PROVENANCE_GRADES);
export const visualBindingSchema = z.object({
  page_pdf_sha256: legalOperationsSha256Schema,
  visual_reading: z.string().min(1).max(40),
}).strict().readonly();

export const parameterCandidateSchema = z.object({
  schema_version: z.literal("tivdoc-parameter-candidate-v0.6.0"),
  parameter_id: legalOperationsIdSchema,
  parameter_version: versionSchema,
  topic: legalOperationsTopicSchema,
  value: parameterValueSchema,
  unit: legalOperationsIdSchema,
  rounding_policy: z.enum(["exact", "toward_zero", "half_up", "half_even"]),
  effective_from: isoDateSchema,
  effective_to: isoDateSchema.nullable(),
  sectors: z.array(legalOperationsIdSchema).min(1).readonly(),
  populations: z.array(legalOperationsIdSchema).min(1).readonly(),
  operative_source_version_ids: z.array(legalOperationsIdSchema).min(1).readonly(),
  support_roles: z.array(sourceAuthorityRoleSchema).min(1).readonly(),
  bindings: dependencyBindingsSchema,
  candidate_sha256: legalOperationsSha256Schema,
  // P-0 (Addendum 6 A6-2). Every alternative of one open legal decision is
  // its own candidate row sharing decision_id, each with its own distinct
  // branch; paired so a candidate cannot silently drop one half of the link.
  decision_id: legalOperationsIdSchema.nullable(),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/).nullable(),
  // L6-2 / D1. The provenance grade of the candidate — the worst of its
  // citations' — and, for a figure read from a page image, the bindings an
  // attestation must confirm: the cited page's hash and the reading. Both are
  // optional so every candidate registered before this field exists keeps its
  // hash; a candidate that carries visual bindings must say its grade is
  // inferred_visual, and one that says so must carry them.
  provenance_grade: provenanceGradeSchema.optional(),
  visual_bindings: z.array(visualBindingSchema).min(1).readonly().optional(),
}).strict().superRefine((candidate, context) => {
  // Visual bindings travel with any candidate that has a visual citation, and
  // such a candidate's grade is inferred_visual or worse; a candidate that
  // claims the inferred_visual grade must carry them.
  if (candidate.visual_bindings !== undefined && candidate.provenance_grade !== "inferred_visual" && candidate.provenance_grade !== "administrative" && candidate.provenance_grade !== "agreement_interpretation") context.addIssue({ code: "custom", message: "parameter_visual_bindings_grade_unpaired", path: ["visual_bindings"] });
  if (candidate.visual_bindings === undefined && candidate.provenance_grade === "inferred_visual") context.addIssue({ code: "custom", message: "parameter_visual_bindings_grade_unpaired", path: ["visual_bindings"] });
  if (candidate.effective_to !== null && candidate.effective_to < candidate.effective_from) context.addIssue({ code: "custom", message: "parameter_interval_inverted", path: ["effective_to"] });
  if (candidate.value.kind === "money" && candidate.unit !== `currency.${candidate.value.value.currency.toLowerCase()}`) context.addIssue({ code: "custom", message: "parameter_money_unit_mismatch", path: ["unit"] });
  if (candidate.value.kind !== "money" && candidate.value.unit !== candidate.unit) context.addIssue({ code: "custom", message: "parameter_value_unit_mismatch", path: ["unit"] });
  if ((candidate.decision_id === null) !== (candidate.branch === null)) context.addIssue({ code: "custom", message: "parameter_decision_branch_unpaired", path: ["branch"] });
}).readonly();

export const parameterAttestationSchema = z.object({
  schema_version: z.literal("tivdoc-parameter-attestation-v0.6.0"),
  attestation_id: legalOperationsIdSchema,
  candidate_id: legalOperationsIdSchema,
  candidate_version: versionSchema,
  candidate_sha256: legalOperationsSha256Schema,
  reviewer_id: legalOperationsIdSchema,
  reviewer_role: z.literal("human_parameter_reviewer"),
  value: parameterValueSchema,
  unit: legalOperationsIdSchema,
  rounding_policy: z.enum(["exact", "toward_zero", "half_up", "half_even"]),
  operative_source_version_ids: z.array(legalOperationsIdSchema).min(1).readonly(),
  bindings_sha256: legalOperationsSha256Schema,
  decision: z.literal("approved"),
  attested_at: isoTimestampSchema,
  signature_sha256: legalOperationsSha256Schema,
  // L6-2 / D1. A reviewer confirming a figure read from a page image says so
  // and names what they looked at. The database refuses an attestation of an
  // inferred_visual candidate without both, and refuses both on any other.
  visual_confirmed: z.literal(true).optional(),
  visual_bindings: z.array(visualBindingSchema).min(1).readonly().optional(),
}).strict().superRefine((attestation, context) => {
  if ((attestation.visual_confirmed === true) !== (attestation.visual_bindings !== undefined)) context.addIssue({ code: "custom", message: "attestation_visual_confirmation_unpaired", path: ["visual_bindings"] });
}).readonly();

export const semanticApprovalSchema = z.object({
  schema_version: z.literal("tivdoc-legal-semantic-approval-v0.6.0"),
  approval_id: legalOperationsIdSchema,
  artifact_id: legalOperationsIdSchema,
  artifact_version: versionSchema,
  artifact_sha256: legalOperationsSha256Schema,
  approval_kind: z.enum(["rule_semantics", "golden_case_outputs"]),
  reviewer_id: legalOperationsIdSchema,
  reviewer_role: z.enum(["human_rule_reviewer", "human_golden_case_reviewer"]),
  decision: z.literal("approved"),
  decided_at: isoTimestampSchema,
  signature_sha256: legalOperationsSha256Schema,
}).strict().superRefine((approval, context) => {
  if (approval.approval_kind === "rule_semantics" && approval.reviewer_role !== "human_rule_reviewer") context.addIssue({ code: "custom", message: "rule_semantics_requires_rule_reviewer" });
  if (approval.approval_kind === "golden_case_outputs" && approval.reviewer_role !== "human_golden_case_reviewer") context.addIssue({ code: "custom", message: "golden_cases_require_golden_case_reviewer" });
}).readonly();

export const lifecycleCommandSchema = z.object({
  schema_version: z.literal("tivdoc-legal-lifecycle-command-v0.6.0"),
  command_id: legalOperationsIdSchema,
  idempotency_key: legalOperationsIdSchema,
  artifact_id: legalOperationsIdSchema,
  artifact_version: versionSchema,
  artifact_kind: z.enum(["review_packet", "source", "parameter", "rule_package"]),
  expected_state: z.string().min(1).max(80),
  target_state: z.string().min(1).max(80),
  actor_id: legalOperationsIdSchema,
  actor_role: reviewerRoleSchema,
  occurred_at: isoTimestampSchema,
  reason: nonEmptyTextSchema,
  bound_content_sha256: legalOperationsSha256Schema,
  bindings: dependencyBindingsSchema,
  action_signature_sha256: legalOperationsSha256Schema.nullable(),
}).strict().readonly();

const signedLifecycleActionBase = z.object({
  schema_version: z.literal("tivdoc-signed-lifecycle-action-v0.6.0"),
  action_id: legalOperationsIdSchema,
  idempotency_key: legalOperationsIdSchema,
  artifact_id: legalOperationsIdSchema,
  artifact_version: versionSchema,
  artifact_kind: z.enum(["source", "parameter", "rule_package"]),
  actor_id: legalOperationsIdSchema,
  occurred_at: isoTimestampSchema,
  reason: nonEmptyTextSchema,
  bound_content_sha256: legalOperationsSha256Schema,
  bindings: dependencyBindingsSchema,
  signature_sha256: legalOperationsSha256Schema,
});

export const signedLifecycleActionSchema = z.discriminatedUnion("action", [
  signedLifecycleActionBase.extend({ action: z.literal("propose_activation"), artifact_kind: z.enum(["parameter", "rule_package"]), expected_state: z.literal("approved"), target_state: z.literal("eligible"), actor_role: reviewerRoleSchema }).strict(),
  signedLifecycleActionBase.extend({ action: z.literal("activate"), expected_state: z.literal("eligible"), target_state: z.literal("active"), actor_role: z.literal("human_activation_approver") }).strict(),
  signedLifecycleActionBase.extend({ action: z.literal("revoke"), expected_state: z.enum(["needs_review", "content_verified", "applicability_verified", "candidate", "structurally_valid", "awaiting_attestations", "approved", "eligible", "active"]), target_state: z.literal("revoked"), actor_role: reviewerRoleSchema }).strict(),
  signedLifecycleActionBase.extend({ action: z.literal("supersede"), expected_state: z.literal("active"), target_state: z.literal("superseded"), actor_role: reviewerRoleSchema }).strict(),
]).readonly();

export const auditReceiptSchema = z.object({
  schema_version: z.literal("tivdoc-legal-operations-audit-receipt-v0.6.0"),
  sequence: z.number().int().positive(),
  artifact_id: legalOperationsIdSchema,
  artifact_version: versionSchema,
  prior_state: z.string().min(1),
  state: z.string().min(1),
  command_sha256: legalOperationsSha256Schema,
  prior_receipt_sha256: legalOperationsSha256Schema.nullable(),
  receipt_sha256: legalOperationsSha256Schema,
  occurred_at: isoTimestampSchema,
  invalidated_gates: z.array(z.string().min(1)).readonly(),
}).strict().readonly();

export type ReviewPacket = z.infer<typeof reviewPacketSchema>;
export type ReviewPacketSource = z.infer<typeof reviewPacketSourceSchema>;
export type SourceReviewAttestation = z.infer<typeof sourceReviewAttestationSchema>;
export type BlankSourceDecisionTemplate = z.infer<typeof blankSourceDecisionTemplateSchema>;
export type ReviewOwnerHandoffIndex = z.infer<typeof reviewOwnerHandoffIndexSchema>;
export type ParameterCandidate = z.infer<typeof parameterCandidateSchema>;
export type ParameterAttestation = z.infer<typeof parameterAttestationSchema>;
export type ParameterValue = z.infer<typeof parameterValueSchema>;
export type DependencyBindings = z.infer<typeof dependencyBindingsSchema>;
export type SemanticApproval = z.infer<typeof semanticApprovalSchema>;
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;
export type SignedLifecycleAction = z.infer<typeof signedLifecycleActionSchema>;
export type AuditReceipt = z.infer<typeof auditReceiptSchema>;
