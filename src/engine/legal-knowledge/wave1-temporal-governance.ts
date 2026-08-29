import { z } from "zod";
import { legalDateSchema, legalTimestampSchema, sha256Schema } from "./contracts.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);

/** Wave 1 accepts only canonical UTC timestamps so comparisons never depend on a host timezone. */
export const wave1UtcTimestampSchema = legalTimestampSchema.refine(
  (value) => value.endsWith("Z"),
  "wave1_timestamp_must_be_canonical_utc",
);

export const wave1DateIntervalSchema = z.object({
  from: legalDateSchema,
  to: legalDateSchema.nullable(),
}).strict().superRefine((interval, context) => {
  if (interval.to !== null && interval.from > interval.to) {
    context.addIssue({ code: "custom", message: "date_interval_inverted" });
  }
}).readonly();

export const wave1SourceRoleSchema = z.enum([
  "operative_instrument",
  "official_implementation_or_corroboration",
  "secondary_explanation",
  "parliamentary_research",
]);

export const wave1RelationshipTypeSchema = z.enum([
  "amends",
  "supplements",
  "temporarily_overrides",
  "revokes",
]);

/**
 * Relation claims deliberately cannot be marked verified in Wave 1. Real-world
 * relationships require later legal review and therefore stay non-operative.
 */
export const wave1RelationshipClaimSchema = z.object({
  relationship_claim_id: stableIdSchema,
  from_source_version_id: stableIdSchema,
  to_source_version_id: stableIdSchema,
  relationship_type: wave1RelationshipTypeSchema,
  verification_status: z.literal("unverified"),
  recorded_at: wave1UtcTimestampSchema,
}).strict().readonly();

export const wave1TemporalAxesSchema = z.object({
  valid_time: z.object({
    signing_date: legalDateSchema.nullable(),
    publication_date: legalDateSchema.nullable(),
    commencement_date: legalDateSchema.nullable(),
    operative_interval: wave1DateIntervalSchema,
    payroll_reference_period: wave1DateIntervalSchema.nullable(),
  }).strict().readonly(),
  knowledge_time: z.object({
    ingested_at: wave1UtcTimestampSchema,
    reviewed_at: wave1UtcTimestampSchema.nullable(),
    activated_at: wave1UtcTimestampSchema.nullable(),
    invalidated_at: wave1UtcTimestampSchema.nullable(),
  }).strict().superRefine((knowledge, context) => {
    if (knowledge.reviewed_at !== null && knowledge.reviewed_at < knowledge.ingested_at) {
      context.addIssue({ code: "custom", message: "review_precedes_ingestion" });
    }
    if (knowledge.activated_at !== null && knowledge.reviewed_at === null) {
      context.addIssue({ code: "custom", message: "activation_requires_review_time" });
    }
    if (knowledge.activated_at !== null && knowledge.reviewed_at !== null && knowledge.activated_at < knowledge.reviewed_at) {
      context.addIssue({ code: "custom", message: "activation_precedes_review" });
    }
    if (knowledge.invalidated_at !== null && knowledge.invalidated_at < knowledge.ingested_at) {
      context.addIssue({ code: "custom", message: "invalidation_precedes_ingestion" });
    }
  }).readonly(),
}).strict().readonly();

export const wave1BitemporalClaimSchema = z.object({
  claim_id: stableIdSchema,
  source_id: stableIdSchema,
  source_version_id: stableIdSchema,
  topic: stableIdSchema,
  source_role: wave1SourceRoleSchema,
  sectors: z.array(stableIdSchema).min(1).readonly(),
  populations: z.array(stableIdSchema).min(1).readonly(),
  artifact_sha256: sha256Schema,
  parsed_sha256: sha256Schema,
  parser_version: z.string().min(1).max(160),
  citation_id: stableIdSchema,
  interval_claim_id: stableIdSchema,
  scope_claim_id: stableIdSchema,
  temporal: wave1TemporalAxesSchema,
  relationship_claims: z.array(wave1RelationshipClaimSchema).readonly(),
}).strict().readonly();

export const wave1TemporalQuerySchema = z.object({
  topic: stableIdSchema,
  sector: stableIdSchema,
  population: stableIdSchema,
  /** Inclusive civil date used only on the valid-time axis. */
  from: legalDateSchema,
  /** Inclusive, canonical UTC cutoff used only on the knowledge-time axis. */
  as_of: wave1UtcTimestampSchema,
}).strict().readonly();

export const wave1TemporalResolutionSchema = z.object({
  query: wave1TemporalQuerySchema,
  status: z.enum(["candidate_set", "not_resolved", "conflict"]),
  selected_claim_ids: z.array(stableIdSchema).readonly(),
  excluded_claim_ids: z.array(stableIdSchema).readonly(),
  reasons: z.array(z.string().min(1)).readonly(),
  usable_for_rules: z.literal(false),
}).strict().readonly();

export type Wave1BitemporalClaim = z.infer<typeof wave1BitemporalClaimSchema>;
export type Wave1TemporalQuery = z.infer<typeof wave1TemporalQuerySchema>;
export type Wave1TemporalResolution = z.infer<typeof wave1TemporalResolutionSchema>;
export type Wave1SourceRole = z.infer<typeof wave1SourceRoleSchema>;

export const WAVE1_SOURCE_ROLE_POLICY = Object.freeze({
  operative_instrument: Object.freeze({ operative: true, can_independently_support_monetary_rule: true }),
  official_implementation_or_corroboration: Object.freeze({ operative: false, can_independently_support_monetary_rule: false }),
  secondary_explanation: Object.freeze({ operative: false, can_independently_support_monetary_rule: false }),
  parliamentary_research: Object.freeze({ operative: false, can_independently_support_monetary_rule: false }),
} satisfies Record<Wave1SourceRole, Readonly<{ operative: boolean; can_independently_support_monetary_rule: boolean }>>);

function includesDate(interval: z.infer<typeof wave1DateIntervalSchema>, date: string) {
  return interval.from <= date && (interval.to === null || interval.to >= date);
}

/**
 * Resolve only claims that existed at `as_of` and claim applicability at `from`.
 * The function intentionally returns candidates, never active legal conclusions.
 */
export function resolveWave1BitemporalClaims(input: Readonly<{
  claims: readonly Wave1BitemporalClaim[];
  query: Wave1TemporalQuery;
}>): Wave1TemporalResolution {
  const query = wave1TemporalQuerySchema.parse(input.query);
  const claims = input.claims.map((claim) => wave1BitemporalClaimSchema.parse(claim));
  const ordered = [...claims].sort((left, right) => left.claim_id.localeCompare(right.claim_id));
  const topical = ordered.filter((claim) => claim.topic === query.topic);
  const known = topical.filter((claim) => (
    claim.temporal.knowledge_time.ingested_at <= query.as_of
    && (claim.temporal.knowledge_time.invalidated_at === null || claim.temporal.knowledge_time.invalidated_at > query.as_of)
  ));
  const inScope = known.filter((claim) => (
    claim.sectors.includes(query.sector)
    && claim.populations.includes(query.population)
  ));
  const valid = inScope.filter((claim) => includesDate(claim.temporal.valid_time.operative_interval, query.from));
  const selectedIds = valid.map((claim) => claim.claim_id);
  const selected = new Set(selectedIds);
  const excludedIds = topical.filter((claim) => !selected.has(claim.claim_id)).map((claim) => claim.claim_id);

  if (known.length === 0) {
    return wave1TemporalResolutionSchema.parse({
      query,
      status: "not_resolved",
      selected_claim_ids: [],
      excluded_claim_ids: excludedIds,
      reasons: topical.length === 0 ? ["topic_claim_missing"] : ["knowledge_time_gap"],
      usable_for_rules: false,
    });
  }
  if (inScope.length === 0) {
    return wave1TemporalResolutionSchema.parse({
      query,
      status: "not_resolved",
      selected_claim_ids: [],
      excluded_claim_ids: excludedIds,
      reasons: ["scope_gap"],
      usable_for_rules: false,
    });
  }
  if (valid.length === 0) {
    return wave1TemporalResolutionSchema.parse({
      query,
      status: "not_resolved",
      selected_claim_ids: [],
      excluded_claim_ids: excludedIds,
      reasons: ["valid_time_gap"],
      usable_for_rules: false,
    });
  }

  const overlappingVersions = new Set<string>();
  const bySource = new Map<string, Wave1BitemporalClaim[]>();
  for (const claim of valid) bySource.set(claim.source_id, [...(bySource.get(claim.source_id) ?? []), claim]);
  for (const [sourceId, versions] of bySource) {
    if (versions.length > 1) overlappingVersions.add(`overlapping_claims:${sourceId}`);
  }
  if (overlappingVersions.size > 0) {
    return wave1TemporalResolutionSchema.parse({
      query,
      status: "conflict",
      selected_claim_ids: selectedIds,
      excluded_claim_ids: excludedIds,
      reasons: [...overlappingVersions].sort(),
      usable_for_rules: false,
    });
  }

  return wave1TemporalResolutionSchema.parse({
    query,
    status: "candidate_set",
    selected_claim_ids: selectedIds,
    excluded_claim_ids: excludedIds,
    reasons: ["candidate_only_review_and_activation_required"],
    usable_for_rules: false,
  });
}
