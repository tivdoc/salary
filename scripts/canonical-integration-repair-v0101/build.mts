import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalPayloadSetHash,
  parseOrderedIntegrationLedger,
  validateV0101Assessment,
  type V0101EvidenceEntry,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";
import { writeDeterministicStoreZip } from "../canonical-persistence-v091/evidence/deterministic-zip.mts";

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const OUTPUT_ROOT = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1");
const WORKING = path.join(OUTPUT_ROOT, "working");
const FINAL = path.join(OUTPUT_ROOT, "final");
const PAYLOAD = path.join(FINAL, "payload");
const MANIFEST = path.join(FINAL, "manifest.json");
const ARCHIVE = path.join(FINAL, "tivdoc-v0101-evidence.zip");
const ARCHIVE_HASH = `${ARCHIVE}.sha256`;
const ASSESSMENT_SOURCE = "src/server/system-marathon/integration-repair-assessment.v0.10.1.json";

const SOURCE_FILES = Object.freeze([
  "src/server/system-marathon/integration-repair-contract.v0.10.1.json",
  "src/server/system-marathon/integration-repair-audit.v0.10.1.json",
  "src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson",
  ASSESSMENT_SOURCE,
  "src/server/system-marathon/canonical-entrypoints.v0.10.0.json",
  "src/server/platform/persistence/wiring-map.ts",
]);

await assertFreshOutput();
const assessmentBytes = await readFile(path.join(ROOT, ASSESSMENT_SOURCE));
const assessment = JSON.parse(assessmentBytes.toString("utf8")) as Record<string, unknown>;
validateV0101Assessment(assessment);
parseOrderedIntegrationLedger(await readFile(path.join(ROOT,
  "src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson"), "utf8"));

const head = gitText(["rev-parse", "HEAD"]);
const tree = gitText(["rev-parse", "HEAD^{tree}"]);
if (assessment.verified_head !== head || assessment.verified_tree !== tree) {
  throw new Error("V0101_BUILD_ASSESSMENT_STALE_HEAD");
}
if (spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT }).status !== 0) {
  throw new Error("V0101_BUILD_BASE_NOT_ANCESTOR");
}
if (gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("V0101_BUILD_WORKTREE_NOT_CLEAN");
}

await mkdir(PAYLOAD, { recursive: true });
for (const source of SOURCE_FILES) await copyOrdinaryFile(path.join(ROOT, source), path.join(PAYLOAD, "repository", source));
for (const source of await ordinaryFiles(WORKING)) {
  const relative = portableRelative(WORKING, source);
  await copyOrdinaryFile(source, path.join(PAYLOAD, "working", ...relative.split("/")));
}

await writeJson(path.join(PAYLOAD, "git", "base-final.json"), {
  schema_version: "tivdoc-canonical-integration-durability-repair-git-v0.10.1",
  branch: gitText(["branch", "--show-current"]),
  base_head: BASE,
  base_tree: gitText(["rev-parse", `${BASE}^{tree}`]),
  final_head: head,
  final_tree: tree,
  base_is_ancestor: true,
  worktree_clean_before_build: true,
});
await writeFile(path.join(PAYLOAD, "git", "full.diff"), gitBytes(["diff", "--binary", "--full-index", `${BASE}..${head}`]));
await writeJson(path.join(PAYLOAD, "git", "commit-receipts.json"), {
  schema_version: "tivdoc-canonical-integration-durability-repair-commits-v0.10.1",
  commits: gitText(["rev-list", "--reverse", `${BASE}..${head}`]).split(/\r?\n/u).filter(Boolean)
    .map((commit, index) => commitReceipt(commit, index + 1)),
});

const payloadFiles = await ordinaryFiles(PAYLOAD);
const payloadEntries: V0101EvidenceEntry[] = [];
for (const file of payloadFiles) {
  const bytes = await readFile(file);
  payloadEntries.push(Object.freeze({
    path: `payload/${portableRelative(PAYLOAD, file)}`,
    sha256: sha256(bytes),
    byte_count: bytes.byteLength,
  }));
}
payloadEntries.sort((left, right) => left.path.localeCompare(right.path));
const manifest = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-manifest-v0.10.1",
  base_head: BASE,
  final_head: head,
  final_tree: tree,
  payload_files: Object.freeze(payloadEntries),
  payload_file_count: payloadEntries.length,
  payload_bytes: payloadEntries.reduce((sum, entry) => sum + entry.byte_count, 0),
  payload_set_sha256: canonicalPayloadSetHash(payloadEntries),
  self_reference_rule: "manifest_archive_hash_and_detached_verifier_are_not_payload_files",
});
await writeJson(MANIFEST, manifest);
await writeDeterministicStoreZip({
  root: FINAL,
  output: ARCHIVE,
  entries: Object.freeze(["manifest.json", ...payloadEntries.map((entry) => entry.path)]),
});
const archiveBytes = await readFile(ARCHIVE);
await writeFile(ARCHIVE_HASH, `${sha256(archiveBytes)}  ${path.basename(ARCHIVE)}\n`, { flag: "wx", mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  schema_version: "tivdoc-canonical-integration-durability-repair-build-v0.10.1",
  status: "PASS",
  final_head: head,
  final_tree: tree,
  payload_file_count: payloadEntries.length,
  payload_set_sha256: manifest.payload_set_sha256,
  archive_sha256: sha256(archiveBytes),
  archive_byte_count: archiveBytes.byteLength,
})}\n`);

async function assertFreshOutput(): Promise<void> {
  try {
    await lstat(FINAL);
    throw new Error("V0101_BUILD_FINAL_ALREADY_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const working = await lstat(WORKING);
  if (!working.isDirectory() || working.isSymbolicLink()) throw new Error("V0101_BUILD_WORKING_INVALID");
}

async function ordinaryFiles(root: string): Promise<string[]> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("V0101_BUILD_SOURCE_ROOT_INVALID");
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("V0101_BUILD_SOURCE_SYMLINK_FORBIDDEN");
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error("V0101_BUILD_SOURCE_NOT_ORDINARY");
    }
  }
  await visit(root);
  return files;
}

async function copyOrdinaryFile(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 16 * 1024 * 1024) {
    throw new Error("V0101_BUILD_SOURCE_FILE_INVALID");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, 1);
}

function portableRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("V0101_BUILD_SOURCE_ESCAPE");
  }
  return relative.split(path.sep).join("/");
}

function commitReceipt(commit: string, ordinal: number): Readonly<Record<string, unknown>> {
  const patch = gitBytes(["show", "--pretty=format:", "--binary", commit]);
  const patchIdProcess = spawnSync("git", ["patch-id", "--stable"], {
    cwd: ROOT,
    input: patch,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (patchIdProcess.status !== 0) throw new Error("V0101_BUILD_PATCH_ID_FAILED");
  const patchId = String(patchIdProcess.stdout).trim().split(/\s+/u)[0];
  if (!patchId || !/^[a-f0-9]{40}$/u.test(patchId)) throw new Error("V0101_BUILD_PATCH_ID_INVALID");
  return Object.freeze({
    ordinal,
    commit,
    tree: gitText(["rev-parse", `${commit}^{tree}`]),
    parents: gitText(["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean),
    subject: gitText(["show", "-s", "--format=%s", commit]),
    stable_patch_id: patchId,
    diffstat: gitText(["show", "--format=", "--shortstat", commit]),
    changed_paths: gitText(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split(/\r?\n/u).filter(Boolean),
  });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

async function writeJson(destination: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
