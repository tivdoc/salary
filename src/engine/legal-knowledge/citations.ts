import type { LegalChunk, LegalCitation, LegalSource } from "./contracts.ts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function validateCitationIntegrity(
  citation: LegalCitation,
  chunks: readonly LegalChunk[],
  sources: readonly LegalSource[],
) {
  const issues: string[] = [];
  const source = sources.find((entry) => entry.source_id === citation.source_id && entry.source_version === citation.source_version);
  if (!source) issues.push("citation_source_missing");
  else {
    if (citation.title !== source.title || citation.canonical_url !== source.canonical_url) issues.push("citation_source_metadata_mismatch");
    if (stableJson(citation.authority) !== stableJson(source.authority)) issues.push("citation_authority_mismatch");
    if (stableJson(citation.effective_period) !== stableJson(source.effective_period)) issues.push("citation_effective_period_mismatch");
    if (citation.retrieved_at !== source.retrieved_at) issues.push("citation_retrieval_timestamp_mismatch");
  }
  const citedChunks = citation.supporting_chunk_ids.map((chunkId) => chunks.find((chunk) => chunk.chunk_id === chunkId));
  if (citedChunks.some((chunk) => !chunk)) issues.push("citation_chunk_missing");
  if (citedChunks.some((chunk) => chunk && (chunk.source_id !== citation.source_id || chunk.source_version !== citation.source_version))) {
    issues.push("citation_chunk_source_mismatch");
  }
  if (citedChunks.some((chunk) => chunk && (stableJson(chunk.authority) !== stableJson(citation.authority)
    || stableJson(chunk.effective_period) !== stableJson(citation.effective_period)))) {
    issues.push("citation_chunk_metadata_mismatch");
  }
  if (citation.excerpt && !citedChunks.some((chunk) => chunk?.text.includes(citation.excerpt ?? ""))) {
    issues.push("citation_excerpt_not_in_supporting_chunk");
  }
  return { passed: issues.length === 0, issues };
}

export function validateApplicabilityOutputCitations(
  output: Readonly<{ assertions: readonly Readonly<{ assertion_id: string; citation_ids: readonly string[] }>[] }>,
  citations: readonly Readonly<{ citation_id: string; citation: LegalCitation }>[],
) {
  const issues: string[] = [];
  for (const assertion of output.assertions) {
    if (assertion.citation_ids.length === 0) issues.push(`unsupported_assertion:${assertion.assertion_id}`);
    for (const citationId of assertion.citation_ids) {
      if (!citations.some((entry) => entry.citation_id === citationId)) issues.push(`unknown_citation:${citationId}`);
    }
  }
  return { passed: issues.length === 0, issues };
}
