// V0.10.3 legal review operations contracts.
//
// This is the internal reviewer workflow, not a legal determination: nothing
// here activates a source, produces a parameter value, or reaches a customer.
// Scope, citation and authority shapes are reused from legal-knowledge so the
// review record binds the same immutable bytes the corpus already pins.

import { z } from "zod";

import { effectivePeriodSchema, legalCitationSchema } from "../legal-knowledge/contracts.ts";
import { legalSectorSchema, legalTopicSchema } from "../legal-knowledge/taxonomy.ts";
import { legalOperationsIdSchema, legalOperationsSha256Schema, nonEmptyTextSchema } from "../legal-operations/contracts.ts";

export const LEGAL_REVIEW_SCHEMA_VERSION = "tivdoc-legal-review-v0.10.3" as const;

/** Explicit, closed review lifecycle. Unknown values fail closed. */
export const legalReviewStateSchema = z.enum([
  "pending_review",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "superseded",
]);

export const legalReviewerRoleSchema = z.enum([
  "legal_reviewer",
  "senior_legal_reviewer",
  "legal_reviewer_observer",
]);

export const legalReviewDecisionSchema = z.enum([
  "claim",
  "request_changes",
  "approve",
  "reject",
  "supersede",
]);

/**
 * Everything the packet identity is derived from. Any change to these bytes is
 * a different packet, which is what stops a decision from silently carrying
 * over to changed evidence.
 */
export const legalReviewPacketBindingSchema = z.object({
  schema_version: z.literal(LEGAL_REVIEW_SCHEMA_VERSION),
  source_id: legalOperationsIdSchema,
  source_version_id: legalOperationsIdSchema,
  manifest_sha256: legalOperationsSha256Schema,
  raw_artifact_sha256: legalOperationsSha256Schema,
  normalized_text_sha256: legalOperationsSha256Schema,
  parser_version: nonEmptyTextSchema,
  normalizer_version: nonEmptyTextSchema,
}).strict().readonly();

/** Applicable sector/population/effective-period scope under review. */
export const legalReviewScopeSchema = z.object({
  topic: legalTopicSchema,
  sectors: z.array(legalSectorSchema).min(1).max(32)
    .refine((values) => new Set(values).size === values.length, "legal_review_scope_duplicate_sector")
    .readonly(),
  applicability: z.enum(["general", "sector_specific"]),
  population_constraints: z.array(nonEmptyTextSchema).max(32)
    .refine((values) => new Set(values).size === values.length, "legal_review_scope_duplicate_population")
    .readonly(),
  effective_period: effectivePeriodSchema,
  period_certainty: z.enum(["known", "unknown_or_disputed"]),
}).strict().superRefine((scope, context) => {
  if (scope.applicability === "general" && !scope.sectors.includes("general")) {
    context.addIssue({ code: "custom", message: "legal_review_general_scope_requires_general_sector" });
  }
  if (scope.period_certainty === "known"
    && scope.effective_period.effective_from === null
    && scope.effective_period.effective_to === null) {
    context.addIssue({ code: "custom", message: "legal_review_known_period_requires_a_bound" });
  }
}).readonly();

export const legalReviewPacketSchema = z.object({
  schema_version: z.literal(LEGAL_REVIEW_SCHEMA_VERSION),
  packet_id: legalOperationsIdSchema,
  packet_sha256: legalOperationsSha256Schema,
  binding: legalReviewPacketBindingSchema,
  scope: legalReviewScopeSchema,
  citations: z.array(legalCitationSchema).min(1).max(200).readonly(),
  state: legalReviewStateSchema,
  revision: z.number().int().positive(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
}).strict().readonly();

/**
 * Human attestation for a review action. Both fields are required for any
 * decision that changes state; their absence is an explicit blocked outcome
 * rather than a silently unsigned decision.
 */
export const legalReviewAttestationSchema = z.object({
  actor_id: legalOperationsIdSchema.nullable(),
  signature_sha256: legalOperationsSha256Schema.nullable(),
}).strict().readonly();

export const legalReviewActionSchema = z.object({
  schema_version: z.literal(LEGAL_REVIEW_SCHEMA_VERSION),
  action_id: legalOperationsIdSchema,
  packet_id: legalOperationsIdSchema,
  packet_sha256: legalOperationsSha256Schema,
  expected_revision: z.number().int().positive(),
  decision: legalReviewDecisionSchema,
  actor_role: legalReviewerRoleSchema,
  attestation: legalReviewAttestationSchema,
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/u),
  reason: nonEmptyTextSchema,
  cited_chunk_ids: z.array(nonEmptyTextSchema).max(200)
    .refine((values) => new Set(values).size === values.length, "legal_review_action_duplicate_citation")
    .readonly(),
  occurred_at: z.iso.datetime({ offset: true }),
}).strict().readonly();

export const legalReviewQueueEntrySchema = z.object({
  packet_id: legalOperationsIdSchema,
  packet_sha256: legalOperationsSha256Schema,
  state: legalReviewStateSchema,
  priority: z.number().int().min(0).max(999),
  enqueued_at: z.iso.datetime({ offset: true }),
}).strict().readonly();

export type LegalReviewState = z.infer<typeof legalReviewStateSchema>;
export type LegalReviewerRole = z.infer<typeof legalReviewerRoleSchema>;
export type LegalReviewDecision = z.infer<typeof legalReviewDecisionSchema>;
export type LegalReviewPacketBinding = z.infer<typeof legalReviewPacketBindingSchema>;
export type LegalReviewScope = z.infer<typeof legalReviewScopeSchema>;
export type LegalReviewPacket = z.infer<typeof legalReviewPacketSchema>;
export type LegalReviewAction = z.infer<typeof legalReviewActionSchema>;
export type LegalReviewQueueEntry = z.infer<typeof legalReviewQueueEntrySchema>;

export type LegalReviewErrorCode =
  | "LEGAL_REVIEW_PACKET_INVALID"
  | "LEGAL_REVIEW_ACTION_INVALID"
  | "LEGAL_REVIEW_STALE_REVISION"
  | "LEGAL_REVIEW_PACKET_IDENTITY_CHANGED"
  | "LEGAL_REVIEW_TRANSITION_FORBIDDEN"
  | "LEGAL_REVIEW_TERMINAL_STATE"
  | "LEGAL_REVIEW_HUMAN_ATTESTATION_BLOCKED"
  | "LEGAL_REVIEW_ROLE_NOT_PERMITTED"
  | "LEGAL_REVIEW_CITATION_NOT_IN_PACKET"
  | "LEGAL_REVIEW_MONETARY_AUTHORITY_INSUFFICIENT"
  | "LEGAL_REVIEW_ACTION_CONFLICT"
  | "LEGAL_REVIEW_QUEUE_BOUND_EXCEEDED";

export class LegalReviewError extends Error {
  readonly code: LegalReviewErrorCode;

  constructor(code: LegalReviewErrorCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "LegalReviewError";
    this.code = code;
  }
}
