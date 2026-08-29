import { z } from "zod";
import {
  legalDateSchema,
  legalSourceTypeSchema,
  legalTimestampSchema,
  sha256Schema,
} from "./contracts.ts";

const officialHttpsUrlSchema = z.string().url().refine((value) => value.startsWith("https://"), "official_url_must_use_https");
const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);

export const acquisitionStateSchema = z.enum(["discovered", "acquired", "quarantined", "unavailable"]);
export const artifactParseStateSchema = z.enum(["not_attempted", "parsed", "failed"]);
export const evidenceStateSchema = z.enum(["incomplete", "ready_for_owner_legal_review"]);
export const candidateReviewStateSchema = z.literal("needs_review");
export const candidateActivationStateSchema = z.literal("inactive");
export const artifactRoleSchema = z.enum([
  "primary_promulgation",
  "official_institutional_copy",
  "official_consolidated_copy",
  "official_guidance",
  "official_implementation_corroboration",
  "officially_published_secondary_research",
  "catalog_discovery_only",
]);
export const acquisitionMethodSchema = z.enum([
  "direct_official_fetch",
  "public_browser_official_download",
  "owner_attested_official_download",
  "existing_immutable_artifact",
]);

export const legalInstrumentSchema = z.object({
  instrument_id: stableIdSchema,
  source_id: stableIdSchema,
  jurisdiction: z.literal("IL"),
  instrument_type: legalSourceTypeSchema,
  title: z.string().min(1),
  legal_force: z.enum(["binding", "non_binding", "unknown"]),
  instrument_issuer: z.string().min(1),
}).strict();

export const legalTextVersionSchema = z.object({
  legal_text_version_id: stableIdSchema,
  instrument_id: stableIdSchema,
  legacy_ingestion_revision: z.string().min(1).nullable(),
  publication_reference: z.string().min(1).nullable(),
  publication_date: legalDateSchema.nullable(),
  consolidation_as_of: z.union([legalDateSchema, z.literal("unknown")]),
  legal_claim_ids: z.array(stableIdSchema),
  evidence_state: evidenceStateSchema,
  review_state: candidateReviewStateSchema,
  activation_state: candidateActivationStateSchema,
}).strict();

export const artifactProvenanceSchema = z.object({
  promulgation_publisher: z.string().min(1),
  artifact_host: z.string().min(1),
  artifact_role: artifactRoleSchema,
  canonicality_status: z.enum([
    "canonical_primary_publication",
    "official_copy_not_primary_promulgation",
    "official_consolidation_date_unknown",
    "discovery_only",
  ]),
  acquisition_method: acquisitionMethodSchema,
}).strict();

export const artifactVersionSchema = z.object({
  artifact_version_id: stableIdSchema,
  source_id: stableIdSchema,
  legal_text_version_id: stableIdSchema.nullable(),
  acquisition_request_id: stableIdSchema.nullable(),
  artifact_sha256: sha256Schema,
  byte_count: z.number().int().positive(),
  media_type: z.string().min(1),
  original_filename: z.string().min(1),
  landing_url: officialHttpsUrlSchema,
  artifact_url: officialHttpsUrlSchema,
  final_url: officialHttpsUrlSchema,
  acquired_at: legalTimestampSchema,
  acquisition_state: z.literal("acquired"),
  parse_state: artifactParseStateSchema,
  evidence_state: evidenceStateSchema,
  review_state: candidateReviewStateSchema,
  activation_state: candidateActivationStateSchema,
  provenance: artifactProvenanceSchema,
}).strict();

export const parsedVersionRecordSchema = z.object({
  parsed_version_id: stableIdSchema,
  artifact_version_id: stableIdSchema,
  parser_name: z.string().min(1),
  parser_version: z.string().min(1),
  normalizer_version: z.string().min(1),
  normalized_text_sha256: sha256Schema,
  chunk_index_sha256: sha256Schema,
}).strict();

export const fetchObservationSchema = z.object({
  observation_id: stableIdSchema,
  source_id: stableIdSchema,
  requested_url: officialHttpsUrlSchema,
  final_url: officialHttpsUrlSchema.nullable(),
  observed_at: legalTimestampSchema,
  http_status: z.number().int().min(100).max(599).nullable(),
  declared_media_type: z.string().nullable(),
  byte_count: z.number().int().nonnegative().nullable(),
  response_sha256: sha256Schema.nullable(),
  acquisition_state: acquisitionStateSchema,
  parse_state: artifactParseStateSchema,
  evidence_state: evidenceStateSchema,
  disposition: z.enum(["legal_artifact_candidate", "not_a_legal_source_version"]),
  safe_error_code: z.string().min(1).nullable(),
}).strict().superRefine((observation, context) => {
  if (observation.disposition === "not_a_legal_source_version") {
    if (observation.acquisition_state !== "quarantined" && observation.acquisition_state !== "unavailable") {
      context.addIssue({ code: "custom", message: "invalid_observation_must_be_quarantined_or_unavailable" });
    }
    if (observation.evidence_state !== "incomplete") context.addIssue({ code: "custom", message: "invalid_observation_evidence_must_be_incomplete" });
  }
  if (observation.disposition === "legal_artifact_candidate" && observation.acquisition_state !== "acquired") {
    context.addIssue({ code: "custom", message: "candidate_observation_must_be_acquired" });
  }
});

export const catalogObservationSchema = z.object({
  catalog_observation_id: stableIdSchema,
  catalog_id: stableIdSchema,
  canonical_url: officialHttpsUrlSchema,
  observed_at: legalTimestampSchema,
  acquisition_method: z.enum(["direct_official_fetch", "public_browser_visible_navigation"]),
  status: z.enum(["complete", "partial", "unavailable"]),
  query: z.record(z.string(), z.string()),
  result_count_reported: z.number().int().nonnegative().nullable(),
  entries_observed: z.array(z.object({
    entry_id: stableIdSchema,
    title: z.string().min(1),
    artifact_url: officialHttpsUrlSchema.nullable(),
  }).strict()),
  pagination: z.object({ pages_observed: z.number().int().nonnegative(), pages_reported: z.number().int().nonnegative().nullable() }).strict(),
  safe_error_code: z.string().min(1).nullable(),
  discovery_only: z.literal(true),
}).strict().superRefine((observation, context) => {
  if (observation.status === "complete") {
    if (observation.result_count_reported === null || observation.entries_observed.length !== observation.result_count_reported) {
      context.addIssue({ code: "custom", message: "complete_catalog_count_mismatch" });
    }
    if (observation.pagination.pages_reported === null || observation.pagination.pages_observed !== observation.pagination.pages_reported) {
      context.addIssue({ code: "custom", message: "complete_catalog_pagination_mismatch" });
    }
  }
  if (observation.status === "unavailable" && observation.entries_observed.length !== 0) {
    context.addIssue({ code: "custom", message: "unavailable_catalog_must_not_contain_entries" });
  }
});

export const legalClaimSchema = z.object({
  legal_claim_id: stableIdSchema,
  subject_id: stableIdSchema,
  claim_type: z.enum(["authority", "effective_date", "scope", "relation", "canonicality"]),
  claim_status: z.literal("unverified"),
  value: z.string().min(1),
  evidence_locator: z.string().min(1),
}).strict();

export const humanReviewEventV02Schema = z.object({
  event_id: stableIdSchema,
  actor_id: z.string().min(1),
  actor_type: z.literal("human"),
  occurred_at: legalTimestampSchema,
  decision: z.enum(["reviewed", "rejected", "activated"]),
  reason: z.string().min(1),
  artifact_sha256: sha256Schema,
  effective_from: legalDateSchema.nullable(),
  effective_to: legalDateSchema.nullable(),
}).strict();

export const acquisitionReceiptSchema = z.object({
  acquisition_request_id: stableIdSchema,
  source_id: stableIdSchema,
  original_filename: z.string().regex(/^[^\\/:*?"<>|]{1,180}$/),
  landing_url: officialHttpsUrlSchema,
  artifact_url: officialHttpsUrlSchema,
  final_url: officialHttpsUrlSchema,
  acquired_at: legalTimestampSchema,
  actor_type: z.literal("owner"),
  acquisition_method: z.literal("owner_attested_official_download"),
  unchanged_original: z.literal(true),
  used_print_to_pdf: z.literal(false),
}).strict();

export const acquisitionRequestSchema = z.object({
  acquisition_request_id: stableIdSchema,
  source_id: stableIdSchema,
  instrument_id: stableIdSchema,
  canonical_landing_url: officialHttpsUrlSchema,
  artifact_url: officialHttpsUrlSchema.nullable(),
  allowlisted_hosts: z.array(z.string().min(1)).min(1),
  expected_document_title: z.string().min(1),
  recommended_filename: z.string().regex(/^[^\\/:*?"<>|]{1,180}$/),
  failure_evidence: z.array(z.object({ stage: z.enum(["fetch", "browser"]), safe_error_code: z.string().min(1) }).strict()),
  receipt_template: acquisitionReceiptSchema.partial({
    original_filename: true,
    artifact_url: true,
    final_url: true,
    acquired_at: true,
  }),
}).strict();

export type AcquisitionReceipt = z.infer<typeof acquisitionReceiptSchema>;
export type AcquisitionRequest = z.infer<typeof acquisitionRequestSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
