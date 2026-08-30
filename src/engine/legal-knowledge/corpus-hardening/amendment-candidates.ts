import { z } from "zod";
import { canonicalEntryHash } from "./canonical-corpus.ts";

export const publicationInventoryEntrySchema = z.object({
  publication_ordinal: z.number().int().positive(),
  publication_identity: z.string().min(3),
  amendment_number: z.string().nullable(),
  publication_kind: z.enum([
    "direct_amendment_publication",
    "indirect_amendment_publication",
    "original_promulgation",
    "error_correction_publication",
  ]),
  catalog_directness: z.string().nullable(),
  title: z.string().min(1),
  publication_series: z.string().min(1),
  publication_issue: z.string().min(1),
  publication_page: z.string().min(1),
  publication_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  official_detail_url: z.string().url(),
  official_artifact_url: z.string().url(),
  discovery_evidence: z.string().min(1),
}).passthrough().readonly();

export type PublicationInventoryEntry = z.infer<typeof publicationInventoryEntrySchema>;

export function buildUnverifiedAmendmentCandidateGraph(input: readonly PublicationInventoryEntry[]) {
  const entries = input.map((entry) => publicationInventoryEntrySchema.parse(entry));
  const identities = new Set(entries.map((entry) => entry.publication_identity));
  if (identities.size !== entries.length) throw new Error("duplicate_publication_identity");
  const roots = entries.filter((entry) => entry.publication_kind === "original_promulgation");
  if (roots.length !== 1) throw new Error("exactly_one_original_promulgation_required");
  const root = roots[0];
  const nodes = [...entries]
    .sort((left, right) => left.publication_ordinal - right.publication_ordinal)
    .map((entry) => Object.freeze({
      node_id: `working-time-publication:${entry.publication_ordinal}:${canonicalEntryHash(entry).slice(0, 16)}`,
      node_sha256: canonicalEntryHash(entry),
      publication_identity: entry.publication_identity,
      publication_kind: entry.publication_kind,
      publication_date: entry.publication_date,
      official_artifact_url: entry.official_artifact_url,
      official_artifact_sha256: null,
      commencement_date: null,
      commencement_date_verified: false as const,
      review_state: "needs_review" as const,
      activation_state: "inactive" as const,
      corpus_version_created: false as const,
    }));
  const edges = nodes
    .filter((node) => node.publication_identity !== root.publication_identity)
    .map((node) => {
      const entry = entries.find((candidate) => candidate.publication_identity === node.publication_identity)!;
      return Object.freeze({
        edge_id: `candidate:${node.node_id}->${root.node_id}`,
        from_publication_identity: node.publication_identity,
        to_publication_identity: root.publication_identity,
        candidate_relation: node.publication_kind === "error_correction_publication" ? "corrects" as const : "amends" as const,
        catalog_directness: entry.catalog_directness,
        evidence_locator: entry.discovery_evidence,
        edge_evidence_sha256: canonicalEntryHash({ from: node.node_sha256, to: root.node_sha256, locator: entry.discovery_evidence, relation: entry.publication_kind }),
        verification_state: "unverified" as const,
        commencement_date: null,
        effectivity_verified: false as const,
        applicability_verified: false as const,
      });
    });
  return Object.freeze({
    schema_version: "working-time-unverified-amendment-candidate-graph-v0.4" as const,
    node_count: nodes.length,
    edge_count: edges.length,
    original_publication_identity: root.publication_identity,
    nodes,
    edges,
    safeguards: Object.freeze({
      current_text_asserted: false as const,
      automatic_consolidation_performed: false as const,
      commencement_inferred: false as const,
      applicability_determined: false as const,
      every_inventory_entry_mapped_once: nodes.length === entries.length,
    }),
  });
}
