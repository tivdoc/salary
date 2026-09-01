import { z } from "zod";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";

const id = z.string().regex(/^[a-z][a-z0-9:._-]{2,159}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });

export const shadowFieldSnapshotSchema = z.object({
  field_id: id,
  value_fingerprint: sha,
  state: z.enum(["complete", "blocked", "uncertain", "error"]),
  uncertainty: z.enum(["none", "low", "high", "unknown"]),
  blocker_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,95}$/u)).max(16).readonly(),
}).strict().readonly();

export const shadowTopicSnapshotSchema = z.object({
  topic: z.enum(WAVE3_TOPICS),
  fields: z.array(shadowFieldSnapshotSchema).min(1).max(128).readonly(),
}).strict().superRefine((value, context) => {
  if (new Set(value.fields.map((field) => field.field_id)).size !== value.fields.length) {
    context.addIssue({ code: "custom", message: "SHADOW_DUPLICATE_FIELD_ID", path: ["fields"] });
  }
}).readonly();

const snapshotContentObjectSchema = z.object({
  schema_version: z.literal("tivdoc-shadow-evaluation-snapshot-v0.10.0"),
  snapshot_id: id,
  engine_version_pin: id,
  topics: z.array(shadowTopicSnapshotSchema).length(7).readonly(),
  monetary_output_count: z.literal(0),
  finding_count: z.literal(0),
  customer_report_count: z.literal(0),
  raw_document_count: z.literal(0),
}).strict();

const snapshotContentSchema = snapshotContentObjectSchema.superRefine((value, context) => {
  if (new Set(value.topics.map((topic) => topic.topic)).size !== WAVE3_TOPICS.length
    || WAVE3_TOPICS.some((topic) => !value.topics.some((candidate) => candidate.topic === topic))) {
    context.addIssue({ code: "custom", message: "SHADOW_EXACT_SEVEN_TOPICS_REQUIRED", path: ["topics"] });
  }
}).readonly();

export const shadowEvaluationSnapshotSchema = z.object({
  ...snapshotContentObjectSchema.shape,
  snapshot_sha256: sha,
}).strict().superRefine((value, context) => {
  const { snapshot_sha256: expected, ...content } = value;
  if (canonicalSha256(content) !== expected) context.addIssue({ code: "custom", message: "SHADOW_SNAPSHOT_HASH_MISMATCH" });
}).readonly();

export type ShadowEvaluationSnapshot = z.infer<typeof shadowEvaluationSnapshotSchema>;

export function createShadowEvaluationSnapshot(input: z.input<typeof snapshotContentSchema>): ShadowEvaluationSnapshot {
  const parsed = snapshotContentSchema.parse(input);
  const content = {
    ...parsed,
    topics: [...parsed.topics]
      .sort((left, right) => WAVE3_TOPICS.indexOf(left.topic) - WAVE3_TOPICS.indexOf(right.topic))
      .map((topic) => ({ ...topic, fields: [...topic.fields].sort((left, right) => left.field_id.localeCompare(right.field_id, "en")) })),
  };
  return deepFreeze(shadowEvaluationSnapshotSchema.parse({ ...content, snapshot_sha256: canonicalSha256(content) })) as ShadowEvaluationSnapshot;
}

const thresholdContentObjectSchema = z.object({
  schema_version: z.literal("tivdoc-shadow-threshold-policy-v0.10.0"),
  threshold_version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u),
  max_regressions: z.number().int().min(0).max(100),
  max_uncertainty_increases: z.number().int().min(0).max(100),
  max_changed_fields: z.number().int().min(0).max(10_000),
  blocked_removal_requires_review: z.literal(true),
  automatic_promotion_allowed: z.literal(false),
}).strict();

const thresholdContentSchema = thresholdContentObjectSchema.readonly();

export const shadowThresholdPolicySchema = z.object({
  ...thresholdContentObjectSchema.shape,
  policy_sha256: sha,
}).strict().superRefine((value, context) => {
  const { policy_sha256: expected, ...content } = value;
  if (canonicalSha256(content) !== expected) context.addIssue({ code: "custom", message: "SHADOW_THRESHOLD_HASH_MISMATCH" });
}).readonly();

export type ShadowThresholdPolicy = z.infer<typeof shadowThresholdPolicySchema>;

export function createShadowThresholdPolicy(input: z.input<typeof thresholdContentSchema>): ShadowThresholdPolicy {
  const content = thresholdContentSchema.parse(input);
  return deepFreeze(shadowThresholdPolicySchema.parse({ ...content, policy_sha256: canonicalSha256(content) })) as ShadowThresholdPolicy;
}

export type ShadowFieldDelta = Readonly<{
  topic: (typeof WAVE3_TOPICS)[number];
  field_id: string;
  baseline_fingerprint: string | null;
  candidate_fingerprint: string | null;
  baseline_state: "complete" | "blocked" | "uncertain" | "error" | "missing";
  candidate_state: "complete" | "blocked" | "uncertain" | "error" | "missing";
  baseline_uncertainty: "none" | "low" | "high" | "unknown" | "missing";
  candidate_uncertainty: "none" | "low" | "high" | "unknown" | "missing";
  regression: boolean;
  uncertainty_change: "stable" | "increased" | "decreased";
  blocked_state_change: "stable" | "added" | "removed";
  taxonomy: "stable" | "changed" | "regression" | "improvement" | "uncertainty_increased" | "uncertainty_decreased" | "blocked_added" | "blocked_removed";
  delta_sha256: string;
}>;

export type ShadowComparison = Readonly<{
  schema_version: "tivdoc-shadow-comparison-v0.10.0";
  comparison_id: string;
  baseline_snapshot_sha256: string;
  baseline_approval_receipt_sha256: string;
  candidate_snapshot_sha256: string;
  threshold_policy_sha256: string;
  topic_deltas: readonly Readonly<{
    topic: (typeof WAVE3_TOPICS)[number];
    field_deltas: readonly ShadowFieldDelta[];
    regression_count: number;
    uncertainty_increase_count: number;
    changed_field_count: number;
    requires_human_review: boolean;
    topic_sha256: string;
  }>[];
  totals: Readonly<{
    regressions: number;
    uncertainty_increases: number;
    changed_fields: number;
    blocked_state_changes: number;
  }>;
  non_degradation: "passed" | "failed" | "manual_review";
  human_review_required: true;
  automatic_customer_promotion: false;
  automatic_production_promotion: false;
  comparison_sha256: string;
}>;

const shadowDisagreementDecisionContentObjectSchema = z.object({
  schema_version: z.literal("tivdoc-shadow-disagreement-decision-v0.10.0"),
  disagreement_id: id,
  disagreement_revision: z.number().int().positive(),
  comparison_sha256: sha,
  threshold_policy_sha256: sha,
  decision: z.enum(["resolved", "rejected"]),
  resolution_code: z.enum(["CANDIDATE_REJECTED", "BASELINE_CONFIRMED", "FALSE_POSITIVE_CONFIRMED", "REQUIRES_THRESHOLD_REVISION"]),
  reviewer_id: id,
  reviewer_key_id: id,
  signed_at: timestamp,
  automatic_customer_promotion: z.literal(false),
  automatic_production_promotion: z.literal(false),
}).strict();

export const shadowDisagreementDecisionContentSchema = shadowDisagreementDecisionContentObjectSchema.readonly();

export const signedShadowDisagreementDecisionSchema = z.object({
  ...shadowDisagreementDecisionContentObjectSchema.shape,
  payload_sha256: sha,
  signature_algorithm: z.literal("ed25519"),
  signature_base64: z.string().regex(/^[A-Za-z0-9+/]{80,100}={0,2}$/u),
}).strict().readonly();

export type SignedShadowDisagreementDecision = z.infer<typeof signedShadowDisagreementDecisionSchema>;

export function shadowDecisionPayload(input: z.input<typeof shadowDisagreementDecisionContentSchema>) {
  const content = shadowDisagreementDecisionContentSchema.parse(input);
  return Object.freeze({ content, payload_sha256: canonicalSha256(content), bytes: new TextEncoder().encode(canonicalStringify(content)) });
}
