import { createRequire } from "node:module";
import { legalSourceSchema } from "../../../../engine/legal-knowledge/contracts.ts";
import { buildUnverifiedAmendmentCandidateGraph, publicationInventoryEntrySchema } from "../../../../engine/legal-knowledge/corpus-hardening/amendment-candidates.ts";
import { classifyRegisteredSourceRole } from "../../../../engine/legal-knowledge/corpus-hardening/source-roles.ts";

const require = createRequire(import.meta.url);
const legalManifest = require("../legal-sources.v0.json") as { sources: unknown[] };
const workingTimeInventory = require("../wave1-working-time-permits-publications.v0.3.json") as { entries: unknown[] };

export function loadCanonicalRoleInventory() {
  const sources = legalManifest.sources.map((source) => legalSourceSchema.parse(source));
  const rows = sources.map((source) => ({
    source_type: source.source_type,
    status: source.status,
    ...classifyRegisteredSourceRole(source),
  })).sort((a, b) => a.source_version_id.localeCompare(b.source_version_id));
  // Bumped 17 -> 21 by Addendum 5/6 Pool D discovery: D-2 (average-wage
  // official rates), D-4 (Sefer HaChukim 3072), D-7 (youth minimum-wage
  // regulations), D-1b (BTL historical rate spreadsheet corroboration).
  // Bumped 21 -> 23 by Addendum 7 A7-5: D-5's second half (1998 general
  // collective agreement) and D-16 (Annual Vacation Law Amendment 15).
  if (rows.length !== 23) throw new Error(`canonical_role_inventory_expected_23_received_${rows.length}`);
  return Object.freeze({ schema_version: "canonical-source-role-inventory-v0.4.1" as const, source_count: rows.length, rows });
}

export function loadWorkingTimeCandidateGraph() {
  const entries = workingTimeInventory.entries.map((entry) => publicationInventoryEntrySchema.parse(entry));
  const graph = buildUnverifiedAmendmentCandidateGraph(entries);
  if (graph.node_count !== 20) throw new Error(`working_time_graph_expected_20_received_${graph.node_count}`);
  return graph;
}
