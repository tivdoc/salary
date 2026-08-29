import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { legalTopicSchema } from "../../../engine/legal-knowledge/taxonomy.ts";
import { extractHtmlLegalText, normalizeLegalText } from "./normalization.ts";

export const legalCatalogRegistrySchema = z.object({
  schema_version: z.literal("legal-official-catalog-registry-v0.1"),
  catalogs: z.array(z.object({
    catalog_id: z.string().regex(/^[A-Z0-9_-]{3,80}$/),
    title: z.string().min(1),
    canonical_url: z.string().url().refine((value) => value.startsWith("https://"), "catalog_url_must_use_https"),
    publisher: z.string().min(1),
    topics: z.array(legalTopicSchema).min(1),
    required_detection: z.array(z.object({
      candidate_id: z.string().regex(/^[A-Z0-9_-]{3,100}$/),
      title_tokens: z.array(z.string().min(1)).min(1),
      evidence_role: z.literal("catalog_discovery_only_not_source_authority"),
    }).strict()),
  }).strict()).min(2),
}).strict();

export type LegalCatalogEntry = Readonly<{
  entry_id: string;
  title: string;
  url: string | null;
  metadata_sha256: string;
}>;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseOfficialCatalogHtml(html: string, baseUrl: string): LegalCatalogEntry[] {
  const entries: LegalCatalogEntry[] = [];
  const seen = new Set<string>();
  const linkPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(linkPattern)) {
    const title = normalizeLegalText(extractHtmlLegalText(match[2]));
    if (title.length < 8) continue;
    let url: string | null = null;
    try {
      const candidate = new URL(match[1], baseUrl);
      if (candidate.protocol === "https:" && ["www.gov.il", "gov.il"].includes(candidate.hostname.toLowerCase())) {
        candidate.search = "";
        candidate.hash = "";
        url = candidate.toString();
      }
    } catch {
      url = null;
    }
    const entryId = hash(`${title}\n${url ?? ""}`);
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    entries.push({ entry_id: entryId, title, url, metadata_sha256: hash(`${title}\n${url ?? ""}`) });
  }
  return entries.sort((left, right) => left.entry_id.localeCompare(right.entry_id));
}

export function diffOfficialCatalogEntries(previous: readonly LegalCatalogEntry[], current: readonly LegalCatalogEntry[]) {
  const previousByUrl = new Map(previous.map((entry) => [entry.url ?? entry.entry_id, entry]));
  const currentByUrl = new Map(current.map((entry) => [entry.url ?? entry.entry_id, entry]));
  const additions = current.filter((entry) => !previousByUrl.has(entry.url ?? entry.entry_id));
  const removals = previous.filter((entry) => !currentByUrl.has(entry.url ?? entry.entry_id));
  const metadataChanges = current.flatMap((entry) => {
    const old = previousByUrl.get(entry.url ?? entry.entry_id);
    return old && old.metadata_sha256 !== entry.metadata_sha256 ? [{ previous: old, current: entry }] : [];
  });
  return { additions, removals, metadata_changes: metadataChanges, review_required: additions.length + removals.length + metadataChanges.length > 0 };
}

export const defaultLegalCatalogRegistryPath = path.resolve(
  "src",
  "server",
  "engine",
  "legal-knowledge",
  "legal-catalogs.v0.1.json",
);

export async function loadLegalCatalogRegistry(filePath = defaultLegalCatalogRegistryPath) {
  return legalCatalogRegistrySchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}
