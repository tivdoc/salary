import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalPayloadSetHash,
  parseOrderedIntegrationLedger,
  validateV0101Assessment,
  type V0101EvidenceEntry,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";
import { inspectDeterministicStoreZip } from "../canonical-persistence-v091/evidence/deterministic-zip.mts";

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const FINAL = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "final");
const MANIFEST_PATH = path.join(FINAL, "manifest.json");
const ARCHIVE_PATH = path.join(FINAL, "tivdoc-v0101-evidence.zip");
const ARCHIVE_HASH_PATH = `${ARCHIVE_PATH}.sha256`;
const OUTPUT_PATH = path.join(FINAL, "detached-verifier-output.json");

const manifestBytes = await ordinaryBytes(MANIFEST_PATH);
const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "V0101_VERIFY_MANIFEST_INVALID");
if (manifest.schema_version !== "tivdoc-canonical-integration-durability-repair-manifest-v0.10.1"
    || manifest.base_head !== BASE
    || manifest.self_reference_rule !== "manifest_archive_hash_and_detached_verifier_are_not_payload_files") {
  throw new Error("V0101_VERIFY_MANIFEST_INVALID");
}
const payload = entries(manifest.payload_files);
if (manifest.payload_file_count !== payload.length
    || manifest.payload_bytes !== payload.reduce((sum, entry) => sum + entry.byte_count, 0)
    || manifest.payload_set_sha256 !== canonicalPayloadSetHash(payload)) {
  throw new Error("V0101_VERIFY_PAYLOAD_SET_INVALID");
}

for (const entry of payload) {
  const bytes = await ordinaryBytes(path.join(FINAL, ...entry.path.split("/")));
  if (bytes.byteLength !== entry.byte_count || sha256(bytes) !== entry.sha256) {
    throw new Error(`V0101_VERIFY_PAYLOAD_BYTES_INVALID:${entry.path}`);
  }
}

const inspection = await inspectDeterministicStoreZip(ARCHIVE_PATH);
const expectedArchive = Object.freeze([
  Object.freeze({ path: "manifest.json", sha256: sha256(manifestBytes), byte_count: manifestBytes.byteLength }),
  ...payload,
].sort((left, right) => left.path.localeCompare(right.path)));
const actualArchive = [...inspection.entries]
  .map((entry) => ({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count }))
  .sort((left, right) => left.path.localeCompare(right.path));
if (JSON.stringify(actualArchive) !== JSON.stringify(expectedArchive)) {
  throw new Error("V0101_VERIFY_ARCHIVE_ENTRY_SET_INVALID");
}

const archiveBytes = await ordinaryBytes(ARCHIVE_PATH);
const archiveSha256 = sha256(archiveBytes);
const declaredHash = (await ordinaryBytes(ARCHIVE_HASH_PATH)).toString("ascii").trim();
if (declaredHash !== `${archiveSha256}  ${path.basename(ARCHIVE_PATH)}`) {
  throw new Error("V0101_VERIFY_ARCHIVE_HASH_INVALID");
}

const assessmentPath = payload.find((entry) => entry.path.endsWith("integration-repair-assessment.v0.10.1.json"))?.path;
const ledgerPath = payload.find((entry) => entry.path.endsWith("integration-repair-ledger.v0.10.1.ndjson"))?.path;
if (!assessmentPath || !ledgerPath) throw new Error("V0101_VERIFY_REQUIRED_PAYLOAD_MISSING");
const assessment = JSON.parse((await ordinaryBytes(path.join(FINAL, ...assessmentPath.split("/")))).toString("utf8"));
validateV0101Assessment(assessment);
parseOrderedIntegrationLedger((await ordinaryBytes(path.join(FINAL, ...ledgerPath.split("/")))).toString("utf8"));

const head = git(["rev-parse", "HEAD"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
if (manifest.final_head !== head || manifest.final_tree !== tree
    || assessment.verified_head !== head || assessment.verified_tree !== tree) {
  throw new Error("V0101_VERIFY_STALE_HEAD");
}
if (spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT }).status !== 0) {
  throw new Error("V0101_VERIFY_BASE_NOT_ANCESTOR");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("V0101_VERIFY_WORKTREE_NOT_CLEAN");
}

const receipt = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-detached-verifier-v0.10.1",
  status: "PASS",
  final_head: head,
  final_tree: tree,
  manifest_sha256: sha256(manifestBytes),
  payload_file_count: payload.length,
  payload_set_sha256: manifest.payload_set_sha256,
  archive_entry_count: inspection.entry_count,
  archive_sha256: archiveSha256,
  traversal_rejected: true,
  duplicate_normalized_paths_rejected: true,
  self_reference_absent: true,
  stale_head_rejected: true,
  contradictory_statuses_rejected: true,
});
await writeFile(OUTPUT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "w", mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);

function entries(value: unknown): V0101EvidenceEntry[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("V0101_VERIFY_PAYLOAD_ENTRIES_INVALID");
  return value.map((item) => {
    const entry = record(item, "V0101_VERIFY_PAYLOAD_ENTRY_INVALID");
    if (typeof entry.path !== "string" || !entry.path.startsWith("payload/")
        || typeof entry.sha256 !== "string" || typeof entry.byte_count !== "number") {
      throw new Error("V0101_VERIFY_PAYLOAD_ENTRY_INVALID");
    }
    return Object.freeze({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count });
  });
}

async function ordinaryBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) {
    throw new Error("V0101_VERIFY_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0101_VERIFY_FILE_CHANGED");
  return bytes;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
