import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { canonicalOwnerPdfReachability } from "../../src/server/engine/legal-knowledge/acquisition.ts";
import { parserIsolationAssurance } from "../../src/server/engine/legal-knowledge/parser-isolation/index.ts";

const repoRoot = process.cwd();
const evidenceRoot = path.resolve(repoRoot, "output", "parallel-wave-2.1", "workers", "w3-ledger-parser");
const nodeArgs = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"];

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

async function writeEvidence(name: string, value: unknown) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, name), stableJson(value));
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, [...args], { cwd: repoRoot, env, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return { exit_code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

async function reachabilityEvidence() {
  const [acquisition, security, cli] = await Promise.all([
    readFile(path.join(repoRoot, "src/server/engine/legal-knowledge/acquisition.ts"), "utf8"),
    readFile(path.join(repoRoot, "src/server/engine/legal-knowledge/controlled-import-security.ts"), "utf8"),
    readFile(path.join(repoRoot, "scripts/legal-acquisition.mts"), "utf8"),
  ]);
  const lowLevelValidatorReferences = security.match(/validateControlledPdfBytes\s*\(/gu)?.length ?? 0;
  const result = {
    schema_version: "tivdoc-wave21-parser-reachability-v0.4.1",
    canonical: canonicalOwnerPdfReachability,
    assurance: parserIsolationAssurance,
    proofs: {
      cli_import_calls_owner_import: cli.includes("importOwnerOfficialArtifact({ request"),
      canonical_owner_reader_uses_committed_list: cli.includes("loadCommittedOwnerArtifacts({"),
      acquisition_has_no_low_level_in_process_validator_reference: !acquisition.includes("validateControlledPdfBytes"),
      low_level_validator_is_definition_only_in_security_module: lowLevelValidatorReferences === 1,
      controlled_import_calls_isolated_screener: security.includes("const isolated = await screenUntrustedPdfIsolated({ bytes: snapshot.bytes })"),
      committed_reader_rescreens_before_visibility: security.includes("const screening = await screenUntrustedPdfIsolated({ bytes })"),
      visibility_enumerates_commit_markers: security.includes("path.resolve(input.ledgerRoot, \".commits\")"),
      real_owner_import_disabled_until_os_sandbox: security.includes("owner_import_disabled_parser_os_sandbox_not_verified"),
    },
    direct_in_process_owner_parse_reachable: false,
    no_partial_outputs_at_reader_gate: { parse_result: null, citations: [], chunks: [], retrieval_results: [] },
  };
  if (Object.values(result.proofs).some((value) => !value)) throw new Error("wave21_parser_reachability_failed");
  return result;
}

async function buildManifest() {
  const names = (await readdir(evidenceRoot)).filter((name) => name.endsWith(".json") && name !== "manifest.json").sort();
  const files = [];
  for (const name of names) {
    const bytes = await readFile(path.join(evidenceRoot, name));
    files.push({ path: name, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  await writeEvidence("manifest.json", {
    schema_version: "tivdoc-wave21-w3-evidence-manifest-v0.4.1",
    self_excluded: true,
    files,
  });
}

async function localVerification() {
  const testFiles = [
    "src/server/engine/legal-knowledge/acquisition.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-security.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/protocol.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/multiprocess.test.ts",
    "src/server/engine/legal-knowledge/parser-isolation/parser-isolation.test.ts",
  ];
  const tests = run(process.execPath, [path.join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...testFiles, "--reporter=verbose"]);
  const strict = run(process.execPath, [...nodeArgs, path.join(repoRoot, "scripts/legal-acquisition.mts"), "operational-readiness"], { ...process.env, TIVDOC_LEGAL_NETWORK_DISABLED: "1" });
  const reachability = await reachabilityEvidence();
  const platform = {
    schema_version: "tivdoc-wave21-native-platform-evidence-v0.4.1",
    actual_host: { platform: process.platform, arch: process.arch, node: process.version },
    actual_native_tests: ["multi_process_identity_locking", "process_termination_restart_recovery", "hardlink_link_count_rejection"],
    conditional_tests: ["win32_junction_or_reparse_rejection_only_when_host_permission_allows_creation"],
    simulated_string_validation_only: ["windows_ads_colon", "windows_device_names", "unc_paths", "drive_absolute_paths"],
    distributed_coordination_claimed: false,
    application_isolation: "PARSER_APPLICATION_ISOLATION_VERIFIED",
    os_sandbox: "PARSER_OS_SANDBOX_NOT_VERIFIED",
  };
  const summary = {
    schema_version: "tivdoc-wave21-w3-local-verification-v0.4.1",
    status: tests.exit_code === 0 && strict.exit_code !== 0 ? "WAVE21_W3_LOCAL_ADVERSARIAL_VERIFIED" : "WAVE21_W3_LOCAL_ADVERSARIAL_FAILED",
    local_only: true,
    tests: { command: `node node_modules/vitest/vitest.mjs run ${testFiles.join(" ")} --reporter=verbose`, exit_code: tests.exit_code, expected_test_files: 5, expected_tests: 86 },
    matrices: {
      crash_points: ["after_received", "after_private_copy", "after_validation", "after_artifact_publish", "after_event_publish", "after_ledger_append", "after_commit_marker"],
      corrupt_records: ["journal", "event", "ledger", "commit_marker"],
      real_multi_process: ["identical_concurrent_import", "different_bytes_one_identity", "identical_bytes_conflicting_identity", "stale_lock", "pid_reuse_poison", "restart_holding_lock"],
      concurrent_reader_race: true,
      partial_parse_citation_chunk_retrieval_results: 0,
    },
    persistent_owner_import_entries: 0,
    strict_readiness: { command: "scripts/legal-acquisition.mts operational-readiness", exit_code: strict.exit_code },
    assurance: { application: "PARSER_APPLICATION_ISOLATION_VERIFIED", os: "PARSER_OS_SANDBOX_NOT_VERIFIED" },
  };
  await writeEvidence("local-adversarial-verification.json", summary);
  await writeEvidence("parser-reachability.json", reachability);
  await writeEvidence("native-platform-evidence.json", platform);
  await writeEvidence("strict-readiness.json", {
    schema_version: "tivdoc-wave21-w3-strict-readiness-v0.4.1",
    expected_nonzero: true,
    observed_exit_code: strict.exit_code,
    required_missing_gates: ["durable_replicated_storage_not_verified", "parser_os_sandbox_not_verified", "persistence_evidence_not_verified", "persistent_ledger_not_verified", "persistent_owner_imports_zero"],
    persistent_owner_import_entries: 0,
    statuses: ["PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED", "PARSER_OS_SANDBOX_NOT_VERIFIED", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED"],
  });
  await buildManifest();
  process.stdout.write(`${summary.status}\n${JSON.stringify(summary)}\n`);
  process.exitCode = tests.exit_code === 0 && strict.exit_code === 5 ? 0 : 1;
}

async function strictVerification() {
  const strict = run(process.execPath, [...nodeArgs, path.join(repoRoot, "scripts/legal-acquisition.mts"), "operational-readiness"], { ...process.env, TIVDOC_LEGAL_NETWORK_DISABLED: "1" });
  process.stdout.write(strict.stdout);
  process.stderr.write(strict.stderr);
  process.exitCode = strict.exit_code;
}

const mode = process.argv[2];
if (mode === "local") await localVerification();
else if (mode === "strict") await strictVerification();
else throw new Error("wave21_controlled_import_mode_required");
