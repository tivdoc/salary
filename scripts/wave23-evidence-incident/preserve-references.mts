// V0.10.11 evidence custody sweep.
//
// `V041_MISMATCH_004` was lost because its only surviving copy was a live,
// tracked working-tree file that ordinary development overwrote. Every other
// recovered reference has the same shape: its bytes live either in a live
// working tree or in an ignored `output/` directory. Neither is custody.
//
// This sweep copies the verified bytes of every such reference into a committed
// evidence tree, byte-for-byte, with provenance. The copies are classed
// `preserved_v0_10_11` and are never counted as recoveries: they were not
// recovered at Wave 2.2, and the recovered counter does not move because of
// them. `.gitattributes` marks them `-text` so git never normalizes the very
// line endings whose loss made `004` unreconstructable.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PRESERVATION_SCHEMA = "tivdoc-evidence-preservation-v0.10.11" as const;
export const PRESERVED_CLASS = "preserved_v0_10_11" as const;

export const REGISTRY_PATH = path.join(
  "output", "parallel-wave-2.3", "workers", "w1-evidence-incident",
  "cross-package-incident-registry.json",
);
export const PRESERVED_ROOT = path.join(
  "src", "engine", "wave23", "evidence-incident", "preserved-bytes",
);
export const MANIFEST_PATH = path.join(
  "src", "engine", "wave23", "evidence-incident", "preserved-references.v0.10.11.json",
);

const RECOVERED_ROOTS = Object.freeze([
  path.join("output", "parallel-wave-2.2", "workers", "w1-evidence-forensics", "recovered-bytes"),
  path.join("output", "parallel-wave-2.2", "workers", "w1-integration-verification", "recovered-bytes"),
]);

export type PreservedEntry = Readonly<{
  reference_id: string;
  class: typeof PRESERVED_CLASS;
  repository_path: string;
  preserved_path: string;
  sha256: string;
  byte_count: number;
  source_kind: "live_working_tree" | "untracked_output_tree";
  source_path: string;
  source_state: string;
  preserved_at: string;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function worktreeRoots(): readonly string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

function walkRecovered(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 12) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".recovered.bin")) found.push(full);
    }
  };
  visit(root, 0);
  return found;
}

/** The first source whose bytes match the claim exactly, or null. */
export function locateSource(reference: Readonly<{
  repository_path: string; claimed_sha256: string; claimed_byte_count: number;
}>): Readonly<{ kind: PreservedEntry["source_kind"]; file: string; state: string }> | null {
  for (const root of worktreeRoots()) {
    const candidate = path.join(root, ...reference.repository_path.split("/"));
    if (!existsSync(candidate)) continue;
    const bytes = readFileSync(candidate);
    if (bytes.byteLength !== reference.claimed_byte_count || sha256(bytes) !== reference.claimed_sha256) continue;
    let state = "unknown";
    try {
      state = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    } catch { state = "unknown"; }
    return Object.freeze({ kind: "live_working_tree" as const, file: candidate, state: `HEAD ${state}` });
  }
  for (const root of RECOVERED_ROOTS) {
    for (const candidate of walkRecovered(root)) {
      const bytes = readFileSync(candidate);
      if (bytes.byteLength !== reference.claimed_byte_count || sha256(bytes) !== reference.claimed_sha256) continue;
      return Object.freeze({
        kind: "untracked_output_tree" as const, file: candidate, state: "ignored output tree",
      });
    }
  }
  return null;
}

function preservedFileFor(referenceId: string, repositoryPath: string): string {
  const flattened = repositoryPath.replaceAll("/", "__");
  return path.join(PRESERVED_ROOT, referenceId, `${flattened}.preserved.bin`);
}

export function preserveAll(now: string): Readonly<{
  entries: readonly PreservedEntry[]; skipped: readonly string[];
}> {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
    references: readonly Readonly<{
      reference_id: string; repository_path: string;
      claimed_sha256: string; claimed_byte_count: number; exact_recovery_status: string;
    }>[];
  };
  const entries: PreservedEntry[] = [];
  const skipped: string[] = [];
  for (const reference of registry.references) {
    if (reference.exact_recovery_status !== "exact_recovered") {
      skipped.push(`${reference.reference_id}:not_recovered`);
      continue;
    }
    const source = locateSource(reference);
    if (source === null) {
      skipped.push(`${reference.reference_id}:no_verified_source`);
      continue;
    }
    const bytes = readFileSync(source.file);
    // Refuse to write anything whose digest does not match the claim exactly.
    if (bytes.byteLength !== reference.claimed_byte_count || sha256(bytes) !== reference.claimed_sha256) {
      skipped.push(`${reference.reference_id}:digest_mismatch`);
      continue;
    }
    const target = preservedFileFor(reference.reference_id, reference.repository_path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    entries.push(Object.freeze({
      reference_id: reference.reference_id,
      class: PRESERVED_CLASS,
      repository_path: reference.repository_path,
      preserved_path: target.replaceAll("\\", "/"),
      sha256: reference.claimed_sha256,
      byte_count: reference.claimed_byte_count,
      source_kind: source.kind,
      source_path: source.file.replaceAll("\\", "/"),
      source_state: source.state,
      preserved_at: now,
    }));
  }
  entries.sort((a, b) => (a.reference_id < b.reference_id ? -1 : 1));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({
    schema_version: PRESERVATION_SCHEMA,
    note: "Preserved copies. These were never recovered at Wave 2.2 and are never counted as recoveries.",
    preserved_count: entries.length,
    skipped,
    entries,
  }, null, 2)}\n`, "utf8");
  return Object.freeze({ entries: Object.freeze(entries), skipped: Object.freeze(skipped) });
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replaceAll("\\", "/").endsWith("scripts/wave23-evidence-incident/preserve-references.mts");
if (invokedDirectly) {
  const result = preserveAll(new Date().toISOString().slice(0, 10));
  process.stdout.write(`preserved ${result.entries.length} skipped ${result.skipped.length}\n`);
}
