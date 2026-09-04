// Addendum 5 Pool P, Addendum 6 §A6-5 owner-decision mapping. Imports real
// (non-synthetic) draft parameter candidates bound to Pool D fetched
// artifacts, via the exact same private.governance_parameter_import path
// P-0 proved. Every candidate here: state draft, zero attestations,
// activation_allowed stays false at the database level regardless of what
// this script does (only governance_parameter_attestation_append can ever
// flip it, and even that only reaches dual_attested_inactive — never
// active). Nothing here reviews a source, activates a rate, or signs
// anything.
//
// Tenant convention (a call this session made, not specified by any
// addendum — flagged for the owner to confirm or rename): every Pool
// P/S/R/Q unit in this session uses the fixed, non-random tenant
// "legal.reference.il", so the draft catalog is durable and findable
// across runs and across Session B, unlike P-0's own proof script (which
// used a fresh random tenant per run because it was proving the mechanism,
// not building the catalog). A rename later is a plain UPDATE — nothing
// here is attested or activated, so nothing is hard to move.
//
// Binding-hash convention (Addendum 7 A7-2). The formula binds all eleven
// dimensions the tracker's invalidation rule names (§7.3): artifact
// SHA-256, parsed version hash, parser version, normalizer version, exact
// citation locator, value, unit, effective interval, sector, population,
// dossier SHA-256, source-set hash. The existing DependencyBindings shape
// (8 named fields, used everywhere from synthetic-fixtures.ts to the DB
// attestation-binding check) is unchanged — changing it would break every
// existing candidate, including the ones already imported this session —
// so the eleven dimensions are distributed across the 5 fields that carry
// real (non-sentinel) data for a Pool P candidate, each field enriched
// with whatever of the eleven it didn't carry before:
//   - source_bytes_sha256: per cited source, {source_id, source_version,
//     artifact_sha256 [dim 1], parsed_version_id [dim 2], parser_version
//     and normalizer_version [dim 3]} — all four read from
//     eval/legal-knowledge/manifests/build-state.json (the real build
//     pipeline's own record, not recomputed), plus the sorted set of
//     {source_id, source_version} pairs on its own [dim 11: which sources
//     are cited is a distinct fact from what their bytes hash to — adding
//     or removing a citation changes this even if no cited source's own
//     bytes changed].
//   - citations_sha256: the exact chunk_id + locator per citation [dim 4],
//     plus the research dossier's own SHA-256 [dim 10] — the dossier is
//     what a citation's *interpretation* traces back to, even though the
//     citation's *text* is verified independently by must_contain.
//   - interval_sha256: {effective_from, effective_to} [dim 7].
//   - scope_sha256: {sectors, populations} [dims 8, 9].
//   - parameter_set_sha256: {parameter_id, parameter_version, value, unit,
//     rounding_policy} [dims 5, 6].
//   - rule_spec_sha256 / golden_cases_sha256 / reviewer_decisions_sha256:
//     deterministic "unassigned" sentinels, exactly as
//     synthetic-fixtures.ts's syntheticBindings does for the same real
//     reason — no RuleSpec, GoldenCaseSet, or attestation exists at
//     draft-import time. Not a placeholder that could be mistaken for a
//     real hash: each hashes an explicit
//     { pool_p_unassigned: true, kind, topic } marker object.
// Every one of the eleven is covered by its own test in
// pool-p-dependency-hash.test.mts: mutating it, and nothing else, changes
// the resulting bindings_sha256 (the hash of the whole bindings object,
// which is what the DB actually compares — see
// governance_parameter_attestation_append's GOVERNANCE_PARAMETER_ATTESTATION_BINDING_MISMATCH
// check). R-8 (semantic invalidation *closure* — propagating a changed
// bindings_sha256 across every dependent run, report and grant) stays
// deferred to Session B; this only makes the hash itself complete.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertUsableAnchor, checkCitationAnchor } from "../../src/engine/legal-knowledge/citation-anchor.ts";
import { bindCompoundThroughLexicon, bindThroughLexicon } from "../../src/engine/legal-knowledge/numeral-lexicon-v1.ts";
import { buildVisualCitation, visualBindingOf, worstProvenance, type ProvenanceGrade, type VisualCitation } from "../../src/engine/legal-knowledge/visual-citation-v1.ts";
import { extractPagePdf, renderScanPagePng, sha256 as bytesSha256 } from "./visual-page.mts";
import { frozen, legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import { parameterCandidateSchema, type DependencyBindings, type ParameterCandidate } from "../../src/engine/legal-operations/contracts.ts";
import type { Wave3Topic } from "../../src/engine/wave3/contracts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresTransactionContext } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { PostgresParameterApprovalRepository } from "../../src/server/platform/persistence/postgres/governance/repositories.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { computeElevenDimensionBindings } from "./pool-p-dependency-hash.mts";

const DOSSIER_SHA256 = "6ad2caa0995b67e42dc85bc6bb8690b0901f8679ffeb2440713964813c806422";
const TENANT = "legal.reference.il";
const SYSTEM_ACTOR = "system_import";
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
// runtime_context_install requires a non-null reviewer_org_id for every
// session under the operations role, even one that never touches the
// reviewer-trust stack (202609010005_governance_runtime_security.sql:76).
// There is no foreign key from product_identity_sessions.reviewer_org_id to
// governance_reviewer_organizations, so this is a label, not a real trust
// organization — nothing in Pool P's draft-only import path verifies it.
//
// L4-6 made it a function of the target tenant rather than a constant, since a
// batch can now write to the synthetic proof tenant; it is derived inline where
// the session is seeded.
const RECEIPT_ROOT = path.join("output", "next", "pool-p");

// --- Pool D artifact lookup (real fetched bytes, real built chunks) -------

const manifest = JSON.parse(readFileSync(
  path.resolve("src/server/engine/legal-knowledge/legal-sources.v0.json"), "utf8",
)) as { sources: Array<{ source_id: string; source_version: string; content_sha256: string | null; content_integrity?: { status: string } }> };

// Addendum 7 A7-4, defense in depth: contracts.ts's own superRefine already
// forces can_independently_support_monetary_rule to false for a
// title-mismatched source, but citation() below never reads that field —
// it only checks fetched/built status. A citation attempt against a
// quarantined source is refused here too, at the one place every Pool P
// script actually calls to bind a value to a source, not left to a schema
// check three layers away.
function assertNotQuarantined(sourceId: string, sourceVersion: string) {
  const source = manifest.sources.find((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion);
  if (source?.content_integrity?.status === "invalid_content_title_mismatch") {
    throw new Error(`POOL_P_SOURCE_QUARANTINED_TITLE_MISMATCH:${sourceId}@${sourceVersion}`);
  }
}
const fetchState = JSON.parse(readFileSync(
  path.resolve("eval/legal-knowledge/manifests/fetch-state.json"), "utf8",
)) as { observations: Array<{ source_id: string; source_version: string; artifact_sha256: string; status: string; chunks_path: string | null }> };
const buildState = JSON.parse(readFileSync(
  path.resolve("eval/legal-knowledge/manifests/build-state.json"), "utf8",
)) as { records: Array<{ source_id: string; source_version: string; artifact_sha256: string; parsed_version_id: string | null; parser_version: string | null; normalizer_version: string | null; parse_status: string; safe_error_code?: string | null }> };

function selectBuildRecord(sourceId: string, sourceVersion: string, artifactSha256: string) {
  const record = buildState.records.find((entry) =>
    entry.source_id === sourceId && entry.source_version === sourceVersion && entry.artifact_sha256 === artifactSha256);
  if (!record || record.parse_status !== "parsed" || !record.parsed_version_id || !record.parser_version || !record.normalizer_version) {
    throw new Error(`POOL_P_BUILD_RECORD_MISSING:${sourceId}@${sourceVersion}`);
  }
  // Lane B (L5): a parsed record that carries a safe_error_code is parsed with
  // a reservation — an instrument selection, for one — and a whole-artifact
  // citation may not stand on it. Selections cite through selectionCitation().
  if (record.safe_error_code) throw new Error(`POOL_P_BUILD_RECORD_RESERVED:${sourceId}@${sourceVersion}:${record.safe_error_code}`);
  return record;
}

function selectObservation(sourceId: string, sourceVersion: string) {
  const source = manifest.sources.find((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion);
  if (!source) throw new Error(`POOL_P_UNKNOWN_SOURCE:${sourceId}@${sourceVersion}`);
  const matching = [...fetchState.observations].reverse().filter((entry) => entry.source_id === sourceId && entry.source_version === sourceVersion);
  const observation = source.content_sha256
    ? matching.find((entry) => entry.artifact_sha256 === source.content_sha256 && entry.status === "fetched")
      ?? matching.find((entry) => entry.artifact_sha256 === source.content_sha256)
    : matching.find((entry) => entry.status === "fetched");
  if (!observation) throw new Error(`POOL_P_ARTIFACT_NOT_FETCHED:${sourceId}@${sourceVersion}`);
  return observation;
}

const chunkTextCache = new Map<string, Map<string, string>>();
function chunkText(sourceId: string, sourceVersion: string, chunksPath: string, chunkId: string) {
  const key = `${sourceId}@${sourceVersion}`;
  let byId = chunkTextCache.get(key);
  if (!byId) {
    const doc = JSON.parse(readFileSync(path.resolve(chunksPath), "utf8")) as { chunks: Array<{ chunk_id: string; text: string }> };
    byId = new Map(doc.chunks.map((chunk) => [chunk.chunk_id, chunk.text]));
    chunkTextCache.set(key, byId);
  }
  const text = byId.get(chunkId);
  if (text === undefined) throw new Error(`POOL_P_UNKNOWN_CHUNK:${chunkId}`);
  return text;
}

type SourceRef = Readonly<{ source_id: string; source_version: string }>;
/**
 * L5-1 / D1. A citation that binds its figure through the numeral lexicon
 * carries the surface string it bound from, the form that string took, and the
 * rational it resolved to. Absent on every other citation.
 */
type NumeralCitation = Readonly<{ lexicon_version: string; surface: string; numeral_form: string; numerator: string; denominator: string }>;
/**
 * L5-5 / D4. A citation into a selected span carries the selection's hash, and
 * the binding hash carries it on: attesting the parameter attests the boundary.
 */
type SelectionCitation = Readonly<{ selection_id: string; selection_sha256: string }>;
/**
 * L6-2 / D1. Every citation carries its provenance grade; a citation whose
 * figure was read from the page image carries the visual citation itself.
 * `chunk_id` for a visual citation is the table-aware chunk of the same page,
 * so the anchor is still checked against text a person can search.
 */
type Citation = Readonly<{
  source: SourceRef; chunk_id: string; locator: string; must_contain: readonly string[];
  provenance: ProvenanceGrade; numeral?: NumeralCitation; selection?: SelectionCitation; visual?: VisualCitation;
}>;

function citation(source: SourceRef, chunkId: string, locator: string, mustContain: readonly string[]): Citation {
  assertNotQuarantined(source.source_id, source.source_version);
  const observation = selectObservation(source.source_id, source.source_version);
  if (!observation.chunks_path) throw new Error(`POOL_P_SOURCE_NOT_BUILT:${source.source_id}@${source.source_version}`);
  const text = chunkText(source.source_id, source.source_version, observation.chunks_path, chunkId);
  for (const needle of mustContain) {
    if (!text.includes(needle)) throw new Error(`POOL_P_CITATION_TEXT_MISMATCH:${chunkId}:${needle}`);
  }
  return frozen({ source, chunk_id: chunkId, locator, must_contain: mustContain, provenance: "text_verified" });
}

// --- L4-1 / D2: citations against the table-aware chunk set ----------------
//
// A `#t` chunk id resolves in the `.t1.chunks.json` sidecar rather than the v0
// file, and needles are checked against the LOGICAL-order text, because that is
// the text a person reads and the text the anchor check runs on.
//
// The anchor is mandatory here, unlike in `citation()`. The entire reason the
// table-aware chunk set exists is that the v0 rows carried numbers with no
// words beside them; a v1 citation that still could not name its clause in
// Hebrew would have gained nothing. So the anchor is an argument, it is checked
// at authoring time against the same chunk, and there is no way to write one
// without it.
/**
 * Every table-aware citation this process made, in the order it made them.
 * Source scraping cannot see a needle built from a loop variable, and a checker
 * that silently reads an empty needle list would report a pass it never made.
 * A batch script writes this into its receipt and the anchor recheck reads it.
 */
export const TABLE_AWARE_CITATIONS: Array<Readonly<{ chunk_id: string; must_contain: readonly string[]; anchor: string; locator: string }>> = [];

const tableAwareCache = new Map<string, Map<string, { text: string; logical_text: string }>>();
function tableAwareChunk(sourceId: string, sourceVersion: string, chunksPath: string, chunkId: string) {
  const key = `${sourceId}@${sourceVersion}`;
  let byId = tableAwareCache.get(key);
  if (!byId) {
    const sidecar = chunksPath.replace(/\.chunks\.json$/u, ".t1.chunks.json");
    if (!existsSync(path.resolve(sidecar))) throw new Error(`POOL_P_TABLE_AWARE_CHUNKS_MISSING:${key}`);
    const doc = JSON.parse(readFileSync(path.resolve(sidecar), "utf8")) as {
      chunks: Array<{ chunk_id: string; text: string; logical_text: string }>;
    };
    byId = new Map(doc.chunks.map((chunk) => [chunk.chunk_id, { text: chunk.text, logical_text: chunk.logical_text }]));
    tableAwareCache.set(key, byId);
  }
  const chunk = byId.get(chunkId);
  if (!chunk) throw new Error(`POOL_P_UNKNOWN_TABLE_AWARE_CHUNK:${chunkId}`);
  return chunk;
}

/**
 * L5-1 / D1. A citation whose figure is a WORD in the chunk, resolved through
 * `legal-numeral-lexicon-v1`. The surface string must be in the chunk verbatim,
 * the anchor must be in the same chunk, and the resolved rational must equal
 * the value the caller is about to register — so a candidate cannot carry a
 * figure its own citation resolved differently. OCR-mangled fractions refuse
 * here by name; a `numeral_form` is recorded on the citation and travels into
 * the binding hash.
 */
export function lexiconCitation(
  source: SourceRef,
  chunkId: string,
  locator: string,
  surface: string,
  anchor: string,
  expected: Readonly<{ numerator: string; denominator: string }>,
  compound?: Readonly<{ whole: string; additive: string }>,
): Citation {
  assertNotQuarantined(source.source_id, source.source_version);
  if (!chunkId.includes("#t")) throw new Error(`POOL_P_TABLE_AWARE_CHUNK_ID_EXPECTED:${chunkId}`);
  const observation = selectObservation(source.source_id, source.source_version);
  if (!observation.chunks_path) throw new Error(`POOL_P_SOURCE_NOT_BUILT:${source.source_id}@${source.source_version}`);
  const chunk = tableAwareChunk(source.source_id, source.source_version, observation.chunks_path, chunkId);
  const outcome = compound
    ? bindCompoundThroughLexicon(chunk.logical_text, compound.whole, compound.additive)
    : bindThroughLexicon(chunk.logical_text, surface);
  if (outcome.binding === null) throw new Error(`POOL_P_LEXICON_REFUSED:${outcome.refusal}:${chunkId}:${surface}`);
  if (outcome.binding.numerator !== expected.numerator || outcome.binding.denominator !== expected.denominator) {
    throw new Error(`POOL_P_LEXICON_VALUE_MISMATCH:${chunkId}:${surface}:${outcome.binding.numerator}/${outcome.binding.denominator}!=${expected.numerator}/${expected.denominator}`);
  }
  assertUsableAnchor(anchor);
  if (!checkCitationAnchor(chunk.logical_text, anchor).matched) throw new Error(`POOL_P_CITATION_ANCHOR_NOT_IN_CHUNK:${chunkId}`);
  const numeral: NumeralCitation = outcome.binding;
  TABLE_AWARE_CITATIONS.push(frozen({ chunk_id: chunkId, must_contain: [outcome.binding.surface], anchor, locator }));
  return frozen({ source, chunk_id: chunkId, locator, must_contain: [outcome.binding.surface], numeral, provenance: "lexicon" });
}

/**
 * L5-5 / D4. A citation into an instrument SELECTION. The `#s` chunk resolves in
 * the `.s1.chunks.json` the build ledger now points at for that source; the
 * needles are checked against the logical text; the anchor is mandatory, as for
 * every table-aware citation; and the selection's hash is recorded on the
 * citation and carried into the binding hash.
 *
 * `assertNotQuarantined` is deliberately NOT called here. The title-mismatch
 * quarantine says "this artifact is a gazette issue, not the instrument", and
 * the selection is precisely the answer to that — it names the instrument by
 * its own title line and hashes the span. A citation that resolves through a
 * registered selection has resolved the mismatch; one that does not, still
 * refuses through `citation()`.
 */
/** Every occurrence of `needle` in `text` that is not glued to a digit on either side. */
export function standsAsFigure(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + needle.length] ?? "";
    if (!/[0-9]/u.test(before) && !/[0-9]/u.test(after)) return true;
    from = at + 1;
  }
}

export function selectionCitation(
  source: SourceRef,
  chunkId: string,
  locator: string,
  mustContain: readonly string[],
  anchor: string,
): Citation {
  if (!chunkId.includes("#s")) throw new Error(`POOL_P_SELECTION_CHUNK_ID_EXPECTED:${chunkId}`);
  const record = buildState.records.find((entry) => entry.source_id === source.source_id && entry.source_version === source.source_version) as
    (Record<string, unknown> & {
      artifact_sha256?: string; chunks_path?: string | null;
      instrument_selection?: { selection_id: string; selection_sha256: string; page_from: number; page_to: number };
    }) | undefined;
  if (!record?.chunks_path || !record.instrument_selection) throw new Error(`POOL_P_SELECTION_NOT_REGISTERED:${source.source_id}@${source.source_version}`);
  // L5 Lane B: the sidecar is trusted only as far as the ledger vouches for it —
  // it must be the file named for this artifact, carry the ledger's selection
  // hash and page span, and the chunk must lie inside that span.
  if (!path.basename(record.chunks_path).startsWith(`${record.artifact_sha256 ?? ""}.`)) throw new Error(`POOL_P_SELECTION_SIDECAR_NOT_FOR_ARTIFACT:${source.source_id}`);
  const doc = JSON.parse(readFileSync(path.resolve(record.chunks_path), "utf8")) as {
    selection_id: string; selection_sha256: string; page_from: number; page_to: number;
    chunks: Array<{ chunk_id: string; logical_text: string; selection_sha256: string; page_from: number; page_to: number }>;
  };
  const ledger = record.instrument_selection;
  if (doc.selection_sha256 !== ledger.selection_sha256 || doc.selection_id !== ledger.selection_id) throw new Error(`POOL_P_SELECTION_LEDGER_MISMATCH:${source.source_id}`);
  if (doc.page_from !== ledger.page_from || doc.page_to !== ledger.page_to) throw new Error(`POOL_P_SELECTION_SPAN_MISMATCH:${source.source_id}`);
  const chunk = doc.chunks.find((entry) => entry.chunk_id === chunkId);
  if (!chunk) throw new Error(`POOL_P_UNKNOWN_SELECTION_CHUNK:${chunkId}`);
  if (chunk.selection_sha256 !== ledger.selection_sha256) throw new Error(`POOL_P_SELECTION_CHUNK_HASH_MISMATCH:${chunkId}`);
  if (!(chunk.page_from >= ledger.page_from && chunk.page_to <= ledger.page_to)) throw new Error(`POOL_P_SELECTION_CHUNK_OUTSIDE_SPAN:${chunkId}`);
  for (const needle of mustContain) {
    // A figure must stand on its own digits: "418" inside "9418" or "4180" is
    // some other number, and a citation that matched it would be verified
    // against a page number or a date.
    if (!standsAsFigure(chunk.logical_text, needle)) throw new Error(`POOL_P_CITATION_TEXT_MISMATCH:${chunkId}:${needle}`);
  }
  assertUsableAnchor(anchor);
  if (!checkCitationAnchor(chunk.logical_text, anchor).matched) throw new Error(`POOL_P_CITATION_ANCHOR_NOT_IN_CHUNK:${chunkId}`);
  const selection: SelectionCitation = { selection_id: doc.selection_id, selection_sha256: doc.selection_sha256 };
  TABLE_AWARE_CITATIONS.push(frozen({ chunk_id: chunkId, must_contain: [...mustContain], anchor, locator }));
  return frozen({ source, chunk_id: chunkId, locator, must_contain: mustContain, selection, provenance: "selection" });
}

export function tableAwareCitation(
  source: SourceRef,
  chunkId: string,
  locator: string,
  mustContain: readonly string[],
  anchor: string,
): Citation {
  assertNotQuarantined(source.source_id, source.source_version);
  if (!chunkId.includes("#t")) throw new Error(`POOL_P_TABLE_AWARE_CHUNK_ID_EXPECTED:${chunkId}`);
  const observation = selectObservation(source.source_id, source.source_version);
  if (!observation.chunks_path) throw new Error(`POOL_P_SOURCE_NOT_BUILT:${source.source_id}@${source.source_version}`);
  const chunk = tableAwareChunk(source.source_id, source.source_version, observation.chunks_path, chunkId);
  for (const needle of mustContain) {
    if (!chunk.logical_text.includes(needle)) throw new Error(`POOL_P_CITATION_TEXT_MISMATCH:${chunkId}:${needle}`);
  }
  assertUsableAnchor(anchor);
  const verdict = checkCitationAnchor(chunk.logical_text, anchor);
  if (!verdict.matched) throw new Error(`POOL_P_CITATION_ANCHOR_NOT_IN_CHUNK:${chunkId}`);
  TABLE_AWARE_CITATIONS.push(frozen({ chunk_id: chunkId, must_contain: [...mustContain], anchor, locator }));
  return frozen({ source, chunk_id: chunkId, locator, must_contain: mustContain, provenance: "text_verified" });
}


// --- L6-2 / D1: visual citations -------------------------------------------
//
// A figure that is unambiguous in the page image and ambiguous in the text
// layer. The session read it from a render of the artifact's own scan stream;
// the citation carries the page (as a standalone PDF, hashed), the render
// (hashed), the stored text-layer line the figure sits on and what that line
// says, and the reading. The anchor is still mandatory and still checked
// against the same page's table-aware chunk — the words around the figure are
// in the text layer even where the figure is not.
/** Every visual citation this process made, for the receipt and the recheck. */
export const VISUAL_CITATIONS: Array<Readonly<{ chunk_id: string; page: number; line_index: number; text_layer_surface: string | null; visual_reading: string; page_pdf_sha256: string; anchor: string; locator: string }>> = [];

export async function visualCitation(
  source: SourceRef,
  chunkId: string,
  locator: string,
  page: number,
  lineIndex: number,
  textLayerSurface: string | null,
  visualReading: string,
  anchor: string,
): Promise<Citation> {
  const observation = selectObservation(source.source_id, source.source_version);
  const build = selectBuildRecord(source.source_id, source.source_version, observation.artifact_sha256) as { normalized_path?: string | null };
  if (!build.normalized_path) throw new Error(`POOL_P_NORMALIZED_MISSING:${source.source_id}@${source.source_version}`);
  const normalized = JSON.parse(readFileSync(path.resolve(build.normalized_path), "utf8")) as { pages: Array<{ page: number; text: string }> };
  const stored = normalized.pages[page - 1];
  if (!stored || stored.page !== page) throw new Error(`POOL_P_VISUAL_PAGE_MISSING:${source.source_id}:${page}`);
  const lines = stored.text.split("\n");
  const lineText = lines[lineIndex];
  if (lineText === undefined) throw new Error(`POOL_P_VISUAL_LINE_MISSING:${source.source_id}:${page}:${lineIndex}`);
  const artifactBytes = readFileSync(path.resolve(observation.artifact_path));
  if (bytesSha256(artifactBytes) !== observation.artifact_sha256) throw new Error(`POOL_P_ARTIFACT_HASH_MISMATCH:${source.source_id}`);
  const pagePdf = await extractPagePdf(artifactBytes, page);
  const render = await renderScanPagePng(artifactBytes, page);
  const built = buildVisualCitation({
    artifact_sha256: observation.artifact_sha256, page, page_pdf_sha256: bytesSha256(pagePdf), page_image_sha256: bytesSha256(render.png),
    line_index: lineIndex, line_text: lineText, text_layer_surface: textLayerSurface, visual_reading: visualReading,
  });
  if (built.refusal !== null) throw new Error(`POOL_P_VISUAL_CITATION_REFUSED:${built.refusal}`);
  // The anchor: the same page's table-aware chunk must carry it, so the
  // citation can still be found by its words.
  if (!observation.chunks_path) throw new Error(`POOL_P_SOURCE_NOT_BUILT:${source.source_id}@${source.source_version}`);
  const chunk = tableAwareChunk(source.source_id, source.source_version, observation.chunks_path, chunkId);
  assertUsableAnchor(anchor);
  if (!checkCitationAnchor(chunk.logical_text, anchor).matched) throw new Error(`POOL_P_CITATION_ANCHOR_NOT_IN_CHUNK:${chunkId}`);
  VISUAL_CITATIONS.push(frozen({ chunk_id: chunkId, page, line_index: lineIndex, text_layer_surface: textLayerSurface, visual_reading: visualReading, page_pdf_sha256: built.citation.page_pdf_sha256, anchor, locator }));
  TABLE_AWARE_CITATIONS.push(frozen({ chunk_id: chunkId, must_contain: [], anchor, locator }));
  return frozen({ source, chunk_id: chunkId, locator, must_contain: [], provenance: "inferred_visual", visual: built.citation });
}

function buildBindings(input: Readonly<{
  topic: Wave3Topic;
  citations: readonly Citation[];
  effective_from: string;
  effective_to: string | null;
  sectors: readonly string[];
  populations: readonly string[];
  parameter_id: string;
  parameter_version: string;
  value: unknown;
  unit: string;
  rounding_policy: string;
}>): DependencyBindings {
  const sourceRefs = [...new Map(input.citations.map((c) => [`${c.source.source_id}@${c.source.source_version}`, c.source])).values()]
    .sort((a, b) => `${a.source_id}@${a.source_version}`.localeCompare(`${b.source_id}@${b.source_version}`));
  // dim 11 (source-set hash): the identity of which sources are cited,
  // independent of their content — distinct from dim 1, which is about
  // what those same sources' bytes hash to.
  const sourceSet = sourceRefs.map((ref) => `${ref.source_id}@${ref.source_version}`);
  const sources = sourceRefs.map((ref) => {
    const observation = selectObservation(ref.source_id, ref.source_version);
    const build = selectBuildRecord(ref.source_id, ref.source_version, observation.artifact_sha256);
    return {
      ...ref,
      artifact_sha256: observation.artifact_sha256,
      parsed_version_id: build.parsed_version_id as string,
      parser_version: build.parser_version as string,
      normalizer_version: build.normalizer_version as string,
    };
  });
  const citations = [...input.citations].sort((a, b) => (`${a.source.source_id}#${a.chunk_id}`).localeCompare(`${b.source.source_id}#${b.chunk_id}`))
    .map((c) => ({
      source_id: c.source.source_id, source_version: c.source.source_version, chunk_id: c.chunk_id, locator: c.locator,
      ...(c.numeral ? { numeral: c.numeral } : {}), ...(c.selection ? { selection: c.selection } : {}),
      // The grade rides into the hash only when it is not the default, so
      // every text-verified candidate registered before grades existed keeps
      // its hash; a lexicon or selection citation already carried its own key.
      ...(c.provenance === "inferred_visual" || c.provenance === "administrative" ? { provenance: c.provenance } : {}),
      ...(c.visual ? { visual: c.visual } : {}),
    }));
  return computeElevenDimensionBindings({
    topic: input.topic, sourceSet, sources, citations, dossierSha256: DOSSIER_SHA256,
    value: input.value, unit: input.unit, effective_from: input.effective_from, effective_to: input.effective_to,
    sectors: input.sectors, populations: input.populations,
    parameter_id: input.parameter_id, parameter_version: input.parameter_version, rounding_policy: input.rounding_policy,
  });
}

export type DraftParameterInput = Readonly<{
  parameter_id: string;
  parameter_version: string;
  topic: Wave3Topic;
  value: ParameterCandidate["value"];
  unit: string;
  rounding_policy: ParameterCandidate["rounding_policy"];
  effective_from: string;
  effective_to: string | null;
  sectors: readonly string[];
  populations: readonly string[];
  support_roles: readonly ParameterCandidate["support_roles"][number][];
  citations: readonly Citation[];
  decision_id?: string | null;
  branch?: string | null;
}>;

function provenanceFields(citations: readonly Citation[]): { provenance_grade?: ProvenanceGrade; visual_bindings?: readonly { page_pdf_sha256: string; visual_reading: string }[] } {
  const grade = worstProvenance(citations.map((entry) => entry.provenance));
  const visual = citations.filter((entry): entry is Citation & { visual: VisualCitation } => entry.visual !== undefined).map((entry) => visualBindingOf(entry.visual));
  if (grade === "inferred_visual") return { provenance_grade: grade, visual_bindings: visual };
  if (grade === "administrative") return { provenance_grade: grade };
  return {};
}

export function buildCandidate(input: DraftParameterInput): ParameterCandidate {
  const operativeSourceVersionIds = [...new Set(input.citations.map((c) => `${c.source.source_id}@${c.source.source_version}`))];
  const bindings = buildBindings({
    topic: input.topic, citations: input.citations, effective_from: input.effective_from, effective_to: input.effective_to,
    sectors: input.sectors, populations: input.populations, parameter_id: input.parameter_id,
    parameter_version: input.parameter_version, value: input.value, unit: input.unit, rounding_policy: input.rounding_policy,
  });
  const seed = frozen({
    schema_version: "tivdoc-parameter-candidate-v0.6.0" as const,
    parameter_id: input.parameter_id,
    parameter_version: input.parameter_version,
    topic: input.topic,
    value: input.value,
    unit: input.unit,
    rounding_policy: input.rounding_policy,
    effective_from: input.effective_from,
    effective_to: input.effective_to,
    sectors: input.sectors,
    populations: input.populations,
    operative_source_version_ids: operativeSourceVersionIds,
    support_roles: input.support_roles,
    bindings,
    decision_id: input.decision_id ?? null,
    branch: input.branch ?? null,
    // L6-2 / D1: the grade and, for a visual reading, what an attestation must
    // confirm. Present only when the grade is below what the text alone gives,
    // so earlier candidates keep their hashes.
    ...provenanceFields(input.citations),
  });
  return parameterCandidateSchema.parse({ ...seed, candidate_sha256: legalOperationsSha256(seed) });
}

export { citation, TENANT, SYSTEM_ACTOR, DOSSIER_SHA256, computeElevenDimensionBindings };
export type { ElevenDimensionInput } from "./pool-p-dependency-hash.mts";

export type OpenDecisionInput = Readonly<{ decision_id: string; topic: Wave3Topic; question: string; dossier_anchor: string }>;

// --- DEV import runner -----------------------------------------------------

/**
 * L4-6 / D4 (BL-17). Which tenant a batch writes to is an argument now, and it
 * defaults to the reference catalogue because that is what the real batches
 * want. A proof batch passes `SYNTHETIC_PROOF_TENANT` and its rows never touch
 * the catalogue at all — better than flagging them after the fact, which is
 * what E3-3 had to settle for.
 */
export async function importPoolPBatch(
  batchName: string,
  candidates: readonly ParameterCandidate[],
  openDecisions: readonly OpenDecisionInput[] = [],
  target: Readonly<{ tenant: string; session: { sid: string; jti: string }; subject: string }> = {
    tenant: TENANT, session: SYSTEM_SESSION, subject: SYSTEM_ACTOR,
  },
): Promise<void> {
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF");
  if (!adminUrl || !operationsUrl || !projectRef) throw new Error("POOL_P_ENV_MISSING");
  const { default: pg } = await import("pg");
  const { createHash } = await import("node:crypto");
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [target.tenant]);
    const now = Math.floor(Date.now() / 1_000);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$8,$7,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = excluded.valid_after,
         expires_at = excluded.expires_at, reviewer_org_id = excluded.reviewer_org_id`,
      [target.tenant, target.session.sid, target.subject, target.session.jti, now - 5, now + 3_600 * 24 * 365,
        sha256(`${target.tenant}|${target.session.sid}|${target.subject}|${target.session.jti}`), `${target.tenant}.no-attestation-placeholder`],
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_pool_p_import",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.replace(/^\//u, ""), project_ref: projectRef },
  });

  const decisionResults: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const decision of openDecisions) {
      const client = await factory.acquire();
      try {
        await client.query(statement("pool_p_decision_begin", "begin", []));
        await client.query(statement("pool_p_decision_context", "select * from private.runtime_context_install($1,$2,$3)",
          [target.session.sid, target.session.jti, `poolp:decision:${sha256(decision.decision_id).slice(0, 8)}`]));
        const idempotencyKey = `pool-p.decision.${decision.decision_id}`.replace(/[^A-Za-z0-9._:@-]/gu, "_").slice(0, 200);
        await client.query(statement("pool_p_decision_register",
          "select * from private.governance_legal_open_decision_register($1,$2::jsonb,$3,$4,$5)",
          [target.tenant, JSON.stringify(decision), idempotencyKey, sha256(`decision:${decision.decision_id}`), new Date().toISOString()]));
        await client.query(statement("pool_p_decision_commit", "commit", []));
        decisionResults.push({ decision_id: decision.decision_id, state: "registered_or_already_open" });
      } catch (error) {
        await client.query(statement("pool_p_decision_rollback", "rollback", [])).catch(() => undefined);
        // Idempotent replay of an already-open decision raises nothing (the
        // idempotency ledger returns the prior receipt); a genuinely
        // duplicate *first* registration would instead hit legal_open_decisions'
        // primary key. Both are "already open, fine to proceed" here — only
        // report a real failure.
        const message = String((error as Error).message ?? "");
        if (!message.includes("duplicate key value") && !message.includes("legal_open_decisions_pkey")) {
          decisionResults.push({ decision_id: decision.decision_id, error: message.slice(0, 300) });
        } else {
          decisionResults.push({ decision_id: decision.decision_id, state: "already_registered" });
        }
      } finally {
        client.release();
      }
    }
    for (const candidate of candidates) {
      const client = await factory.acquire();
      try {
        await client.query(statement("pool_p_begin", "begin", []));
        await client.query(statement("pool_p_context", "select * from private.runtime_context_install($1,$2,$3)",
          [target.session.sid, target.session.jti, `poolp:${sha256(candidate.parameter_id + candidate.parameter_version).slice(0, 8)}`]));
        const context: PostgresTransactionContext = { client, transaction_id: `poolp:${sha256(candidate.parameter_id + candidate.parameter_version).slice(0, 12)}` };
        const repo = new PostgresParameterApprovalRepository(context, target.tenant);
        const idempotencyKey = `pool-p.import.${candidate.parameter_id}.${candidate.parameter_version}`.replace(/[^A-Za-z0-9._:@-]/gu, "_").slice(0, 200);
        const receipt = await repo.importCandidate(candidate, { idempotency_key: idempotencyKey, occurred_at: new Date().toISOString() });
        const snapshot = await repo.readCurrent("parameter_approval", candidate.parameter_id, candidate.parameter_version);
        await client.query(statement("pool_p_commit", "commit", []));
        results.push({
          parameter_id: candidate.parameter_id, parameter_version: candidate.parameter_version,
          candidate_sha256: candidate.candidate_sha256, state: snapshot.receipt.state,
          revision: snapshot.receipt.revision, idempotent_replay: receipt.idempotent_replay,
        });
      } catch (error) {
        await client.query(statement("pool_p_rollback", "rollback", [])).catch(() => undefined);
        results.push({ parameter_id: candidate.parameter_id, parameter_version: candidate.parameter_version, error: String((error as Error).message).slice(0, 300) });
      } finally {
        client.release();
      }
    }
  } finally {
    await factory.close();
  }

  await mkdir(RECEIPT_ROOT, { recursive: true });
  const receiptPath = path.join(RECEIPT_ROOT, `${batchName}.json`);
  await writeFile(receiptPath, `${JSON.stringify({ tenant: target.tenant, batch: batchName, decisions: decisionResults, results }, null, 2)}\n`);
  const failed = [...decisionResults.filter((r) => "error" in r), ...results.filter((r) => "error" in r)];
  process.stdout.write(`${JSON.stringify({ batch: batchName, total: results.length, failed: failed.length, receipt: receiptPath })}\n`);
  if (failed.length > 0) {
    process.stderr.write(`${JSON.stringify(failed, null, 2)}\n`);
    process.exitCode = 1;
  }
}
