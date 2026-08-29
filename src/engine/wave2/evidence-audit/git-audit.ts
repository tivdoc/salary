import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { normalizeRelative, WAVE1_FINAL_SHA, WAVE1_ORIGINAL_BASE } from "./common.ts";

type WorkerDefinition = Readonly<{
  worker_id: string;
  branch: string;
  expected_base: string;
  worker_commit: string;
  integration_commit: string;
  allowlist: readonly string[];
}>;

const WAVE_A_SHA = "34a4bff98a1ae8771a932916ece4e2a408d7e501";

export const WAVE1_WORKERS: readonly WorkerDefinition[] = [
  {
    worker_id: "A3_CONTROLLED_IMPORT",
    branch: "codex/wave1-controlled-import-security",
    expected_base: WAVE1_ORIGINAL_BASE,
    worker_commit: "aa1697c772c7fc3379a9bdb4edfae92c00b4303b",
    integration_commit: "2585fc02f2619c000318c89bcae067248d3b91ad",
    allowlist: [
      "docs/legal-controlled-import-security-v0.3.1.md",
      "scripts/legal-acquisition.mts",
      "src/engine/legal-knowledge/acquisition-contracts.ts",
      "src/engine/legal-knowledge/acquisition-contracts.test.ts",
      "src/server/engine/legal-knowledge/acquisition.ts",
      "src/server/engine/legal-knowledge/acquisition.test.ts",
      "src/server/engine/legal-knowledge/change-detection.ts",
      "src/server/engine/legal-knowledge/controlled-import-security.ts",
      "src/server/engine/legal-knowledge/controlled-import-security.test.ts",
      "src/server/engine/legal-knowledge/manifest-and-changes.test.ts",
    ],
  },
  {
    worker_id: "A1_PENSION_CONVALESCENCE",
    branch: "codex/wave1-pension-convalescence",
    expected_base: WAVE1_ORIGINAL_BASE,
    worker_commit: "c950887baeac64b05adf05932eab5518a5694aac",
    integration_commit: "551a9e8aec2a714f1bffb6b56e85aed9f4470060",
    allowlist: [
      "docs/legal-wave1-pension-convalescence.md",
      "scripts/wave1-pension-convalescence.mts",
      "src/server/engine/legal-knowledge/wave1-pension-convalescence.ts",
      "src/server/engine/legal-knowledge/wave1-pension-convalescence.test.ts",
      "src/server/engine/legal-knowledge/wave1-pension-convalescence.inventory.v0.3.1.json",
    ],
  },
  {
    worker_id: "A2_WORKING_TIME_PERMITS",
    branch: "codex/wave1-working-time-permits",
    expected_base: WAVE1_ORIGINAL_BASE,
    worker_commit: "18fa155490ef347aa92611861cbf1e20fbbd70d8",
    integration_commit: "7ee3f330ef506fc32b43ae84854ff9b6bf105fb9",
    allowlist: [
      "docs/legal-wave1-working-time-permits.md",
      "scripts/wave1-working-time-permits.mts",
      "src/server/engine/legal-knowledge/wave1-working-time-permits.ts",
      "src/server/engine/legal-knowledge/wave1-working-time-permits.test.ts",
      "src/server/engine/legal-knowledge/wave1-working-time-permits-catalog.v0.3.json",
      "src/server/engine/legal-knowledge/wave1-working-time-permits-publications.v0.3.json",
    ],
  },
  {
    worker_id: "B1_TEMPORAL_REVIEW",
    branch: "codex/wave1-temporal-review-governance",
    expected_base: WAVE_A_SHA,
    worker_commit: "3d0763f72301b69ddd949730e619e0ff9051dddf",
    integration_commit: "df8d7c3688b0b1c8745f8140128bf9624391c35e",
    allowlist: [
      "docs/legal-wave1-temporal-review-governance.md",
      "scripts/wave1-topic-readiness.mts",
      "src/engine/legal-knowledge/wave1-review-governance.ts",
      "src/engine/legal-knowledge/wave1-review-governance.test.ts",
      "src/engine/legal-knowledge/wave1-synthetic-fixtures.ts",
      "src/engine/legal-knowledge/wave1-temporal-governance.ts",
      "src/engine/legal-knowledge/wave1-temporal-governance.test.ts",
      "src/engine/legal-knowledge/wave1-topic-readiness.ts",
      "src/engine/legal-knowledge/wave1-topic-readiness.test.ts",
    ],
  },
  {
    worker_id: "B2_PERSISTENCE",
    branch: "codex/wave1-persistence-isolated",
    expected_base: WAVE_A_SHA,
    worker_commit: "4f6667d32f297b74536799c0c0142e21259377cc",
    integration_commit: "7eb8593b6fc011d546d166f4ce86e83ba47c1b50",
    allowlist: [
      "docs/wave1-persistence-isolated-v0.3.1.md",
      "scripts/wave1-persistence-static.mts",
      "src/server/engine/persistence-verification/**",
    ],
  },
  {
    worker_id: "B3_RULE_RUNTIME",
    branch: "codex/wave1-rule-runtime-synthetic",
    expected_base: WAVE_A_SHA,
    worker_commit: "215d9bc443ca9119e67034e165ebabaaae246c6e",
    integration_commit: "84168931e2201585e8956ef63306b80b8b065d55",
    allowlist: [
      "docs/wave1-synthetic-rule-runtime.md",
      "src/engine/rule-runtime/**",
    ],
  },
] as const;

function git(repoRoot: string, args: readonly string[], input?: string) {
  const result = spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git_audit_command_failed:${args.join("_")}:${String(result.stderr).trim()}`);
  }
  return result.stdout.trim();
}

function splitLines(value: string) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

export function allowlistMatch(relative: string, allowlist: readonly string[]) {
  const normalized = normalizeRelative(relative);
  return allowlist.some((entry) => {
    const allowed = normalizeRelative(entry);
    return allowed.endsWith("/**")
      ? normalized.startsWith(allowed.slice(0, -3))
      : normalized === allowed;
  });
}

function commitFiles(repoRoot: string, commit: string) {
  return splitLines(git(repoRoot, ["diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames=100%", commit]))
    .map((line) => {
      const [status, ...names] = line.split("\t");
      return { status, paths: names.map(normalizeRelative) };
    });
}

function diffStat(repoRoot: string, commit: string) {
  const records = splitLines(git(repoRoot, ["show", "--numstat", "--format=", "--no-renames", commit])).map((line) => {
    const [added, deleted, relative] = line.split("\t");
    return {
      path: normalizeRelative(relative),
      added_lines: added === "-" ? null : Number(added),
      deleted_lines: deleted === "-" ? null : Number(deleted),
    };
  });
  return {
    files: records,
    file_count: records.length,
    added_lines: records.reduce((sum, record) => sum + (record.added_lines ?? 0), 0),
    deleted_lines: records.reduce((sum, record) => sum + (record.deleted_lines ?? 0), 0),
    binary_files: records.filter((record) => record.added_lines === null).length,
  };
}

function patchId(repoRoot: string, commit: string) {
  const patch = git(repoRoot, ["show", "--pretty=format:", "--no-ext-diff", "--binary", commit]);
  const output = git(repoRoot, ["patch-id", "--stable"], `${patch}\n`);
  const id = output.split(/\s+/u)[0];
  if (!/^[a-f0-9]{40}$/u.test(id)) throw new Error(`patch_id_unavailable:${commit}`);
  return id;
}

function blobId(repoRoot: string, commit: string, relative: string) {
  const result = spawnSync("git", ["rev-parse", `${commit}:${relative}`], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function commitRecord(repoRoot: string, commit: string) {
  const [sha, parents, subject, tree] = git(repoRoot, ["show", "-s", "--format=%H%n%P%n%s%n%T", commit]).split(/\r?\n/u);
  return {
    sha,
    parents: parents ? parents.split(" ") : [],
    subject,
    tree,
    changed_files: commitFiles(repoRoot, commit),
    diff_stat: diffStat(repoRoot, commit),
  };
}

export function assertPatchEquivalence(left: Readonly<{ patch_id: string }>, right: Readonly<{ patch_id: string }>) {
  if (left.patch_id !== right.patch_id) throw new Error("wave1_worker_cherry_pick_patch_mismatch");
}

export function generateWave1GitAudit(input: Readonly<{
  repo_root: string;
  original_base?: string;
  final_sha?: string;
}>) {
  const repoRoot = path.resolve(input.repo_root);
  const originalBase = input.original_base ?? WAVE1_ORIGINAL_BASE;
  const finalSha = input.final_sha ?? WAVE1_FINAL_SHA;
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", originalBase, finalSha], {
    cwd: repoRoot,
    windowsHide: true,
  }).status === 0;
  if (!ancestry) throw new Error("wave1_original_base_not_ancestor");

  const firstParentShas = splitLines(git(repoRoot, [
    "rev-list",
    "--first-parent",
    "--reverse",
    `${originalBase}^..${finalSha}`,
  ]));
  if (firstParentShas[0] !== originalBase || firstParentShas.at(-1) !== finalSha) {
    throw new Error("wave1_first_parent_range_mismatch");
  }
  const firstParentChain = firstParentShas.map((sha) => commitRecord(repoRoot, sha));

  const workers = WAVE1_WORKERS.map((worker) => {
    const workerRecord = commitRecord(repoRoot, worker.worker_commit);
    const integrationRecord = commitRecord(repoRoot, worker.integration_commit);
    const workerPatch = patchId(repoRoot, worker.worker_commit);
    const integrationPatch = patchId(repoRoot, worker.integration_commit);
    assertPatchEquivalence({ patch_id: workerPatch }, { patch_id: integrationPatch });
    const mergeBase = git(repoRoot, ["merge-base", worker.worker_commit, worker.expected_base]);
    const commitCount = Number(git(repoRoot, ["rev-list", "--count", `${worker.expected_base}..${worker.worker_commit}`]));
    const workerParent = workerRecord.parents[0] ?? null;
    const paths = workerRecord.changed_files.flatMap((record) => record.paths).sort();
    const pathChecks = paths.map((relative) => ({
      path: relative,
      allowlisted: allowlistMatch(relative, worker.allowlist),
      worker_blob: blobId(repoRoot, worker.worker_commit, relative),
      cherry_pick_blob: blobId(repoRoot, worker.integration_commit, relative),
    }));
    const blobEquivalent = pathChecks.every((entry) => entry.worker_blob === entry.cherry_pick_blob);
    const allowlistPassed = pathChecks.every((entry) => entry.allowlisted);
    const basePassed = mergeBase === worker.expected_base && workerParent === worker.expected_base && commitCount === 1;
    if (!allowlistPassed) throw new Error(`wave1_worker_allowlist_failed:${worker.worker_id}`);
    if (!basePassed) throw new Error(`wave1_worker_base_failed:${worker.worker_id}`);
    if (!blobEquivalent) throw new Error(`wave1_worker_blob_equivalence_failed:${worker.worker_id}`);
    return {
      ...worker,
      merge_base: mergeBase,
      worker_parent: workerParent,
      commit_count_over_base: commitCount,
      worker_commit_record: workerRecord,
      integration_commit_record: integrationRecord,
      worker_patch_id: workerPatch,
      integration_patch_id: integrationPatch,
      patch_id_equivalent: workerPatch === integrationPatch,
      blob_equivalent_at_cherry_pick: blobEquivalent,
      allowlist_passed: allowlistPassed,
      path_checks: pathChecks,
    };
  });

  const reportWithoutHash = {
    schema_version: "tivdoc-wave1-git-audit-v0.4",
    original_base: originalBase,
    final_sha: finalSha,
    original_base_is_ancestor: ancestry,
    first_parent_commit_count: firstParentChain.length,
    first_parent_chain: firstParentChain,
    branch_bases: workers.map((worker) => ({
      worker_id: worker.worker_id,
      branch: worker.branch,
      expected_base: worker.expected_base,
      merge_base: worker.merge_base,
      worker_parent: worker.worker_parent,
      commit_count_over_base: worker.commit_count_over_base,
    })),
    workers,
    orchestrator_integration_commits: [
      commitRecord(repoRoot, WAVE_A_SHA),
      commitRecord(repoRoot, WAVE1_FINAL_SHA),
    ],
    all_worker_patch_ids_equivalent: workers.every((worker) => worker.patch_id_equivalent),
    all_worker_blobs_equivalent: workers.every((worker) => worker.blob_equivalent_at_cherry_pick),
    all_worker_allowlists_passed: workers.every((worker) => worker.allowlist_passed),
    no_merge_commits_in_range: firstParentChain.every((commit) => commit.parents.length === 1),
  };
  const reportHash = createHash("sha256").update(JSON.stringify(reportWithoutHash)).digest("hex");
  return { ...reportWithoutHash, report_content_sha256: reportHash } as const;
}
