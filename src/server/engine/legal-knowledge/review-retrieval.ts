import type { LegalChunk, LegalSource } from "../../../engine/legal-knowledge/contracts.ts";
import { retrieveLegalKnowledgeCore } from "../../../engine/legal-knowledge/retrieval-core.ts";
import type { LegalKnowledgeQuery } from "../../../engine/legal-knowledge/retrieval.ts";

/** Candidate retrieval is deliberately located in server-side review tooling, not the runtime API. */
export function retrieveLegalKnowledgeForReview(
  sources: readonly LegalSource[],
  chunks: readonly LegalChunk[],
  query: LegalKnowledgeQuery,
) {
  return retrieveLegalKnowledgeCore(sources, chunks, query, "review_tooling");
}
