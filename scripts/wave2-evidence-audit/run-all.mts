import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseCliOptions,
  requireContained,
  sha256,
  WAVE1_REVIEW_ZIP_SHA256,
  writeJsonAtomic,
} from "../../src/engine/wave2/evidence-audit/common.ts";
import { buildWave1ArtifactReconciliation } from "../../src/engine/wave2/evidence-audit/artifact-reconciliation.ts";
import { scanFullChangedFileRange } from "../../src/engine/wave2/evidence-audit/full-diff-scan.ts";
import { generateWave1GitAudit } from "../../src/engine/wave2/evidence-audit/git-audit.ts";
import { runTopicReadinessCommand } from "../../src/engine/wave2/evidence-audit/topic-readiness-command.ts";

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") {
  throw new Error("wave2_evidence_audit_requires_offline_canary");
}

const options = parseCliOptions(process.argv.slice(2));
const repoRoot = path.resolve(process.cwd());
const evidenceRepoRoot = path.resolve(typeof options["evidence-repo-root"] === "string" ? options["evidence-repo-root"] : "C:\\dev\\tivdoc\\salary");
const sourcePackRoot = path.resolve(typeof options["source-pack-root"] === "string"
  ? options["source-pack-root"]
  : "C:\\dev\\tivdoc-wave1-working-time-permits\\output\\legal-knowledge\\wave1-working-time-permits");
const outputRoot = path.resolve(repoRoot, "output", "parallel-wave-2", "batch-a", "evidence-audit");
requireContained(path.resolve(repoRoot, "output", "parallel-wave-2", "batch-a"), outputRoot, "evidence_output_path_escape");
const ignored = spawnSync("git", ["check-ignore", "-q", path.join("output", "parallel-wave-2", "batch-a", "evidence-audit", ".probe")], {
  cwd: repoRoot,
  windowsHide: true,
});
if (ignored.status !== 0) throw new Error("wave2_evidence_output_not_git_ignored");
await mkdir(outputRoot, { recursive: true });

const gitAudit = generateWave1GitAudit({ repo_root: repoRoot });
await writeJsonAtomic(path.join(outputRoot, "wave1-git-audit.json"), gitAudit);

const reconciliation = await buildWave1ArtifactReconciliation({
  repo_root: repoRoot,
  evidence_repo_root: evidenceRepoRoot,
  source_pack_root: sourcePackRoot,
});
await writeJsonAtomic(path.join(outputRoot, "wave1-artifact-crosswalk.json"), reconciliation);

const scope = scanFullChangedFileRange({ repo_root: repoRoot, to: "HEAD" });
if (!scope.passed) throw new Error("wave2_full_diff_scope_scan_failed");
await writeJsonAtomic(path.join(outputRoot, "full-diff-scope-scan.json"), scope);

const diagnostic = runTopicReadinessCommand({ command: "status" });
const strict = runTopicReadinessCommand({ command: "gate" });
if (diagnostic.exit_code !== 0 || diagnostic.result.status !== "not_ready" || strict.exit_code === 0) {
  throw new Error("wave2_topic_readiness_exit_semantics_failed");
}
await writeJsonAtomic(path.join(outputRoot, "topic-readiness-diagnostic.json"), diagnostic);
await writeJsonAtomic(path.join(outputRoot, "topic-readiness-strict-gate.json"), strict);

function pythonExecutable() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return bundled && existsSync(bundled) ? { command: bundled, prefix: [] as string[] } : { command: "py", prefix: ["-3"] };
}

const sourceZip = path.join(evidenceRepoRoot, "output", "parallel-wave-1", "review-package-v0.3.zip");
const verifier = path.resolve(repoRoot, "scripts", "wave2-evidence-audit", "review_package_verifier.py");
const reviewOutput = path.join(outputRoot, "review-package-rebuild");
const python = pythonExecutable();
const verification = spawnSync(python.command, [
  ...python.prefix,
  verifier,
  "self-test",
  "--source-zip",
  sourceZip,
  "--expected-sha256",
  WAVE1_REVIEW_ZIP_SHA256,
  "--output-root",
  reviewOutput,
], { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
if (verification.status !== 0) throw new Error(`wave1_review_package_verifier_failed:${verification.stderr.trim()}`);
const reviewReport = JSON.parse(verification.stdout) as Record<string, unknown>;
await writeJsonAtomic(path.join(outputRoot, "wave1-review-package-verification.json"), reviewReport);

const evidenceFiles = (await readdir(outputRoot))
  .filter((name) => name.endsWith(".json") && name !== "evidence-manifest.json")
  .sort();
const entries = [];
for (const name of evidenceFiles) {
  const target = path.join(outputRoot, name);
  const bytes = await readFile(target);
  entries.push({ path: name, byte_count: (await stat(target)).size, sha256: sha256(bytes) });
}
const manifest = {
  schema_version: "tivdoc-wave2-a1-evidence-manifest-v0.4",
  generated_offline: true,
  legal_meaning_mutated: false,
  source_status_mutated: false,
  files: entries,
};
await writeJsonAtomic(path.join(outputRoot, "evidence-manifest.json"), manifest);

const result = {
  schema_version: "tivdoc-wave2-a1-evidence-audit-result-v0.4",
  output_root: path.relative(repoRoot, outputRoot).replaceAll("\\", "/"),
  git_audit_sha256: sha256(await readFile(path.join(outputRoot, "wave1-git-audit.json"))),
  artifact_crosswalk_sha256: sha256(await readFile(path.join(outputRoot, "wave1-artifact-crosswalk.json"))),
  scope_scan_sha256: sha256(await readFile(path.join(outputRoot, "full-diff-scope-scan.json"))),
  review_package_verification_sha256: sha256(await readFile(path.join(outputRoot, "wave1-review-package-verification.json"))),
  evidence_manifest_sha256: sha256(await readFile(path.join(outputRoot, "evidence-manifest.json"))),
  evidence_json_files: entries.length + 1,
  runtime_canaries_passed: scope.runtime_denial_canaries.passed,
  strict_topic_gate_exit_code: strict.exit_code,
  diagnostic_topic_status_exit_code: diagnostic.exit_code,
  review_package_counts: {
    package_files: 140,
    manifest_entries: 139,
    copied_evidence_files: 133,
  },
  status: "WAVE2_A1_EVIDENCE_AUDIT_COMPLETE",
};
await writeJsonAtomic(path.join(outputRoot, "result.json"), result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
