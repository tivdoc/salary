import { z } from "zod";
import {
  legalEvidenceRefSchema,
  topicReadinessResultSchema,
  type TopicReadinessResult,
} from "../wave1/contracts.ts";
import {
  detectWave1AttestationInvalidations,
  wave1ReviewAttestationSchema,
  wave1ReviewBindingSchema,
} from "./wave1-review-governance.ts";
import {
  wave1DateIntervalSchema,
  wave1SourceRoleSchema,
  wave1TemporalQuerySchema,
  wave1UtcTimestampSchema,
} from "./wave1-temporal-governance.ts";
import { evaluateLegalReadiness, type LegalReadinessCandidate } from "./canonical-readiness/evaluate-legal-readiness.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);

export const wave1TopicEvidenceSchema = z.object({
  evidence_ref: legalEvidenceRefSchema,
  topic: stableIdSchema,
  source_role: wave1SourceRoleSchema,
  catalog_entry_id: stableIdSchema.nullable(),
  valid_time: wave1DateIntervalSchema,
  sectors: z.array(stableIdSchema).min(1).readonly(),
  populations: z.array(stableIdSchema).min(1).readonly(),
  ingested_at: wave1UtcTimestampSchema,
  effective_claim_id: stableIdSchema.nullable(),
  scope_claim_id: stableIdSchema.nullable(),
  review_attestation: wave1ReviewAttestationSchema.nullable(),
  current_review_binding: wave1ReviewBindingSchema.nullable(),
  review_invalidations: z.array(z.string().min(1)).readonly(),
}).strict().readonly();

export const wave1TopicReadinessQuerySchema = wave1TemporalQuerySchema.unwrap().extend({
  required_source_roles: z.array(wave1SourceRoleSchema).min(1).readonly(),
  use_case: z.enum(["monetary_rule", "non_monetary_review"]),
}).strict().readonly();

export type Wave1TopicEvidence = z.infer<typeof wave1TopicEvidenceSchema>;
export type Wave1TopicReadinessQuery = z.infer<typeof wave1TopicReadinessQuerySchema>;

function includesDate(interval: z.infer<typeof wave1DateIntervalSchema>, date: string) {
  return interval.from <= date && (interval.to === null || interval.to >= date);
}

function missingCandidateGates(candidate: Wave1TopicEvidence, knownAt: string) {
  const version = candidate.evidence_ref.source_version_id;
  const missing: string[] = [];
  if (candidate.catalog_entry_id === null) missing.push(`catalog_missing:${version}`);
  if (candidate.evidence_ref.parsed_version_id === null) missing.push(`parse_missing:${version}`);
  if (candidate.evidence_ref.citation_id === null) missing.push(`citation_missing:${version}`);
  if (candidate.effective_claim_id === null) missing.push(`effective_claim_missing:${version}`);
  if (candidate.scope_claim_id === null) missing.push(`scope_claim_missing:${version}`);
  const attestation = candidate.review_attestation;
  const currentBinding = candidate.current_review_binding;
  const detectedInvalidations = attestation !== null && currentBinding !== null
    ? detectWave1AttestationInvalidations(attestation, currentBinding)
    : [];
  if (
    candidate.evidence_ref.review_state !== "reviewed"
    || attestation === null
    || currentBinding === null
    || attestation.ref.status !== "valid"
    || attestation.ref.reviewed_at > knownAt
    || attestation.ref.artifact_sha256 !== candidate.evidence_ref.artifact_sha256
    || attestation.ref.interval_claim_id !== candidate.effective_claim_id
    || attestation.ref.scope_claim_id !== candidate.scope_claim_id
    || detectedInvalidations.length > 0
    || candidate.review_invalidations.length > 0
  ) {
    missing.push(`review_missing:${version}`);
  }
  if (candidate.evidence_ref.activation_state !== "active") missing.push(`activation_missing:${version}`);
  return missing;
}

/** @deprecated Legacy evidence diagnostics are formatted here; evaluateLegalReadiness is the sole decision source. */
export function evaluateWave1TopicReadiness(input: Readonly<{
  query: Wave1TopicReadinessQuery;
  evidence: readonly Wave1TopicEvidence[];
}>): TopicReadinessResult {
  const query = wave1TopicReadinessQuerySchema.parse(input.query);
  const evidence = input.evidence.map((candidate) => wave1TopicEvidenceSchema.parse(candidate));
  const known = evidence.filter((candidate) => candidate.topic === query.topic && candidate.ingested_at <= query.as_of);
  const applicable = known.filter((candidate) => (
    includesDate(candidate.valid_time, query.from)
    && candidate.sectors.includes(query.sector)
    && candidate.populations.includes(query.population)
  ));
  const missing = new Set<string>();
  const selectedCandidates: Wave1TopicEvidence[] = [];
  const rolesToCheck = new Set(query.required_source_roles);
  if (query.use_case === "monetary_rule") rolesToCheck.add("operative_instrument");

  for (const role of rolesToCheck) {
    const roleCandidates = applicable
      .filter((candidate) => candidate.source_role === role)
      .sort((left, right) => left.evidence_ref.source_version_id.localeCompare(right.evidence_ref.source_version_id));
    if (roleCandidates.length === 0) {
      missing.add(`source_role_missing:${role}`);
      continue;
    }
    const candidateGateSets = roleCandidates.map((candidate) => missingCandidateGates(candidate, query.as_of));
    const completeIndex = candidateGateSets.findIndex((gates) => gates.length === 0);
    if (completeIndex >= 0) selectedCandidates.push(roleCandidates[completeIndex]);
    else {
      for (const gate of candidateGateSets.flat()) missing.add(gate);
    }
  }

  if (known.length === 0) missing.add("catalog_missing:topic");
  else if (applicable.length === 0) {
    if (!known.some((candidate) => includesDate(candidate.valid_time, query.from))) missing.add("effective_claim_missing:topic_date");
    else missing.add("scope_claim_missing:topic_scope");
  }

  if (query.use_case === "monetary_rule") {
    const operative = applicable.filter((candidate) => candidate.source_role === "operative_instrument");
    if (operative.length === 0) missing.add("operative_instrument_required_for_monetary_rule");
    if (applicable.length > 0 && applicable.every((candidate) => candidate.source_role === "parliamentary_research")) {
      missing.add("parliamentary_research_cannot_independently_support_monetary_rule");
    }
  }

  const evidenceRefs = (missing.size === 0 ? selectedCandidates : applicable)
    .map((candidate) => candidate.evidence_ref)
    .sort((left, right) => left.source_version_id.localeCompare(right.source_version_id));
  const missingGates = [...missing].sort();
  const requiredRolesSatisfied = [...rolesToCheck].every((role) => applicable.some((candidate) => candidate.source_role === role));
  const canonicalCandidates: LegalReadinessCandidate[] = applicable.map((candidate) => {
    const gates = missingCandidateGates(candidate, query.as_of);
    return {
      source_version_id: candidate.evidence_ref.source_version_id,
      topics: [candidate.topic],
      parse_succeeded: candidate.catalog_entry_id !== null && candidate.evidence_ref.parsed_version_id !== null,
      citation_verified: candidate.evidence_ref.citation_id !== null,
      operative_role_eligible: candidate.source_role === "operative_instrument" && requiredRolesSatisfied,
      human_reviewed: !gates.some((gate) => gate.startsWith("review_missing:")),
      effective_interval_verified: candidate.effective_claim_id !== null,
      verified_sectors: candidate.scope_claim_id === null ? [] : candidate.sectors,
      verified_populations: candidate.scope_claim_id === null ? [] : candidate.populations,
      active: candidate.evidence_ref.activation_state === "active",
    };
  });
  const canonical = evaluateLegalReadiness({ readinessCase: { case_id: "READINESS_LEGACY_WAVE1_ADAPTER", topic: query.topic, kind: "adapter", target_date: query.from, as_of: query.as_of.slice(0, 10), sector: query.sector, population: query.population }, candidates: canonicalCandidates });
  const usableForRules = canonical.usable_for_rules;
  return topicReadinessResultSchema.parse({
    topic: query.topic,
    valid_on: query.from,
    known_at: query.as_of,
    sector: query.sector,
    population: query.population,
    status: usableForRules ? "ready" : "not_ready",
    missing_gates: missingGates,
    evidence_refs: evidenceRefs,
    usable_for_rules: usableForRules,
  });
}
