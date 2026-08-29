import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChangedPath, scanAddedLine, scanFullChangedFileRange } from "./full-diff-scan.ts";
import { WAVE2_A_CONTRACT_SHA } from "./common.ts";

describe("full base-to-HEAD changed-file scope scan", () => {
  it("inventories every path including tests, scripts, package, lock and config classifications", () => {
    const report = scanFullChangedFileRange({ repo_root: path.resolve("."), to: WAVE2_A_CONTRACT_SHA });
    expect(report.every_changed_path_inventoried).toBe(true);
    expect(report.changed_path_count).toBeGreaterThan(0);
    expect(report.runtime_denial_canaries.passed).toBe(true);
    expect(report.violation_count).toBe(0);
    expect(report.files.some((file) => file.category === "test")).toBe(true);
    expect(report.files.some((file) => file.category === "executable_script")).toBe(true);
    expect(report.files.some((file) => file.category === "package_manifest")).toBe(true);
    expect(report.files.some((file) => file.category === "configuration")).toBe(true);
    expect(classifyChangedPath("package-lock.json")).toBe("lockfile");
  }, 30_000);

  it("does not hide documentation or test files", () => {
    expect(classifyChangedPath("docs/report.md")).toBe("documentation");
    expect(classifyChangedPath("src/example.test.ts")).toBe("test");
    expect(scanAddedLine("docs/report.md", "The boundary rejects new OpenAI().")[0]).toMatchObject({
      disposition: "documented_reference",
      violation: false,
    });
  });

  it("flags a prohibited executable construction", () => {
    expect(scanAddedLine("src/engine/unsafe.ts", "import OpenAI from \"openai\";")[0]).toMatchObject({
      pattern: "openai_client_construction",
      violation: true,
    });
  });
});
