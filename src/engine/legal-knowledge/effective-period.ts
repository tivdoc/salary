import type { LegalSource } from "./contracts.ts";

export function isEffectiveOn(source: LegalSource, targetDate: string) {
  if (!source.effective_from) return false;
  return source.effective_from <= targetDate && (!source.effective_to || targetDate <= source.effective_to);
}

export function resolveSourceVersion(sources: readonly LegalSource[], sourceId: string, targetDate: string) {
  const matches = sources.filter((source) => source.source_id === sourceId && isEffectiveOn(source, targetDate));
  if (matches.length === 0) return { status: "gap" as const, source: null, candidates: [] as LegalSource[] };
  if (matches.length > 1) return { status: "ambiguous_overlap" as const, source: null, candidates: matches };
  return { status: "resolved" as const, source: matches[0], candidates: matches };
}

export function inspectEffectivePeriods(sources: readonly LegalSource[], sourceId: string) {
  const versions = sources
    .filter((source) => source.source_id === sourceId && source.effective_from)
    .sort((left, right) => (left.effective_from ?? "").localeCompare(right.effective_from ?? ""));
  const overlaps: Array<readonly [string, string]> = [];
  for (let leftIndex = 0; leftIndex < versions.length; leftIndex += 1) {
    const left = versions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < versions.length; rightIndex += 1) {
      const right = versions[rightIndex];
      if (left.effective_to && left.effective_to < (right.effective_from ?? "")) break;
      overlaps.push([left.source_version, right.source_version]);
    }
  }
  const gaps: Array<Readonly<{ after: string; before: string }>> = [];
  let coverageEnd = versions[0]?.effective_to ?? null;
  let coverageVersion = versions[0]?.source_version ?? "";
  for (const version of versions.slice(1)) {
    if (coverageEnd) {
      const nextDay = new Date(`${coverageEnd}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      if (nextDay.toISOString().slice(0, 10) < (version.effective_from ?? "")) {
        gaps.push({ after: coverageVersion, before: version.source_version });
      }
      if (!version.effective_to || version.effective_to > coverageEnd) {
        coverageEnd = version.effective_to;
        coverageVersion = version.source_version;
      }
    }
  }
  return { versions, overlaps, gaps };
}

export function temporalSourceState(source: LegalSource, asOf: string) {
  if (source.effective_from && source.effective_from > asOf) return "future_effective" as const;
  if (source.effective_to && source.effective_to < asOf) return "expired" as const;
  if (source.status === "superseded") return "superseded" as const;
  if (!source.effective_from) return "effective_date_unresolved" as const;
  return "effective" as const;
}
