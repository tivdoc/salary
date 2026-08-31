import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import { runSafeCommand } from "./process.mts";
import {
  assertTrustedGitRepository,
  trustedGitBuffer,
  trustedGitText,
} from "./trusted-git.mts";

type GitIdentity = Readonly<{
  branch: string;
  head: string;
  tree: string;
  required_base_head: string;
  required_base_tree: string;
}>;

export type DynamicPreflightReceipt = Readonly<{
  schema_version: "tivdoc-canonical-postgresql-dynamic-preflight-v0.9.1";
  branch: string;
  base_head: string;
  base_tree: string;
  source_worktree: "CLEAN";
  tracked_text_files_scanned: number;
  untracked_text_files_scanned: number;
  secrets_detected: 0;
  local_environment_files_detected: 0;
  customer_artifacts_tracked: 0;
  supabase_temp_present: false;
  prior_static_package: Readonly<{
    present_and_verified: true;
    acceptance_result: "23/24 PASS";
    verified_branch: "codex/tivdoc-engine-foundation";
    verified_head: "43f3e63a5cef75b24e95d1bce4383e9249a2d866";
    verified_tree: "16aea86ef3251ec92e52ebf0e4757902459cf987";
    pc_22_status: "SKIPPED_BLOCKED";
    pc_22_blocker: "SKIPPED_ENVIRONMENT_DEPENDENCY";
    ordered_acceptance_items_verified: 24;
    truth_counters_verified: true;
    manifest_sha256: string;
    zip_sha256: string;
    verifier_status: "PASS";
  }>;
  credentials_recorded: 0;
  status: "PASS";
}>;

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\b(?:rk|sk)_(?:live|test)_[A-Za-z0-9]{20,}\b/u,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /postgres(?:ql)?:\/\/[^\s/@:]+:[A-Za-z0-9._~!$&'()*+,;=%-]{20,}@/iu,
] as const);
const GENERIC_SECRET_ASSIGNMENT = /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[ \t]*=[ \t]*["']?([A-Za-z0-9_./+=-]{24,})["']?\b/gu;

const CUSTOMER_ARTIFACT_PATH = /(?:^|\/)(?:eval\/customer-payslips|customer-payslips\/(?:redacted|inspection|ground-truth)|customer-documents?)(?:\/|$)|\.(?:pdf|png|jpe?g|tiff?|docx?|xlsx?)$/iu;
const PRIOR_STATIC_HEAD = "43f3e63a5cef75b24e95d1bce4383e9249a2d866" as const;
const PRIOR_STATIC_TREE = "16aea86ef3251ec92e52ebf0e4757902459cf987" as const;
const PRIOR_STATIC_STATUSES = Object.freeze([
  "CANONICAL_POSTGRESQL_ADAPTERS_AND_WIRING_COMPLETE",
  "CANONICAL_COMPOSITION_ROOT_COMPLETE",
  "DYNAMIC_POSTGRESQL_VERIFICATION_PENDING",
  "CASE_ANALYSIS_DURABILITY_NOT_DYNAMICALLY_PROVEN",
  "CUSTOMER_APPLICATION_INTEGRATION_LOCALLY_PROVEN_SYNTHETIC",
]);

export async function runDynamicPreflight(
  repositoryRoot: string,
  git: GitIdentity,
): Promise<DynamicPreflightReceipt> {
  const root = path.resolve(repositoryRoot);
  assertTrustedGitRepository(root);
  const status = await gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("DYNAMIC_PREFLIGHT_WORKTREE_NOT_CLEAN");
  if (await exists(path.join(root, "supabase", ".temp"))) {
    throw new Error("DYNAMIC_PREFLIGHT_SUPABASE_TEMP_PRESENT");
  }
  const sourceSafety = await inspectRepositorySourceSafety(root);
  if (sourceSafety.local_environment_files.length !== 0) throw new Error("DYNAMIC_PREFLIGHT_LOCAL_ENV_FILE_PRESENT");
  if (sourceSafety.secrets_detected !== 0) throw new Error("DYNAMIC_PREFLIGHT_SECRET_MATERIAL_DETECTED");
  if (sourceSafety.customer_artifacts_tracked !== 0) throw new Error("DYNAMIC_PREFLIGHT_CUSTOMER_ARTIFACT_TRACKED");

  const prior = await inspectPriorStaticPackage(root);
  return Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-dynamic-preflight-v0.9.1",
    branch: git.branch,
    base_head: git.required_base_head,
    base_tree: git.required_base_tree,
    source_worktree: "CLEAN",
    tracked_text_files_scanned: sourceSafety.tracked_text_files_scanned,
    untracked_text_files_scanned: sourceSafety.untracked_text_files_scanned,
    secrets_detected: 0,
    local_environment_files_detected: 0,
    customer_artifacts_tracked: 0,
    supabase_temp_present: false,
    prior_static_package: prior,
    credentials_recorded: 0,
    status: "PASS",
  });
}

export type RepositorySourceSafety = Readonly<{
  tracked_text_files_scanned: number;
  untracked_text_files_scanned: number;
  secrets_detected: number;
  local_environment_files: readonly string[];
  customer_artifacts_tracked: number;
}>;

export async function inspectRepositorySourceSafety(repositoryRoot: string): Promise<RepositorySourceSafety> {
  const root = path.resolve(repositoryRoot);
  const localEnvironmentFiles = await findLocalEnvironmentFiles(root);
  const trackedBlobs = await readTrackedGitBlobs(root);
  const tracked = trackedBlobs.map(({ relative }) => relative);
  const untracked = nulPaths(await gitOutputBuffer(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  let trackedText = 0;
  let untrackedText = 0;
  let secrets = 0;
  for (const { bytes } of trackedBlobs) {
    const decoded = decodeForSecretScan(bytes);
    if (decoded.text) trackedText += 1;
    secrets += countSecretPatterns(decoded.scans);
  }
  for (const relative of untracked) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("DYNAMIC_PREFLIGHT_PATH_ESCAPE");
    const metadata = await lstat(absolute);
    let bytes: Buffer;
    if (metadata.isSymbolicLink()) bytes = Buffer.from(await readlink(absolute), "utf8");
    else if (metadata.isFile()) {
      if (metadata.size > 64 * 1024 * 1024) throw new Error("DYNAMIC_PREFLIGHT_SOURCE_FILE_TOO_LARGE");
      bytes = await readFile(absolute);
    }
    else throw new Error("DYNAMIC_PREFLIGHT_UNSCANNED_SOURCE_ENTRY");
    if (bytes.byteLength > 64 * 1024 * 1024) throw new Error("DYNAMIC_PREFLIGHT_SOURCE_FILE_TOO_LARGE");
    const decoded = decodeForSecretScan(bytes);
    if (decoded.text) untrackedText += 1;
    secrets += countSecretPatterns(decoded.scans);
  }
  const customerArtifacts = tracked
    .map((value) => value.replaceAll("\\", "/"))
    .filter((value) => CUSTOMER_ARTIFACT_PATH.test(value));
  return Object.freeze({
    tracked_text_files_scanned: trackedText,
    untracked_text_files_scanned: untrackedText,
    secrets_detected: secrets,
    local_environment_files: localEnvironmentFiles,
    customer_artifacts_tracked: customerArtifacts.length,
  });
}

type TrackedBlob = Readonly<{ relative: string; bytes: Buffer }>;

async function readTrackedGitBlobs(root: string): Promise<readonly TrackedBlob[]> {
  const rows = nulPaths(await gitOutputBuffer(root, ["ls-files", "--stage", "-z"])).map((row) => {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/u.exec(row);
    if (!match || match[3] !== "0") throw new Error("DYNAMIC_PREFLIGHT_GIT_INDEX_INVALID");
    return Object.freeze({ mode: match[1]!, object: match[2]!, relative: match[4]! });
  });
  const output = trustedGitBuffer(root, ["cat-file", "--batch"], {
    input: rows.map(({ object }) => object).join("\n") + "\n",
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  const blobs: TrackedBlob[] = [];
  for (const row of rows) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("DYNAMIC_PREFLIGHT_GIT_BLOB_HEADER_INVALID");
    const header = output.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== row.object) throw new Error("DYNAMIC_PREFLIGHT_GIT_BLOB_HEADER_INVALID");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) {
      throw new Error("DYNAMIC_PREFLIGHT_SOURCE_FILE_TOO_LARGE");
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) throw new Error("DYNAMIC_PREFLIGHT_GIT_BLOB_SIZE_INVALID");
    blobs.push(Object.freeze({ relative: row.relative, bytes: Buffer.from(output.subarray(start, end)) }));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("DYNAMIC_PREFLIGHT_GIT_BLOB_TRAILING_OUTPUT");
  return Object.freeze(blobs);
}

function decodeForSecretScan(bytes: Buffer): Readonly<{ scans: readonly string[]; text: boolean }> {
  const scans = [bytes.toString("utf8")];
  if (bytes.includes(0)) scans.push(bytes.toString("latin1"));
  const evenNuls = countByteAtParity(bytes, 0, 0);
  const oddNuls = countByteAtParity(bytes, 0, 1);
  const pairCount = Math.max(1, Math.floor(bytes.length / 2));
  const hasBom = bytes.length >= 2
    && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  const looksUtf16 = hasBom || evenNuls / pairCount >= 0.02 || oddNuls / pairCount >= 0.02;
  if (bytes.length >= 2) {
    const evenLength = bytes.length - (bytes.length % 2);
    const pairs = bytes.subarray(0, evenLength);
    scans.push(pairs.toString("utf16le"));
    scans.push(swapPairs(pairs).toString("utf16le"));
  }
  const text = !bytes.includes(0) || looksUtf16;
  return Object.freeze({ scans: Object.freeze([...new Set(scans)]), text });
}

function countSecretPatterns(values: readonly string[]): number {
  let count = 0;
  for (const value of values) {
    for (const expression of SECRET_PATTERNS) {
      const global = new RegExp(expression.source, expression.flags.includes("g")
        ? expression.flags : `${expression.flags}g`);
      for (const match of value.matchAll(global)) {
        if (!looksLikeExplicitPlaceholder(match[0])) count += 1;
      }
    }
    GENERIC_SECRET_ASSIGNMENT.lastIndex = 0;
    for (const match of value.matchAll(GENERIC_SECRET_ASSIGNMENT)) {
      if (looksLikeGenericSecret(match[1] ?? "")) count += 1;
    }
  }
  return count;
}

function looksLikeGenericSecret(value: string): boolean {
  if (looksLikeExplicitPlaceholder(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[_./+=-]/u]
    .filter((expression) => expression.test(value)).length;
  const uppercaseAlphanumeric = /^[A-Z0-9]{24,}$/u.test(value);
  return (classes >= 3 || uppercaseAlphanumeric)
    && new Set(value).size >= 12 && shannonEntropy(value) >= 3.25;
}

function looksLikeExplicitPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return /(?:dummy|example|fake|fixture|hermetic|local-only|placeholder|replace|sample|synthetic|test-only|your[-_])/u
    .test(normalized)
    || /^<(?:[^>]+)>$/u.test(value)
    || /^(?:x{24,}|0{24,})$/iu.test(value);
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function countByteAtParity(bytes: Buffer, value: number, parity: 0 | 1): number {
  let count = 0;
  for (let index = parity; index < bytes.length; index += 2) if (bytes[index] === value) count += 1;
  return count;
}

function swapPairs(bytes: Buffer): Buffer {
  const evenLength = bytes.length - (bytes.length % 2);
  const output = Buffer.from(bytes.subarray(0, evenLength));
  output.swap16();
  return output;
}

const ENVIRONMENT_WALK_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".next", ".tools", ".tmp", "coverage", "eval", "node_modules", "output",
]);

async function findLocalEnvironmentFiles(root: string): Promise<readonly string[]> {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ENVIRONMENT_WALK_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.resolve(current, entry.name);
      if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("DYNAMIC_PREFLIGHT_PATH_ESCAPE");
      if (/^\.env(?:\.|$)/iu.test(entry.name) && !entry.name.toLowerCase().endsWith(".example")) {
        matches.push(path.relative(root, absolute).replaceAll("\\", "/"));
        continue;
      }
      if (entry.isDirectory()) pending.push(absolute);
    }
  }
  return Object.freeze(matches.sort());
}

async function inspectPriorStaticPackage(root: string): Promise<DynamicPreflightReceipt["prior_static_package"]> {
  const finalRoot = path.resolve(root, "output", "canonical-postgresql-persistence-v0.9.0", "final");
  const manifestPath = path.join(finalRoot, "evidence-manifest.json");
  const wrapperPath = path.join(finalRoot, "evidence-wrapper-receipt.json");
  const acceptancePath = path.join(finalRoot, "acceptance-receipt.json");
  const [manifestBytes, wrapperBytes, acceptanceBytes] = await Promise.all([
    readFile(manifestPath), readFile(wrapperPath), readFile(acceptancePath),
  ]).catch(() => { throw new Error("DYNAMIC_PREFLIGHT_PRIOR_STATIC_PACKAGE_MISSING"); });
  const wrapper = parseRecord(wrapperBytes, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_WRAPPER_INVALID");
  const acceptance = parseRecord(acceptanceBytes, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_ACCEPTANCE_INVALID");
  const counts = record(acceptance.counts, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_COUNTS_INVALID");
  const verifiedGit = record(acceptance.verified_git, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_GIT_INVALID");
  const truth = record(acceptance.truth_counters, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_TRUTH_INVALID");
  const proofClasses = record(acceptance.proof_classes, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_PROOF_INVALID");
  const pc = Array.isArray(acceptance.pc) ? acceptance.pc.map((entry) => record(entry, "DYNAMIC_PREFLIGHT_PRIOR_STATIC_PC_INVALID")) : [];
  const expectedPcIds = Array.from({ length: 24 }, (_, index) => `PC-${String(index + 1).padStart(2, "0")}`);
  const pc22 = pc[21];
  if (wrapper.manifest_sha256 !== sha256(manifestBytes)
    || typeof wrapper.zip_sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(wrapper.zip_sha256)
    || counts.acceptance_total !== 24
    || counts.acceptance_passed !== 23
    || counts.acceptance_failed !== 0
    || counts.acceptance_skipped_blocked !== 1
    || counts.capabilities_total !== 14 || counts.adapters_implemented !== 14
    || counts.composition_bindings !== 14 || counts.product_reachable_memory_fallbacks !== 0
    || counts.real_postgresql_connection_attempts !== 0
    || verifiedGit.branch !== "codex/tivdoc-engine-foundation"
    || verifiedGit.head !== PRIOR_STATIC_HEAD || verifiedGit.tree !== PRIOR_STATIC_TREE
    || verifiedGit.ancestry !== true || verifiedGit.preflight_clean !== true
    || JSON.stringify(acceptance.overall_statuses) !== JSON.stringify(PRIOR_STATIC_STATUSES)
    || pc.length !== 24 || JSON.stringify(pc.map(({ id }) => id)) !== JSON.stringify(expectedPcIds)
    || pc.some((entry, index) => entry.status !== (index === 21 ? "SKIPPED_BLOCKED" : "PASS"))
    || pc22?.blocker !== "SKIPPED_ENVIRONMENT_DEPENDENCY"
    || proofClasses.static !== "PASS" || proofClasses.recording_driver !== "PASS"
    || proofClasses.postgresql_execution !== "SKIPPED_BLOCKED"
    || truth.PERSISTENCE_CAPABILITIES_TOTAL !== 14
    || truth.POSTGRESQL_ADAPTERS_IMPLEMENTED !== "14/14"
    || truth.CANONICAL_COMPOSITION_ROOT_BINDINGS !== "14/14"
    || truth.PRODUCT_REACHABLE_MEMORY_FALLBACKS !== 0
    || truth.REAL_POSTGRESQL_CONNECTION_ATTEMPTS !== 0
    || truth.REAL_POSTGRESQL_VERIFICATION !== "SKIPPED_BLOCKED"
    || truth.REAL_SOURCES_ACTIVE !== 0 || truth.REAL_PARAMETERS_ACTIVE !== 0
    || truth.REAL_RULES_ACTIVE !== 0 || truth.REAL_CALCULATIONS_OR_FINDINGS !== 0
    || truth.REAL_CUSTOMER_DATA_READS !== 0 || truth.DEPLOYMENTS !== 0
    || truth.REMOTE_MIGRATIONS !== 0 || truth.LIVE_PROVIDER_CALLS !== 0 || truth.OPENAI_CALLS !== 0) {
    throw new Error("DYNAMIC_PREFLIGHT_PRIOR_STATIC_TRUTH_INVALID");
  }
  const resolvedPriorTree = await gitOutput(root, ["show", "-s", "--format=%T", PRIOR_STATIC_HEAD]);
  if (resolvedPriorTree !== PRIOR_STATIC_TREE) throw new Error("DYNAMIC_PREFLIGHT_PRIOR_STATIC_GIT_INVALID");
  const zipBytes = await readFile(path.join(finalRoot, String(wrapper.zip_path)));
  if (sha256(zipBytes) !== wrapper.zip_sha256) throw new Error("DYNAMIC_PREFLIGHT_PRIOR_STATIC_ZIP_INVALID");
  const verifierScript = path.resolve(root, "scripts", "canonical-persistence-v09", "evidence", "verify.mts");
  const systemRoot = "C:\\Windows";
  const result = await runSafeCommand({
    executable: process.execPath,
    args: Object.freeze(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", verifierScript, finalRoot]),
    cwd: root,
    env: Object.freeze({
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: path.join(systemRoot, "System32"),
    }),
    timeout_ms: 60_000,
  });
  let verifier: unknown;
  try {
    verifier = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("DYNAMIC_PREFLIGHT_PRIOR_STATIC_VERIFIER_INVALID");
  }
  if (!isRecord(verifier) || verifier.status !== "PASS") {
    throw new Error("DYNAMIC_PREFLIGHT_PRIOR_STATIC_VERIFIER_FAILED");
  }
  return Object.freeze({
    present_and_verified: true,
    acceptance_result: "23/24 PASS",
    verified_branch: "codex/tivdoc-engine-foundation",
    verified_head: PRIOR_STATIC_HEAD,
    verified_tree: PRIOR_STATIC_TREE,
    pc_22_status: "SKIPPED_BLOCKED",
    pc_22_blocker: "SKIPPED_ENVIRONMENT_DEPENDENCY",
    ordered_acceptance_items_verified: 24,
    truth_counters_verified: true,
    manifest_sha256: String(wrapper.manifest_sha256),
    zip_sha256: String(wrapper.zip_sha256),
    verifier_status: "PASS",
  });
}

async function gitOutput(root: string, args: readonly string[]): Promise<string> {
  return trustedGitText(root, args);
}

async function gitOutputBuffer(root: string, args: readonly string[]): Promise<Buffer> {
  return trustedGitBuffer(root, args, { maxBuffer: 16 * 1024 * 1024 });
}

function nulPaths(bytes: Buffer): readonly string[] {
  return Object.freeze(bytes.toString("utf8").split("\0").filter(Boolean).sort());
}

function parseRecord(bytes: Uint8Array, code: string): Record<string, unknown> {
  try {
    return record(JSON.parse(Buffer.from(bytes).toString("utf8")), code);
  } catch {
    throw new Error(code);
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
