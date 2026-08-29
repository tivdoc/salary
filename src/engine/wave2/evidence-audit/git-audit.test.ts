import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowlistMatch,
  assertPatchEquivalence,
  generateWave1GitAudit,
  WAVE1_WORKERS,
} from "./git-audit.ts";

describe("Wave 1 Git evidence audit", () => {
  it("proves every worker base, allowlist and cherry-pick patch", () => {
    const report = generateWave1GitAudit({ repo_root: path.resolve(".") });
    expect(report.first_parent_commit_count).toBe(9);
    expect(report.all_worker_patch_ids_equivalent).toBe(true);
    expect(report.all_worker_blobs_equivalent).toBe(true);
    expect(report.all_worker_allowlists_passed).toBe(true);
    expect(report.no_merge_commits_in_range).toBe(true);
    expect(report.workers).toHaveLength(6);
    expect(report.workers.every((worker) => worker.commit_count_over_base === 1)).toBe(true);
  }, 30_000);

  it("rejects an unexpected changed path", () => {
    expect(allowlistMatch("package.json", WAVE1_WORKERS[0].allowlist)).toBe(false);
    expect(allowlistMatch("src/server/engine/persistence-verification/fixture.ts", WAVE1_WORKERS[4].allowlist)).toBe(true);
  });

  it("fails closed on a patch mismatch", () => {
    expect(() => assertPatchEquivalence({ patch_id: "a" }, { patch_id: "b" }))
      .toThrow("wave1_worker_cherry_pick_patch_mismatch");
  });
});
