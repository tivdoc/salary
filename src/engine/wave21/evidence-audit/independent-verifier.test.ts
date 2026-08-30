import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function python() {
  const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "";
  return bundled && existsSync(bundled) ? { command: bundled, prefix: [] as string[] } : { command: "py", prefix: ["-3"] };
}

describe("independent V0.4 ZIP verifier adversarial rules", () => {
  it("rejects traversal, duplicates, case collisions, links, devices and member mutations", () => {
    const runtime = python();
    const result = spawnSync(runtime.command, [
      ...runtime.prefix,
      path.resolve("scripts", "wave21-evidence-audit", "independent_v04_verifier.py"),
      "self-test",
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { passed: boolean; rule_set_sha256: string; checks: Array<{ id: string; passed: boolean }> };
    expect(report.passed).toBe(true);
    expect(report.rule_set_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.checks.map((entry) => entry.id)).toEqual(["traversal", "device", "case", "link", "extra", "missing", "changed", "duplicate"]);
    expect(report.checks.every((entry) => entry.passed)).toBe(true);
  }, 30_000);
});
