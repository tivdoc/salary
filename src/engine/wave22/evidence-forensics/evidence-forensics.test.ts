import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pythonHost, resolvePython } from "../../../test-support/host.ts";

function python() {
  const runtime = resolvePython();
  if (!runtime) throw new Error("PYTHON_3_NOT_ON_HOST");
  return { command: runtime.command, prefix: [...runtime.prefix] };
}

describe.skipIf(!(pythonHost()).holds)("Wave 2.2 immutable V0.4 erratum", () => {
  it("freezes all 11 original references and keeps unrecovered claims failed", () => {
    const declaration = JSON.parse(readFileSync(path.resolve(
      "src", "engine", "wave22", "evidence-forensics", "v0.4-erratum.v0.4.2.json",
    ), "utf8")) as {
      append_only: boolean;
      historical_package_mutated: boolean;
      references: Array<{ case_id: string; repository_path: string; strict_resolved: boolean; claim_authority: string }>;
    };
    expect(declaration.append_only).toBe(true);
    expect(declaration.historical_package_mutated).toBe(false);
    expect(declaration.references).toHaveLength(11);
    expect(declaration.references.map((entry) => entry.case_id)).toEqual(
      Array.from({ length: 11 }, (_, index) => `FORENSIC_REF_${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(declaration.references.map((entry) => entry.repository_path)).size).toBe(7);
    expect(declaration.references.filter((entry) => entry.strict_resolved)).toHaveLength(3);
    expect(declaration.references.filter((entry) => !entry.strict_resolved).every(
      (entry) => entry.claim_authority === "non_authoritative_unresolved",
    )).toBe(true);
  });

  it("regresses false overall to strict exit 6 independently of diagnostic exit 0", () => {
    const runtime = python();
    const result = spawnSync(runtime.command, [
      ...runtime.prefix,
      path.resolve("scripts", "wave22-evidence-forensics", "forensics.py"),
      "self-test",
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { passed: boolean; cases: Array<{ case_id: string; observed_exit_code: number }> };
    expect(report.passed).toBe(true);
    expect(report.cases).toContainEqual(expect.objectContaining({ case_id: "STRICT_FALSE_OVERALL", observed_exit_code: 6 }));
  });
});
