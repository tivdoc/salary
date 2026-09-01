import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalSha256 } from "../../src/engine/rule-runtime/canonical.ts";
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
const ACCEPTANCE_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "SKIPPED_DEPENDENCY", "NOT_APPLICABLE"]);
const HEADLINE_STATUSES = new Set([
  "LOCAL_SYSTEM_ENGINEERING_MARATHON_COMPLETE_EXTERNAL_GATES_REMAIN",
  "LOCAL_SYSTEM_ENGINEERING_MARATHON_PARTIAL",
  "BLOCKED_SAFETY_OR_REPOSITORY_STATE",
]);
const FORBIDDEN_STATUS_CONSTANTS = new Set(["FULL_SYSTEM_READY", "SHADOW_READY", "CUSTOMER_READY", "PRODUCTION_READY"]);
const REQUIRED_FINAL_COMMANDS = [
  "focused_marathon",
  "full_suite",
  "eslint",
  "typescript",
  "production_build",
  "browser_e2e",
  "prohibited_operation_audit",
  "canonical_reachability",
  "persistence_wiring",
] as const;
const POST_VERIFICATION_CLOSURE_PATH = "git/post-verification-closure.json";
const PRE_CLOSURE_ASSESSMENT_PATH = "assessment/pre-closure-assessment.json";
const POST_VERIFICATION_COMMIT_SPECS = [
  Object.freeze({
    classification: "TARGETED_REPAIR_UNVERIFIED_BY_COMPLETE_FINAL_RUN",
    subject: "fix(postgres): reuse canonical report bytes in matrix",
    changed_paths: Object.freeze([
      "scripts/canonical-persistence-v091/matrix/marathon-v010.mts",
      "scripts/canonical-persistence-v091/matrix/marathon-v010.test.mjs",
    ]),
  }),
  Object.freeze({
    classification: "EVIDENCE_TOOLING_CLOSURE_SUPPORT",
    subject: "fix(marathon): support exhausted-attempt evidence closure",
    changed_paths: Object.freeze([
      "scripts/full-local-system-marathon/evidence-core.mts",
      "scripts/full-local-system-marathon/run.mts",
      "src/server/system-marathon/evidence-core.test.ts",
    ]),
  }),
  Object.freeze({
    classification: "ASSESSMENT_ONLY_CLOSURE",
    subject: "docs(marathon): record exhausted final verification",
    changed_paths: Object.freeze([
      "src/server/system-marathon/acceptance-assessment.v0.10.0.json",
    ]),
  }),
] as const;
const W2_OLD_COMPLETED = "real V0.10 restart matrix";
const W2_NEW_COMPLETED = "V0.10 restart-matrix tooling and targeted exact-byte repair";
const W2_NEW_REMAINING = "complete V0.10 dynamic restart regression remains FAILED_LOCAL_WITH_EVIDENCE";
const POSTGRES_REPAIR_CHECK = Object.freeze({
  commit_subject: "fix(postgres): reuse canonical report bytes in matrix",
  checks: Object.freeze(["FC-008", "FC-010"]),
  status: "PASS",
});
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
const POSTGRESQL_MARATHON_RECEIPT_PATH =
  "output/canonical-postgresql-dynamic-v0.9.1/development/marathon-v010-matrix.json";
const POSTGRESQL_RUNTIME_PROVENANCE = Object.freeze({
  source_kind: "edb_authenticode_signed_windows_installer",
  source_sha256: "f104c552d8495a6f20738c2a03f643164bc64b9985363329e314dec24559f0b7",
  source_integrity: "PINNED_SHA256_AND_VALID_AUTHENTICODE",
  distribution_file_count: 20_569,
  distribution_bytes: 948_935_114,
  distribution_tree_sha256: "bd43ff63eac0a3592b495af1a31da9d532ab553846f9a6cf4fab1d76b98cc7d9",
  binary_sha256: Object.freeze({
    postgres: "4125c1e963072d929f6468a449ad184b26d3be7d97cae3181c3d613dace49c8d",
    initdb: "6978bdb96e1e515285eb7bbf8915c4a254644107b1fcb44917e52f707dbe798a",
    pg_ctl: "5afdea4f4860b52cd03cee4c51be5d034a51f7ed63312acc3b6abee9006fa0ba",
    psql: "5bb3fad8a7ff555abff37921a24ee3d9e377c15408b5e7267aa9245596965ca0",
    createdb: "1e8322a28156e0c33a668a2a9a1cf3c8f24e36951e461c8f3bfa60dfb0a80ef9",
    dropdb: "10fabb879e3dcef64f23484b35c508a7665c6a00d7feae0c0cf87ffbe9eb0a30",
    pg_dump: "ff766351cc88b0ea2bc7b6e365777cb51f792b16000688a378f64124810ffa88",
    pg_restore: "ae002028451e79240eaad9838d9eb0b644436a05decb3888468a529bf881ac6c",
    pg_isready: "15242279c66680141586747a475090d70f83874cc19dc63709be6b57b0ba411c",
  }),
  authenticode_status: "Valid",
  authenticode_subject: "CN=EnterpriseDB Corporation, O=EnterpriseDB Corporation, L=Wilmington, S=Delaware, C=US",
  authenticode_issuer: "CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=\"DigiCert, Inc.\", C=US",
  authenticode_thumbprint: "7BEDD1269FCCF7A5D95F18274750B79893C06C70",
});

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalPayloadSetHash(entries: readonly ManifestEntry[]): string {
  return sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""));
}

export function canonicalAcceptanceMarkdown(assessment: Record<string, unknown>): string {
  const acceptance = Array.isArray(assessment.acceptance)
    ? assessment.acceptance.map((entry) => asObject(entry, "MARATHON_ACCEPTANCE_ENTRY_INVALID"))
    : [];
  const lines = [
    "# Tivdoc V0.10.0 Marathon acceptance ledger",
    "",
    `Final status: ${String(assessment.final_status ?? "INVALID")}`,
    "",
    "| ID | Status | Evidence |",
    "|---|---|---|",
    ...acceptance.map((entry) => `| ${escapeMarkdownCell(String(entry.id))} | ${escapeMarkdownCell(String(entry.status))} | ${escapeMarkdownCell(String(entry.evidence))} |`),
    "",
  ];
  return lines.join("\n");
}

type PostVerificationClosureInput = Readonly<{
  previousAssessmentBytes: Uint8Array;
  currentAssessment: Record<string, unknown>;
  finalVerification: Record<string, unknown>;
  git: Record<string, unknown>;
  commits: readonly Record<string, unknown>[];
}>;

type PostVerificationClosureVerificationInput = PostVerificationClosureInput & Readonly<{
  receipt: Record<string, unknown>;
}>;

export function createPostVerificationClosureReceipt(
  input: PostVerificationClosureInput,
): Readonly<Record<string, unknown>> {
  const attempts = Array.isArray(input.finalVerification.attempts)
    ? input.finalVerification.attempts.map((entry) => asObject(entry, "MARATHON_CLOSURE_ATTEMPTS_INVALID"))
    : [];
  const latest = attempts.at(-1);
  if (!latest) throw new Error("MARATHON_CLOSURE_ATTEMPTS_INVALID");
  const suffix = postVerificationCommitSuffix(input.commits, String(latest.verified_head));
  const receipt = Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-post-verification-closure-v0.10.0",
    closure_mode: "EXHAUSTED_ATTEMPT_TARGETED_REPAIR_TOOLING_AND_ASSESSMENT_CLOSURE",
    status: "PASS",
    final_verification_status: input.finalVerification.status,
    complete_final_attempts: attempts.length,
    complete_attempt_limit: input.finalVerification.complete_attempt_limit,
    verified_head: latest.verified_head,
    verified_tree: latest.verified_tree,
    final_head: input.git.final_head,
    final_tree: input.git.final_tree,
    previous_assessment_path: PRE_CLOSURE_ASSESSMENT_PATH,
    previous_assessment_sha256: sha256(input.previousAssessmentBytes),
    post_attempt_commits: Object.freeze(suffix.map((commit, index) => Object.freeze({
      ordinal: index + 1,
      classification: POST_VERIFICATION_COMMIT_SPECS[index]?.classification,
      sha: commit.sha,
      tree: commit.tree,
      parent: commit.parent,
      subject: commit.subject,
      changed_paths: Object.freeze([...(commit.changed_paths as readonly string[])]),
    }))),
  });
  verifyPostVerificationClosure({ ...input, receipt });
  return receipt;
}

export function verifyPostVerificationClosure(input: PostVerificationClosureVerificationInput): void {
  const { receipt, finalVerification, git, commits } = input;
  assertExactObjectKeys(receipt, [
    "schema_version", "closure_mode", "status", "final_verification_status", "complete_final_attempts",
    "complete_attempt_limit", "verified_head", "verified_tree", "final_head", "final_tree",
    "previous_assessment_path", "previous_assessment_sha256", "post_attempt_commits",
  ], "MARATHON_CLOSURE_RECEIPT_INVALID");
  if (receipt.schema_version !== "tivdoc-full-local-system-marathon-post-verification-closure-v0.10.0"
      || receipt.closure_mode !== "EXHAUSTED_ATTEMPT_TARGETED_REPAIR_TOOLING_AND_ASSESSMENT_CLOSURE"
      || receipt.status !== "PASS"
      || receipt.final_verification_status !== "FAIL"
      || receipt.complete_final_attempts !== 2
      || receipt.complete_attempt_limit !== 2
      || receipt.previous_assessment_path !== PRE_CLOSURE_ASSESSMENT_PATH
      || typeof receipt.previous_assessment_sha256 !== "string"
      || !SHA256.test(receipt.previous_assessment_sha256)
      || receipt.previous_assessment_sha256 !== sha256(input.previousAssessmentBytes)) {
    throw new Error("MARATHON_CLOSURE_RECEIPT_INVALID");
  }
  if (finalVerification.status !== "FAIL"
      || finalVerification.complete_attempt_limit !== 2
      || !Array.isArray(finalVerification.attempts)
      || finalVerification.attempts.length !== 2
      || finalVerification.attempts.some((entry) => asObject(entry, "MARATHON_CLOSURE_ATTEMPTS_INVALID").status !== "FAIL")
      || asObject(finalVerification.run_counts, "MARATHON_CLOSURE_RUN_COUNTS_INVALID").complete_final_attempts !== 2) {
    throw new Error("MARATHON_CLOSURE_REQUIRES_EXHAUSTED_FAILURE");
  }
  const latest = asObject(finalVerification.attempts[1], "MARATHON_CLOSURE_ATTEMPTS_INVALID");
  if (latest.status !== "FAIL"
      || finalVerification.verified_head !== latest.verified_head
      || finalVerification.verified_tree !== latest.verified_tree
      || receipt.verified_head !== latest.verified_head
      || receipt.verified_tree !== latest.verified_tree
      || receipt.final_head !== git.final_head
      || receipt.final_tree !== git.final_tree
      || latest.verified_head === git.final_head) {
    throw new Error("MARATHON_CLOSURE_GIT_BINDING_INVALID");
  }

  const suffix = postVerificationCommitSuffix(commits, String(latest.verified_head));
  if (!Array.isArray(receipt.post_attempt_commits)
      || receipt.post_attempt_commits.length !== POST_VERIFICATION_COMMIT_SPECS.length) {
    throw new Error("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");
  }
  let expectedParent = String(latest.verified_head);
  for (const [index, spec] of POST_VERIFICATION_COMMIT_SPECS.entries()) {
    const commit = suffix[index]!;
    const claimed = asObject(receipt.post_attempt_commits[index], "MARATHON_CLOSURE_COMMIT_RECEIPT_INVALID");
    assertExactObjectKeys(claimed, [
      "ordinal", "classification", "sha", "tree", "parent", "subject", "changed_paths",
    ], "MARATHON_CLOSURE_COMMIT_RECEIPT_INVALID");
    if (commit.parent !== expectedParent
        || commit.subject !== spec.subject
        || JSON.stringify(commit.changed_paths) !== JSON.stringify(spec.changed_paths)
        || claimed.ordinal !== index + 1
        || claimed.classification !== spec.classification
        || claimed.sha !== commit.sha
        || claimed.tree !== commit.tree
        || claimed.parent !== commit.parent
        || claimed.subject !== commit.subject
        || JSON.stringify(claimed.changed_paths) !== JSON.stringify(commit.changed_paths)) {
      throw new Error("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");
    }
    expectedParent = String(commit.sha);
  }
  const finalCommit = suffix.at(-1)!;
  if (expectedParent !== git.final_head || finalCommit.tree !== git.final_tree) {
    throw new Error("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");
  }

  let previousAssessment: Record<string, unknown>;
  try {
    previousAssessment = asObject(
      JSON.parse(Buffer.from(input.previousAssessmentBytes).toString("utf8")),
      "MARATHON_PRE_CLOSURE_ASSESSMENT_INVALID",
    );
  } catch {
    throw new Error("MARATHON_PRE_CLOSURE_ASSESSMENT_INVALID");
  }
  verifyAssessment(previousAssessment);
  verifyAssessment(input.currentAssessment);
  verifyPostVerificationAssessmentDelta(previousAssessment, input.currentAssessment);
}

function postVerificationCommitSuffix(
  commits: readonly Record<string, unknown>[],
  verifiedHead: string,
): readonly Record<string, unknown>[] {
  const verifiedIndexes = commits.flatMap((commit, index) => commit.sha === verifiedHead ? [index] : []);
  if (verifiedIndexes.length !== 1) throw new Error("MARATHON_CLOSURE_VERIFIED_COMMIT_MISSING");
  const suffix = commits.slice(verifiedIndexes[0]! + 1);
  if (suffix.length !== POST_VERIFICATION_COMMIT_SPECS.length) {
    throw new Error("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");
  }
  return suffix;
}

function verifyPostVerificationAssessmentDelta(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): void {
  const previousAcceptance = (previous.acceptance as readonly unknown[])
    .map((entry) => asObject(entry, "MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID"));
  const currentAcceptance = (current.acceptance as readonly unknown[])
    .map((entry) => asObject(entry, "MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID"));
  const previousById = new Map(previousAcceptance.map((entry) => [String(entry.id), entry]));
  const currentById = new Map(currentAcceptance.map((entry) => [String(entry.id), entry]));
  const previousMc01 = previousById.get("MC-01")!;
  const currentMc01 = currentById.get("MC-01")!;
  const previousMc11 = previousById.get("MC-11")!;
  const currentMc11 = currentById.get("MC-11")!;
  const previousMc34 = previousById.get("MC-34")!;
  const currentMc34 = currentById.get("MC-34")!;
  const previousCounts = asObject(previous.acceptance_counts, "MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  const currentCounts = asObject(current.acceptance_counts, "MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  if (previousMc01.status !== "PASS" || currentMc01.status !== "PASS"
      || previousMc01.evidence === currentMc01.evidence
      || previousMc11.status !== "PASS" || currentMc11.status !== "FAIL"
      || previousMc11.evidence === currentMc11.evidence
      || previousMc34.status !== "PASS" || currentMc34.status !== "FAIL"
      || previousMc34.evidence === currentMc34.evidence
      || previousCounts.PASS !== 22 || currentCounts.PASS !== 20
      || previousCounts.FAIL !== 14 || currentCounts.FAIL !== 16
      || previousCounts.BLOCKED !== 3 || currentCounts.BLOCKED !== 3
      || previousCounts.SKIPPED_DEPENDENCY !== 0 || currentCounts.SKIPPED_DEPENDENCY !== 0
      || previousCounts.NOT_APPLICABLE !== 0 || currentCounts.NOT_APPLICABLE !== 0) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  }
  const mc01Evidence = String(currentMc01.evidence);
  const mc11Evidence = String(currentMc11.evidence);
  const mc34Evidence = String(currentMc34.evidence);
  if (!mc01Evidence.includes("attempt HEAD")
      || !mc01Evidence.includes("closure HEAD")
      || !mc01Evidence.includes(POST_VERIFICATION_CLOSURE_PATH)
      || !mc01Evidence.includes(PRE_CLOSURE_ASSESSMENT_PATH)
      || !mc11Evidence.includes("FAILED_LOCAL_WITH_EVIDENCE")
      || !mc11Evidence.includes("POSTGRES_TRANSACTION_FAILED")
      || !mc34Evidence.includes("2/2")
      || !mc34Evidence.includes("FAIL")
      || !mc34Evidence.includes("BROWSER_E2E_SERVER_EXITED:1")
      || !mc34Evidence.includes("POSTGRES_TRANSACTION_FAILED")) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_EVIDENCE_INVALID");
  }

  const previousWaves = previous.wave_receipts as readonly unknown[];
  const currentWaves = current.wave_receipts as readonly unknown[];
  if (!Array.isArray(previousWaves) || !Array.isArray(currentWaves)) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  }
  const previousW2 = previousWaves.map((entry) => asObject(entry, "MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID"))
    .find((entry) => entry.wave === "W2");
  const currentW2 = currentWaves.map((entry) => asObject(entry, "MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID"))
    .find((entry) => entry.wave === "W2");
  if (!previousW2 || !currentW2 || !Array.isArray(previousW2.completed) || !Array.isArray(currentW2.completed)
      || !Array.isArray(previousW2.remaining) || !Array.isArray(currentW2.remaining)) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  }
  const completedIndex = previousW2.completed.indexOf(W2_OLD_COMPLETED);
  if (completedIndex < 0
      || previousW2.completed.filter((entry) => entry === W2_OLD_COMPLETED).length !== 1
      || currentW2.completed.length !== previousW2.completed.length
      || currentW2.completed[completedIndex] !== W2_NEW_COMPLETED
      || currentW2.remaining.length !== previousW2.remaining.length + 1
      || currentW2.remaining.at(-1) !== W2_NEW_REMAINING
      || previousW2.remaining.includes(W2_NEW_REMAINING)) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  }
  const previousChecks = previous.commit_checks as readonly unknown[];
  const currentChecks = current.commit_checks as readonly unknown[];
  if (!Array.isArray(previousChecks) || !Array.isArray(currentChecks)
      || currentChecks.length !== previousChecks.length + 1
      || canonicalSha256(currentChecks.at(-1)) !== canonicalSha256(POSTGRES_REPAIR_CHECK)) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  }

  const normalized = structuredClone(current);
  const normalizedAcceptance = normalized.acceptance as Record<string, unknown>[];
  const restoreAcceptance = (id: string, fields: readonly string[]) => {
    const oldEntry = previousById.get(id)!;
    const newEntry = normalizedAcceptance.find((entry) => entry.id === id)!;
    for (const field of fields) newEntry[field] = oldEntry[field];
  };
  restoreAcceptance("MC-01", ["evidence"]);
  restoreAcceptance("MC-11", ["status", "evidence"]);
  restoreAcceptance("MC-34", ["status", "evidence"]);
  const normalizedCounts = normalized.acceptance_counts as Record<string, unknown>;
  normalizedCounts.PASS = previousCounts.PASS;
  normalizedCounts.FAIL = previousCounts.FAIL;
  const normalizedW2 = (normalized.wave_receipts as Record<string, unknown>[]).find((entry) => entry.wave === "W2")!;
  normalizedW2.completed = structuredClone(previousW2.completed);
  normalizedW2.remaining = structuredClone(previousW2.remaining);
  normalized.commit_checks = structuredClone(previousChecks);
  if (canonicalSha256(normalized) !== canonicalSha256(previous)) {
    throw new Error("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  }
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
  if (await readTextPayload(root, manifest, "assessment.md") !== canonicalAcceptanceMarkdown(assessment)) {
    throw new Error("MARATHON_ASSESSMENT_MARKDOWN_MISMATCH");
  }
  verifyNdjson(await readTextPayload(root, manifest, "ledgers/marathon.ndjson"), "event_id");
  verifyNdjson(await readTextPayload(root, manifest, "ledgers/focused-checks.ndjson"), "check_id");
  const git = asObject(await readJsonPayload(root, manifest, "git/base-final.json"), "MARATHON_GIT_RECEIPT_INVALID");
  verifyGitReceipt(git);
  const commits = verifyCommitReceipts(
    asObject(await readJsonPayload(root, manifest, "git/commits.json"), "MARATHON_COMMIT_RECEIPTS_INVALID"),
    git,
  );
  await verifyFinalVerification(
    asObject(await readJsonPayload(root, manifest, "verification/final-verification.json"), "MARATHON_FINAL_VERIFICATION_INVALID"),
    assessment,
    git,
    commits,
    root,
    manifest,
  );
  if ((await readBytesPayload(root, manifest, "git/full.diff")).byteLength === 0) throw new Error("MARATHON_FULL_DIFF_EMPTY");
  verifyProhibitedScan(asObject(await readJsonPayload(root, manifest, "security/prohibited-operation-scan.json"), "MARATHON_PROHIBITED_SCAN_INVALID"));
  verifyProhibitedAudit(asObject(await readJsonPayload(root, manifest, "security/prohibited-operation-audit.json"), "MARATHON_PROHIBITED_AUDIT_INVALID"));
  verifyOwnerActionIndex(asObject(await readJsonPayload(root, manifest, "owner/action-index.json"), "MARATHON_OWNER_ACTION_INDEX_INVALID"));

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
      || !HEADLINE_STATUSES.has(String(assessment.final_status))
      || !Array.isArray(assessment.status_constants)
      || !Array.isArray(assessment.acceptance)
      || assessment.acceptance.length !== ACCEPTANCE_IDS.length) {
    throw new Error("MARATHON_ASSESSMENT_SHAPE_INVALID");
  }
  const statusConstants = assessment.status_constants.map(String);
  if (statusConstants.some((value) => FORBIDDEN_STATUS_CONSTANTS.has(value))
      || !statusConstants.includes("LEGAL_SOURCE_CORPUS_INCOMPLETE")
      || !statusConstants.includes("CUSTOMER_SHADOW_NOT_AUTHORIZED")
      || !statusConstants.includes("PRODUCTION_DELIVERY_DISABLED")) {
    throw new Error("MARATHON_ASSESSMENT_STATUS_CONSTANTS_INVALID");
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

function verifyOwnerActionIndex(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-owner-action-index-v0.10.0"
      || !Array.isArray(value.groups)
      || value.groups.length !== 11) throw new Error("MARATHON_OWNER_ACTION_INDEX_INVALID");
  const expected = Array.from({ length: 11 }, (_, index) => `OA-${String(index + 1).padStart(2, "0")}`);
  const groups = value.groups.map((entry) => asObject(entry, "MARATHON_OWNER_ACTION_GROUP_INVALID"));
  if (JSON.stringify(groups.map((entry) => entry.group_id)) !== JSON.stringify(expected)) {
    throw new Error("MARATHON_OWNER_ACTION_GROUP_SET_INVALID");
  }
  for (const group of groups) {
    if (!Array.isArray(group.actions) || group.actions.length === 0) throw new Error("MARATHON_OWNER_ACTION_GROUP_EMPTY");
    for (const raw of group.actions) {
      const action = asObject(raw, "MARATHON_OWNER_ACTION_INVALID");
      if (action.status !== "BLOCKED_EXTERNAL"
          || action.locally_solvable_engineering !== false
          || !Array.isArray(action.evidence_required)
          || action.evidence_required.length === 0) throw new Error("MARATHON_OWNER_ACTION_INVALID");
    }
  }
  const truths = asObject(value.baseline_truth, "MARATHON_OWNER_ACTION_TRUTHS_INVALID");
  if (truths.REAL_LEGAL_TOPICS_READY !== "0/7") throw new Error("MARATHON_OWNER_ACTION_TRUTHS_INVALID");
  for (const key of ZERO_TRUTH_COUNTERS) if (truths[key] !== 0) throw new Error(`MARATHON_OWNER_ACTION_TRUTH_NONZERO:${key}`);
  for (const key of NO_TRUTH_COUNTERS) if (truths[key] !== "NO") throw new Error(`MARATHON_OWNER_ACTION_TRUTH_NOT_NO:${key}`);
}

function verifyProhibitedAudit(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-full-local-system-marathon-security-audit-v0.10.0"
      || value.status !== "PASS"
      || value.finding_count !== 0
      || !Array.isArray(value.findings)
      || value.findings.length !== 0) throw new Error("MARATHON_PROHIBITED_AUDIT_FAILED");
  const truths = asObject(value.truth_counters, "MARATHON_PROHIBITED_AUDIT_TRUTHS_INVALID");
  for (const key of ["deployments", "remote_migrations", "live_provider_calls", "openai_calls", "customer_data_reads"] as const) {
    if (truths[key] !== 0) throw new Error(`MARATHON_PROHIBITED_AUDIT_NONZERO:${key}`);
  }
}

async function verifyFinalVerification(
  value: Record<string, unknown>,
  assessment: Record<string, unknown>,
  git: Record<string, unknown>,
  commits: readonly Record<string, unknown>[],
  root: string,
  manifest: MarathonManifest,
): Promise<void> {
  if (value.schema_version !== "tivdoc-full-local-system-marathon-final-verification-v0.10.0"
      || !["PASS", "FAIL"].includes(String(value.status))
      || !Array.isArray(value.commands)
      || !Array.isArray(value.attempts)
      || value.complete_attempt_limit !== 2) throw new Error("MARATHON_FINAL_VERIFICATION_SHAPE_INVALID");

  const attempts = value.attempts.map((entry) => asObject(entry, "MARATHON_FINAL_ATTEMPT_INVALID"));
  if (attempts.length < 1 || attempts.length > 2) throw new Error("MARATHON_FINAL_ATTEMPT_COUNT_INVALID");
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.schema_version !== "tivdoc-full-local-system-marathon-final-attempt-v0.10.0"
        || attempt.attempt_number !== index + 1
        || !["PASS", "FAIL"].includes(String(attempt.status))
        || typeof attempt.migration_or_persistence_changed !== "boolean"
        || typeof attempt.verified_head !== "string" || !/^[a-f0-9]{40}$/u.test(attempt.verified_head)
        || typeof attempt.verified_tree !== "string" || !/^[a-f0-9]{40}$/u.test(attempt.verified_tree)
        || !Array.isArray(attempt.commands)) throw new Error("MARATHON_FINAL_ATTEMPT_INVALID");
    const commands = attempt.commands.map((entry) => asObject(entry, "MARATHON_FINAL_COMMAND_INVALID"));
    await verifyCommandSet(commands, attempt.migration_or_persistence_changed === true, root, manifest, index + 1);
    const required = commands.filter((entry) => !["canonical_reachability", "persistence_wiring"].includes(String(entry.command_id)));
    const expectedStatus = required.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
    if (attempt.status !== expectedStatus) throw new Error("MARATHON_FINAL_ATTEMPT_STATUS_CONTRADICTION");
    const attemptPayload = asObject(
      await readJsonPayload(root, manifest, `verification/final-attempts/attempt-${String(index + 1).padStart(2, "0")}/attempt.json`),
      "MARATHON_FINAL_ATTEMPT_PAYLOAD_INVALID",
    );
    if (JSON.stringify(attemptPayload) !== JSON.stringify(attempt)) throw new Error("MARATHON_FINAL_ATTEMPT_PAYLOAD_MISMATCH");
    const attemptStart = asObject(
      await readJsonPayload(root, manifest, `verification/final-attempts/attempt-${String(index + 1).padStart(2, "0")}/attempt-start.json`),
      "MARATHON_FINAL_ATTEMPT_START_INVALID",
    );
    if (attemptStart.schema_version !== "tivdoc-full-local-system-marathon-final-attempt-start-v0.10.0"
        || attemptStart.attempt_number !== index + 1
        || attemptStart.migration_or_persistence_changed !== attempt.migration_or_persistence_changed
        || attemptStart.verified_head !== attempt.verified_head
        || attemptStart.verified_tree !== attempt.verified_tree
        || JSON.stringify(attemptStart.command_ids) !== JSON.stringify(commands.map((entry) => entry.command_id))) {
      throw new Error("MARATHON_FINAL_ATTEMPT_START_INVALID");
    }
  }

  const latest = attempts.at(-1)!;
  if (value.status !== latest.status || JSON.stringify(value.commands) !== JSON.stringify(latest.commands)) {
    throw new Error("MARATHON_FINAL_LATEST_ATTEMPT_MISMATCH");
  }
  if (value.verified_head !== latest.verified_head || value.verified_tree !== latest.verified_tree) {
    throw new Error("MARATHON_FINAL_VERIFIED_GIT_MISMATCH");
  }
  const exactHeadBinding = latest.verified_head === git.final_head && latest.verified_tree === git.final_tree;
  const closurePayloadPresent = manifest.payload_files.some((entry) => entry.path === POST_VERIFICATION_CLOSURE_PATH);
  const previousAssessmentPresent = manifest.payload_files.some((entry) => entry.path === PRE_CLOSURE_ASSESSMENT_PATH);
  if (exactHeadBinding) {
    if (closurePayloadPresent || previousAssessmentPresent) throw new Error("MARATHON_CLOSURE_PAYLOAD_UNEXPECTED");
  } else {
    if (!closurePayloadPresent || !previousAssessmentPresent) throw new Error("MARATHON_FINAL_VERIFIED_GIT_MISMATCH");
    const previousAssessmentBytes = await readBytesPayload(root, manifest, PRE_CLOSURE_ASSESSMENT_PATH);
    verifyPostVerificationClosure({
      receipt: asObject(await readJsonPayload(root, manifest, POST_VERIFICATION_CLOSURE_PATH), "MARATHON_CLOSURE_RECEIPT_INVALID"),
      previousAssessmentBytes,
      currentAssessment: assessment,
      finalVerification: value,
      git,
      commits,
    });
  }
  const runCounts = asObject(value.run_counts, "MARATHON_FINAL_RUN_COUNTS_INVALID");
  const commandCount = (commandId: string) => attempts.reduce(
    (total, attempt) => total + (attempt.commands as readonly Record<string, unknown>[])
      .filter((entry) => entry.command_id === commandId).length,
    0,
  );
  const expectedCounts = {
    full_suite: commandCount("full_suite"),
    production_build: commandCount("production_build"),
    browser_e2e_full: commandCount("browser_e2e"),
    postgresql_regression: commandCount("postgresql_regression"),
    complete_final_attempts: attempts.length,
  } as const;
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (runCounts[key] !== expected) throw new Error(`MARATHON_FINAL_RUN_COUNT_MISMATCH:${key}`);
  }
  if (expectedCounts.full_suite !== attempts.length
      || expectedCounts.production_build !== attempts.length
      || expectedCounts.browser_e2e_full !== attempts.length
      || expectedCounts.postgresql_regression !== attempts.filter((entry) => entry.migration_or_persistence_changed === true).length) {
    throw new Error("MARATHON_FINAL_RUN_COUNT_SEMANTICS_INVALID");
  }

  const ledgerLines = (await readTextPayload(root, manifest, "verification/final-attempt-ledger.ndjson"))
    .split(/\r?\n/u).filter(Boolean).map((line) => asObject(JSON.parse(line), "MARATHON_FINAL_ATTEMPT_LEDGER_INVALID"));
  if (JSON.stringify(ledgerLines) !== JSON.stringify(attempts)) throw new Error("MARATHON_FINAL_ATTEMPT_LEDGER_MISMATCH");

  const truths = asObject(assessment.truth_counters, "MARATHON_TRUTH_COUNTERS_INVALID");
  if (truths.FULL_SUITE_RUN_COUNT !== expectedCounts.full_suite
      || truths.PRODUCTION_BUILD_RUN_COUNT !== expectedCounts.production_build
      || truths.BROWSER_E2E_FULL_RUN_COUNT !== expectedCounts.browser_e2e_full) {
    throw new Error("MARATHON_ASSESSMENT_RUN_COUNT_CONTRADICTION");
  }
  const acceptance = (assessment.acceptance as readonly Record<string, unknown>[]);
  const mc34 = acceptance.find((entry) => entry.id === "MC-34");
  const expectedMc34 = value.status === "PASS" ? "PASS" : "FAIL";
  if (!mc34 || mc34.status !== expectedMc34) throw new Error("MARATHON_MC34_FINAL_VERIFICATION_CONTRADICTION");

  const latestCommands = latest.commands as readonly Record<string, unknown>[];
  if (latestCommands.some((entry) => entry.command_id === "browser_e2e" && entry.status === "PASS")) {
    await verifyBrowserReceipt(root, manifest);
  }
  if (attempts.some((attempt) => (attempt.commands as readonly Record<string, unknown>[])
    .some((entry) => entry.command_id === "postgresql_regression" && entry.status === "PASS"))) {
    await verifyPostgresqlEvidence(root, manifest, attempts, git);
  }
}

async function verifyCommandSet(
  commands: readonly Record<string, unknown>[],
  migrationChanged: boolean,
  root: string,
  manifest: MarathonManifest,
  attemptNumber: number,
): Promise<void> {
  const ids = commands.map((entry) => String(entry.command_id));
  const expected = [...REQUIRED_FINAL_COMMANDS, ...(migrationChanged ? ["postgresql_regression"] : [])].sort(compareStrings);
  if (new Set(ids).size !== ids.length || JSON.stringify([...ids].sort(compareStrings)) !== JSON.stringify(expected)) {
    throw new Error("MARATHON_FINAL_COMMAND_SET_INVALID");
  }
  for (const command of commands) {
    if (!new Set(["PASS", "FAIL"]).has(String(command.status))
        || !Number.isSafeInteger(command.exit_code)
        || (command.status === "PASS") !== (command.exit_code === 0 && command.signal === null)
        || !Number.isSafeInteger(command.elapsed_ms)
        || (command.elapsed_ms as number) < 0
        || typeof command.stdout_sha256 !== "string"
        || !SHA256.test(command.stdout_sha256)
        || typeof command.stderr_sha256 !== "string"
        || !SHA256.test(command.stderr_sha256)
        || !Number.isSafeInteger(command.stdout_byte_count)
        || !Number.isSafeInteger(command.stderr_byte_count)
        || typeof command.stdout_log !== "string"
        || typeof command.stderr_log !== "string") {
      throw new Error("MARATHON_FINAL_COMMAND_RECEIPT_INVALID");
    }
    const attemptLabel = `attempt-${String(attemptNumber).padStart(2, "0")}`;
    const persistedCommand = asObject(
      await readJsonPayload(root, manifest, `verification/final-attempts/${attemptLabel}/${String(command.command_id)}.json`),
      "MARATHON_FINAL_COMMAND_PAYLOAD_INVALID",
    );
    if (JSON.stringify(persistedCommand) !== JSON.stringify(command)) throw new Error("MARATHON_FINAL_COMMAND_PAYLOAD_MISMATCH");
    const started = asObject(
      await readJsonPayload(root, manifest, `verification/final-attempts/${attemptLabel}/${String(command.command_id)}.started.json`),
      "MARATHON_FINAL_COMMAND_START_INVALID",
    );
    if (started.schema_version !== "tivdoc-full-local-system-marathon-command-start-v0.10.0"
        || started.attempt_number !== attemptNumber
        || started.command_id !== command.command_id) throw new Error("MARATHON_FINAL_COMMAND_START_INVALID");
    const expectedPrefix = `final-logs/attempt-${String(attemptNumber).padStart(2, "0")}/`;
    for (const [logName, digest, byteCount] of [
      [command.stdout_log, command.stdout_sha256, command.stdout_byte_count],
      [command.stderr_log, command.stderr_sha256, command.stderr_byte_count],
    ] as const) {
      if (!String(logName).startsWith(expectedPrefix) || !isSafeLogPath(String(logName))) {
        throw new Error("MARATHON_FINAL_LOG_PATH_INVALID");
      }
      const payloadName = `verification/${String(logName)}`;
      const bytes = await readBytesPayload(root, manifest, payloadName);
      if (bytes.byteLength !== byteCount || sha256(bytes) !== digest) throw new Error("MARATHON_FINAL_LOG_HASH_MISMATCH");
    }
  }
}

async function verifyBrowserReceipt(root: string, manifest: MarathonManifest): Promise<void> {
  const value = asObject(
    await readJsonPayload(root, manifest, "verification/browser/browser-e2e-receipt.json"),
    "MARATHON_BROWSER_RECEIPT_INVALID",
  );
  if (value.schema_version !== "tivdoc-full-local-system-marathon-browser-e2e-v0.10.0"
      || value.status !== "PASS"
      || value.real_browser_cli !== true
      || value.direct_service_shortcuts !== false
      || !Array.isArray(value.snapshots)
      || value.snapshots.length === 0) throw new Error("MARATHON_BROWSER_RECEIPT_INVALID");
  for (const raw of value.snapshots) {
    const snapshot = asObject(raw, "MARATHON_BROWSER_SNAPSHOT_INVALID");
    if (typeof snapshot.path !== "string"
        || !snapshot.path.startsWith("output/playwright/v010-marathon/")
        || typeof snapshot.sha256 !== "string"
        || !SHA256.test(snapshot.sha256)
        || !Number.isSafeInteger(snapshot.byte_count)) throw new Error("MARATHON_BROWSER_SNAPSHOT_INVALID");
    const name = snapshot.path.slice("output/playwright/v010-marathon/".length);
    assertSafePayloadName(name);
    const bytes = await readBytesPayload(root, manifest, `verification/browser/${name}`);
    if (bytes.byteLength !== snapshot.byte_count || sha256(bytes) !== snapshot.sha256) {
      throw new Error("MARATHON_BROWSER_SNAPSHOT_HASH_MISMATCH");
    }
  }
}

async function verifyPostgresqlEvidence(
  root: string,
  manifest: MarathonManifest,
  attempts: readonly Record<string, unknown>[],
  git: Record<string, unknown>,
): Promise<void> {
  const matrixBytes = await readBytesPayload(root, manifest, "verification/postgresql/matrix-smoke.json");
  const matrix = asObject(JSON.parse(matrixBytes.toString("utf8")), "MARATHON_POSTGRESQL_MATRIX_RECEIPT_INVALID");
  const detailedBytes = await readBytesPayload(root, manifest, "verification/postgresql/marathon-v010-matrix.json");
  const detailed = asObject(JSON.parse(detailedBytes.toString("utf8")), "MARATHON_POSTGRESQL_V010_RECEIPT_INVALID");

  verifyPostgresqlMatrixSmoke(matrix, detailedBytes);
  verifyMarathonV010PostgresqlReceipt(detailed, String(git.final_head));
  const before = asObject(detailed.before_restart, "MARATHON_POSTGRESQL_V010_BEFORE_INVALID");
  const after = asObject(detailed.after_restart, "MARATHON_POSTGRESQL_V010_AFTER_INVALID");
  const checkpoint = asObject(before.checkpoint, "MARATHON_POSTGRESQL_V010_CHECKPOINT_INVALID");
  if (matrix.marathon_v010_checkpoint_sha256 !== checkpoint.checkpoint_sha256) {
    throw new Error("MARATHON_POSTGRESQL_CHECKPOINT_BINDING_MISMATCH");
  }
  const v010Connections = Number(asObject(before.connection_attempts,
    "MARATHON_POSTGRESQL_V010_CONNECTIONS_INVALID").observed_total)
    + Number(asObject(after.connection_attempts, "MARATHON_POSTGRESQL_V010_CONNECTIONS_INVALID").observed_total);
  if ((matrix.real_connection_attempts as number) < v010Connections) {
    throw new Error("MARATHON_POSTGRESQL_CONNECTION_BINDING_INVALID");
  }

  const successfulCommand = [...attempts].reverse().flatMap((attempt) =>
    [...(attempt.commands as readonly Record<string, unknown>[])].reverse())
    .find((entry) => entry.command_id === "postgresql_regression" && entry.status === "PASS");
  if (!successfulCommand || typeof successfulCommand.stdout_log !== "string") {
    throw new Error("MARATHON_POSTGRESQL_SUCCESSFUL_COMMAND_MISSING");
  }
  const stdout = await readTextPayload(root, manifest, `verification/${successfulCommand.stdout_log}`);
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error("MARATHON_POSTGRESQL_STDOUT_RECEIPT_INVALID");
  const logged = asObject(JSON.parse(lines[0]!), "MARATHON_POSTGRESQL_STDOUT_RECEIPT_INVALID");
  if (JSON.stringify(logged) !== JSON.stringify(matrix)) {
    throw new Error("MARATHON_POSTGRESQL_STDOUT_RECEIPT_MISMATCH");
  }
}

function verifyPostgresqlMatrixSmoke(value: Record<string, unknown>, detailedBytes: Uint8Array): void {
  if (value.schema_version !== "tivdoc-real-postgresql-matrix-smoke-v0.9.1"
      || value.status !== "PASS"
      || value.postgres_version !== "17.11"
      || value.migrations !== "PASS"
      || !Number.isSafeInteger(value.migration_count)
      || (value.migration_count as number) < 14
      || value.capabilities !== 14
      || value.restart !== "PASS"
      || value.rls !== "PASS"
      || value.atomicity !== "PASS"
      || value.concurrency !== "PASS"
      || !["PASS", "BLOCKED_ENVIRONMENT"].includes(String(value.backup_restore))
      || !Number.isSafeInteger(value.real_connection_attempts)
      || (value.real_connection_attempts as number) < 1
      || value.credentials_recorded !== 0
      || value.marathon_v010 !== "PASS"
      || value.marathon_v010_receipt_path !== POSTGRESQL_MARATHON_RECEIPT_PATH
      || value.marathon_v010_receipt_sha256 !== sha256(detailedBytes)
      || typeof value.marathon_v010_checkpoint_sha256 !== "string"
      || !SHA256.test(value.marathon_v010_checkpoint_sha256)
      || value.marathon_v010_tenant_ordinal !== 3) {
    throw new Error("MARATHON_POSTGRESQL_MATRIX_RECEIPT_FAILED");
  }
  const provenance = asObject(value.runtime_provenance, "MARATHON_POSTGRESQL_RUNTIME_PROVENANCE_INVALID");
  if (canonicalSha256(provenance) !== canonicalSha256(POSTGRESQL_RUNTIME_PROVENANCE)) {
    throw new Error("MARATHON_POSTGRESQL_RUNTIME_PROVENANCE_INVALID");
  }
}

function verifyMarathonV010PostgresqlReceipt(value: Record<string, unknown>, finalHead: string): void {
  if (value.schema_version !== "tivdoc-marathon-v010-postgresql-matrix-v1"
      || value.proof_class !== "REAL_NODE_POSTGRES_PARAMETERIZED_SQL"
      || value.receipt_path !== POSTGRESQL_MARATHON_RECEIPT_PATH
      || typeof value.target_id !== "string" || value.target_id.length === 0
      || value.tenant_ordinal !== 3
      || value.genuine_server_stop_start !== true
      || value.same_cluster_restarted !== true
      || value.pre_restart_pools_closed !== true
      || value.fresh_post_restart_pools !== true
      || value.status !== "PASS") {
    throw new Error("MARATHON_POSTGRESQL_V010_RECEIPT_FAILED");
  }

  const before = asObject(value.before_restart, "MARATHON_POSTGRESQL_V010_BEFORE_INVALID");
  const after = asObject(value.after_restart, "MARATHON_POSTGRESQL_V010_AFTER_INVALID");
  verifyMarathonBeforeRestart(before, finalHead, String(value.target_id));
  verifyMarathonAfterRestart(after);
  const checkpoint = asObject(before.checkpoint, "MARATHON_POSTGRESQL_V010_CHECKPOINT_INVALID");
  if (after.checkpoint_sha256 !== checkpoint.checkpoint_sha256
      || JSON.stringify(value.final_row_counts) !== JSON.stringify(after.final_row_counts)) {
    throw new Error("MARATHON_POSTGRESQL_V010_CROSS_PHASE_MISMATCH");
  }
  assertMarathonTruthCounters(value.truth_counters, "MARATHON_POSTGRESQL_V010_TRUTH_COUNTER_INVALID");
  if (JSON.stringify(value.truth_counters) !== JSON.stringify(before.truth_counters)
      || JSON.stringify(value.truth_counters) !== JSON.stringify(after.truth_counters)) {
    throw new Error("MARATHON_POSTGRESQL_V010_TRUTH_COUNTER_MISMATCH");
  }
}

function verifyMarathonBeforeRestart(value: Record<string, unknown>, finalHead: string, targetId: string): void {
  if (value.schema_version !== "tivdoc-marathon-v010-postgresql-before-restart-v1"
      || value.proof_class !== "REAL_NODE_POSTGRES_PARAMETERIZED_SQL" || value.status !== "PASS") {
    throw new Error("MARATHON_POSTGRESQL_V010_BEFORE_INVALID");
  }
  const seed = asObject(value.capability_seed, "MARATHON_POSTGRESQL_V010_CAPABILITY_SEED_INVALID");
  if (seed.tenant_ordinal !== 3 || seed.capability_count !== 14
      || typeof seed.tenant_id !== "string" || seed.tenant_id.length === 0
      || typeof seed.case_id !== "string" || seed.case_id.length === 0
      || typeof seed.capability_matrix_sha256 !== "string" || !SHA256.test(seed.capability_matrix_sha256)
      || typeof seed.durable_state_sha256 !== "string" || !SHA256.test(seed.durable_state_sha256)) {
    throw new Error("MARATHON_POSTGRESQL_V010_CAPABILITY_SEED_INVALID");
  }
  assertExactTrueFields(value.controlled_import, [
    "reserve_idempotency_replay", "idempotency_binding_mismatch_rejected", "unpublished_bytes_denied",
    "stale_fencing_token_rejected", "toctou_reopen_rejected", "exact_bytes_staged",
    "publication_idempotency_replay", "published_exact_bytes_reopened",
  ], "MARATHON_POSTGRESQL_V010_IMPORT_INVALID");
  const controlledImport = asObject(value.controlled_import, "MARATHON_POSTGRESQL_V010_IMPORT_INVALID");
  if (controlledImport.audit_event_rows !== 5) throw new Error("MARATHON_POSTGRESQL_V010_IMPORT_INVALID");
  assertExactTrueFields(value.durable_boundaries, [
    "identity_registration_replayed", "identity_rotation_persisted", "stale_identity_rotation_rejected",
    "owner_binding_replayed", "cross_owner_denied", "privacy_revision_replayed", "report_binding_replayed",
    "report_approval_replayed", "wrong_report_binding_denied", "exact_report_bytes_read",
  ], "MARATHON_POSTGRESQL_V010_BOUNDARIES_INVALID");
  const boundaries = asObject(value.durable_boundaries, "MARATHON_POSTGRESQL_V010_BOUNDARIES_INVALID");
  if (boundaries.privacy_revision_count !== 2
      || boundaries.report_byte_provider !== "EXPLICIT_SYNTHETIC_TEST_DOUBLE_NOT_PRODUCT_COMPOSITION"
      || boundaries.managed_storage_proof_claimed !== false) {
    throw new Error("MARATHON_POSTGRESQL_V010_BOUNDARIES_INVALID");
  }
  verifyMarathonRowCounts(value.row_counts, 2, "MARATHON_POSTGRESQL_V010_BEFORE_ROWS_INVALID");
  verifyConnectionAttempts(value.connection_attempts, ["capability_seed", "service_role", "administrative_count_probe"]);
  const checkpoint = asObject(value.checkpoint, "MARATHON_POSTGRESQL_V010_CHECKPOINT_INVALID");
  verifyMarathonCheckpoint(checkpoint, finalHead, targetId, value.row_counts);
  if (seed.durable_state_sha256 !== asObject(checkpoint.capability_state,
    "MARATHON_POSTGRESQL_V010_CAPABILITY_STATE_INVALID").durable_state_sha256) {
    throw new Error("MARATHON_POSTGRESQL_V010_CAPABILITY_STATE_MISMATCH");
  }
  assertMarathonTruthCounters(value.truth_counters, "MARATHON_POSTGRESQL_V010_TRUTH_COUNTER_INVALID");
}

function verifyMarathonAfterRestart(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-marathon-v010-postgresql-after-restart-v1"
      || value.proof_class !== "REAL_NODE_POSTGRES_PARAMETERIZED_SQL" || value.status !== "PASS") {
    throw new Error("MARATHON_POSTGRESQL_V010_AFTER_INVALID");
  }
  assertExactTrueFields(value.restart, [
    "externally_managed_genuine_stop_start", "same_cluster_restarted", "all_pre_restart_pools_closed",
    "fresh_capability_replay_pool", "fresh_boundary_pool", "target_id_unchanged",
  ], "MARATHON_POSTGRESQL_V010_RESTART_INVALID");
  assertExactTrueFields(value.durable_replay, [
    "capability_matrix_unchanged", "import_status_reloaded", "import_publication_replayed",
    "published_exact_bytes_reopened", "pre_revocation_rows_unchanged", "identity_rotation_reloaded",
    "owner_binding_reloaded", "privacy_revision_replayed", "approved_report_exact_bytes_reloaded",
  ], "MARATHON_POSTGRESQL_V010_REPLAY_INVALID");
  const replay = asObject(value.durable_replay, "MARATHON_POSTGRESQL_V010_REPLAY_INVALID");
  if (replay.capability_count !== 14) throw new Error("MARATHON_POSTGRESQL_V010_REPLAY_INVALID");
  assertExactTrueFields(value.fail_closed_revocation, [
    "identity_revoked", "revoked_identity_rotation_denied", "owner_revoked", "owner_read_denied",
    "report_revoked", "report_read_denied_before_provider_access", "privacy_completion_revision_persisted",
  ], "MARATHON_POSTGRESQL_V010_REVOCATION_INVALID");
  verifyMarathonRowCounts(value.pre_revocation_row_counts, 2, "MARATHON_POSTGRESQL_V010_PRE_REVOCATION_ROWS_INVALID");
  verifyMarathonRowCounts(value.final_row_counts, 3, "MARATHON_POSTGRESQL_V010_FINAL_ROWS_INVALID");
  verifyConnectionAttempts(value.connection_attempts, ["capability_replay", "service_role", "administrative_count_probe"]);
  if (typeof value.checkpoint_sha256 !== "string" || !SHA256.test(value.checkpoint_sha256)) {
    throw new Error("MARATHON_POSTGRESQL_V010_CHECKPOINT_INVALID");
  }
  assertMarathonTruthCounters(value.truth_counters, "MARATHON_POSTGRESQL_V010_TRUTH_COUNTER_INVALID");
}

function verifyMarathonCheckpoint(
  value: Record<string, unknown>,
  finalHead: string,
  targetId: string,
  beforeRows: unknown,
): void {
  if (value.schema_version !== "tivdoc-marathon-v010-postgresql-checkpoint-v1"
      || value.build_identity_sha !== finalHead || value.target_id !== targetId || value.tenant_ordinal !== 3
      || typeof value.fixture_suffix !== "string" || !/^[a-z0-9]{8,24}$/u.test(value.fixture_suffix)
      || typeof value.before_restart_rows_sha256 !== "string" || !SHA256.test(value.before_restart_rows_sha256)
      || typeof value.checkpoint_sha256 !== "string" || !SHA256.test(value.checkpoint_sha256)
      || JSON.stringify(value.before_restart_rows) !== JSON.stringify(beforeRows)) {
    throw new Error("MARATHON_POSTGRESQL_V010_CHECKPOINT_INVALID");
  }
  if (value.before_restart_rows_sha256 !== canonicalSha256(value.before_restart_rows)) {
    throw new Error("MARATHON_POSTGRESQL_V010_ROW_HASH_MISMATCH");
  }
  const capabilityState = asObject(value.capability_state, "MARATHON_POSTGRESQL_V010_CAPABILITY_STATE_INVALID");
  const durableStateHash = capabilityState.durable_state_sha256;
  const durableStateSeed = { ...capabilityState };
  delete durableStateSeed.durable_state_sha256;
  if (capabilityState.schema_version !== "tivdoc-canonical-persistence-v091-durable-state-v1"
      || typeof durableStateHash !== "string" || !SHA256.test(durableStateHash)
      || durableStateHash !== canonicalSha256(durableStateSeed)) {
    throw new Error("MARATHON_POSTGRESQL_V010_CAPABILITY_STATE_INVALID");
  }
  const checkpointHash = value.checkpoint_sha256;
  const checkpointSeed = { ...value };
  delete checkpointSeed.checkpoint_sha256;
  if (checkpointHash !== canonicalSha256(checkpointSeed)) {
    throw new Error("MARATHON_POSTGRESQL_V010_CHECKPOINT_HASH_MISMATCH");
  }
}

function verifyMarathonRowCounts(value: unknown, privacyRevisions: 2 | 3, code: string): void {
  if (!Array.isArray(value)) throw new Error(code);
  const expected = new Map<string, number>([
    ["private.controlled_import_requests", 1],
    ["private.controlled_import_artifacts", 1],
    ["private.controlled_import_audit_events", 5],
    ["public.controlled_import_publication_markers", 1],
    ["public.product_identity_sessions", 1],
    ["public.product_case_owners", 1],
    ["public.product_privacy_request_versions", privacyRevisions],
    ["public.product_private_report_objects", 1],
  ]);
  if (value.length !== expected.size) throw new Error(code);
  const seen = new Set<string>();
  for (const raw of value) {
    const row = asObject(raw, code);
    if (typeof row.table !== "string" || seen.has(row.table) || expected.get(row.table) !== row.row_count
        || typeof row.state_sha256 !== "string" || !SHA256.test(row.state_sha256)) throw new Error(code);
    seen.add(row.table);
  }
  if (seen.size !== expected.size) throw new Error(code);
}

function verifyConnectionAttempts(value: unknown, components: readonly string[]): void {
  const receipt = asObject(value, "MARATHON_POSTGRESQL_V010_CONNECTIONS_INVALID");
  let total = 0;
  for (const component of components) {
    if (!Number.isSafeInteger(receipt[component]) || (receipt[component] as number) < 1) {
      throw new Error("MARATHON_POSTGRESQL_V010_CONNECTIONS_INVALID");
    }
    total += receipt[component] as number;
  }
  if (receipt.observed_total !== total) throw new Error("MARATHON_POSTGRESQL_V010_CONNECTIONS_INVALID");
}

function assertExactTrueFields(value: unknown, fields: readonly string[], code: string): void {
  const receipt = asObject(value, code);
  for (const field of fields) if (receipt[field] !== true) throw new Error(code);
}

function assertMarathonTruthCounters(value: unknown, code: string): void {
  const truths = asObject(value, code);
  if (truths.REAL_LEGAL_TOPICS_READY !== "0/7") throw new Error(code);
  for (const key of ZERO_TRUTH_COUNTERS) if (truths[key] !== 0) throw new Error(code);
  for (const key of NO_TRUTH_COUNTERS) if (truths[key] !== "NO") throw new Error(code);
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

function verifyCommitReceipts(
  value: Record<string, unknown>,
  git: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  if (value.schema_version !== "tivdoc-marathon-commit-receipts-v0.10.0"
      || !Array.isArray(value.commits)
      || value.commits.length === 0) throw new Error("MARATHON_COMMIT_RECEIPTS_INVALID");
  const commits = value.commits.map((entry) => asObject(entry, "MARATHON_COMMIT_RECEIPT_INVALID"));
  let expectedParent = String(git.base_head);
  for (const commit of commits) {
    if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/u.test(commit.sha)
        || typeof commit.tree !== "string" || !/^[a-f0-9]{40}$/u.test(commit.tree)
        || commit.parent !== expectedParent
        || typeof commit.stable_patch_id !== "string" || !/^[a-f0-9]{40}$/u.test(commit.stable_patch_id)
        || typeof commit.subject !== "string" || commit.subject.length === 0
        || typeof commit.diffstat !== "string" || commit.diffstat.length === 0
        || !Array.isArray(commit.changed_paths) || commit.changed_paths.length === 0
        || !Array.isArray(commit.focused_checks)) throw new Error("MARATHON_COMMIT_RECEIPT_INVALID");
    const paths = commit.changed_paths.map(String);
    if (new Set(paths.map((name) => name.toLowerCase())).size !== paths.length
        || JSON.stringify([...paths].sort(compareStrings)) !== JSON.stringify(paths)) {
      throw new Error("MARATHON_COMMIT_PATHS_INVALID");
    }
    for (const name of paths) assertSafePayloadName(name);
    expectedParent = commit.sha;
  }
  if (expectedParent !== git.final_head) throw new Error("MARATHON_COMMIT_CHAIN_FINAL_HEAD_MISMATCH");
  return commits;
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

async function readBytesPayload(root: string, manifest: MarathonManifest, name: string): Promise<Buffer> {
  if (!manifest.payload_files.some((entry) => entry.path === name)) throw new Error(`MARATHON_REQUIRED_PAYLOAD_MISSING:${name}`);
  return readFile(path.resolve(root, ...name.split("/")));
}

async function readTextPayload(root: string, manifest: MarathonManifest, name: string): Promise<string> {
  if (!manifest.payload_files.some((entry) => entry.path === name)) throw new Error(`MARATHON_REQUIRED_PAYLOAD_MISSING:${name}`);
  return readFile(path.resolve(root, ...name.split("/")), "utf8");
}

function isSafeLogPath(name: string): boolean {
  return /^final-logs\/attempt-\d{2}\/[a-z0-9_]+\.(?:stdout|stderr)\.log$/u.test(name)
    && path.posix.normalize(name) === name;
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

function assertExactObjectKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  if (JSON.stringify(Object.keys(value).sort(compareStrings)) !== JSON.stringify([...expected].sort(compareStrings))) {
    throw new Error(code);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}
