import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCorrectedCountLedger } from "../../src/engine/wave21/evidence-audit/count-ledger.ts";
import { buildCompleteGitProof } from "../../src/engine/wave21/evidence-audit/git-proof.ts";
import { sha256, stableJson, WAVE2_MANIFEST_SHA256, WAVE2_ZIP_SHA256 } from "../../src/engine/wave21/evidence-audit/common.ts";

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("wave21_evidence_audit_requires_offline_canary");

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.resolve(repoRoot, "output", "parallel-wave-2.1", "workers", "w1-evidence-reachability");
const allowedOutputParent = path.resolve(repoRoot, "output", "parallel-wave-2.1", "workers");
if (!outputRoot.startsWith(`${allowedOutputParent}${path.sep}`)) throw new Error("wave21_output_path_escape");
const ignored = spawnSync("git", ["check-ignore", "-q", path.relative(repoRoot, path.join(outputRoot, ".probe"))], { cwd: repoRoot, windowsHide: true });
if (ignored.status !== 0) throw new Error("wave21_evidence_output_not_git_ignored");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

function pythonExecutable() {
  const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "";
  return bundled && existsSync(bundled) ? { command: bundled, prefix: [] as string[] } : { command: "py", prefix: ["-3"] };
}

async function writeJson(name: string, value: unknown) {
  await writeFile(path.join(outputRoot, name), stableJson(value), "utf8");
}

const canonicalZip = "C:\\dev\\tivdoc\\salary\\output\\parallel-wave-2\\review-package-v0.4.zip";
const extracted = path.join(outputRoot, "verified-v0.4-package");
const python = pythonExecutable();
const verifier = spawnSync(python.command, [
  ...python.prefix,
  path.resolve(repoRoot, "scripts", "wave21-evidence-audit", "independent_v04_verifier.py"),
  "verify",
  "--source-zip", canonicalZip,
  "--output-dir", extracted,
  "--repo-root", repoRoot,
  "--expected-zip-sha256", WAVE2_ZIP_SHA256,
  "--expected-manifest-sha256", WAVE2_MANIFEST_SHA256,
], { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
if (verifier.status !== 0) throw new Error(`independent_v04_verifier_failed:${verifier.stderr.trim()}`);
const packageVerification = JSON.parse(verifier.stdout) as Record<string, unknown>;
await writeJson("independent-v0.4-package-verification.json", packageVerification);

const countLedger = await buildCorrectedCountLedger(extracted);
await writeJson("corrected-count-ledger.json", countLedger);
await writeJson("url-to-unique-sha-alias-crosswalk.json", {
  schema_version: "tivdoc-url-to-unique-sha-alias-crosswalk-v0.4.1",
  byte_objects: countLedger.byte_objects,
  unique_sha256_byte_objects: countLedger.required_reconciliation.unique_sha256_byte_objects,
  alias_groups: countLedger.required_reconciliation.unique_sha256_byte_objects < countLedger.required_reconciliation.acquired_url_results
    ? countLedger.byte_objects.filter((entry) => entry.alias_count > 1).length
    : 0,
});

const runtimeEvidence = spawnSync(process.execPath, [
  path.resolve(repoRoot, "node_modules", "vitest", "vitest.mjs"),
  "run",
  "src/engine/wave21/evidence-audit/runtime-evidence-generation.test.ts",
  "--reporter=dot",
], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true,
  env: { ...process.env, TIVDOC_WAVE21_W1_OUTPUT_ROOT: outputRoot },
  maxBuffer: 32 * 1024 * 1024,
});
if (runtimeEvidence.status !== 0) throw new Error(`wave21_runtime_evidence_generation_failed:${runtimeEvidence.stderr}:${runtimeEvidence.stdout}`);
const reachability = await (async () => JSON.parse(await readFile(path.join(outputRoot, "canonical-reachability.json"), "utf8")) as { blocking_finding_count: number })();
const ruleInput = await (async () => JSON.parse(await readFile(path.join(outputRoot, "rule-input-negative-matrix.json"), "utf8")) as { passed: boolean })();
const groundTruth = await (async () => JSON.parse(await readFile(path.join(outputRoot, "ground-truth-negative-matrix.json"), "utf8")) as { passed: boolean })();

const gitProof = await buildCompleteGitProof(repoRoot, extracted);
await writeJson("complete-git-proof.json", gitProof);

const names = (await readdir(outputRoot)).filter((name) => name.endsWith(".json") && name !== "evidence-manifest.json" && name !== "result.json").sort();
const files = [];
for (const name of names) {
  const data = await readFile(path.join(outputRoot, name));
  files.push({ path: name, byte_count: (await stat(path.join(outputRoot, name))).size, sha256: sha256(data) });
}
await writeJson("evidence-manifest.json", {
  schema_version: "tivdoc-wave21-w1-evidence-manifest-v0.4.1",
  manifest_self_excluded: true,
  ignored_extracted_v0_4_package_member_count: 115,
  files,
});
const manifestSha = sha256(await readFile(path.join(outputRoot, "evidence-manifest.json")));
const result = {
  schema_version: "tivdoc-wave21-w1-evidence-reachability-result-v0.4.1",
  status: "PARALLEL_WAVE_2_1_PARTIAL",
  independent_readiness_statuses: [
    "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    "HUMAN_LEGAL_REVIEW_REQUIRED",
    "HUMAN_GROUND_TRUTH_REQUIRED",
    "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
    "PARSER_APPLICATION_ISOLATION_VERIFIED",
    "PARSER_OS_SANDBOX_NOT_VERIFIED",
    "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
    "SHADOW_MODE_NOT_READY",
  ],
  package_verification_passed: packageVerification.passed === true,
  git_proof_passed: gitProof.current_worker.clean_handoff && gitProof.current_worker.all_paths_allowlisted,
  corrected_counts: countLedger.required_reconciliation,
  canonical_reachability_blockers: reachability.blocking_finding_count,
  rule_input_negative_matrix_passed: ruleInput.passed,
  ground_truth_negative_matrix_passed: groundTruth.passed,
  evidence_manifest_sha256: manifestSha,
  tracked_legal_behavior_changed: false,
  reviewed_sources_created: 0,
  active_sources_created: 0,
  real_numeric_candidates_created: 0,
  real_attestations_created: 0,
  active_parameters_created: 0,
  real_legal_rules_created: 0,
  findings_created: 0,
  customer_files_read: 0,
  openai_calls: 0,
  external_supabase_connections: 0,
  migrations: 0,
  production_preview_deploy_actions: 0,
};
await writeJson("result.json", result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
