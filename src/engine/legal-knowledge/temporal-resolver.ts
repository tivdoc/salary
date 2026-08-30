import { legalSourceVersionId, type LegalSource, type LegalSourceRelation } from "./contracts.ts";
import { isEffectiveOn } from "./effective-period.ts";
import type { LegalSector, LegalTopic } from "./taxonomy.ts";
import { classifyRegisteredSourceRole } from "./corpus-hardening/source-roles.ts";
import { legalServerResolverAdmission } from "./canonical-readiness/delegates.ts";

export const LEGAL_CORPUS_V01_COVERAGE = Object.freeze({
  from: "2019-01-01",
  to: "2026-08-29",
  timezone: "Asia/Jerusalem",
  basis: "engineering_corpus_boundary_only",
});

export type TemporalResolutionStatus =
  | "NOT_APPLICABLE"
  | "UNVERIFIED_CANDIDATE_SET"
  | "UNRESOLVED_MISSING_BASE_INSTRUMENT"
  | "UNRESOLVED_INCOMPLETE_CATALOG"
  | "UNRESOLVED_EFFECTIVITY"
  | "UNRESOLVED_SCOPE"
  | "CONFLICT"
  | "RESOLVED_ACTIVE";

export type SourceVersionEvidence = Readonly<{
  artifact_sha256: string | null;
  parsed_version_id: string | null;
  normalized_text_sha256: string | null;
  parser_version: string | null;
  citation: Readonly<{
    chunk_id: string;
    locator: string;
    effective_date_evidence_locator: string;
  }> | null;
}>;

export type TemporalSourceSetMember = Readonly<{
  source_id: string;
  source_version: string;
  source_version_id: string;
  raw_hash: string | null;
  parsed_version_id: string | null;
  normalized_hash: string | null;
  parser_version: string | null;
  effective_interval: Readonly<{ from: string; to: string | null }>;
  review_status: LegalSource["status"];
  authority: LegalSource["authority"];
  sector_scope: readonly string[];
  citation: SourceVersionEvidence["citation"];
  selection_rationale: readonly string[];
}>;

export function resolveTemporalSourceSet(input: Readonly<{
  sources: readonly LegalSource[];
  relations?: readonly LegalSourceRelation[];
  evidence?: Readonly<Record<string, SourceVersionEvidence>>;
  topic: LegalTopic;
  targetDate: string;
  sector: LegalSector | null;
  activeOnly: boolean;
  reviewContext?: Readonly<{
    catalogComplete: boolean;
    catalogCutoff: string | null;
    requiredSourceRoles: readonly string[];
    missingSourceRoles: readonly string[];
    rejectedObservationIds: readonly string[];
    missingApplicabilityFacts: readonly string[];
  }>;
}>) {
  const query = { topic: input.topic, target_date: input.targetDate, sector: input.sector, active_only: input.activeOnly };
  const reviewContext = input.reviewContext ?? {
    catalogComplete: false,
    catalogCutoff: null,
    requiredSourceRoles: [],
    missingSourceRoles: [],
    rejectedObservationIds: [],
    missingApplicabilityFacts: ["effective_interval", "scope", "population"],
  };
  const canonicalAdmission = legalServerResolverAdmission({
    case_id: `READINESS_SERVER_RESOLVER_${input.topic.toUpperCase()}`,
    topic: input.topic,
    kind: "adapter",
    target_date: input.targetDate,
    as_of: reviewContext.catalogCutoff ?? LEGAL_CORPUS_V01_COVERAGE.to,
    sector: input.sector,
    population: null,
  }, input.sources.map((source) => {
    const versionId = legalSourceVersionId(source);
    const evidence = input.evidence?.[versionId];
    const role = classifyRegisteredSourceRole(source);
    const reviewed = source.status === "reviewed" || source.status === "active";
    return {
      source_version_id: versionId,
      topics: source.topics,
      parse_succeeded: Boolean(evidence?.parsed_version_id),
      citation_verified: Boolean(evidence?.citation),
      operative_role_eligible: role.eligible_for_operative_resolution,
      human_reviewed: reviewed,
      effective_interval_verified: reviewed && isEffectiveOn(source, input.targetDate),
      verified_sectors: reviewed ? source.sectors : [],
      verified_populations: [],
      active: source.status === "active",
    };
  }));
  const resultContext = {
    usable_for_rules: false,
    catalog_cutoff: reviewContext.catalogCutoff,
    required_source_roles: reviewContext.requiredSourceRoles,
    missing_source_roles: reviewContext.missingSourceRoles,
    rejected_observation_ids: reviewContext.rejectedObservationIds,
    missing_applicability_facts: reviewContext.missingApplicabilityFacts,
    canonical_readiness: canonicalAdmission.decision,
  };
  if (input.targetDate < LEGAL_CORPUS_V01_COVERAGE.from || input.targetDate > LEGAL_CORPUS_V01_COVERAGE.to) {
    return { query, status: "NOT_APPLICABLE" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], unverified_candidates: [] as string[], excluded_source_roles: [] as Array<{ source_version_id: string; role: string }>, reasons: ["outside_declared_engineering_coverage"], conflicts: [] as string[], ...resultContext };
  }
  if (!input.sector || input.sector === "unknown") {
    return { query, status: "UNRESOLVED_SCOPE" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], unverified_candidates: [] as string[], excluded_source_roles: [] as Array<{ source_version_id: string; role: string }>, reasons: ["sector_required", "general_tag_is_not_applicability_evidence"], conflicts: [] as string[], ...resultContext };
  }

  const registeredTopicSources = input.sources.filter((source) => source.topics.includes(input.topic) && source.status !== "rejected");
  const excludedSourceRoles = registeredTopicSources.filter((source) => !classifyRegisteredSourceRole(source).eligible_for_operative_resolution).map((source) => ({ source_version_id: legalSourceVersionId(source), role: classifyRegisteredSourceRole(source).role })).sort((a, b) => a.source_version_id.localeCompare(b.source_version_id));
  const topicSources = registeredTopicSources.filter((source) => classifyRegisteredSourceRole(source).eligible_for_operative_resolution);
  const unverifiedCandidates = topicSources.map(legalSourceVersionId).sort();
  if (input.topic === "working_time" && !topicSources.some((source) => source.source_id === "IL_HOURS_WORK_REST_LAW")) {
    return { query, status: "UNRESOLVED_MISSING_BASE_INSTRUMENT" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: ["valid_base_statute_artifact_missing"], conflicts: [] as string[], ...resultContext };
  }
  const dateCandidates = topicSources.filter((source) => isEffectiveOn(source, input.targetDate));
  const sectorCandidates = dateCandidates.filter((source) => source.sectors.includes("general") || source.sectors.includes(input.sector!));
  if (sectorCandidates.length === 0) {
    const reason = topicSources.length === 0
      ? "topic_not_in_corpus"
      : dateCandidates.length === 0
        ? "effective_interval_gap_or_unresolved"
        : "sector_not_covered";
    const roleReasons = topicSources.length === 0 && registeredTopicSources.length > 0 ? ["operative_source_role_missing", "guidance_or_secondary_cannot_close_gap"] : [];
    return { query, status: (roleReasons.length ? "UNRESOLVED_MISSING_BASE_INSTRUMENT" : reason === "sector_not_covered" ? "UNRESOLVED_SCOPE" : "UNRESOLVED_EFFECTIVITY") as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: [...roleReasons, reason, ...(reviewContext.catalogComplete ? [] : ["catalog_coverage_incomplete"])], conflicts: [] as string[], ...resultContext };
  }

  const activeCandidates = sectorCandidates.filter((source) => source.status === "active");
  const selected = input.activeOnly ? activeCandidates : sectorCandidates;
  if (selected.length === 0) {
    return { query, status: "UNRESOLVED_EFFECTIVITY" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: ["active_source_not_available", "no_needs_review_fallback"], conflicts: [] as string[], ...resultContext };
  }

  const conflicts: string[] = [];
  const bySourceId = new Map<string, LegalSource[]>();
  for (const source of selected) bySourceId.set(source.source_id, [...(bySourceId.get(source.source_id) ?? []), source]);
  for (const [sourceId, versions] of bySourceId) {
    if (versions.length > 1) conflicts.push(`overlapping_source_versions:${sourceId}`);
  }
  const sectorSpecific = selected.filter((source) => source.authority.scope === "sector_specific");
  if (sectorSpecific.length > 1) {
    const related = new Set((input.relations ?? []).flatMap((relation) => [
      `${relation.from_source_version_id}>${relation.to_source_version_id}`,
      `${relation.to_source_version_id}>${relation.from_source_version_id}`,
    ]));
    for (let left = 0; left < sectorSpecific.length; left += 1) {
      for (let right = left + 1; right < sectorSpecific.length; right += 1) {
        const leftId = legalSourceVersionId(sectorSpecific[left]);
        const rightId = legalSourceVersionId(sectorSpecific[right]);
        if (!related.has(`${leftId}>${rightId}`)) conflicts.push(`undocumented_sector_overlap:${leftId}:${rightId}`);
      }
    }
  }

  const sourceSet = selected
    .map((source): TemporalSourceSetMember => {
      const versionId = legalSourceVersionId(source);
      const evidence = input.evidence?.[versionId];
      return {
        source_id: source.source_id,
        source_version: source.source_version,
        source_version_id: versionId,
        raw_hash: evidence?.artifact_sha256 ?? source.content_sha256,
        parsed_version_id: evidence?.parsed_version_id ?? null,
        normalized_hash: evidence?.normalized_text_sha256 ?? null,
        parser_version: evidence?.parser_version ?? null,
        effective_interval: { from: source.effective_from!, to: source.effective_to },
        review_status: source.status,
        authority: source.authority,
        sector_scope: source.sectors,
        citation: evidence?.citation ?? null,
        selection_rationale: [
          "exact_effective_interval_match",
          source.sectors.includes(input.sector!) ? "explicit_sector_match" : "general_baseline_retained",
          source.authority.operative ? "operative_source" : "explanatory_source_only",
          source.status === "active" ? "active" : "candidate_not_active",
        ],
      };
    })
    .sort((left, right) => {
      const leftScope = left.authority.scope === "general" ? 0 : 1;
      const rightScope = right.authority.scope === "general" ? 0 : 1;
      return leftScope - rightScope || left.source_version_id.localeCompare(right.source_version_id);
    });

  if (conflicts.length > 0) return { query, status: "CONFLICT" as TemporalResolutionStatus, source_set: sourceSet, unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: ["manual_relation_review_required"], conflicts, ...resultContext };
  if (!sourceSet.some((member) => member.authority.operative)) {
    return { query, status: "UNRESOLVED_MISSING_BASE_INSTRUMENT" as TemporalResolutionStatus, source_set: sourceSet, unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: ["operative_authority_required", "guidance_or_secondary_cannot_close_gap"], conflicts, ...resultContext };
  }
  if (input.evidence && sourceSet.some((member) => member.authority.operative && (!member.raw_hash || !member.parsed_version_id || !member.normalized_hash || !member.parser_version))) {
    return { query, status: "UNRESOLVED_EFFECTIVITY" as TemporalResolutionStatus, source_set: sourceSet, unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: ["source_version_lineage_incomplete"], conflicts, ...resultContext };
  }
  if (!sourceSet.every((member) => member.review_status === "active") && !reviewContext.catalogComplete) {
    return { query, status: "UNRESOLVED_INCOMPLETE_CATALOG" as TemporalResolutionStatus, source_set: sourceSet, unverified_candidates: unverifiedCandidates, excluded_source_roles: excludedSourceRoles, reasons: ["catalog_coverage_incomplete", "open_end_is_end_unknown", "candidate_set_not_usable_for_rules"], conflicts, ...resultContext };
  }
  return {
    query,
    status: (canonicalAdmission.decision.status === "READY" ? "RESOLVED_ACTIVE" : "UNVERIFIED_CANDIDATE_SET") as TemporalResolutionStatus,
    source_set: sourceSet,
    unverified_candidates: unverifiedCandidates,
    excluded_source_roles: excludedSourceRoles,
    usable_for_rules: canonicalAdmission.decision.usable_for_rules,
    reasons: canonicalAdmission.decision.status === "READY" ? ["canonical_legal_readiness_ready"] : ["canonical_legal_readiness_blocked", ...canonicalAdmission.decision.reason_codes],
    conflicts,
    catalog_cutoff: reviewContext.catalogCutoff,
    required_source_roles: reviewContext.requiredSourceRoles,
    missing_source_roles: reviewContext.missingSourceRoles,
    rejected_observation_ids: reviewContext.rejectedObservationIds,
    missing_applicability_facts: reviewContext.missingApplicabilityFacts,
    canonical_readiness: canonicalAdmission.decision,
  };
}
