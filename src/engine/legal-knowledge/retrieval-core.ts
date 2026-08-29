import { compareSourceAuthority } from "./authority.ts";
import { legalSourceVersionId, type LegalChunk, type LegalSource } from "./contracts.ts";
import { isEffectiveOn } from "./effective-period.ts";
import type { LegalKnowledgeQuery, LegalKnowledgeResult } from "./retrieval.ts";

const bindingRank: Readonly<Record<LegalSource["authority"]["binding_level"], number>> = {
  primary_binding: 4,
  official_implementation: 3,
  official_guidance: 2,
  secondary_explanatory: 1,
};

function normalizedTerms(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("he").split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
}

/** Internal shared implementation. Public runtime and server review APIs apply fixed modes. */
export function retrieveLegalKnowledgeCore(
  sources: readonly LegalSource[],
  chunks: readonly LegalChunk[],
  query: LegalKnowledgeQuery,
  mode: "active_runtime" | "review_tooling",
) {
  if (query.sector === "unknown") {
    return { results: [] as LegalKnowledgeResult[], conflicts: ["sector_required"], incomplete: true };
  }
  const minimumRank = query.minimumBindingLevel ? bindingRank[query.minimumBindingLevel] : 1;
  const eligibleSources = sources.filter((source) => {
    if (source.status === "rejected") return false;
    if (mode === "active_runtime" && source.status !== "active") return false;
    if (query.sourceTypes && !query.sourceTypes.includes(source.source_type)) return false;
    if (query.language && source.language !== query.language) return false;
    if (!source.topics.includes(query.topic)) return false;
    if (bindingRank[source.authority.binding_level] < minimumRank) return false;
    return isEffectiveOn(source, query.targetDate);
  });
  const sourceByVersion = new Map(eligibleSources.map((source) => [`${source.source_id}@${source.source_version}`, source]));
  const queryTerms = [...new Set([...(query.keywords ?? []), query.topic.replaceAll("_", " "), query.role ?? ""].flatMap(normalizedTerms))];
  const results = chunks.flatMap((chunk): LegalKnowledgeResult[] => {
    const source = sourceByVersion.get(`${chunk.source_id}@${chunk.source_version}`);
    if (!source || !chunk.topics.includes(query.topic)) return [];
    const sectorSpecific = chunk.sectors.includes(query.sector) && query.sector !== "general";
    const general = chunk.sectors.includes("general");
    if (!sectorSpecific && !general && query.sector !== "unknown") return [];
    const haystack = normalizedTerms(`${chunk.heading_path.join(" ")} ${chunk.text}`);
    const termMatches = queryTerms.filter((term) => haystack.some((candidate) => candidate.includes(term) || term.includes(candidate))).length;
    const effectiveDateMatch = isEffectiveOn(source, query.targetDate);
    const scoreComponents = {
      topic: 40,
      sector: sectorSpecific ? 25 : general ? 12 : 0,
      authority: bindingRank[source.authority.binding_level] * 6,
      effective_date: effectiveDateMatch ? 15 : 0,
      keywords: Math.min(termMatches, 5) * 3,
      operative: source.authority.operative ? 5 : 0,
    };
    const score = Object.values(scoreComponents).reduce((sum, value) => sum + value, 0);
    return [{
      chunk,
      source,
      effectiveDateMatch,
      citationReference: { source_id: source.source_id, source_version: source.source_version, source_version_id: legalSourceVersionId(source), chunk_id: chunk.chunk_id },
      score,
      scoreComponents,
      reasons: [sectorSpecific ? "sector_specific" : "general_baseline", source.authority.binding_level, effectiveDateMatch ? "date_match" : "date_unresolved_or_mismatch"],
      requiresReview: source.status !== "active" || source.authority.binding_level === "secondary_explanatory" || !effectiveDateMatch,
    }];
  });
  results.sort((left, right) => right.score - left.score || compareSourceAuthority(left.source, right.source, query.sector) || left.chunk.chunk_id.localeCompare(right.chunk.chunk_id));
  const effectiveGroups = new Map<string, Set<string>>();
  for (const result of results.filter((entry) => entry.effectiveDateMatch)) {
    const versions = effectiveGroups.get(result.source.source_id) ?? new Set<string>();
    versions.add(result.source.source_version);
    effectiveGroups.set(result.source.source_id, versions);
  }
  const conflicts = [...effectiveGroups.entries()].filter(([, versions]) => versions.size > 1).map(([sourceId]) => `overlapping_source_versions:${sourceId}`);
  return { results: results.slice(0, Math.max(1, Math.min(query.limit, 50))), conflicts, incomplete: results.length === 0 || results.some((result) => result.requiresReview) };
}
