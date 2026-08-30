import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { legalSourceSchema, type LegalChunk } from "../../src/engine/legal-knowledge/contracts.ts";
import { evaluateStrictRealCorpusReadiness } from "../../src/engine/legal-knowledge/corpus-hardening/readiness.ts";
import { loadCanonicalRoleInventory, loadWorkingTimeCandidateGraph } from "../../src/server/engine/legal-knowledge/wave21-canonical-corpus/canonical-inventory.ts";
import { createReviewedTranscriptRevision, PENSION_2016_OCR_TOOLCHAIN } from "../../src/engine/legal-knowledge/corpus-hardening/pension-ocr.ts";
import { classifyStagedArtifact } from "../../src/engine/legal-knowledge/corpus-hardening/source-roles.ts";

const root = process.cwd();
const output = path.join(root, "output", "parallel-wave-2.1", "workers", "w2-canonical-corpus");
const beforePath = path.join(output, "convalescence-before.chunks.json");
const fetchStatePath = path.join(root, "eval", "legal-knowledge", "manifests", "fetch-state.json");
const buildStatePath = path.join(root, "eval", "legal-knowledge", "manifests", "build-state.json");
const reproducibilityPath = path.join(root, "output", "legal-knowledge", "clean-room-reproducibility-report.json");
const manifestPath = path.join(root, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)])) : value;
const stableJson = (value: unknown) => `${JSON.stringify(stable(value), null, 2)}\n`;
async function json<T>(file: string) { return JSON.parse(await readFile(file, "utf8")) as T; }
async function emit(name: string, value: unknown) { const text = stableJson(value); await writeFile(path.join(output, name), text); return sha256(text); }

await mkdir(output, { recursive: true });
const before = (await json<{ chunks: LegalChunk[] }>(beforePath)).chunks;
const fetchState = await json<{ observations: Array<{ source_id: string; parse_status: string; chunks_path?: string }> }>(fetchStatePath);
const selected = fetchState.observations.find((entry) => entry.source_id === "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025" && entry.parse_status === "parsed");
if (!selected?.chunks_path) throw new Error("canonical_convalescence_build_missing");
const after = (await json<{ chunks: LegalChunk[] }>(path.join(root, selected.chunks_path))).chunks;
const afterByTextHash = new Map(after.map((chunk) => [sha256(chunk.text), chunk.chunk_id]));
const mappings = before.map((chunk) => {
  const mapped = afterByTextHash.get(sha256(chunk.text)) ?? null;
  const inDeclaredPages = chunk.page_from !== null && chunk.page_from >= 16 && chunk.page_from <= 25;
  return { before_chunk_id: chunk.chunk_id, page_from: chunk.page_from, text_sha256: sha256(chunk.text), after_chunk_id: mapped, disposition: mapped ? "stable_text_rechunked" : inDeclaredPages ? "mixed_boundary_or_resegmented" : "outside_registered_instrument" };
});
const excluded = before.filter((chunk) => !afterByTextHash.has(sha256(chunk.text)));
const excludedGroups = {
  pre_instrument: excluded.filter((chunk) => chunk.page_from !== null && chunk.page_from < 16),
  mixed_page_16: excluded.filter((chunk) => chunk.page_from === 16),
  mixed_page_25: excluded.filter((chunk) => chunk.page_from === 25),
  post_instrument: excluded.filter((chunk) => chunk.page_from !== null && chunk.page_from > 25),
};
const cli = path.join(root, "scripts", "legal-sources.mts");
const searchProofs = Object.entries(excludedGroups).map(([label, chunks]) => {
  if (chunks.length === 0) throw new Error(`negative_group_empty:${label}`);
  const distinctive = chunks[0].text.replace(/\s+/gu, " ").trim().slice(0, 80);
  const stdout = execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", cli, "search", "--topic", "convalescence", "--sector", "general", "--date", "2025-01-01", "--limit", "50", "--keywords", distinctive], { cwd: root, encoding: "utf8" });
  const result = JSON.parse(stdout) as { results: Array<{ chunk_id: string }> };
  const excludedIds = new Set(chunks.map((chunk) => chunk.chunk_id));
  const leaked = result.results.filter((entry) => excludedIds.has(entry.chunk_id)).map((entry) => entry.chunk_id);
  if (leaked.length) throw new Error(`canonical_search_leak:${label}:${leaked.join(",")}`);
  return { label, command: "scripts/legal-sources.mts search", distinctive_text_sha256: sha256(distinctive), excluded_candidate_chunk_ids: [...excludedIds].sort(), returned_chunk_ids: result.results.map((entry) => entry.chunk_id), leaked_chunk_ids: leaked, passed: true };
});
const roleInventory = loadCanonicalRoleInventory();
const graph = loadWorkingTimeCandidateGraph();
const manifest = await json<{ sources: unknown[] }>(manifestPath);
const buildState = await json<{ records: Array<{ source_id: string; source_version: string; parse_status: string; safe_error_code: string | null }> }>(buildStatePath);
const readiness = evaluateStrictRealCorpusReadiness({ sources: manifest.sources.map((source: unknown) => legalSourceSchema.parse(source)), buildRecords: buildState.records.map((record) => ({ source_version_id: `${record.source_id}@${record.source_version}`, parse_status: record.parse_status })), citationRecords: [], stagedArtifacts: [classifyStagedArtifact({ sourceVersionId: "SYNTHETIC_STAGED@evidence-v1", artifactId: `artifact:${"f".repeat(64)}` })] });
const reproducibility = await json<Record<string, unknown>>(reproducibilityPath);
const pensionRevision = createReviewedTranscriptRevision({ revision: 1, parent_revision_sha256: null, raw_pdf_sha256: PENSION_2016_OCR_TOOLCHAIN.source_pdf_sha256, rendered_page_sha256: PENSION_2016_OCR_TOOLCHAIN.renderer.expected_page_sha256, raw_ocr_page_sha256: ["1".repeat(64), "2".repeat(64), "3".repeat(64)], normalized_page_sha256: ["4".repeat(64), "5".repeat(64), "6".repeat(64)], reviewed_transcript_page_sha256: ["7".repeat(64), "8".repeat(64), "9".repeat(64)], reviewer_id: "synthetic-reviewer", reviewed_at: "2026-08-29T12:00:00Z", decision: "synthetic_reject" });
const chunkInventory = { schema_version: "convalescence-canonical-chunk-mapping-v0.4.1", source_version_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025@discovery-v0.3.1", container_artifact_sha256: "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa", instrument_id: "GAZETTE-3384:CHAPTER-7:SECTION-24", review_state: "needs_review", activation_state: "inactive", before_chunk_count: before.length, after_chunk_count: after.length, mappings, after_chunks: after.map((chunk) => ({ chunk_id: chunk.chunk_id, page_from: chunk.page_from, page_to: chunk.page_to, text_sha256: sha256(chunk.text), citation_eligible: true, retrieval_eligible: true })) };
const hashes: Record<string, string> = {};
hashes["source-role-inventory.json"] = await emit("source-role-inventory.json", roleInventory);
hashes["working-time-candidate-graph.json"] = await emit("working-time-candidate-graph.json", graph);
hashes["readiness-matrix.json"] = await emit("readiness-matrix.json", readiness);
hashes["convalescence-chunk-mapping.json"] = await emit("convalescence-chunk-mapping.json", chunkInventory);
hashes["canonical-search-negative-evidence.json"] = await emit("canonical-search-negative-evidence.json", { schema_version: "canonical-search-negative-evidence-v0.4.1", proofs: searchProofs });
hashes["reproducibility.json"] = await emit("reproducibility.json", reproducibility);
hashes["pension-transcript-revision.json"] = await emit("pension-transcript-revision.json", pensionRevision);
await emit("summary.json", { schema_version: "wave21-w2-canonical-corpus-evidence-v0.4.1", status: "LEGAL_SOURCE_CORPUS_INCOMPLETE", active_sources: 0, reviewed_sources: 0, parameters_activated: 0, legal_effect_inferred: false, canonical_search_negative_cases: searchProofs.length, source_role_count: roleInventory.source_count, working_time_nodes: graph.node_count, readiness_topic_count: readiness.topic_count, readiness_strict_exit_code: readiness.strict_exit_code, convalescence_before_chunks: before.length, convalescence_after_chunks: after.length, canonical_build: { parsed: buildState.records.filter((record) => record.parse_status === "parsed").length, failed: buildState.records.filter((record) => record.parse_status !== "parsed").map((record) => ({ source_version_id: `${record.source_id}@${record.source_version}`, parse_status: record.parse_status, safe_error_code: record.safe_error_code })) }, reproducibility_passed: reproducibility.passed === true, evidence_sha256: hashes });
console.log(JSON.stringify({ status: "LEGAL_SOURCE_CORPUS_INCOMPLETE", evidence_sha256: hashes }));
if (process.argv.includes("--strict")) process.exitCode = 2;
