import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LegalSource } from "../../src/engine/legal-knowledge/contracts.ts";
import { classifyRegisteredSourceRole } from "../../src/engine/legal-knowledge/corpus-hardening/source-roles.ts";
import {
  buildConvalescenceChunkTransition,
  buildCorpusSourceTransitionLedger,
  buildNetChunkDeltaLedger,
  type CorpusBuildRecord,
  type TransitionChunk,
} from "../../src/engine/legal-knowledge/corpus-hardening/corpus-transition.ts";
import { createReviewedTranscriptRevision, sha256, stableJson } from "../../src/engine/legal-knowledge/corpus-hardening/pension-ocr.ts";
import { LEGAL_READINESS_CASES, LEGAL_READINESS_CASE_EXPECTATION } from "../../src/engine/legal-knowledge/canonical-readiness/case-registry.ts";
import { evaluateLegalReadiness, type LegalReadinessCandidate } from "../../src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts";
import {
  futureLegalActivationAdmission,
  futureLegalShadowAdmission,
  legalCorpusTopicGate,
  legalReadinessDiagnostic,
  legalReadinessStrict,
  legalServerResolverAdmission,
} from "../../src/engine/legal-knowledge/canonical-readiness/delegates.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");
const outputDefault = path.join(repoRoot, "output", "parallel-wave-2.2", "workers", "w2-corpus-readiness");
const manifestPath = path.join(repoRoot, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json");

type BuildStateRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  parse_status: "parsed" | "parse_failed";
  safe_error_code: string | null;
  chunk_count: number;
  chunks_path: string | null;
  parsed_version_id: string | null;
}>;

const parseArg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
};
const readJson = async <T>(filePath: string) => JSON.parse(await readFile(filePath, "utf8")) as T;
const evidenceHash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");

function toTransitionRecord(source: LegalSource, build: BuildStateRecord, chunkIds: readonly string[]): CorpusBuildRecord {
  return {
    source_id: source.source_id,
    source_version: source.source_version,
    artifact_sha256: build.artifact_sha256,
    acquisition_status: "acquired",
    parse_status: build.parse_status,
    safe_error_code: build.safe_error_code,
    chunk_count: build.chunk_count,
    chunk_ids: chunkIds,
    // No legal-review assertion is inferred from acquisition/build state.
    citation_status: "unverified",
    interval_status: "unverified",
    sector_status: "unverified",
    population_status: "unverified",
    review_status: source.status,
    activation_status: "inactive",
    role: classifyRegisteredSourceRole(source),
  };
}

async function chunkDocument(filePath: string) {
  return (await readJson<{ chunks: TransitionChunk[] }>(filePath)).chunks;
}

async function generate(corpusRoot: string, outputRoot: string) {
  const manifest = await readJson<{ sources: LegalSource[] }>(manifestPath);
  const buildStatePath = path.join(corpusRoot, "eval", "legal-knowledge", "manifests", "build-state.json");
  const buildState = await readJson<{ records: BuildStateRecord[] }>(buildStatePath);
  const normalizedRoot = path.join(corpusRoot, "eval", "legal-knowledge", "normalized");
  const convalescenceDirectory = path.join(normalizedRoot, "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025", "discovery-v0.3.1");
  const oldConvalescence = await chunkDocument(path.join(convalescenceDirectory, "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa.2c7b134d2c67feddbaee804c6eaf6a333fbd19f8b700805c4b3bef2d7915fe11.chunks.json"));
  const newConvalescence = await chunkDocument(path.join(convalescenceDirectory, "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa.0a3f6a577e99580820aa535c59247799f0463be8599da26bc5360a68877f3f1d.chunks.json"));
  const permitChunks = await chunkDocument(path.join(normalizedRoot, "IL_GENERAL_OVERTIME_PERMIT_2018", "discovery-v0.1", "c11623a168aa157331afacbe74e9d64c1c4714755fa02efa5e86affd5c4893f9.5c9a95324843c2cc562c5578043d9fd95e15a951bdc58b8b16772242b357f452.chunks.json"));
  const attachmentChunks = await chunkDocument(path.join(normalizedRoot, "IL_CONVALESCENCE_EXTENSION_ORDER_2023", "discovery-v0.2", "1b7228630a815e00c583377ce3c7eb08f4a52dbfb08b75cb25da1effd44fd9b2.9069a0eb0d9ab6b68326c3eb6f29207c6ad885080ba62ee6cc8641cb0fee6bcd.chunks.json"));
  const after = await Promise.all(manifest.sources.map(async (source) => {
    const build = buildState.records.find((record) => record.source_id === source.source_id && record.source_version === source.source_version);
    if (!build) throw new Error(`build_record_missing:${source.source_id}`);
    const chunks = build.chunks_path && build.parse_status === "parsed" ? await chunkDocument(path.resolve(corpusRoot, build.chunks_path)) : [];
    return toTransitionRecord(source, build, chunks.map((chunk) => chunk.chunk_id));
  }));
  const before = after.map((record) => {
    if (record.source_id === "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025") return { ...record, parse_status: "parsed" as const, safe_error_code: null, chunk_count: 65, chunk_ids: oldConvalescence.map((chunk) => chunk.chunk_id) };
    if (record.source_id === "IL_GENERAL_OVERTIME_PERMIT_2018") return { ...record, parse_status: "parsed" as const, safe_error_code: null, chunk_count: 12, chunk_ids: permitChunks.map((chunk) => chunk.chunk_id) };
    if (record.source_id === "IL_CONVALESCENCE_EXTENSION_ORDER_2023") return { ...record, parse_status: "parsed" as const, safe_error_code: null, chunk_count: 6, chunk_ids: attachmentChunks.map((chunk) => chunk.chunk_id) };
    return record;
  });
  const sourceTransition = buildCorpusSourceTransitionLedger(before, after);
  const convalescence = buildConvalescenceChunkTransition(oldConvalescence, newConvalescence);
  const deltaLedger = buildNetChunkDeltaLedger({ convalescence, permitOldChunks: permitChunks, attachmentOldChunks: attachmentChunks });

  const buildByVersion = new Map(buildState.records.map((record) => [`${record.source_id}@${record.source_version}`, record]));
  const candidates: LegalReadinessCandidate[] = manifest.sources.map((source) => {
    const build = buildByVersion.get(`${source.source_id}@${source.source_version}`)!;
    return {
      source_version_id: `${source.source_id}@${source.source_version}`,
      topics: source.topics,
      parse_succeeded: build.parse_status === "parsed",
      citation_verified: false,
      operative_role_eligible: classifyRegisteredSourceRole(source).eligible_for_operative_resolution,
      human_reviewed: false,
      effective_interval_verified: false,
      verified_sectors: [],
      verified_populations: [],
      active: false,
    };
  });
  const decisions = LEGAL_READINESS_CASES.map((readinessCase) => evaluateLegalReadiness({ readinessCase, candidates }));
  if (decisions.length !== 28 || decisions.some((decision) => decision.status !== LEGAL_READINESS_CASE_EXPECTATION.status || stableJson(decision.reason_codes) !== stableJson(LEGAL_READINESS_CASE_EXPECTATION.reason_codes))) throw new Error("seven_topic_readiness_matrix_must_match_frozen_blocked_reasons");
  const probeCase = LEGAL_READINESS_CASES[0];
  const delegates = [
    legalReadinessDiagnostic(probeCase, candidates),
    legalReadinessStrict(probeCase, candidates),
    legalCorpusTopicGate(probeCase, candidates),
    legalServerResolverAdmission(probeCase, candidates),
    futureLegalActivationAdmission(probeCase, candidates),
    futureLegalShadowAdmission(probeCase, candidates),
  ];
  if (new Set(delegates.map((entry) => entry.decision.decision_sha256)).size !== 1) throw new Error("readiness_delegate_divergence");

  const pensionBundlePath = path.join(corpusRoot, "output", "parallel-wave-2", "batch-a", "corpus-hardening", "pension-2016-ocr", "run-a", "derived-bundle.json");
  const pensionBundle = await readJson<{ source_pdf_sha256: string; pages: Array<{ rendered_page_sha256: string; raw_ocr_sha256: string; normalized_text_sha256: string }> }>(pensionBundlePath);
  const immutable = {
    raw_pdf_sha256: pensionBundle.source_pdf_sha256,
    rendered_page_sha256: pensionBundle.pages.map((page) => page.rendered_page_sha256),
    raw_ocr_page_sha256: pensionBundle.pages.map((page) => page.raw_ocr_sha256),
    normalized_page_sha256: pensionBundle.pages.map((page) => page.normalized_text_sha256),
  };
  const revision1 = createReviewedTranscriptRevision({
    revision: 1,
    parent_revision_sha256: null,
    ...immutable,
    reviewed_transcript_page_sha256: immutable.normalized_page_sha256.map((hash, index) => sha256(`fixture-review-v1:${index + 1}:${hash}`)),
    reviewer_id: "synthetic-transcript-contract-reviewer",
    reviewed_at: "2026-08-29T10:00:00Z",
    decision: "synthetic_reject",
  });
  const revision2 = createReviewedTranscriptRevision({
    revision: 2,
    parent_revision_sha256: revision1.revision_sha256,
    ...immutable,
    reviewed_transcript_page_sha256: immutable.normalized_page_sha256.map((hash, index) => sha256(`fixture-review-v2:${index + 1}:${hash}`)),
    reviewer_id: "synthetic-transcript-contract-reviewer",
    reviewed_at: "2026-08-29T11:00:00Z",
    decision: "synthetic_reject",
  });
  const pensionRevisions = Object.freeze({
    schema_version: "pension-transcript-revision-evidence-v0.4.2",
    evidence_kind: "contract_fixture_only_not_legal_review",
    source_review_state: "needs_review",
    activation_state: "inactive",
    immutable_raw_evidence_preserved: revision1.raw_pdf_sha256 === revision2.raw_pdf_sha256 && stableJson(revision1.raw_ocr_page_sha256) === stableJson(revision2.raw_ocr_page_sha256),
    revisions: [revision1, revision2],
  });
  const selectorFixtures = Object.freeze({
    schema_version: "multi-instrument-selector-fixtures-v0.4.2",
    fixtures: [
      { fixture_id: "MULTI_INSTRUMENT_GAZETTE_001", source_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025", artifact_sha256: after.find((record) => record.source_id === "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025")!.artifact_sha256, container_chunks: 65, selected_instrument_chunks: 11, selected_pages: { from: 16, to: 25 }, old_chunk_ids: oldConvalescence.map((chunk) => chunk.chunk_id), current_chunk_ids: newConvalescence.map((chunk) => chunk.chunk_id), review_state: "needs_review", activation_state: "inactive", legal_effect_assessed: false },
      { fixture_id: "MULTI_INSTRUMENT_PERMIT_001", source_id: "IL_GENERAL_OVERTIME_PERMIT_2018", artifact_sha256: after.find((record) => record.source_id === "IL_GENERAL_OVERTIME_PERMIT_2018")!.artifact_sha256, old_chunks: 12, old_chunk_ids: permitChunks.map((chunk) => chunk.chunk_id), current_chunks: 0, current_parse_status: "parse_failed", safe_error_code: "instrument_selector_pending_human_review", review_state: "needs_review", activation_state: "inactive", legal_effect_assessed: false },
      { fixture_id: "PERMIT_ATTACHMENT_BOUNDARY_001", source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2023", artifact_sha256: after.find((record) => record.source_id === "IL_CONVALESCENCE_EXTENSION_ORDER_2023")!.artifact_sha256, old_chunks: 6, old_chunk_ids: attachmentChunks.map((chunk) => chunk.chunk_id), current_chunks: 0, current_parse_status: "parse_failed", safe_error_code: "instrument_selector_pending_human_review", review_state: "needs_review", activation_state: "inactive", legal_effect_assessed: false },
    ],
  });

  const artifacts: Record<string, unknown> = {
    "source-transition-ledger.json": sourceTransition,
    "convalescence-65-to-11.json": convalescence,
    "chunk-delta-72.json": deltaLedger,
    "readiness-case-matrix.json": { schema_version: "seven-topic-readiness-case-matrix-v0.4.2", cases: LEGAL_READINESS_CASES, decisions },
    "readiness-delegation.json": { schema_version: "canonical-readiness-delegation-v0.4.2", sole_decision_source: "evaluateLegalReadiness", delegates, identical_decision_sha256: true },
    "multi-instrument-fixtures.json": selectorFixtures,
    "pension-transcript-revisions.json": pensionRevisions,
  };
  await mkdir(outputRoot, { recursive: true });
  for (const [name, artifact] of Object.entries(artifacts)) await writeFile(path.join(outputRoot, name), stableJson(artifact), "utf8");
  const evidenceManifest = {
    schema_version: "wave22-w2-corpus-readiness-evidence-manifest-v0.4.2",
    status: "BLOCKED_NOT_READY",
    corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    source_counts: sourceTransition.counts,
    source_transition_count: sourceTransition.entries.length,
    chunk_delta_record_count: deltaLedger.records.length,
    convalescence_counts: convalescence.counts,
    preserved_non_operative_parse_success: sourceTransition.entries.filter((entry) => entry.parse.after === "parsed" && entry.explanatory_or_corroborative_retrieval.after).map((entry) => ({ source_version_id: entry.source_version_id, role: entry.source_role.after })),
    readiness_cases: decisions.length,
    blocked_cases: decisions.filter((decision) => decision.status === "BLOCKED_NOT_READY").length,
    frozen_readiness_reason_codes: LEGAL_READINESS_CASE_EXPECTATION.reason_codes,
    files: Object.entries(artifacts).map(([name, artifact]) => ({ name, sha256: evidenceHash(artifact) })).sort((left, right) => left.name.localeCompare(right.name)),
  };
  await writeFile(path.join(outputRoot, "evidence-manifest.json"), stableJson(evidenceManifest), "utf8");
  return evidenceManifest;
}

const corpusRoot = path.resolve(parseArg("--corpus-root") ?? repoRoot);
const outputRoot = path.resolve(parseArg("--output") ?? outputDefault);
const strict = process.argv.includes("--strict");
try {
  const report = await generate(corpusRoot, outputRoot);
  process.stdout.write(stableJson(report));
  if (strict) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
