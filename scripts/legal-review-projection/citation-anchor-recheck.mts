// E3-1 (BL-10), the corpus half: re-run the citation check for every registered
// parameter with the anchor rule in force, against v1 logical-order text.
//
// Nothing is patched. A citation that fails the anchor is recorded; it becomes a
// superseded candidate only when a correct citation exists to replace it, which
// is E3-2's job for the one case where one does.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { verifyCitation } from "../../src/engine/legal-knowledge/citation-anchor.ts";
import { normalizeToLogicalOrder, hebrewOrderSignal } from "../../src/engine/legal-knowledge/normalizer-v1.ts";
import { POOL_P_CITATION_ANCHORS, anchorFor } from "./pool-p-citation-anchors.mts";

const NORMALIZED_ROOT = path.join("eval", "legal-knowledge", "normalized");
const RECEIPT_ROOT = path.join("output", "next", "citation-anchors");

type Chunk = Readonly<{ chunk_id: string; text: string }>;

/** v1 text for every chunk, built here so the check never depends on a stale file. */
function loadV1Chunks(): Map<string, string> {
  const byId = new Map<string, string>();
  if (!existsSync(NORMALIZED_ROOT)) return byId;
  for (const source of readdirSync(NORMALIZED_ROOT)) {
    for (const version of readdirSync(path.join(NORMALIZED_ROOT, source))) {
      const dir = path.join(NORMALIZED_ROOT, source, version);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".chunks.json") || file.endsWith(".v1.chunks.json")) continue;
        // L4-1: the table-aware set ships its own logical text, decided once per
        // document by the same rule, so it is taken as given rather than
        // re-derived here.
        // L5-5: chunks of an instrument selection carry their own logical text too.
        if (file.endsWith(".t1.chunks.json") || file.endsWith(".s1.chunks.json")) {
          const tableAware = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { chunks: Array<{ chunk_id: string; logical_text: string }> };
          for (const chunk of tableAware.chunks) byId.set(chunk.chunk_id, chunk.logical_text);
          continue;
        }
        const document = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { chunks: Chunk[] };
        const joined = document.chunks.map((chunk) => chunk.text).join("\n");
        const signal = hebrewOrderSignal(joined);
        const reorder = signal.visual_order && signal.confident;
        for (const chunk of document.chunks) {
          byId.set(chunk.chunk_id, reorder ? normalizeToLogicalOrder(chunk.text).text : chunk.text);
        }
      }
    }
  }
  return byId;
}

/**
 * Citations a batch recorded as it made them, read from its own receipt.
 *
 * L4-1. Source scraping cannot see a needle that is a loop variable, and a
 * checker that quietly read an empty needle list would report a pass it never
 * performed. A batch that writes its citations down is checked against what it
 * did; scraping stays for the batches that do not.
 */
function readRecordedCitations(): Array<{ file: string; chunk_id: string; must_contain: string[] }> {
  const receipts = path.join("output", "next", "pool-p");
  if (!existsSync(receipts)) return [];
  const recorded: Array<{ file: string; chunk_id: string; must_contain: string[] }> = [];
  for (const name of readdirSync(receipts).filter((entry) => entry.endsWith(".json")).sort()) {
    const receipt = JSON.parse(readFileSync(path.join(receipts, name), "utf8")) as {
      citations?: Array<{ chunk_id: string; must_contain: string[] }>;
    };
    for (const entry of receipt.citations ?? []) {
      recorded.push({ file: `${name.replace(/\.json$/u, "")}.mts`, chunk_id: entry.chunk_id, must_contain: entry.must_contain });
    }
  }
  return recorded;
}

/** Every citation declared by a Pool P batch script, chunk id and needles. */
function readDeclaredCitations(): Array<{ file: string; chunk_id: string; must_contain: string[] }> {
  const dir = path.join("scripts", "legal-review-projection");
  const citations: Array<{ file: string; chunk_id: string; must_contain: string[] }> = [...readRecordedCitations()];
  const recordedFiles = new Set(citations.map((entry) => entry.file));
  for (const file of readdirSync(dir).filter((name) => /^pool-p-batch-.*\.mts$/u.test(name)).sort()) {
    if (recordedFiles.has(file)) continue;
    const source = readFileSync(path.join(dir, file), "utf8");
    // L4-1: a chunk id may be written inline or held in a file-level constant,
    // because the table-aware citations name the same chunk three times over.
    // Both forms are resolved here — a scanner that only understood string
    // literals would quietly stop counting the moment an author factored one
    // out, and a citation nobody counts is a citation nobody checks.
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*#[^"]*)"/gu)) {
      constants.set(match[1], match[2]);
    }
    for (const fragment of source.split("citation(").slice(1)) {
      const head = fragment.split("[")[0];
      const chunkId = /"([^"]*#[^"]*)"/u.exec(head)?.[1]
        ?? [...head.matchAll(/\b([A-Z][A-Z0-9_]*)\b/gu)].map((match) => constants.get(match[1])).find((value) => value !== undefined);
      const rawArray = /(\[[^\]]*\])/u.exec(fragment)?.[1];
      if (!chunkId || !chunkId.includes("#")) continue;
      let mustContain: string[] = [];
      try { mustContain = rawArray ? JSON.parse(rawArray.replaceAll("'", '"')) as string[] : []; } catch { mustContain = []; }
      citations.push({ file, chunk_id: chunkId, must_contain: mustContain });
    }
  }
  return citations;
}

mkdirSync(RECEIPT_ROOT, { recursive: true });
const chunks = loadV1Chunks();
const declared = readDeclaredCitations();

const findings = declared.map((citation) => {
  const text = chunks.get(citation.chunk_id) ?? null;
  const registered = anchorFor(citation.chunk_id);
  if (!registered) {
    return {
      chunk_id: citation.chunk_id, declared_in: citation.file,
      outcome: "anchor_not_registered" as const,
      detail: "No anchor is registered for this chunk. Every cited chunk must have one, or an explicit reason it cannot.",
    };
  }
  if (registered.anchor === undefined) {
    return {
      chunk_id: citation.chunk_id, declared_in: citation.file,
      outcome: "anchor_impossible" as const,
      reason: registered.anchor_absent, remedy: registered.remedy,
      must_contain: citation.must_contain,
      numbers_verified: text !== null && citation.must_contain.every((needle) => text.includes(needle)),
    };
  }
  if (text === null) {
    return { chunk_id: citation.chunk_id, declared_in: citation.file, outcome: "chunk_missing" as const };
  }
  const verification = verifyCitation({
    chunk_id: citation.chunk_id, chunk_text: text,
    must_contain: citation.must_contain, anchor: registered.anchor,
  });
  return {
    chunk_id: citation.chunk_id, declared_in: citation.file,
    outcome: verification.verified ? "verified" as const : "anchor_failed" as const,
    anchor: registered.anchor,
    anchor_matched: verification.anchor.matched,
    anchor_usable: verification.anchor.usable,
    numbers_missing: verification.numbers_missing,
    must_contain: citation.must_contain,
  };
});

const byOutcome = (outcome: string) => findings.filter((entry) => entry.outcome === outcome);
const receipt = {
  schema_version: "tivdoc-citation-anchor-recheck-v0.10.15",
  unit: "E3-1 (BL-10)",
  rule: "A citation is verified only when every required number AND the registered Hebrew anchor are present in the same chunk of v1 logical-order text.",
  citations_declared: findings.length,
  distinct_chunks: new Set(findings.map((entry) => entry.chunk_id)).size,
  verified: byOutcome("verified").length,
  anchor_failed: byOutcome("anchor_failed").length,
  anchor_impossible: byOutcome("anchor_impossible").length,
  anchor_not_registered: byOutcome("anchor_not_registered").length,
  chunk_missing: byOutcome("chunk_missing").length,
  anchors_registered: POOL_P_CITATION_ANCHORS.length,
  anchors_with_text: POOL_P_CITATION_ANCHORS.filter((entry) => entry.anchor !== undefined).length,
  parameters_patched: 0,
  parameters_superseded_here: 0,
  note: "Nothing is patched by this script. A citation that fails becomes a superseded candidate only when a correct citation exists to replace it.",
  findings,
};
writeFileSync(path.join(RECEIPT_ROOT, "citation-anchor-recheck.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  citations_declared: receipt.citations_declared,
  distinct_chunks: receipt.distinct_chunks,
  verified: receipt.verified,
  anchor_failed: receipt.anchor_failed,
  anchor_impossible: receipt.anchor_impossible,
  anchor_not_registered: receipt.anchor_not_registered,
  failures: byOutcome("anchor_failed").map((entry) => entry.chunk_id),
}, null, 2)}\n`);
