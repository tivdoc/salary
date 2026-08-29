import { z } from "zod";
import { isoDateSchema, isoTimestampSchema } from "../../domain/primitives.ts";
import { sha256Schema } from "../contracts.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@#-]{2,239}$/);

const citationEvidenceSchema = z.object({
  citation_id: stableIdSchema,
  chunk_id: stableIdSchema,
  page_from: z.number().int().positive(),
  page_to: z.number().int().positive(),
  section_identifier: z.string().min(1).max(500),
}).strict().refine((value) => value.page_to >= value.page_from, "citation_interval_inverted");

const candidateIntervalSchema = z.object({
  claim_id: stableIdSchema,
  from: isoDateSchema.nullable(),
  to: isoDateSchema.nullable(),
  verification_state: z.literal("unverified"),
}).strict();

export const minimumWageSourceEvidenceSchema = z.object({
  schema_version: z.literal("tivdoc-minimum-wage-source-evidence-v0.4"),
  as_of: isoTimestampSchema,
  topic: z.literal("minimum_wage"),
  sources: z.array(z.object({
    source_id: z.enum(["IL_MIN_WAGE_LAW", "IL_MIN_WAGE_OFFICIAL_RATES"]),
    source_version_id: stableIdSchema,
    source_role: z.enum([
      "binding_operative_instrument_candidate",
      "official_implementation_corroboration",
    ]),
    artifact_role: z.enum(["official_consolidated_copy", "official_implementation_corroboration"]),
    legal_force: z.enum(["binding", "non_binding"]),
    can_independently_support_monetary_rule_after_review: z.boolean(),
    currently_usable_for_monetary_rule: z.literal(false),
    artifact_id: stableIdSchema,
    artifact_sha256: sha256Schema,
    observed_at: isoTimestampSchema,
    review_state: z.literal("needs_review"),
    activation_state: z.literal("inactive"),
    parsed_version_id: stableIdSchema,
    parsed_sha256: sha256Schema,
    parser_identity: z.object({
      parser_version: z.string().min(1),
      normalizer_version: z.string().min(1),
      chunker_version: z.string().min(1),
    }).strict(),
    citations: z.array(citationEvidenceSchema).min(1),
    candidate_intervals: z.array(candidateIntervalSchema).min(1),
  }).strict()).length(2),
  byte_change_baseline: z.object({
    artifact_sha256: sha256Schema,
    normalized_text_sha256: sha256Schema,
    structure_sha256: sha256Schema,
  }).strict(),
  byte_change_candidates: z.array(z.object({
    artifact_sha256: sha256Schema,
    observed_at: isoTimestampSchema,
    parse_available: z.boolean(),
    normalized_text_sha256: sha256Schema.nullable(),
    structure_sha256: sha256Schema.nullable(),
  }).strict()).length(3),
  unresolved_contradictions: z.array(z.string().min(1)).min(1),
  missing_gates: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, context) => {
  const law = value.sources.find((source) => source.source_id === "IL_MIN_WAGE_LAW");
  const rates = value.sources.find((source) => source.source_id === "IL_MIN_WAGE_OFFICIAL_RATES");
  if (!law || !rates) context.addIssue({ code: "custom", message: "minimum_wage_source_pair_required" });
  if (law && (law.source_role !== "binding_operative_instrument_candidate" || law.legal_force !== "binding")) {
    context.addIssue({ code: "custom", message: "minimum_wage_binding_source_role_mismatch" });
  }
  if (rates && (rates.source_role !== "official_implementation_corroboration"
    || rates.artifact_role !== "official_implementation_corroboration"
    || rates.legal_force !== "non_binding"
    || rates.can_independently_support_monetary_rule_after_review)) {
    context.addIssue({ code: "custom", message: "btl_rates_must_remain_corroborative_only" });
  }
  if (new Set(value.byte_change_candidates.map((candidate) => candidate.artifact_sha256)).size !== 3) {
    context.addIssue({ code: "custom", message: "three_distinct_byte_change_candidates_required" });
  }
}).readonly();

export type MinimumWageSourceEvidence = z.infer<typeof minimumWageSourceEvidenceSchema>;
