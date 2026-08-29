import { z } from "zod";
import { legalSectorSchema, legalTopicSchema } from "./taxonomy.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "invalid_calendar_date");
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const legalSourceTypeSchema = z.enum([
  "statute",
  "regulation",
  "extension_order",
  "official_guidance",
  "official_rate_table",
  "case_law",
  "secondary_reference",
]);

export const legalAuthorityKindSchema = z.enum([
  "israeli_legislature",
  "ministry_of_labor",
  "national_insurance_institute",
  "tax_authority",
  "judiciary",
  "other_government_authority",
  "secondary_professional_source",
]);

export const bindingLevelSchema = z.enum([
  "primary_binding",
  "official_implementation",
  "official_guidance",
  "secondary_explanatory",
]);

export const courtLevelSchema = z.enum([
  "supreme_court",
  "national_labor_court",
  "district_court",
  "regional_labor_court",
  "magistrates_court",
  "other",
]).nullable();

export const legalAuthoritySchema = z.object({
  kind: legalAuthorityKindSchema,
  issuing_body: z.string().min(1),
  binding_level: bindingLevelSchema,
  court_level: courtLevelSchema.default(null),
  scope: z.enum(["general", "sector_specific", "case_specific"]),
  operative: z.boolean(),
  explanatory: z.boolean(),
  contains_numeric_rate: z.boolean(),
  can_independently_support_monetary_rule: z.boolean(),
}).superRefine((authority, context) => {
  if (authority.binding_level === "secondary_explanatory" && authority.can_independently_support_monetary_rule) {
    context.addIssue({ code: "custom", message: "secondary_authority_cannot_support_monetary_rule" });
  }
  if (authority.kind === "secondary_professional_source" && authority.binding_level !== "secondary_explanatory") {
    context.addIssue({ code: "custom", message: "secondary_source_binding_level_invalid" });
  }
});

export const applicabilityBasisSchema = z.enum([
  "work_date",
  "salary_month",
  "payment_date",
  "employment_start_date",
  "employment_end_date",
  "entitlement_year",
  "termination_date",
  "publication_only",
  "explanatory_as_of",
  "requires_historical_version_review",
]);

export const effectivePeriodSchema = z.object({
  effective_from: dateSchema.nullable(),
  effective_to: dateSchema.nullable(),
  retroactive: z.boolean(),
  retroactive_basis: z.string().nullable(),
  applicability_basis: applicabilityBasisSchema,
}).superRefine((period, context) => {
  if (period.effective_from && period.effective_to && period.effective_from > period.effective_to) {
    context.addIssue({ code: "custom", message: "effective_period_inverted" });
  }
  if (period.retroactive && !period.retroactive_basis) {
    context.addIssue({ code: "custom", message: "retroactive_basis_required" });
  }
});

export const sourceVerificationSchema = z.object({
  status: z.enum(["unverified", "domain_verified", "content_verified", "dual_verified"]),
  method: z.string().min(1),
  verified_by: z.array(z.string().min(1)),
  verified_at: timestampSchema.nullable(),
  notes: z.array(z.string()),
}).superRefine((verification, context) => {
  if (verification.status !== "unverified" && (!verification.verified_at || verification.verified_by.length === 0)) {
    context.addIssue({ code: "custom", message: "verification_evidence_required" });
  }
  if (verification.status === "dual_verified" && new Set(verification.verified_by).size < 2) {
    context.addIssue({ code: "custom", message: "dual_verification_requires_two_reviewers" });
  }
});

export const legalSourceStatusSchema = z.enum([
  "draft",
  "verified",
  "active",
  "superseded",
  "needs_review",
  "rejected",
]);

export const legalSourceSchema = z.object({
  source_id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,79}$/),
  source_version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
  source_type: legalSourceTypeSchema,
  authority: legalAuthoritySchema,
  jurisdiction: z.literal("IL"),
  title: z.string().min(1),
  canonical_url: z.string().url().refine((value) => value.startsWith("https://"), "canonical_url_must_use_https"),
  publication_reference: z.string().nullable(),
  published_at: dateSchema.nullable(),
  effective_from: dateSchema.nullable(),
  effective_to: dateSchema.nullable(),
  retrieved_at: timestampSchema.nullable(),
  language: z.enum(["he", "ar", "en"]),
  topics: z.array(legalTopicSchema).min(1),
  sectors: z.array(legalSectorSchema).min(1),
  status: legalSourceStatusSchema,
  content_sha256: sha256Schema.nullable(),
  artifact_format: z.enum(["html", "pdf", "text", "table"]),
  supersedes_source_version: z.string().nullable(),
  notes: z.array(z.string()),
  verification: sourceVerificationSchema,
  effective_period: effectivePeriodSchema,
  discovery: z.object({
    method: z.enum(["official_registry", "official_domain_search", "official_cross_reference"]),
    found_at: dateSchema,
    included_reason: z.string().min(1),
  }),
}).superRefine((source, context) => {
  if (source.effective_from !== source.effective_period.effective_from || source.effective_to !== source.effective_period.effective_to) {
    context.addIssue({ code: "custom", message: "effective_period_fields_disagree" });
  }
  if (source.source_type === "case_law" && (source.authority.kind !== "judiciary" || !source.authority.court_level)) {
    context.addIssue({ code: "custom", message: "case_law_judicial_authority_required" });
  }
  if (source.source_type === "secondary_reference" && source.authority.binding_level !== "secondary_explanatory") {
    context.addIssue({ code: "custom", message: "secondary_reference_binding_level_invalid" });
  }
  if (source.status === "active") {
    if (!source.content_sha256) context.addIssue({ code: "custom", message: "active_source_content_hash_required" });
    if (!source.retrieved_at) context.addIssue({ code: "custom", message: "active_source_retrieval_timestamp_required" });
    if (!source.authority.issuing_body) context.addIssue({ code: "custom", message: "active_source_authority_required" });
    if (!source.canonical_url) context.addIssue({ code: "custom", message: "active_source_canonical_url_required" });
    if (source.authority.operative && !source.effective_from) {
      context.addIssue({ code: "custom", message: "active_operative_source_effective_date_required" });
    } else if (!source.effective_from && !["publication_only", "explanatory_as_of"].includes(source.effective_period.applicability_basis)) {
      context.addIssue({ code: "custom", message: "active_operative_source_effective_treatment_required" });
    }
    if (!source.verification.verified_at || !["content_verified", "dual_verified"].includes(source.verification.status)) {
      context.addIssue({ code: "custom", message: "active_source_content_verification_required" });
    }
  }
});

const safeHttpMetadataSchema = z.record(z.string(), z.string()).superRefine((metadata, context) => {
  const safeNames = new Set(["content-type", "content-length", "etag", "last-modified"]);
  for (const name of Object.keys(metadata)) {
    if (!safeNames.has(name.toLowerCase())) context.addIssue({ code: "custom", message: `unsafe_http_metadata:${name}` });
  }
});

export const legalArtifactSchema = z.object({
  source_id: z.string(),
  source_version: z.string(),
  artifact_sha256: sha256Schema,
  final_url: z.string().url().refine((value) => value.startsWith("https://"), "final_url_must_use_https"),
  content_type: z.string(),
  byte_count: z.number().int().nonnegative(),
  retrieved_at: timestampSchema,
  parser_version: z.string(),
  normalized_text_sha256: sha256Schema.nullable(),
  parse_status: z.enum(["pending", "parsed", "parse_failed", "unsupported"]),
  safe_error_code: z.string().nullable(),
  safe_http_metadata: safeHttpMetadataSchema,
});

export const legalChunkSchema = z.object({
  chunk_id: z.string(),
  source_id: z.string(),
  source_version: z.string(),
  artifact_sha256: sha256Schema,
  section_identifier: z.string(),
  heading_path: z.array(z.string()),
  page_from: z.number().int().positive().nullable(),
  page_to: z.number().int().positive().nullable(),
  character_from: z.number().int().nonnegative(),
  character_to: z.number().int().nonnegative(),
  text: z.string().min(1),
  chunk_text_sha256: sha256Schema,
  topics: z.array(legalTopicSchema).min(1),
  sectors: z.array(legalSectorSchema).min(1),
  effective_period: effectivePeriodSchema,
  authority: legalAuthoritySchema,
}).superRefine((chunk, context) => {
  if (chunk.character_to < chunk.character_from) context.addIssue({ code: "custom", message: "chunk_character_range_inverted" });
  if ((chunk.page_from === null) !== (chunk.page_to === null)) context.addIssue({ code: "custom", message: "chunk_page_range_incomplete" });
  if (chunk.page_from && chunk.page_to && chunk.page_to < chunk.page_from) context.addIssue({ code: "custom", message: "chunk_page_range_inverted" });
});

export const legalCitationSchema = z.object({
  source_id: z.string(),
  source_version: z.string(),
  title: z.string(),
  authority: legalAuthoritySchema,
  canonical_url: z.string().url().refine((value) => value.startsWith("https://"), "citation_url_must_use_https"),
  section_or_clause: z.string(),
  page: z.number().int().positive().nullable(),
  effective_period: effectivePeriodSchema,
  retrieved_at: timestampSchema,
  supporting_chunk_ids: z.array(z.string()).min(1).refine((values) => new Set(values).size === values.length, "citation_chunk_ids_must_be_unique"),
  excerpt: z.string().max(280).nullable(),
});

export const legalParameterStatusSchema = z.enum(["candidate", "verified", "active", "superseded", "rejected"]);
export const legalParameterSchema = z.object({
  parameter_id: z.string(),
  source_id: z.string(),
  source_version: z.string(),
  citation: legalCitationSchema,
  effective_period: effectivePeriodSchema,
  unit: z.enum(["ils", "ils_per_day", "ils_per_hour", "percentage", "multiplier", "days", "months"]),
  value: z.object({ normalized_decimal: z.string().regex(/^-?\d+(?:\.\d+)?$/), source_representation_hash: sha256Schema }),
  sector: legalSectorSchema,
  applicability_conditions: z.array(z.string()),
  extraction_method: z.enum(["manual", "deterministic_table", "deterministic_text"]),
  verification_status: legalParameterStatusSchema,
  verified_by: z.array(z.string()),
});

export const caseLawRecordSchema = z.object({
  case_identifier: z.string(),
  court: z.string(),
  court_level: courtLevelSchema,
  decided_at: dateSchema,
  parties: z.array(z.string()).nullable(),
  topics: z.array(legalTopicSchema),
  facts_summary: z.string(),
  legal_question: z.string(),
  holding: z.string(),
  reasoning: z.string(),
  cited_source_ids: z.array(z.string()),
  precedential_weight: z.enum(["binding", "persuasive", "limited", "unknown"]),
  source_url: z.string().url().refine((value) => value.startsWith("https://"), "case_law_url_must_use_https"),
  judgment_sha256: sha256Schema,
  verification_status: z.enum(["unverified", "verified", "rejected"]),
  summary_method: z.enum(["manual", "court_supplied", "ai_candidate"]),
}).superRefine((record, context) => {
  if (record.summary_method === "ai_candidate" && record.verification_status === "verified") {
    context.addIssue({ code: "custom", message: "ai_summary_cannot_be_verified_holding" });
  }
});

export type LegalSource = z.infer<typeof legalSourceSchema>;
export type LegalAuthority = z.infer<typeof legalAuthoritySchema>;
export type EffectivePeriod = z.infer<typeof effectivePeriodSchema>;
export type LegalChunk = z.infer<typeof legalChunkSchema>;
export type LegalCitation = z.infer<typeof legalCitationSchema>;
export type LegalParameter = z.infer<typeof legalParameterSchema>;
