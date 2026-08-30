import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { stableJson } from "../../src/engine/legal-knowledge/corpus-hardening/pension-ocr.ts";
import { generateCorpusHardeningEvidence } from "../../src/server/engine/legal-knowledge/wave2-corpus-hardening/corpus-hardening-evidence.ts";
import {
  acquirePinnedHebrewTooling,
  runPinnedPensionOcrTwice,
} from "../../src/server/engine/legal-knowledge/wave2-corpus-hardening/pension-ocr-runner.ts";

const repositoryRoot = process.cwd();
const frozenEvidenceRoot = path.resolve(repositoryRoot, "output", "parallel-wave-2", "batch-a", "corpus-hardening");

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertWithinFrozenEvidenceRoot(target: string) {
  const relative = path.relative(frozenEvidenceRoot, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("evidence_output_outside_frozen_worker_path");
}

async function assertAbsent(target: string) {
  try {
    await access(target, constants.F_OK);
    throw new Error(`output_already_exists:${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function inventory(root: string, excluded = new Set<string>()) {
  const names = await readdir(root, { recursive: true, withFileTypes: true });
  const files = names
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((filePath) => !excluded.has(path.relative(root, filePath).replaceAll("\\", "/")))
    .sort();
  return Promise.all(files.map(async (filePath) => {
    const bytes = await readFile(filePath);
    return Object.freeze({ path: path.relative(root, filePath).replaceAll("\\", "/"), byte_count: bytes.length, sha256: sha256(bytes) });
  }));
}

async function allCommand() {
  const outputRoot = path.resolve(flag("--output") ?? frozenEvidenceRoot);
  assertWithinFrozenEvidenceRoot(outputRoot);
  await assertAbsent(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const corpusStateRoot = path.resolve(flag("--corpus-state-root") ?? repositoryRoot);
  const toolingDirectory = path.join(outputRoot, "tooling");
  const tooling = await acquirePinnedHebrewTooling(toolingDirectory);
  const pensionPdf = path.resolve(flag("--pension-pdf") ?? path.join(corpusStateRoot, "eval", "legal-knowledge", "artifacts", "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016", "discovery-v0.2", "f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70.pdf"));
  const convalescencePdf = path.resolve(flag("--convalescence-pdf") ?? path.join(corpusStateRoot, "eval", "legal-knowledge", "artifacts", "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025", "discovery-v0.3.1", "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa.pdf"));
  const ocr = await runPinnedPensionOcrTwice({
    pdfPath: pensionPdf,
    toolingDirectory,
    outputDirectory: path.join(outputRoot, "pension-2016-ocr"),
    tesseractExecutable: flag("--tesseract") ?? "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
    pdftoppmExecutable: flag("--pdftoppm") ?? "pdftoppm",
  });
  const corpus = await generateCorpusHardeningEvidence({
    repositoryRoot,
    corpusStateRoot,
    evidenceDirectory: path.join(outputRoot, "corpus-evidence"),
    convalescencePdfPath: convalescencePdf,
    pdfinfoExecutable: flag("--pdfinfo") ?? "pdfinfo",
    inspectPermitLive: flag("--offline") !== "true",
  });
  const files = await inventory(outputRoot, new Set(["worker-summary.json"]));
  const summary = Object.freeze({
    schema_version: "wave2-a2-corpus-hardening-worker-evidence-v0.4" as const,
    status: "LEGAL_SOURCE_CORPUS_INCOMPLETE" as const,
    pension_ocr_status: ocr.status,
    pension_ocr_byte_identical_clean_runs: ocr.byte_identical_clean_runs,
    pension_ocr_review_state: ocr.review_state,
    pension_ocr_activation_state: ocr.activation_state,
    source_role_proof: corpus.nonOperativeProof.assertions,
    convalescence_segment: corpus.segmentation.segment,
    working_time_graph: Object.freeze({ nodes: corpus.graph.node_count, edges: corpus.graph.edge_count, safeguards: corpus.graph.safeguards }),
    permit_8753_status: corpus.permit.status,
    readiness: Object.freeze({ topic_count: corpus.readiness.topic_count, ready_topic_count: corpus.readiness.ready_topic_count, strict_exit_code: corpus.readiness.strict_exit_code }),
    counts: corpus.counts,
    network_scope: Object.freeze({ tooling: "official upstream Tesseract artifact and license", permit_diagnostic: "exact already-approved official gov.il URL", bypass: false }),
    invariants: Object.freeze({ reviewed_created: 0, active_created: 0, parameters_created: 0, legal_rules_created: 0, customer_files_read: 0, llm_calls: 0, external_database_connections: 0 }),
    evidence_files_excluding_this_summary: files,
    evidence_inventory_sha256: sha256(stableJson(files)),
    tooling_acquisition_evidence_sha256: sha256(stableJson(tooling.report)),
  });
  await writeFile(path.join(outputRoot, "worker-summary.json"), stableJson(summary), { flag: "wx" });
  process.stdout.write(`${stableJson({ output_root: outputRoot, summary })}`);
}

async function verifyCommand() {
  const outputRoot = path.resolve(flag("--output") ?? frozenEvidenceRoot);
  assertWithinFrozenEvidenceRoot(outputRoot);
  const summary = JSON.parse(await readFile(path.join(outputRoot, "worker-summary.json"), "utf8")) as Readonly<{
    evidence_files_excluding_this_summary: readonly Readonly<{ path: string; byte_count: number; sha256: string }>[];
    evidence_inventory_sha256: string;
  }>;
  if (sha256(stableJson(summary.evidence_files_excluding_this_summary)) !== summary.evidence_inventory_sha256) throw new Error("evidence_inventory_hash_mismatch");
  for (const entry of summary.evidence_files_excluding_this_summary) {
    const filePath = path.resolve(outputRoot, entry.path);
    const relative = path.relative(outputRoot, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("evidence_path_escape");
    const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
    if (!metadata.isFile() || bytes.length !== entry.byte_count || sha256(bytes) !== entry.sha256) throw new Error(`evidence_member_mismatch:${entry.path}`);
  }
  process.stdout.write(`${stableJson({ status: "CORPUS_HARDENING_EVIDENCE_VERIFIED", file_count: summary.evidence_files_excluding_this_summary.length, evidence_inventory_sha256: summary.evidence_inventory_sha256 })}`);
}

async function readinessCommand(strict: boolean) {
  const outputRoot = path.resolve(flag("--output") ?? frozenEvidenceRoot);
  assertWithinFrozenEvidenceRoot(outputRoot);
  const report = JSON.parse(await readFile(path.join(outputRoot, "corpus-evidence", "real-corpus-readiness.json"), "utf8")) as Readonly<{
    decision_source: string;
    status: string;
    strict_gate_passed: boolean;
    strict_exit_code: number;
    topic_count: number;
    ready_topic_count: number;
    reports: readonly unknown[];
  }>;
  if (report.decision_source !== "evaluateLegalReadiness") throw new Error("parallel_readiness_decision_source_rejected");
  process.stdout.write(stableJson({ mode: strict ? "strict_gate" : "diagnostic", ...report }));
  if (strict && !report.strict_gate_passed) process.exitCode = report.strict_exit_code;
}

const command = process.argv[2];
if (command === "all") await allCommand();
else if (command === "verify") await verifyCommand();
else if (command === "readiness") await readinessCommand(false);
else if (command === "readiness-strict") await readinessCommand(true);
else throw new Error("usage: run.mts <all|verify|readiness|readiness-strict> [--output path] [--corpus-state-root path]");
