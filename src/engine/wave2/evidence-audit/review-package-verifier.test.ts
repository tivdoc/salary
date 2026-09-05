import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WAVE1_REVIEW_ZIP_SHA256 } from "./common.ts";
import { localArtifacts, resolvePython } from "../../../test-support/host.ts";

function pythonExecutable() {
  const runtime = resolvePython();
  if (!runtime) throw new Error("PYTHON_3_NOT_ON_HOST");
  return runtime.prefix.length > 0 ? "py" : runtime.command;
}

describe.skipIf(!(localArtifacts(["C:/dev/tivdoc/salary/output/parallel-wave-1/review-package-v0.3.zip"])).holds)("Wave 1 V0.3 review-package verifier", () => {
  it("rebuilds twice and rejects corrupt, stale, interrupted and unsafe variants", () => {
    const script = path.resolve("scripts", "wave2-evidence-audit", "review_package_verifier.py");
    const source = "C:\\dev\\tivdoc\\salary\\output\\parallel-wave-1\\review-package-v0.3.zip";
    const output = path.resolve("output", "parallel-wave-2", "batch-a", "evidence-audit", "test-review-package");
    const python = pythonExecutable();
    const prefix = python.toLowerCase().endsWith("py.exe") || path.basename(python).toLowerCase() === "py" ? ["-3"] : [];
    const result = spawnSync(python, [
      ...prefix,
      script,
      "self-test",
      "--source-zip",
      source,
      "--expected-sha256",
      WAVE1_REVIEW_ZIP_SHA256,
      "--output-root",
      output,
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      passed: boolean;
      baseline: { package_file_count: number; manifest_entry_count: number; copied_evidence_file_count: number };
      checks: Array<{ name: string; passed: boolean }>;
      interrupted_build_recovery: { passed: boolean };
    };
    expect(report.passed).toBe(true);
    expect(report.baseline).toMatchObject({
      package_file_count: 140,
      manifest_entry_count: 139,
      copied_evidence_file_count: 133,
    });
    expect(report.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "forced_source_hash_mismatch",
      "corrupt_manifest",
      "changed_zip_member",
      "unexpected_zip_member",
      "unsafe_archive_path",
      "interrupted_build",
    ]));
    expect(report.interrupted_build_recovery.passed).toBe(true);
  }, 120_000);
});
