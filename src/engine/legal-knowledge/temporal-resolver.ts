import { legalSourceVersionId, type LegalSource, type LegalSourceRelation } from "./contracts.ts";
import { isEffectiveOn } from "./effective-period.ts";
import type { LegalSector, LegalTopic } from "./taxonomy.ts";

export const LEGAL_CORPUS_V01_COVERAGE = Object.freeze({
  from: "2019-01-01",
  to: "2026-08-29",
  timezone: "Asia/Jerusalem",
  basis: "engineering_corpus_boundary_only",
});

export type TemporalResolutionStatus =
  | "UNSUPPORTED"
  | "UNRESOLVED"
  | "CONFLICT"
  | "RESOLVED_CANDIDATE"
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
}>) {
  const query = { topic: input.topic, target_date: input.targetDate, sector: input.sector, active_only: input.activeOnly };
  if (input.targetDate < LEGAL_CORPUS_V01_COVERAGE.from || input.targetDate > LEGAL_CORPUS_V01_COVERAGE.to) {
    return { query, status: "UNSUPPORTED" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], reasons: ["outside_declared_engineering_coverage"], conflicts: [] as string[] };
  }
  if (!input.sector || input.sector === "unknown") {
    return { query, status: "UNRESOLVED" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], reasons: ["sector_required"], conflicts: [] as string[] };
  }

  const topicSources = input.sources.filter((source) => source.topics.includes(input.topic) && source.status !== "rejected");
  const dateCandidates = topicSources.filter((source) => isEffectiveOn(source, input.targetDate));
  const sectorCandidates = dateCandidates.filter((source) => source.sectors.includes("general") || source.sectors.includes(input.sector!));
  if (sectorCandidates.length === 0) {
    const reason = topicSources.length === 0
      ? "topic_not_in_corpus"
      : dateCandidates.length === 0
        ? "effective_interval_gap_or_unresolved"
        : "sector_not_covered";
    return { query, status: "UNRESOLVED" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], reasons: [reason], conflicts: [] as string[] };
  }

  const activeCandidates = sectorCandidates.filter((source) => source.status === "active");
  const selected = input.activeOnly ? activeCandidates : sectorCandidates;
  if (selected.length === 0) {
    return { query, status: "UNRESOLVED" as TemporalResolutionStatus, source_set: [] as TemporalSourceSetMember[], reasons: ["active_source_not_available", "no_needs_review_fallback"], conflicts: [] as string[] };
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

  if (conflicts.length > 0) return { query, status: "CONFLICT" as TemporalResolutionStatus, source_set: sourceSet, reasons: ["manual_relation_review_required"], conflicts };
  if (!sourceSet.some((member) => member.authority.operative)) {
    return { query, status: "UNRESOLVED" as TemporalResolutionStatus, source_set: sourceSet, reasons: ["operative_authority_required", "guidance_or_secondary_cannot_close_gap"], conflicts };
  }
  if (input.evidence && sourceSet.some((member) => member.authority.operative && (!member.raw_hash || !member.parsed_version_id || !member.normalized_hash || !member.parser_version))) {
    return { query, status: "UNRESOLVED" as TemporalResolutionStatus, source_set: sourceSet, reasons: ["source_version_lineage_incomplete"], conflicts };
  }
  return {
    query,
    status: (sourceSet.every((member) => member.review_status === "active") ? "RESOLVED_ACTIVE" : "RESOLVED_CANDIDATE") as TemporalResolutionStatus,
    source_set: sourceSet,
    reasons: sourceSet.every((member) => member.review_status === "active") ? ["all_source_set_members_active"] : ["source_set_requires_owner_legal_review"],
    conflicts,
  };
}
