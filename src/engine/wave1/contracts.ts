import { z } from "zod";
import { legalDateSchema, legalTimestampSchema, sha256Schema } from "../legal-knowledge/contracts.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);

/** Frozen V0.3.1 placeholder. Full fact snapshot contents are intentionally deferred. */
export const ruleInputSnapshotSchema = z.object({
  snapshot_id: stableIdSchema,
  snapshot_version: z.string().min(1).max(80),
  snapshot_sha256: sha256Schema,
}).strict().readonly();

export const legalEvidenceRefSchema = z.object({
  source_id: stableIdSchema,
  source_version_id: z.string().min(3).max(240),
  artifact_sha256: sha256Schema,
  parsed_version_id: z.string().min(3).max(240).nullable(),
  citation_id: z.string().min(3).max(240).nullable(),
  review_state: z.enum(["needs_review", "reviewed"]),
  activation_state: z.enum(["inactive", "active"]),
}).strict().readonly();

export const reviewAttestationRefSchema = z.object({
  attestation_id: stableIdSchema,
  artifact_sha256: sha256Schema,
  parsed_sha256: sha256Schema,
  source_set_version: z.string().min(1).max(160),
  interval_claim_id: stableIdSchema,
  scope_claim_id: stableIdSchema,
  reviewer_id: z.string().min(1).max(160),
  reviewer_role: z.string().min(1).max(160),
  reviewed_at: legalTimestampSchema,
  status: z.enum(["valid", "invalidated"]),
}).strict().readonly();

export const topicReadinessResultSchema = z.object({
  topic: stableIdSchema,
  valid_on: legalDateSchema,
  known_at: legalTimestampSchema,
  sector: stableIdSchema,
  population: stableIdSchema,
  status: z.enum(["ready", "not_ready"]),
  missing_gates: z.array(z.string().min(1)).readonly(),
  evidence_refs: z.array(legalEvidenceRefSchema).readonly(),
  usable_for_rules: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.status === "ready" && (value.missing_gates.length > 0 || !value.usable_for_rules)) {
    context.addIssue({ code: "custom", message: "ready_topic_requires_no_missing_gates_and_rule_usability" });
  }
}).readonly();

export const ruleExecutionRequestSchema = z.object({
  request_id: stableIdSchema,
  rule_id: stableIdSchema,
  rule_version: z.string().min(1).max(80),
  input_snapshot: ruleInputSnapshotSchema,
  legal_evidence: z.array(legalEvidenceRefSchema).readonly(),
  requested_at: legalTimestampSchema,
  execution_policy_version: z.string().min(1).max(80),
}).strict().readonly();

export const ruleExecutionResultSchema = z.object({
  request_id: stableIdSchema,
  rule_id: stableIdSchema,
  rule_version: z.string().min(1).max(80),
  status: z.enum(["succeeded", "rejected", "cancelled"]),
  trace_id: stableIdSchema.nullable(),
  output_hash: sha256Schema.nullable(),
  rejection_codes: z.array(z.string().min(1)).readonly(),
  completed_at: legalTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.status === "succeeded" && (value.trace_id === null || value.output_hash === null || value.rejection_codes.length > 0)) {
    context.addIssue({ code: "custom", message: "successful_execution_requires_trace_and_hash_without_rejections" });
  }
  if (value.status !== "succeeded" && (value.output_hash !== null || value.rejection_codes.length === 0)) {
    context.addIssue({ code: "custom", message: "non_successful_execution_requires_rejection_without_output" });
  }
}).readonly();

export type RuleInputSnapshot = z.infer<typeof ruleInputSnapshotSchema>;
export type LegalEvidenceRef = z.infer<typeof legalEvidenceRefSchema>;
export type ReviewAttestationRef = z.infer<typeof reviewAttestationRefSchema>;
export type TopicReadinessResult = z.infer<typeof topicReadinessResultSchema>;
export type RuleExecutionRequest = z.infer<typeof ruleExecutionRequestSchema>;
export type RuleExecutionResult = z.infer<typeof ruleExecutionResultSchema>;
