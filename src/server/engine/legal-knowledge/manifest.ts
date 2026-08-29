import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { legalSourceSchema } from "../../../engine/legal-knowledge/contracts.ts";
import { LEGAL_TAXONOMY_VERSION } from "../../../engine/legal-knowledge/taxonomy.ts";

export const legalSourceManifestSchema = z.object({
  manifest_version: z.literal("israeli-employment-legal-sources-v0"),
  taxonomy_version: z.literal(LEGAL_TAXONOMY_VERSION),
  classification: z.literal("source_discovery_manifest_pending_content_review"),
  sources: z.array(legalSourceSchema).min(1),
}).superRefine((manifest, context) => {
  const keys = new Set<string>();
  for (const source of manifest.sources) {
    const key = `${source.source_id}@${source.source_version}`;
    if (keys.has(key)) context.addIssue({ code: "custom", message: `duplicate_source_version:${key}` });
    keys.add(key);
  }
});

export const defaultLegalSourceManifestPath = path.resolve(
  "src",
  "server",
  "engine",
  "legal-knowledge",
  "legal-sources.v0.json",
);

export async function loadLegalSourceManifest(filePath = defaultLegalSourceManifestPath) {
  const text = await readFile(filePath, "utf8");
  return legalSourceManifestSchema.parse(JSON.parse(text));
}
