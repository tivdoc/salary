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
  await verifyFinalVerification(
    asObject(await readJsonPayload(root, manifest, "verification/final-verification.json"), "MARATHON_FINAL_VERIFICATION_INVALID"),
    assessment,
    git,
    root,
    manifest,
  );
  verifyCommitReceipts(
    asObject(await readJsonPayload(root, manifest, "git/commits.json"), "MARATHON_COMMIT_RECEIPTS_INVALID"),
    git,
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
  if (value.verified_head !== latest.verified_head
      || value.verified_tree !== latest.verified_tree
      || latest.verified_head !== git.final_head
      || latest.verified_tree !== git.final_tree) {
    throw new Error("MARATHON_FINAL_VERIFIED_GIT_MISMATCH");
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
    verifyPostgresqlReceipt(asObject(
      await readJsonPayload(root, manifest, "verification/postgresql/acceptance-receipt.json"),
      "MARATHON_POSTGRESQL_RECEIPT_INVALID",
    ));
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

function verifyPostgresqlReceipt(value: Record<string, unknown>): void {
  if (value.schema_version !== "tivdoc-canonical-postgresql-dynamic-acceptance-v0.9.1"
      || value.status !== "PASS"
      || value.acceptance_result !== "ACCEPTANCE_24_OF_24_PASS"
      || value.pc_22 !== "PC-22_PASS") throw new Error("MARATHON_POSTGRESQL_RECEIPT_FAILED");
  const counts = asObject(value.counts, "MARATHON_POSTGRESQL_COUNTS_INVALID");
  if (counts.total !== 24 || counts.pass !== 24 || counts.fail !== 0 || counts.skipped !== 0) {
    throw new Error("MARATHON_POSTGRESQL_COUNTS_INVALID");
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

function verifyCommitReceipts(value: Record<string, unknown>, git: Record<string, unknown>): void {
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}
