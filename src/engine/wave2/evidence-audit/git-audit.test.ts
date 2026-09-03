import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowlistMatch,
  assertPatchEquivalence,
  generateWave1GitAudit,
  WAVE1_WORKERS,
} from "./git-audit.ts";

describe("Wave 1 Git evidence audit", () => {
  // H-2. `generateWave1GitAudit` spawns roughly 90 synchronous `git`
  // subprocesses (per-commit `show`/`diff-tree` for the 9-commit
  // first-parent chain, plus per-worker `show`/`patch-id`/`merge-base`/
  // `rev-list` for all 6 workers), and each `spawnSync` blocks the event
  // loop until the child exits. Measured on this host with no other process
  // competing for CPU: 13.5s. Under full-suite parallelism, with dozens of
  // other vitest workers and their own `git`/`node` child processes
  // contending for the same cores, one run measured 33.5s before the 30s
  // budget killed it mid-test — a genuine resource-contention timeout, not
  // a defect in the audit itself (`git-audit.ts` is unchanged). 90s is
  // comfortably over 2x the isolated measurement and over 2x the one
  // observed under-load duration, without being reachable by a hang.
  it("proves every worker base, allowlist and cherry-pick patch", () => {
    const report = generateWave1GitAudit({ repo_root: path.resolve(".") });
    expect(report.first_parent_commit_count).toBe(9);
    expect(report.all_worker_patch_ids_equivalent).toBe(true);
    expect(report.all_worker_blobs_equivalent).toBe(true);
    expect(report.all_worker_allowlists_passed).toBe(true);
    expect(report.no_merge_commits_in_range).toBe(true);
    expect(report.workers).toHaveLength(6);
    expect(report.workers.every((worker) => worker.commit_count_over_base === 1)).toBe(true);
  }, 90_000);

  it("rejects an unexpected changed path", () => {
    expect(allowlistMatch("package.json", WAVE1_WORKERS[0].allowlist)).toBe(false);
    expect(allowlistMatch("src/server/engine/persistence-verification/fixture.ts", WAVE1_WORKERS[4].allowlist)).toBe(true);
  });

  it("fails closed on a patch mismatch", () => {
    expect(() => assertPatchEquivalence({ patch_id: "a" }, { patch_id: "b" }))
      .toThrow("wave1_worker_cherry_pick_patch_mismatch");
  });
});
