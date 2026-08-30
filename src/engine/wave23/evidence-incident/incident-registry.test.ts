import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function pythonRuntime() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return bundled && existsSync(bundled)
    ? { command: bundled, prefix: [] as string[] }
    : { command: "py", prefix: ["-3"] };
}

function runIncidentCommand(command: "diagnostic" | "self-test") {
  const runtime = pythonRuntime();
  return spawnSync(runtime.command, [
    ...runtime.prefix,
    path.resolve("scripts", "wave23-evidence-incident", "incident_registry.py"),
    command,
  ], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
}

describe("Wave 2.3 cross-package incident registry", () => {
  it("freezes all four V0.4.1 mismatches and binds exact historical identities", () => {
    const declaration = JSON.parse(readFileSync(path.resolve(
      "src", "engine", "wave23", "evidence-incident", "incident-declaration.v0.5.0.json",
    ), "utf8")) as {
      required_reference_count: number;
      historical_roots_repaired: boolean;
      historical_packages: Array<{ package_id: string; zip_sha256: string; manifest_sha256: string }>;
      v0_4_1_references: Array<{ reference_id: string; json_pointers: Record<string, string> }>;
    };
    expect(declaration.required_reference_count).toBe(15);
    expect(declaration.historical_roots_repaired).toBe(false);
    expect(declaration.v0_4_1_references.map((item) => item.reference_id)).toEqual([
      "V041_MISMATCH_001",
      "V041_MISMATCH_002",
      "V041_MISMATCH_003",
      "V041_MISMATCH_004",
    ]);
    expect(declaration.v0_4_1_references.every((item) => Object.keys(item.json_pointers).length === 3)).toBe(true);
    expect(declaration.historical_packages).toHaveLength(3);
    expect(declaration.historical_packages.every((item) => item.zip_sha256.length === 64 && item.manifest_sha256.length === 64)).toBe(true);
  });

  it("runs the bounded registry and all required adversarial cases", () => {
    const result = runIncidentCommand("diagnostic");
    expect(result.status, result.stderr).toBe(0);
    const diagnostic = JSON.parse(result.stdout) as {
      status: string;
      reference_count: number;
      unique_path_hash_incident_count: number;
      exact_recovered_reference_count: number;
      unrecoverable_or_unavailable_reference_count: number;
    };
    expect(diagnostic).toMatchObject({
      status: "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
      reference_count: 15,
      unique_path_hash_incident_count: 11,
      exact_recovered_reference_count: 5,
      unrecoverable_or_unavailable_reference_count: 10,
    });
    const output = path.resolve("output", "parallel-wave-2.3", "workers", "w1-evidence-incident");
    const negatives = JSON.parse(readFileSync(path.join(output, "negative-case-matrix.json"), "utf8")) as {
      passed: boolean;
      case_count: number;
      cases: Array<{ case_id: string; passed: boolean }>;
    };
    expect(negatives.passed).toBe(true);
    expect(negatives.case_count).toBe(10);
    expect(negatives.cases.every((item) => item.passed)).toBe(true);
  }, 120_000);

  it("keeps the pure state-machine self-test independent from historical bytes", () => {
    const result = runIncidentCommand("self-test");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ case_count: 2, passed_count: 2, passed: true });
  });
});
