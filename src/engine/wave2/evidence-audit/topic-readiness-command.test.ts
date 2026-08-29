import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTopicReadinessCommand } from "./topic-readiness-command.ts";

const script = path.resolve("scripts", "wave2-evidence-audit", "topic-readiness.mts");
const nodeArgs = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", script];

describe("diagnostic and strict topic readiness commands", () => {
  it("keeps diagnostic status at exit zero while reporting not_ready", () => {
    const result = runTopicReadinessCommand({ command: "status" });
    expect(result.exit_code).toBe(0);
    expect(result.result.status).toBe("not_ready");
    const processResult = spawnSync(process.execPath, [...nodeArgs, "status"], { encoding: "utf8", windowsHide: true });
    expect(processResult.status, processResult.stderr).toBe(0);
    expect(JSON.parse(processResult.stdout).result.status).toBe("not_ready");
  });

  it("returns nonzero from the strict gate while required gates are missing", () => {
    const result = runTopicReadinessCommand({ command: "gate" });
    expect(result.exit_code).toBe(2);
    expect(result.result.usable_for_rules).toBe(false);
    const processResult = spawnSync(process.execPath, [...nodeArgs, "gate"], { encoding: "utf8", windowsHide: true });
    expect(processResult.status, processResult.stderr).toBe(2);
    expect(JSON.parse(processResult.stdout).semantics).toContain("strict_gate_exits_nonzero");
  });
});
