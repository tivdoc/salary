import { describe, expect, it } from "vitest";

import { verifyWorktreeIsolation, WORKTREE_ISOLATION_SCHEMA } from "./verify.mts";

const ROOT = "C:/dev/tivdoc/salary";
const HEAD = "6646d0810c5f80a78c939f81ea07f79a4e7ea85c";
const STALE_HEAD = "b963844bdcc1c3192f24516c9154a00a5f1ac0e9";

const expectation = Object.freeze({
  integration_root: ROOT,
  integration_head: HEAD,
  required_specifiers: Object.freeze(["vitest", "typescript"]),
});

function facts(overrides = {}) {
  return Object.freeze({
    worktree_path: `${ROOT}/.claude/worktrees/agent-1`,
    toplevel: `${ROOT}/.claude/worktrees/agent-1`,
    git_common_dir: `${ROOT}/.git`,
    head: HEAD,
    tracked_bytes_changed: false,
    reparse_points: Object.freeze([]),
    worktree_local_node_modules: false,
    resolved_dependencies: Object.freeze([
      { specifier: "vitest", resolved_path: `${ROOT}/node_modules/vitest/index.cjs` },
      { specifier: "typescript", resolved_path: `${ROOT}/node_modules/typescript/lib/typescript.js` },
    ]),
    ...overrides,
  });
}

function statusOf(proof, checkId) {
  return proof.checks.find((entry) => entry.check_id === checkId)?.status;
}

describe("V0.10.3 worktree isolation proof", () => {
  it("passes only when every safety property holds together", () => {
    const proof = verifyWorktreeIsolation(facts(), expectation);
    expect(proof.schema_version).toBe(WORKTREE_ISOLATION_SCHEMA);
    expect(proof.status).toBe("PASS");
    expect(proof.safe_to_retire_without_force).toBe(true);
    expect(proof.checks.map((entry) => entry.check_id)).toEqual([
      "HEAD_EQUALS_INTEGRATION_HEAD",
      "TOPLEVEL_UNDER_CANONICAL_REPOSITORY",
      "COMMON_DIR_MATCHES_INTEGRATION_REPOSITORY",
      "DEPENDENCIES_RESOLVE",
      "DEPENDENCIES_RESOLVE_BY_PARENT_WALK_ONLY",
      "NO_REPARSE_POINT",
      "NO_TRACKED_BYTE_CHANGE",
      "RETIREABLE_WITHOUT_FORCE",
    ]);
    expect(proof.checks.every((entry) => entry.status === "PASS")).toBe(true);
  });

  it("rejects the observed stale-commit provisioning that this proof exists to catch", () => {
    const proof = verifyWorktreeIsolation(facts({ head: STALE_HEAD }), expectation);
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "HEAD_EQUALS_INTEGRATION_HEAD")).toBe("FAIL");
    // A stale checkout is still physically safe to retire; only the wave must not start.
    expect(proof.safe_to_retire_without_force).toBe(true);
  });

  it("rejects a worktree outside the canonical repository even when its HEAD matches", () => {
    const foreign = "C:/Users/smart/.claude/worktrees/agent-1";
    const proof = verifyWorktreeIsolation(
      facts({ worktree_path: foreign, toplevel: foreign, git_common_dir: "C:/Users/smart/.git" }),
      expectation,
    );
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "TOPLEVEL_UNDER_CANONICAL_REPOSITORY")).toBe("FAIL");
    expect(statusOf(proof, "COMMON_DIR_MATCHES_INTEGRATION_REPOSITORY")).toBe("FAIL");
  });

  it("refuses a junction or symlink anywhere in the worktree and blocks retirement", () => {
    const proof = verifyWorktreeIsolation(
      facts({ reparse_points: [`${ROOT}/.claude/worktrees/agent-1/node_modules`] }),
      expectation,
    );
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "NO_REPARSE_POINT")).toBe("FAIL");
    expect(statusOf(proof, "RETIREABLE_WITHOUT_FORCE")).toBe("FAIL");
    expect(proof.safe_to_retire_without_force).toBe(false);
  });

  it("refuses a copied node_modules even when resolution succeeds", () => {
    const proof = verifyWorktreeIsolation(facts({ worktree_local_node_modules: true }), expectation);
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "DEPENDENCIES_RESOLVE")).toBe("PASS");
    expect(statusOf(proof, "DEPENDENCIES_RESOLVE_BY_PARENT_WALK_ONLY")).toBe("FAIL");
  });

  it("refuses dependencies resolved from outside the integration tree", () => {
    const proof = verifyWorktreeIsolation(facts({
      resolved_dependencies: [
        { specifier: "vitest", resolved_path: "C:/Users/smart/node_modules/vitest/index.cjs" },
        { specifier: "typescript", resolved_path: `${ROOT}/node_modules/typescript/lib/typescript.js` },
      ],
    }), expectation);
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "DEPENDENCIES_RESOLVE_BY_PARENT_WALK_ONLY")).toBe("FAIL");
  });

  it("fails closed when a required dependency does not resolve at all", () => {
    const proof = verifyWorktreeIsolation(facts({
      resolved_dependencies: [
        { specifier: "vitest", resolved_path: null },
        { specifier: "typescript", resolved_path: `${ROOT}/node_modules/typescript/lib/typescript.js` },
      ],
    }), expectation);
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "DEPENDENCIES_RESOLVE")).toBe("FAIL");
  });

  it("blocks retirement while tracked bytes differ so no work is discarded", () => {
    const proof = verifyWorktreeIsolation(facts({ tracked_bytes_changed: true }), expectation);
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "NO_TRACKED_BYTE_CHANGE")).toBe("FAIL");
    expect(proof.safe_to_retire_without_force).toBe(false);
  });

  it("fails closed on a truncated or non-canonical HEAD rather than comparing prefixes", () => {
    const proof = verifyWorktreeIsolation(facts({ head: HEAD.slice(0, 7) }), expectation);
    expect(proof.status).toBe("FAIL");
    expect(statusOf(proof, "HEAD_EQUALS_INTEGRATION_HEAD")).toBe("FAIL");
  });

  it("treats path separators and case as equivalent on Windows paths", () => {
    const proof = verifyWorktreeIsolation(facts({
      toplevel: "C:\\dev\\tivdoc\\salary\\.claude\\worktrees\\agent-1",
      git_common_dir: "C:\\DEV\\Tivdoc\\Salary\\.git",
    }), expectation);
    expect(statusOf(proof, "TOPLEVEL_UNDER_CANONICAL_REPOSITORY")).toBe("PASS");
    expect(statusOf(proof, "COMMON_DIR_MATCHES_INTEGRATION_REPOSITORY")).toBe("PASS");
  });

  it("does not accept a sibling directory that merely shares the root prefix", () => {
    const sibling = `${ROOT}-other/worktree`;
    const proof = verifyWorktreeIsolation(facts({ toplevel: sibling }), expectation);
    expect(statusOf(proof, "TOPLEVEL_UNDER_CANONICAL_REPOSITORY")).toBe("FAIL");
  });
});
