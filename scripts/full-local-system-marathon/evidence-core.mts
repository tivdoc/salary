import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { inspectDeterministicStoreZip } from "../canonical-persistence-v091/evidence/deterministic-zip.mts";

export type ManifestEntry = Readonly<{ path: string; sha256: string; byte_count: number }>;
export type MarathonManifest = Readonly<{
  schema_version: "tivdoc-full-local-system-marathon-evidence-manifest-v0.10.0";
  payload_files: readonly ManifestEntry[];
  payload_file_count: number;
  payload_bytes: number;
  payload_set_sha256: string;
  self_reference_rule: "manifest_zip_verifier_and_wrapper_are_not_payload_files";
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const ACCEPTANCE_IDS = Array.from({ length: 39 }, (_, index) => `MC-${String(index + 1).padStart(2, "0")}`);
const ACCEPTANCE_STATUSES = new Set(["PASS", "BLOCKED", "FAILED_LOCAL_WITH_EVIDENCE", "SKIPPED"]);
const ZERO_TRUTH_COUNTERS = [
  "REAL_SOURCES_ACTIVE",
  "REAL_PARAMETERS_ACTIVE",
  "REAL_RULES_ACTIVE",
  "REAL_CALCULATIONS_OR_FINDINGS",
  "HUMAN_GROUND_TRUTH_LOCKED",
  "REAL_CUSTOMER_DATA_READS",
  "DEPLOYMENTS",
  "REMOTE_MIGRATIONS",
  "LIVE_PROVIDER_CALLS",
  "OPENAI_CALLS",
  "PRODUCT_REACHABLE_MEMORY_FALLBACKS",
] as const;
const NO_TRUTH_COUNTERS = [
  "CUSTOMER_PROCESSING_ENABLED",
  "CUSTOMER_SHADOW_AUTHORIZED",
  "PRODUCTION_DELIVERY_ENABLED",
] as const;

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalPayloadSetHash(entries: readonly ManifestEntry[]): string {
  return sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""));
}

export async function createEvidenceManifest(
  root: string,
  payloadNames: readonly string[],
): Promise<MarathonManifest> {
  const portable = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const name of [...payloadNames].sort(compareStrings)) {
    assertSafePayloadName(name);
    const normalized = name.toLowerCase();
    if (portable.has(normalized)) throw new Error("MARATHON_MANIFEST_DUPLICATE_NORMALIZED_PATH");
    portable.add(normalized);
    const absolute = path.resolve(root, ...name.split("/"));
    assertWithin(root, absolute);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
      throw new Error("MARATHON_MANIFEST_PAYLOAD_NOT_ORDINARY_FILE");
    }
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== metadata.size) throw new Error("MARATHON_MANIFEST_PAYLOAD_CHANGED_DURING_READ");
    entries.push(Object.freeze({ path: name, sha256: sha256(bytes), byte_count: bytes.byteLength }));
  }
  if (entries.length === 0) throw new Error("MARATHON_MANIFEST_EMPTY");
  return Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-evidence-manifest-v0.10.0",
    payload_files: Object.freeze(entries),
    payload_file_count: entries.length,
    payload_bytes: entries.reduce((sum, entry) => sum + entry.byte_count, 0),
    payload_set_sha256: canonicalPayloadSetHash(entries),
    self_reference_rule: "manifest_zip_verifier_and_wrapper_are_not_payload_files",
  });
}

export async function verifyEvidenceDirectory(input: Readonly<{
  root: string;
  archive: string;
}>): Promise<Readonly<Record<string, unknown>>> {
  const root = path.resolve(input.root);
  const manifestPath = path.join(root, "evidence-manifest.json");
  const manifest = asObject(JSON.parse(await readFile(manifestPath, "utf8")), "MARATHON_MANIFEST_INVALID") as unknown as MarathonManifest;
  assertManifestShape(manifest);
  const recomputed = await createEvidenceManifest(root, manifest.payload_files.map((entry) => entry.path));
  if (JSON.stringify(recomputed) !== JSON.stringify(manifest)) throw new Error("MARATHON_MANIFEST_RECOMPUTE_MISMATCH");

  const archiveInspection = await inspectDeterministicStoreZip(input.archive);
  const expectedArchive = [...manifest.payload_files, {
    path: "evidence-manifest.json",
    sha256: sha256(await readFile(manifestPath)),
    byte_count: (await lstat(manifestPath)).size,
  }].sort((left, right) => compareStrings(left.path, right.path));
  const actualArchive = archiveInspection.entries
    .map((entry) => ({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count }))
    .sort((left, right) => compareStrings(left.path, right.path));
  if (JSON.stringify(actualArchive) !== JSON.stringify(expectedArchive)) {
    throw new Error("MARATHON_ARCHIVE_PAYLOAD_MISMATCH");
  }

  const assessment = asObject(await readJsonPayload(root, manifest, "assessment.json"), "MARATHON_ASSESSMENT_INVALID");
  verifyAssessment(assessment);
  verifyNdjson(await readTextPayload(root, manifest, "ledgers/marathon.ndjson"), "event_id");
  verifyNdjson(await readTextPayload(root, manifest, "ledgers/focused-checks.ndjson"), "check_id");
  verifyFinalVerification(asObject(await readJsonPayload(root, manifest, "verification/final-verification.json"), "MARATHON_FINAL_VERIFICATION_INVALID"));
  verifyGitReceipt(asObject(await readJsonPayload(root, manifest, "git/base-final.json"), "MARATHON_GIT_RECEIPT_INVALID"));
  verifyProhibitedScan(asObject(await readJsonPayload(root, manifest, "security/prohibited-operation-scan.json"), "MARATHON_PROHIBITED_SCAN_INVALID"));

  return Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-independent-verifier-v0.10.0",
    status: "PASS",
    payload_file_count: manifest.payload_file_count,
    payload_bytes: manifest.payload_bytes,
    payload_set_sha256: manifest.payload_set_sha256,
    manifest_sha256: sha256(await readFile(manifestPath)),
    archive_sha256: sha256(await readFile(input.archive)),
    archive_entry_count: archiveInspection.entry_count,
    acceptance_pass: (assessment.acceptance as readonly Record<string, unknown>[]).filter((entry) => entry.status === "PASS").length,
    acceptance_non_pass: (assessment.acceptance as readonly Record<string, unknown>[]).filter((entry) => entry.status !== "PASS").length,
    contradictory_statuses: 0,
    blocked_gate_claimed_pass: 0,
    credentials_detected: 0,
  });
}

function assertManifestShape(manifest: MarathonManifest): void {
  if (manifest.schema_version !== "tivdoc-full-local-system-marathon-evidence-manifest-v0.10.0"
      || manifest.self_reference_rule !== "manifest_zip_verifier_and_wrapper_are_not_payload_files"
      || !Array.isArray(manifest.payload_files)
      || manifest.payload_file_count !== manifest.payload_files.length
      || manifest.payload_bytes !== manifest.payload_files.reduce((sum, entry) => sum + entry.byte_count, 0)
      || manifest.payload_set_sha256 !== canonicalPayloadSetHash(manifest.payload_files)) {
    throw new Error("MARATHON_MANIFEST_SHAPE_INVALID");
  }
  const sorted = [...manifest.payload_files].sort((left, right) => compareStrings(left.path, right.path));
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.payload_files)) throw new Error("MARATHON_MANIFEST_ORDER_INVALID");
  for (const entry of manifest.payload_files) {
    assertSafePayloadName(entry.path);
    if (!SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.byte_count) || entry.byte_count < 0) {
      throw new Error("MARATHON_MANIFEST_ENTRY_INVALID");
    }
  }
}

function verifyAssessment(assessment: Record<string, unknown>): void {
  if (assessment.schema_version !== "tivdoc-full-local-system-marathon-assessment-v0.10.0"
      || !Array.isArray(assessment.acceptance)
      || assessment.acceptance.length !== ACCEPTANCE_IDS.length) {
    throw new Error("MARATHON_ASSESSMENT_SHAPE_INVALID");
  }
  const acceptance = assessment.acceptance.map((entry) => asObject(entry, "MARATHON_ACCEPTANCE_ENTRY_INVALID"));
  const ids = acceptance.map((entry) => entry.id);
  if (JSON.stringify(ids) !== JSON.stringify(ACCEPTANCE_IDS)) throw new Error("MARATHON_ACCEPTANCE_ID_SET_INVALID");
  for (const entry of acceptance) {
    if (!ACCEPTANCE_STATUSES.has(String(entry.status)) || typeof entry.evidence !== "string" || entry.evidence.length === 0) {
      throw new Error("MARATHON_ACCEPTANCE_STATUS_INVALID");
    }
  }
  const counts = asObject(assessment.acceptance_counts, "MARATHON_ACCEPTANCE_COUNTS_INVALID");
  for (const status of ACCEPTANCE_STATUSES) {
    if (counts[status] !== acceptance.filter((entry) => entry.status === status).length) {
      throw new Error("MARATHON_ACCEPTANCE_COUNTS_MISMATCH");
    }
  }
  const truths = asObject(assessment.truth_counters, "MARATHON_TRUTH_COUNTERS_INVALID");
  if (truths.REAL_LEGAL_TOPICS_READY !== "0/7") throw new Error("MARATHON_REAL_LEGAL_TOPICS_CONTRADICTION");
  for (const key of ZERO_TRUTH_COUNTERS) if (truths[key] !== 0) throw new Error(`MARATHON_TRUTH_COUNTER_NONZERO:${key}`);
  for (const key of NO_TRUTH_COUNTERS) if (truths[key] !== "NO") throw new Error(`MARATHON_TRUTH_COUNTER_NOT_NO:${key}`);
  for (const key of ["FULL_SUITE_RUN_COUNT", "PRODUCTION_BUILD_RUN_COUNT", "BROWSER_E2E_FULL_RUN_COUNT"]) {
    if (!Number.isSafeInteger(truths[key]) || (truths[key] as number) < 0 || (truths[key] as number) > 2) {
      throw new Error(`MARATHON_RUN_COUNT_INVALID:${key}`);
    }
  }
  const blockedHumanIds = new Set(["MC-03", "MC-10", "MC-27"]);
  for (const entry of acceptance) {
    if (blockedHumanIds.has(String(entry.id)) && entry.status === "PASS" && entry.external_gate_satisfied !== true) {
      throw new Error(`MARATHON_BLOCKED_GATE_FALSE_PASS:${String(entry.id)}`);
    }
  }
}

function verifyProhibitedScan(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-marathon-prohibited-operation-scan-v0.10.0"
      || value.status !== "PASS"
      || value.secret_or_customer_path_matches !== 0) throw new Error("MARATHON_PROHIBITED_SCAN_FAILED");
  for (const key of ["deployments", "remote_migrations", "live_provider_calls", "openai_calls", "customer_data_reads"]) {
    if (value[key] !== 0) throw new Error(`MARATHON_PROHIBITED_EXECUTION_NONZERO:${key}`);
  }
}

function verifyFinalVerification(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-full-local-system-marathon-final-verification-v0.10.0"
      || !Array.isArray(value.commands)) throw new Error("MARATHON_FINAL_VERIFICATION_SHAPE_INVALID");
  const commands = value.commands.map((entry) => asObject(entry, "MARATHON_FINAL_COMMAND_INVALID"));
  const ids = new Set(commands.map((entry) => entry.command_id));
  for (const required of ["focused_marathon", "full_suite", "eslint", "typescript", "production_build", "browser_e2e"] as const) {
    if (!ids.has(required)) throw new Error(`MARATHON_FINAL_COMMAND_MISSING:${required}`);
  }
  for (const command of commands) {
    if (!new Set(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]).has(String(command.status))
        || !Number.isSafeInteger(command.exit_code)
        || typeof command.stdout_sha256 !== "string"
        || !SHA256.test(command.stdout_sha256)) {
      throw new Error("MARATHON_FINAL_COMMAND_RECEIPT_INVALID");
    }
  }
}

function verifyGitReceipt(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-full-local-system-marathon-git-v0.10.0"
      || value.base_head !== "28d18da69108913252736f4b8a39c4ef614984a3"
      || value.base_tree !== "2a9859470003a095521a13e21474a45e1f69620e"
      || value.branch !== "codex/tivdoc-engine-foundation"
      || value.base_is_ancestor !== true
      || value.worktree_clean !== true
      || typeof value.final_head !== "string"
      || !/^[a-f0-9]{40}$/.test(value.final_head)
      || typeof value.final_tree !== "string"
      || !/^[a-f0-9]{40}$/.test(value.final_tree)) {
    throw new Error("MARATHON_GIT_RECEIPT_CONTRADICTION");
  }
}

function verifyNdjson(text: string, identityKey: string): void {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("MARATHON_LEDGER_EMPTY");
  const identities = new Set<string>();
  for (const line of lines) {
    const value = asObject(JSON.parse(line), "MARATHON_LEDGER_LINE_INVALID");
    const identity = value[identityKey];
    if (typeof identity !== "string" || identity.length === 0 || identities.has(identity)) {
      throw new Error("MARATHON_LEDGER_IDENTITY_INVALID");
    }
    identities.add(identity);
  }
}

async function readJsonPayload(root: string, manifest: MarathonManifest, name: string): Promise<unknown> {
  return JSON.parse(await readTextPayload(root, manifest, name));
}

async function readTextPayload(root: string, manifest: MarathonManifest, name: string): Promise<string> {
  if (!manifest.payload_files.some((entry) => entry.path === name)) throw new Error(`MARATHON_REQUIRED_PAYLOAD_MISSING:${name}`);
  return readFile(path.resolve(root, ...name.split("/")), "utf8");
}

function assertSafePayloadName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.includes("\\")
      || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)
      || !/^[A-Za-z0-9._/-]+$/u.test(name)) throw new Error("MARATHON_PAYLOAD_PATH_UNSAFE");
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || path.posix.normalize(name) !== name
      || ["evidence-manifest.json", "marathon-evidence-v0.10.0.zip", "independent-verifier-output.json", "evidence-wrapper.json"].includes(name)) {
    throw new Error("MARATHON_PAYLOAD_PATH_UNSAFE");
  }
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("MARATHON_PAYLOAD_OUT_OF_ROOT");
  }
}

function asObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
