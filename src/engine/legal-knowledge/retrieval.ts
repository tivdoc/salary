import type { LegalChunk, LegalSource } from "./contracts.ts";
import { retrieveLegalKnowledgeCore } from "./retrieval-core.ts";
import type { LegalSector, LegalTopic } from "./taxonomy.ts";

export type LegalKnowledgeQuery = Readonly<{
  topic: LegalTopic;
  targetDate: string;
  sector: LegalSector;
  role?: string | null;
  sourceTypes?: readonly LegalSource["source_type"][];
  minimumBindingLevel?: LegalSource["authority"]["binding_level"];
  language?: LegalSource["language"];
  keywords?: readonly string[];
  limit: number;
}>;

export type LegalKnowledgeResult = Readonly<{
  chunk: LegalChunk;
  source: LegalSource;
  effectiveDateMatch: boolean;
  citationReference: Readonly<{ source_id: string; source_version: string; source_version_id: string; chunk_id: string }>;
  score: number;
  scoreComponents: Readonly<Record<string, number>>;
  reasons: readonly string[];
  requiresReview: boolean;
}>;

export interface LegalKnowledgeRetriever {
  retrieve(query: LegalKnowledgeQuery): Promise<Readonly<{
    results: readonly LegalKnowledgeResult[];
    conflicts: readonly string[];
    incomplete: boolean;
  }>>;
}

export function retrieveActiveLegalKnowledge(
  sources: readonly LegalSource[],
  chunks: readonly LegalChunk[],
  query: LegalKnowledgeQuery,
) {
  return retrieveLegalKnowledgeCore(sources, chunks, query, "active_runtime");
}
