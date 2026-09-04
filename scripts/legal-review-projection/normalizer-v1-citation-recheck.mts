// E2-4, the corpus half. Produce `legal-normalizer-v1` parsed versions beside
// the v0 ones, and re-run the run-time citation check for every registered
// parameter against v1 text.
//
// Nothing is rebound. Under the supersession rules a v1 parsed version is a new
// parsed version with a new hash sitting beside an immutable v0; changing which
// text a parameter cites is a new candidate revision and belongs to the P-pool,
// with a human deciding it. This script produces evidence and a list, and stops
// there.
//
// The v1 artifacts are written under the git-ignored eval tree, never over v0.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LEGAL_NORMALIZER_V1_VERSION,
  hebrewOrderSignal,
  normalizeToLogicalOrder,
} from "../../src/engine/legal-knowledge/normalizer-v1.ts";
import { REGISTERED_DRAFT_PARAMETERS } from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const NORMALIZED_ROOT = path.join("eval", "legal-knowledge", "normalized");
const RECEIPT_ROOT = path.join("output", "next", "normalizer-v1");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Chunk = Readonly<{ chunk_id: string; text: string; source_version_id: string }>;
type Citation = Readonly<{ parameter_version_id: string; chunk_id: string; locator: string; must_contain: readonly string[] }>;

// The stored candidate does NOT carry its citation locators: the import folds
// them into `bindings.citations_sha256` and keeps only the hash, so the
// governance database can prove a citation set has not changed but cannot show
// you what it was. The locators live in the Pool P batch scripts, which are the
// record of what was cited, so they are read from there — parsed out of the
// literal `citation(...)` calls rather than hand-copied into a second list that
// could drift from the first.
// The subject of this re-check is the CITED CHUNK, which is what the reordering
// can move. Every `citation(...)` call in every batch script is read, whether
// its candidate was written out literally or built in a loop — associating each
// with a parameter by nearest preceding declaration would be a guess in the
// loop cases, and a guess is not worth putting in a receipt. What is exact is
// the chunk id and the strings the check requires of it, and those are what
// this reports.
function readRegisteredCitations(): Citation[] {
  const batchDir = path.join("scripts", "legal-review-projection");
  const citations: Citation[] = [];
  for (const file of readdirSync(batchDir).filter((name) => /^pool-p-batch-.*\.mts$/u.test(name)).sort()) {
    const source = readFileSync(path.join(batchDir, file), "utf8");
    // Split on the call rather than matching the whole call: a single regex
    // across a multi-line argument list runs past the end of one citation into
    // the next and silently drops the ones in between. Each fragment starts
    // immediately inside one `citation(`, so the FIRST quoted string in it is
    // that call's chunk id and the FIRST array is its must_contain.
    for (const fragment of source.split("citation(").slice(1)) {
      const chunkId = /"([^"]+)"/u.exec(fragment)?.[1];
      const rawArray = /(\[[^\]]*\])/u.exec(fragment)?.[1];
      if (!chunkId || !chunkId.includes("#")) continue;
      let mustContain: string[] = [];
      try { mustContain = rawArray ? JSON.parse(rawArray.replaceAll("'", '"')) as string[] : []; } catch { mustContain = []; }
      citations.push({
        parameter_version_id: "(declared in batch script)",
        chunk_id: chunkId,
        locator: file,
        must_contain: mustContain,
      });
    }
  }
  return citations;
}

function listChunkFiles(): string[] {
  const files: string[] = [];
  if (!existsSync(NORMALIZED_ROOT)) return files;
  for (const source of readdirSync(NORMALIZED_ROOT)) {
    const sourceDir = path.join(NORMALIZED_ROOT, source);
    for (const version of readdirSync(sourceDir)) {
      const versionDir = path.join(sourceDir, version);
      for (const file of readdirSync(versionDir)) {
        // v1 outputs are not inputs: without this a second run would read back
        // its own product and count it as another source.
        if (file.endsWith(".chunks.json") && !file.endsWith(".v1.chunks.json")) files.push(path.join(versionDir, file));
      }
    }
  }
  return files.sort();
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });

  // --- Pass 1: every chunk, through v1.
  const chunksById = new Map<string, { v0: string; v1: string; reordered: boolean }>();
  const perSource: Array<Record<string, unknown>> = [];
  for (const file of listChunkFiles()) {
    const document = JSON.parse(readFileSync(file, "utf8")) as { chunks: Chunk[]; source_id: string; source_version?: string };
    const joined = document.chunks.map((chunk) => chunk.text).join("\n");
    const signal = hebrewOrderSignal(joined);
    let reorderedChunks = 0;
    const v1Chunks = document.chunks.map((chunk) => {
      // The decision is made once per source, from the whole document, and
      // applied to every chunk in it. Deciding per chunk would let a short
      // chunk in a clearly visual document opt out on its own thin evidence.
      const shouldReorder = signal.visual_order && signal.confident;
      const result = shouldReorder
        ? normalizeToLogicalOrder(chunk.text)
        : { text: chunk.text, reordered: false };
      if (shouldReorder) reorderedChunks += 1;
      chunksById.set(chunk.chunk_id, { v0: chunk.text, v1: result.text, reordered: shouldReorder });
      return {
        chunk_id: chunk.chunk_id,
        source_version_id: chunk.source_version_id,
        normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
        visual_order: false,
        reordered_from_visual: shouldReorder,
        text: result.text,
        chunk_text_sha256: sha256(result.text),
      };
    });

    // A new parsed version beside the old one. The v0 file is not opened for
    // writing anywhere in this script.
    const parsedVersionId = `${document.source_id}@${document.source_version ?? "discovery-v0"}#parsed-v1-${sha256(v1Chunks.map((c) => c.chunk_text_sha256).join("")).slice(0, 24)}`;
    const target = file.replace(/\.chunks\.json$/u, ".v1.chunks.json");
    writeFileSync(target, `${JSON.stringify({
      schema_version: "legal-chunks-v1",
      source_id: document.source_id,
      source_version: document.source_version ?? "discovery-v0",
      parsed_version_id: parsedVersionId,
      normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
      visual_order: false,
      supersedes_nothing: true,
      note: "New parsed version beside the v0 one. The v0 text is immutable and untouched; no parameter is rebound by producing this.",
      chunks: v1Chunks,
    }, null, 2)}\n`, "utf8");

    perSource.push({
      source_id: document.source_id,
      chunks: document.chunks.length,
      hebrew_words: signal.hebrew_words,
      visual_order_detected: signal.visual_order,
      confident: signal.confident,
      reordered_chunks: reorderedChunks,
      parsed_version_id: parsedVersionId,
    });
  }

  // --- Pass 2: the citation re-check, against every registered parameter.
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("E24_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_e24_citation_recheck",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  const client = await factory.acquire();
  const findings: Array<Record<string, unknown>> = [];
  const registeredParameterVersions = [
    ...REGISTERED_DRAFT_PARAMETERS.flatMap((entry) => entry.versions.map((version) => `${entry.parameter_id}@${version}`)),
    "il.vacation.calendar_days_years_1_to_4@2017.1.0",
  ];
  const citations = readRegisteredCitations();
  let registeredAndDraft = 0;
  try {
    await client.query(statement("e24_begin", "begin", []));
    await client.query(statement("e24_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `e24:${randomUUID().slice(0, 8)}`]));
    // The parameters these citations belong to are confirmed present and draft
    // once, up front, rather than per citation — the re-check itself is about
    // chunks, and re-reading the same rows per citation would be noise.
    for (const id of registeredParameterVersions) {
      const at = id.lastIndexOf("@");
      const row = await client.query(statement("e24_aggregate",
        "select state from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", id.slice(0, at), id.slice(at + 1)]));
      if (row.row_count === 1 && (row.rows[0] as unknown as { state: string }).state === "draft") registeredAndDraft += 1;
    }
    for (const citation of citations) {
      const chunk = chunksById.get(citation.chunk_id);
      const required = citation.must_contain;
      const v0Matches = chunk ? required.filter((needle) => chunk.v0.includes(needle)) : [];
      const v1Matches = chunk ? required.filter((needle) => chunk.v1.includes(needle)) : [];
      findings.push({
        parameter_version_id: citation.parameter_version_id,
        chunk_id: citation.chunk_id,
        declared_in: citation.locator,
        chunk_found: chunk !== undefined,
        text_moved: chunk?.reordered ?? false,
        must_contain: required,
        matched_in_v0: v0Matches,
        matched_in_v1: v1Matches,
        v0_fully_matched: chunk !== undefined && v0Matches.length === required.length,
        v1_fully_matched: chunk !== undefined && v1Matches.length === required.length,
        newly_matching_in_v1: required.filter((needle) => !v0Matches.includes(needle) && v1Matches.includes(needle)),
        lost_in_v1: required.filter((needle) => v0Matches.includes(needle) && !v1Matches.includes(needle)),
      });
    }
    await client.query(statement("e24_rollback", "rollback", []));
  } finally {
    client.release();
  }

  const moved = findings.filter((entry) => entry.text_moved === true);
  const newlyMatching = findings.filter((entry) => (entry.newly_matching_in_v1 as string[]).length > 0);
  const lost = findings.filter((entry) => (entry.lost_in_v1 as string[]).length > 0);

  const receipt = {
    schema_version: "tivdoc-normalizer-v1-citation-recheck-v0.10.14",
    unit: "E2-4",
    normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
    v0_texts_modified: 0,
    parameters_rebound: 0,
    rebinding_note:
      "None, deliberately. A v1 parsed version sits beside an immutable v0; changing which text a parameter cites is a new candidate revision and belongs to the P-pool with a person deciding it. This script produces the list.",
    sources: perSource,
    sources_total: perSource.length,
    sources_in_visual_order: perSource.filter((entry) => entry.visual_order_detected === true && entry.confident === true).length,
    registered_parameter_versions_confirmed_draft: registeredAndDraft,
    citations_checked: findings.length,
    distinct_cited_chunks: new Set(findings.map((entry) => entry.chunk_id)).size,
    // The result that actually matters, and it is not the one this unit set out
    // to find. Every needle the citation check requires, across every
    // registered parameter, is a number. Digits survive the visual/logical
    // transform in both directions, so reordering changes nothing about whether
    // a citation matches — which is another way of saying the check has never
    // verified a word of Hebrew. That is exactly how it passed on amendment 15
    // while the seniority band in the parameter disagreed with the clause.
    needles_total: [...new Set(findings.flatMap((entry) => entry.must_contain as string[]))].length,
    needles_non_numeric: [...new Set(findings.flatMap((entry) => entry.must_contain as string[]))]
      .filter((needle) => !/^[\d.,/]+$/u.test(needle)),
    citation_check_verifies_hebrew: false,
    citations_whose_text_moved: moved.length,
    citations_newly_matching_in_v1: newlyMatching.map((entry) => ({
      chunk_id: entry.chunk_id, declared_in: entry.declared_in, needles: entry.newly_matching_in_v1,
    })),
    citations_lost_in_v1: lost.map((entry) => ({
      chunk_id: entry.chunk_id, declared_in: entry.declared_in, needles: entry.lost_in_v1,
    })),
    findings,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "normalizer-v1-citation-recheck.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    sources_total: receipt.sources_total,
    sources_in_visual_order: receipt.sources_in_visual_order,
    citations_checked: receipt.citations_checked,
    citations_whose_text_moved: receipt.citations_whose_text_moved,
    newly_matching: receipt.citations_newly_matching_in_v1.length,
    lost: receipt.citations_lost_in_v1.length,
    v0_texts_modified: 0,
    parameters_rebound: 0,
  }, null, 2)}\n`);
}

await main();
