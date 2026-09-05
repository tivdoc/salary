import "./production-refusal.mjs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { legalSourceManifestSchema } from "../src/server/engine/legal-knowledge/manifest.ts";

const SOURCE_ID = "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025";
const SOURCE_VERSION = "discovery-v0.3.1";
const ARTIFACT_SHA256 = "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa";
const ARTIFACT_BYTES = 1_251_894;
const OFFICIAL_URL = "https://fs.knesset.gov.il/25/law/25_lsr_6133485.pdf";
const OBSERVED_AT = "2026-08-29T20:13:44.404Z";

const repoRoot = process.cwd();
const manifestPath = path.resolve(repoRoot, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json");
const fetchStatePath = path.resolve(repoRoot, "eval", "legal-knowledge", "manifests", "fetch-state.json");
const artifactPath = path.resolve(repoRoot, "eval", "legal-knowledge", "artifacts", SOURCE_ID, SOURCE_VERSION, `${ARTIFACT_SHA256}.pdf`);
const evidenceTarget = path.resolve(repoRoot, "output", "parallel-wave-1", "worker-evidence", "batch-a-pension-convalescence");

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function assertIgnored(target: string) {
  const relative = path.relative(repoRoot, target).replaceAll("\\", "/");
  const result = spawnSync("git", ["check-ignore", "-q", relative], { cwd: repoRoot, windowsHide: true });
  if (result.status !== 0) throw new Error(`wave1_generated_path_not_ignored:${relative}`);
}

async function atomicJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, stableJson(value), { flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function copyTree(sourceRoot: string, targetRoot: string, inventory: Array<{ path: string; byte_count: number; sha256: string }>, prefix = "") {
  const names = (await readdir(sourceRoot)).sort();
  for (const name of names) {
    const source = path.join(sourceRoot, name);
    const relative = path.join(prefix, name);
    const target = path.join(targetRoot, relative);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error("wave1_evidence_symlink_rejected");
    if (info.isDirectory()) await copyTree(source, targetRoot, inventory, relative);
    else if (info.isFile()) {
      const bytes = await readFile(source);
      await mkdir(path.dirname(target), { recursive: true });
      if (existsSync(target)) {
        const existing = await readFile(target);
        if (!existing.equals(bytes)) throw new Error("wave1_evidence_immutable_mismatch");
      } else await copyFile(source, target);
      inventory.push({ path: relative.replaceAll("\\", "/"), byte_count: bytes.byteLength, sha256: sha256(bytes) });
    } else throw new Error("wave1_evidence_non_regular_file_rejected");
  }
}

async function main() {
  const workerRootOption = option("--worker-root");
  if (!workerRootOption) throw new Error("worker_root_required");
  const workerRoot = await realpath(path.resolve(workerRootOption));
  const sourceEvidenceRoot = path.join(workerRoot, "output", "legal-knowledge", "wave1-pension-convalescence");
  const sourceArtifact = path.join(sourceEvidenceRoot, "convalescence-2025", "artifacts", `${ARTIFACT_SHA256}.pdf`);
  const canonicalSourceArtifact = await realpath(sourceArtifact);
  if (!canonicalSourceArtifact.startsWith(`${sourceEvidenceRoot}${path.sep}`)) throw new Error("worker_artifact_path_escape");
  const sourceInfo = await lstat(canonicalSourceArtifact);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("worker_artifact_not_regular_file");
  const bytes = await readFile(canonicalSourceArtifact);
  if (bytes.byteLength !== ARTIFACT_BYTES || sha256(bytes) !== ARTIFACT_SHA256) throw new Error("worker_artifact_hash_or_size_mismatch");

  const manifest = legalSourceManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const source = manifest.sources.find((entry) => entry.source_id === SOURCE_ID && entry.source_version === SOURCE_VERSION);
  if (!source || source.canonical_url !== OFFICIAL_URL || source.status !== "needs_review") throw new Error("wave1_manifest_source_binding_missing");
  const effectiveMetadataHash = sha256(stableJson({
    source_id: source.source_id,
    source_version: source.source_version,
    source_type: source.source_type,
    title: source.title,
    publication_reference: source.publication_reference,
    published_at: source.published_at,
    effective_from: source.effective_from,
    effective_to: source.effective_to,
    effective_period: source.effective_period,
    language: source.language,
    artifact_format: source.artifact_format,
    topics: source.topics,
    sectors: source.sectors,
    authority: source.authority,
  }));

  assertIgnored(artifactPath);
  assertIgnored(evidenceTarget);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  if (existsSync(artifactPath)) {
    const existing = await readFile(artifactPath);
    if (!existing.equals(bytes)) throw new Error("wave1_artifact_immutable_mismatch");
  } else await copyFile(canonicalSourceArtifact, artifactPath);

  const fetchState = JSON.parse(await readFile(fetchStatePath, "utf8")) as { schema_version: string; observations: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>> };
  const existing = fetchState.observations.find((entry) => entry.source_id === SOURCE_ID && entry.source_version === SOURCE_VERSION && entry.artifact_sha256 === ARTIFACT_SHA256);
  if (!existing) fetchState.observations.push({
    source_id: SOURCE_ID,
    source_version: SOURCE_VERSION,
    artifact_sha256: ARTIFACT_SHA256,
    effective_metadata_hash: effectiveMetadataHash,
    final_url: OFFICIAL_URL,
    content_type: "application/pdf",
    byte_count: ARTIFACT_BYTES,
    retrieved_at: OBSERVED_AT,
    artifact_path: path.relative(repoRoot, artifactPath).replaceAll("\\", "/"),
    safe_http_metadata: {
      "content-length": String(ARTIFACT_BYTES),
      "content-type": "application/pdf",
      etag: "\"0e9481535a1db1:0\"",
      "last-modified": "Sun, 30 Mar 2025 05:32:10 GMT",
    },
    redirect_count: 0,
    redirect_chain: [OFFICIAL_URL],
    status: "fetched",
    parser_version: null,
    normalized_text_sha256: null,
    normalized_path: null,
    chunks_path: null,
    chunk_count: 0,
    page_count: 0,
    parse_status: "not_built",
    safe_error_code: null,
  });
  fetchState.observations.sort((left, right) => `${left.source_id}@${left.source_version}#${left.artifact_sha256}`.localeCompare(`${right.source_id}@${right.source_version}#${right.artifact_sha256}`));
  await atomicJson(fetchStatePath, fetchState);

  const evidenceInventory: Array<{ path: string; byte_count: number; sha256: string }> = [];
  await copyTree(sourceEvidenceRoot, evidenceTarget, evidenceInventory);
  evidenceInventory.sort((left, right) => left.path.localeCompare(right.path));
  await atomicJson(path.join(evidenceTarget, "integration-inventory.json"), {
    schema_version: "wave1-worker-evidence-inventory-v0.3.1",
    source_worker_root_redacted: "batch-a-pension-convalescence-worktree",
    imported_artifact_sha256: ARTIFACT_SHA256,
    files: evidenceInventory,
  });
  process.stdout.write(`${stableJson({ status: "WAVE1_EVIDENCE_INTEGRATED", artifact_sha256: ARTIFACT_SHA256, evidence_files: evidenceInventory.length })}`);
}

await main();
