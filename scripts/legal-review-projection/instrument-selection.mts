// L5-5 / L5-6 / L5-7 (D4). Instrument selections over the three multi-instrument
// gazette artifacts, registered through the governance path and chunked.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/instrument-selection.mts
//
// For each artifact: select the instrument by its own title line and the next
// instrument's title line, both verbatim from the stored normalized text;
// register the selection (draft, revision 1) on the reference tenant; chunk the
// selected pages with chunker-v1 under `#s` ids into a `.s1.chunks.json` beside
// the whole-artifact chunk files; and point the build ledger and the fetch
// ledger at that file with `safe_error_code: instrument_selection_draft`.
//
// The anchors below are the stored bytes — visual order, as the layout parser
// left them — and the receipt carries them beside their logical rendering so a
// reader can check them without trusting this file.
//
// The 2016 pension increase order is NOT here. Its ledger record is a technical
// parse failure — `document_sanity_minimum_content_failed`, no normalized text
// on disk, a 64 KB PDF with no text layer — and D4 says: record the class and
// stop. It is recorded in the receipt under `not_selected`.
import "../production-refusal.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INSTRUMENT_SELECTION_DRAFT } from "../../src/engine/legal-knowledge/corpus-hardening/canonical-corpus.ts";
import { END_OF_ARTIFACT, selectInstrument, selectedPages, type InstrumentSelection } from "../../src/engine/legal-knowledge/instrument-selector-v1.ts";
import { hebrewOrderSignal, LEGAL_NORMALIZER_V1_VERSION, normalizeToLogicalOrder } from "../../src/engine/legal-knowledge/normalizer-v1.ts";
import type { LegalSource } from "../../src/engine/legal-knowledge/contracts.ts";
import { chunkLegalPagesTableAware, LEGAL_CHUNKER_VERSION_V1 } from "../../src/server/engine/legal-knowledge/normalization.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "selection");
const NORMALIZED_ROOT = path.join("eval", "legal-knowledge", "normalized");
const BUILD_STATE = path.join("eval", "legal-knowledge", "manifests", "build-state.json");
const FETCH_STATE = path.join("eval", "legal-knowledge", "manifests", "fetch-state.json");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Target = Readonly<{
  selection_id: string;
  source_id: string;
  source_version: string;
  /** The instrument, in words, for the receipt. */
  instrument: string;
  start_anchor: string;
  end_anchor: string;
  topics: readonly string[];
}>;

// Stored bytes. Each is one whole line of `pages[].text`; the receipt shows the
// logical rendering beside it.
const TARGETS: readonly Target[] = [
  {
    selection_id: "selection.IL_CONVALESCENCE_EXTENSION_ORDER_2023.convalescence-order",
    source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2023",
    source_version: "discovery-v0.2",
    instrument: "צו הרחבה בדבר השתתפות המעסיק בהוצאות הבראה ונופש (2023) — the convalescence extension order, gazette page 136",
    start_anchor: ")2023 רבמטפסב 11( ג\"פשתה לולאב ה\"כ תואצוהב קיסעמה תופתתשה רבדב הבחרה וצ",
    end_anchor: "1999-ט\"נשתה ,תורבחה קוח יפל ןוצרמ קוריפ ךילה םויס רבדב תיפוס הפיסא סוניכ לע העדוה",
    topics: ["convalescence"],
  },
  {
    selection_id: "selection.IL_CONVALESCENCE_EXTENSION_ORDER_2026.convalescence-order",
    source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2026",
    source_version: "discovery-v0.2",
    instrument: "צו הרחבה בדבר השתתפות המעסיק בהוצאות הבראה ונופש (2026) — the convalescence extension order, gazette page 9134",
    start_anchor: "תואצוהב קיסעמה תופתתשה רבדב הבחרה וצ .158 'מע ,א\"סשתה ח\"ס 2",
    end_anchor: "תפסות תימואל תיתשתל תויצרא תוינכות רושיא לע העדוה",
    topics: ["convalescence"],
  },
  {
    selection_id: "selection.IL_GENERAL_OVERTIME_PERMIT_2018.general-permit",
    source_id: "IL_GENERAL_OVERTIME_PERMIT_2018",
    source_version: "discovery-v0.1",
    instrument: "הודעה על מתן היתר כללי להעסקת עובדים בשעות נוספות (2018) — the general overtime permit notice, gazette page 6286",
    start_anchor: ".בחרוה אל .1 םידבוע תקסעהל יללכ רתיה ןתמ לע העדוה",
    end_anchor: ".hokrimpz@justice.gov.il תונוישיר ישקבמ לש המישר רבדב העדוה",
    topics: ["working_time"],
  },
];

const NOT_SELECTED = [{
  source_id: "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016",
  source_version: "discovery-v0.2",
  class: "technical_parse_failure",
  detail: "build-state records document_sanity_minimum_content_failed with page_count 0; no normalized text exists on disk; the fetched artifact is a 64,285-byte application/pdf with no text layer. A selection needs text to select over. Recorded, not retried.",
}];

type NormalizedDocument = Readonly<{ artifact_sha256: string; normalized_text_sha256: string; parser_version: string; pages: Array<{ page: number; text: string }> }>;

function normalizedDocument(sourceId: string, sourceVersion: string): Readonly<{ file: string; document: NormalizedDocument }> {
  const dir = path.join(NORMALIZED_ROOT, sourceId, sourceVersion);
  const file = readdirSync(dir).filter((name) => name.endsWith(".normalized.json")).sort()[0];
  if (!file) throw new Error(`L55_NO_NORMALIZED_TEXT:${sourceId}@${sourceVersion}`);
  return { file: path.join(dir, file), document: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as NormalizedDocument };
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("L55_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l55_instrument_selection",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });

  const buildState = JSON.parse(readFileSync(BUILD_STATE, "utf8")) as { records: Array<Record<string, unknown>> };
  const fetchState = JSON.parse(readFileSync(FETCH_STATE, "utf8")) as { observations: Array<Record<string, unknown>> };
  const results: Array<Record<string, unknown>> = [];

  for (const target of TARGETS) {
    const { file, document } = normalizedDocument(target.source_id, target.source_version);
    const outcome = selectInstrument({
      selection_id: target.selection_id,
      source_id: target.source_id,
      source_version: target.source_version,
      artifact_sha256: document.artifact_sha256,
      pages: document.pages,
      start_anchor: target.start_anchor,
      end_anchor: target.end_anchor === "END_OF_ARTIFACT" ? END_OF_ARTIFACT : target.end_anchor,
    });
    if (outcome.selection === null) {
      results.push({ selection_id: target.selection_id, registered: false, refusal: outcome.refusal });
      continue;
    }
    const selection: InstrumentSelection = outcome.selection;

    // --- Register, draft, revision 1, through the governance path.
    const client = await factory.acquire();
    let registered: Record<string, unknown>;
    try {
      await client.query(statement("l55_begin", "begin", []));
      await client.query(statement("l55_context", "select * from private.runtime_context_install($1,$2,$3)",
        [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `l55:${randomUUID().slice(0, 8)}`]));
      const record = {
        selection_id: selection.selection_id,
        selector_version: selection.selector_version,
        source_id: selection.source_id,
        source_version: selection.source_version,
        artifact_sha256: selection.artifact_sha256,
        page_from: selection.page_from,
        page_to: selection.page_to,
        start_anchor: selection.start_anchor,
        start_anchor_logical: selection.start_anchor_logical,
        end_anchor: selection.end_anchor,
        end_anchor_logical: selection.end_anchor_logical,
        selection_sha256: selection.selection_sha256,
        start_anchor_at: selection.start_anchor_at,
        end_anchor_at: selection.end_anchor_at,
        instrument: target.instrument,
        synthetic: false,
      };
      let receipt: Record<string, unknown>;
      try {
        const row = await client.query(statement("l55_register",
          "select * from private.governance_legal_instrument_selection_register($1,$2::jsonb,$3,$4,$5::timestamptz)",
          [TENANT, JSON.stringify(record), `l55.selection.${selection.selection_id}`, sha256(`l55:${selection.selection_id}:${selection.selection_sha256}`), new Date().toISOString()]));
        receipt = row.rows[0] as Record<string, unknown>;
        await client.query(statement("l55_commit", "commit", []));
      } catch (error) {
        await client.query(statement("l55_rollback", "rollback", [])).catch(() => undefined);
        const message = String((error as Error).message ?? "");
        if (!message.includes("GOVERNANCE_SELECTION_ALREADY_REGISTERED")) throw error;
        receipt = { state: "draft", already_registered: true };
      }
      registered = receipt;
    } finally {
      client.release();
    }

    // --- Chunk the selected pages, under #s ids, beside the whole-artifact files.
    const wholeRecord = buildState.records.find((entry) => entry.source_id === target.source_id && entry.source_version === target.source_version);
    if (!wholeRecord) throw new Error(`L55_BUILD_RECORD_MISSING:${target.source_id}`);
    const span = selectedPages(selection, document.pages);
    const facet = { source_id: target.source_id, source_version: target.source_version, topics: target.topics, sectors: ["general"], effective_period: { from: "1900-01-01", to: null }, authority: "primary_legislation" } as unknown as LegalSource;
    const chunks = chunkLegalPagesTableAware(facet, document.artifact_sha256, span, {
      normalizedTextSha256: document.normalized_text_sha256, parserVersion: document.parser_version,
    }, "s");
    const signal = hebrewOrderSignal(chunks.map((chunk) => chunk.text).join("\n"));
    const reorder = signal.visual_order && signal.confident;
    const sidecar = {
      schema_version: "legal-chunks-selection-v1",
      selection_id: selection.selection_id,
      selection_sha256: selection.selection_sha256,
      source_id: target.source_id,
      source_version: target.source_version,
      artifact_sha256: document.artifact_sha256,
      page_from: selection.page_from,
      page_to: selection.page_to,
      chunker_version: LEGAL_CHUNKER_VERSION_V1,
      normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
      note: "Chunks of the SELECTED span only, beside the whole-artifact files, which are untouched. Nothing is rebound by producing this.",
      chunks: chunks.map((chunk) => {
        const logical = reorder ? normalizeToLogicalOrder(chunk.text).text : chunk.text;
        return {
          chunk_id: chunk.chunk_id, source_version_id: chunk.source_version_id, parsed_version_id: chunk.parsed_version_id,
          page_from: chunk.page_from, page_to: chunk.page_to, character_from: chunk.character_from, character_to: chunk.character_to,
          text: chunk.text, chunk_text_sha256: chunk.chunk_text_sha256, logical_text: logical, logical_text_sha256: sha256(logical),
          reordered_from_visual: reorder, selection_sha256: selection.selection_sha256,
        };
      }),
    };
    const body = `${JSON.stringify(sidecar, null, 2)}\n`;
    const chunksPath = path.join(path.dirname(file), `${document.artifact_sha256}.${sha256(body).slice(0, 64)}.s1.chunks.json`);
    writeFileSync(chunksPath, body, "utf8");

    // --- The ledgers point at the selected span, and say why.
    Object.assign(wholeRecord, {
      parse_status: "parsed",
      safe_error_code: INSTRUMENT_SELECTION_DRAFT,
      chunks_path: chunksPath.replaceAll("\\", "/"),
      normalized_path: file.replaceAll("\\", "/"),
      chunk_count: chunks.length,
      chunker_version: LEGAL_CHUNKER_VERSION_V1,
      normalized_text_sha256: document.normalized_text_sha256,
      parser_version: document.parser_version,
      normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
      page_count: document.pages.length,
      parsed_version_id: chunks[0]?.parsed_version_id ?? null,
      chunks_output_sha256: sha256(body),
      instrument_selection: { selection_id: selection.selection_id, selection_sha256: selection.selection_sha256, page_from: selection.page_from, page_to: selection.page_to },
    });
    for (const observation of fetchState.observations) {
      if (observation.source_id === target.source_id && observation.source_version === target.source_version && observation.artifact_sha256 === document.artifact_sha256) {
        observation.chunks_path = chunksPath.replaceAll("\\", "/");
        observation.safe_error_code = INSTRUMENT_SELECTION_DRAFT;
        observation.parse_status = "parsed";
      }
    }

    results.push({
      selection_id: selection.selection_id,
      registered: true,
      state: registered.state ?? "draft",
      already_registered: registered.already_registered === true,
      instrument: target.instrument,
      pages: [selection.page_from, selection.page_to],
      start_anchor: selection.start_anchor,
      start_anchor_logical: selection.start_anchor_logical,
      start_anchor_at: selection.start_anchor_at,
      end_anchor: selection.end_anchor,
      end_anchor_logical: selection.end_anchor_logical,
      end_anchor_at: selection.end_anchor_at,
      selection_sha256: selection.selection_sha256,
      chunks_path: chunksPath.replaceAll("\\", "/"),
      chunk_ids: chunks.map((chunk) => chunk.chunk_id),
      reordered_from_visual: reorder,
    });
  }

  writeFileSync(BUILD_STATE, `${JSON.stringify(buildState, null, 2)}\n`, "utf8");
  writeFileSync(FETCH_STATE, `${JSON.stringify(fetchState, null, 2)}\n`, "utf8");
  await factory.shutdown?.();

  const receipt = {
    schema_version: "tivdoc-instrument-selection-v0.10.17",
    unit: "L5-5",
    tenant: TENANT,
    selector_version: "legal-instrument-selector-v1",
    layout_note: "These gazettes are set in two columns and the layout parser emits one text line per physical row across both. The anchors identify the instrument; the selection unit is the page span they bound, because a line span would cut through the neighbouring column. A selected page can therefore carry other instruments as well, and a citation into it still needs its own Hebrew anchor in the same chunk.",
    selections: results,
    not_selected: NOT_SELECTED,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "instrument-selection.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L5_5_SELECTION ${JSON.stringify({ registered: results.filter((entry) => entry.registered).length, refused: results.filter((entry) => !entry.registered).length, not_selected: NOT_SELECTED.length })}`);
}

await main();
