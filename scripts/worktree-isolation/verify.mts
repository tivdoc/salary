// V0.10.3 worktree isolation proof.
//
// The worker worktrees used by parallel waves are provisioned outside this
// repository, so this module cannot create them. What it can do is refuse to
// let a wave start on an unsafe one: it turns a set of observed facts into an
// explicit, deterministic verdict.
//
// The validator is pure so every rule is testable without touching the disk.
// gatherWorktreeFacts is the only part that performs IO, and it never writes,
// never follows a reparse point and never removes anything.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

export const WORKTREE_ISOLATION_SCHEMA = "tivdoc-worktree-isolation-proof-v0.10.3" as const;

const SHA256_HEX = /^[a-f0-9]{40}$/u;

export type WorktreeFacts = Readonly<{
  worktree_path: string;
  toplevel: string;
  git_common_dir: string;
  head: string;
  tracked_bytes_changed: boolean;
  reparse_points: readonly string[];
  worktree_local_node_modules: boolean;
  resolved_dependencies: readonly Readonly<{ specifier: string; resolved_path: string | null }>[];
}>;

export type WorktreeExpectation = Readonly<{
  integration_root: string;
  integration_head: string;
  required_specifiers: readonly string[];
}>;

export type WorktreeCheck = Readonly<{
  check_id: string;
  status: "PASS" | "FAIL";
  detail: string;
}>;

export type WorktreeIsolationProof = Readonly<{
  schema_version: typeof WORKTREE_ISOLATION_SCHEMA;
  status: "PASS" | "FAIL";
  checks: readonly WorktreeCheck[];
  safe_to_retire_without_force: boolean;
}>;

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function isInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalize(candidate);
  const normalizedRoot = normalize(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function check(checkId: string, passed: boolean, detail: string): WorktreeCheck {
  return Object.freeze({ check_id: checkId, status: passed ? "PASS" as const : "FAIL" as const, detail });
}

/**
 * Turns observed worktree facts into a deterministic verdict. Every rule is
 * fail-closed: anything unproven is a FAIL, never an assumed PASS.
 */
export function verifyWorktreeIsolation(
  facts: WorktreeFacts,
  expectation: WorktreeExpectation,
): WorktreeIsolationProof {
  const checks: WorktreeCheck[] = [];

  const headKnown = SHA256_HEX.test(facts.head) && SHA256_HEX.test(expectation.integration_head);
  checks.push(check(
    "HEAD_EQUALS_INTEGRATION_HEAD",
    headKnown && facts.head === expectation.integration_head,
    headKnown
      ? `worktree HEAD ${facts.head} vs integration HEAD ${expectation.integration_head}`
      : "HEAD values must both be full 40-character object names",
  ));

  checks.push(check(
    "TOPLEVEL_UNDER_CANONICAL_REPOSITORY",
    isInside(facts.toplevel, expectation.integration_root),
    `toplevel ${facts.toplevel} against integration root ${expectation.integration_root}`,
  ));

  checks.push(check(
    "COMMON_DIR_MATCHES_INTEGRATION_REPOSITORY",
    isInside(facts.git_common_dir, expectation.integration_root),
    `git common dir ${facts.git_common_dir}`,
  ));

  const missing = expectation.required_specifiers.filter((specifier) => !facts.resolved_dependencies
    .some((entry) => entry.specifier === specifier && entry.resolved_path !== null));
  checks.push(check(
    "DEPENDENCIES_RESOLVE",
    missing.length === 0,
    missing.length === 0 ? "every required specifier resolved" : `unresolved: ${missing.join(", ")}`,
  ));

  // Resolution must come from the integration tree via Node's ordinary parent
  // directory walk. A copy inside the worktree is a divergent second tree; a
  // resolution from anywhere else is not the dependency set we verified.
  const foreign = facts.resolved_dependencies
    .filter((entry) => entry.resolved_path !== null && !isInside(entry.resolved_path, expectation.integration_root));
  checks.push(check(
    "DEPENDENCIES_RESOLVE_BY_PARENT_WALK_ONLY",
    !facts.worktree_local_node_modules && foreign.length === 0,
    facts.worktree_local_node_modules
      ? "worktree carries its own node_modules"
      : foreign.length === 0
        ? "all resolutions came from the integration tree"
        : `resolved outside the integration tree: ${foreign.map((entry) => entry.resolved_path).join(", ")}`,
  ));

  checks.push(check(
    "NO_REPARSE_POINT",
    facts.reparse_points.length === 0,
    facts.reparse_points.length === 0
      ? "no junction, symlink or reparse point found"
      : `reparse points present: ${facts.reparse_points.join(", ")}`,
  ));

  checks.push(check(
    "NO_TRACKED_BYTE_CHANGE",
    !facts.tracked_bytes_changed,
    facts.tracked_bytes_changed
      ? "worktree is not pristine (modified tracked bytes or untracked files present)"
      : "tracked bytes unchanged",
  ));

  // Retiring is only safe when nothing would be lost and no delete can escape
  // through a link. Those are exactly the two conditions that made a previous
  // `git worktree remove --force` destroy the shared dependency tree.
  const safeToRetire = facts.reparse_points.length === 0 && !facts.tracked_bytes_changed;
  checks.push(check(
    "RETIREABLE_WITHOUT_FORCE",
    safeToRetire,
    safeToRetire
      ? "plain `git worktree remove` is safe"
      : "refuse to remove: resolve reparse points and tracked changes first",
  ));

  return Object.freeze({
    schema_version: WORKTREE_ISOLATION_SCHEMA,
    status: checks.every((entry) => entry.status === "PASS") ? "PASS" as const : "FAIL" as const,
    checks: Object.freeze(checks),
    safe_to_retire_without_force: safeToRetire,
  });
}

function git(worktreePath: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: worktreePath, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error(`WORKTREE_ISOLATION_GIT_FAILED:${args.join(" ")}`);
  return result.stdout.trim();
}

/** Read-only reparse-point scan. Never descends through a reparse point. */
function collectReparsePoints(root: string, found: string[], depth = 0): void {
  if (depth > 12) return;
  let entries: readonly string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    // A worktree-local node_modules is reported on its own; skipping it here
    // keeps the scan bounded instead of walking a full dependency tree.
    if (entry === ".git" || entry === "node_modules") continue;
    const full = path.join(root, entry);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      found.push(full);
      continue;
    }
    if (stats.isDirectory()) collectReparsePoints(full, found, depth + 1);
  }
}

/**
 * Observes a worktree without modifying it. Resolution is probed in a child
 * process rooted at the worktree so the answer reflects Node's real behaviour
 * rather than this process's module cache.
 */
export function gatherWorktreeFacts(
  worktreePath: string,
  requiredSpecifiers: readonly string[],
): WorktreeFacts {
  const reparsePoints: string[] = [];
  collectReparsePoints(worktreePath, reparsePoints);
  const probe = spawnSync(process.execPath, [
    "-e",
    "const out=[];for(const s of process.argv.slice(1)){try{out.push({specifier:s,resolved_path:require.resolve(s)});}"
      + "catch{out.push({specifier:s,resolved_path:null});}}process.stdout.write(JSON.stringify(out));",
    ...requiredSpecifiers,
  ], { cwd: worktreePath, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const resolved = probe.status === 0 && probe.stdout
    ? (JSON.parse(probe.stdout) as WorktreeFacts["resolved_dependencies"])
    : requiredSpecifiers.map((specifier) => Object.freeze({ specifier, resolved_path: null }));
  return Object.freeze({
    worktree_path: worktreePath,
    toplevel: git(worktreePath, ["rev-parse", "--show-toplevel"]),
    git_common_dir: path.resolve(worktreePath, git(worktreePath, ["rev-parse", "--git-common-dir"])),
    head: git(worktreePath, ["rev-parse", "HEAD"]),
    tracked_bytes_changed: git(worktreePath, ["status", "--porcelain"]) !== "",
    reparse_points: Object.freeze(reparsePoints),
    worktree_local_node_modules: existsSync(path.join(worktreePath, "node_modules")),
    resolved_dependencies: Object.freeze(resolved),
  });
}
