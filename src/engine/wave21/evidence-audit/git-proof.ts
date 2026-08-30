import { readFile } from "node:fs/promises";
import path from "node:path";
import { allowlistMatch, git, normalized, readJson, sha256, stableJson, WAVE21_CONTRACT_SHA } from "./common.ts";

const SHA40 = /^[a-f0-9]{40}$/u;
const CURRENT_ALLOWLIST = [
  "src/engine/wave21/evidence-audit/**",
  "scripts/wave21-evidence-audit/**",
  "docs/wave21-evidence-reachability-v0.4.1.md",
] as const;

function collectSha40(value: unknown, output = new Set<string>(), key = "") {
  if (Array.isArray(value)) value.forEach((entry) => collectSha40(entry, output, key));
  else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, entry]) => collectSha40(entry, output, childKey));
  else if (typeof value === "string" && SHA40.test(value) && !key.includes("patch_id")) output.add(value);
  return output;
}

function lines(value: string) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

function changedFiles(repoRoot: string, commit: string) {
  return lines(git(repoRoot, ["diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames=100%", commit])).map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status, paths: paths.map(normalized) };
  });
}

function diffStat(repoRoot: string, commit: string) {
  const files = lines(git(repoRoot, ["show", "--numstat", "--format=", "--no-renames", commit])).map((line) => {
    const [added, deleted, relative] = line.split("\t");
    return { path: normalized(relative!), added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) };
  });
  return { files, file_count: files.length, added_lines: files.reduce((sum, entry) => sum + (entry.added ?? 0), 0), deleted_lines: files.reduce((sum, entry) => sum + (entry.deleted ?? 0), 0) };
}

function patchId(repoRoot: string, commit: string) {
  const patch = git(repoRoot, ["show", "--pretty=format:", "--no-ext-diff", "--binary", commit]);
  const output = git(repoRoot, ["patch-id", "--stable"], `${patch}\n`);
  return output.split(/\s+/u)[0]!;
}

function record(repoRoot: string, commit: string) {
  const [sha, parents, subject, tree] = git(repoRoot, ["show", "-s", "--format=%H%n%P%n%s%n%T", commit]).split(/\r?\n/u);
  return { sha, parents: parents ? parents.split(" ") : [], subject, tree, patch_id: patchId(repoRoot, commit), changed_files: changedFiles(repoRoot, commit), diff_stat: diffStat(repoRoot, commit) };
}

export async function buildCompleteGitProof(repoRoot: string, extractedPackageRoot: string) {
  const wave2Audit = await readJson<Record<string, unknown>>(path.join(extractedPackageRoot, "git", "wave2-git-audit.json"));
  const wave1Audit = await readJson<Record<string, unknown>>(path.join(extractedPackageRoot, "worker-evidence", "A1", "wave1-git-audit.json"));
  const allRefs = [...collectSha40(wave2Audit), ...collectSha40(wave1Audit)];
  const uniqueRefs = [...new Set(allRefs)].sort();
  const objectTypes = uniqueRefs.map((sha) => ({ sha, object_type: git(repoRoot, ["cat-file", "-t", sha]) }));
  const commits = objectTypes.filter((entry) => entry.object_type === "commit").map((entry) => record(repoRoot, entry.sha));
  const currentHead = git(repoRoot, ["rev-parse", "HEAD"]);
  const branch = git(repoRoot, ["branch", "--show-current"]);
  const worktree = normalized(git(repoRoot, ["rev-parse", "--show-toplevel"]));
  const mergeBase = git(repoRoot, ["merge-base", WAVE21_CONTRACT_SHA, currentHead]);
  const commitCount = Number(git(repoRoot, ["rev-list", "--count", `${WAVE21_CONTRACT_SHA}..${currentHead}`]));
  const currentChanged = lines(git(repoRoot, ["diff", "--name-only", `${WAVE21_CONTRACT_SHA}..${currentHead}`])).map(normalized).sort();
  const pathChecks = await Promise.all(currentChanged.map(async (relative) => ({
    path: relative,
    allowlisted: allowlistMatch(relative, CURRENT_ALLOWLIST),
    content_sha256: sha256(await readFile(path.resolve(repoRoot, relative))),
  })));
  const status = git(repoRoot, ["status", "--porcelain=v1"]);
  const cleanHandoff = status === "";
  const currentWorker = {
    worker_id: "W1",
    branch,
    worktree,
    expected_base: WAVE21_CONTRACT_SHA,
    merge_base: mergeBase,
    commit_count_over_base: commitCount,
    head: currentHead,
    head_record: record(repoRoot, currentHead),
    allowlist: CURRENT_ALLOWLIST,
    allowlist_content_sha256: sha256(stableJson(CURRENT_ALLOWLIST)),
    changed_paths: pathChecks,
    all_paths_allowlisted: pathChecks.every((entry) => entry.allowlisted),
    clean_handoff: cleanHandoff,
    porcelain: status,
  };
  if (branch !== "codex/wave21-w1-evidence-reachability" || mergeBase !== WAVE21_CONTRACT_SHA || commitCount !== 1 || !currentWorker.all_paths_allowlisted || !cleanHandoff) {
    throw new Error(`wave21_worker_git_handoff_failed:${JSON.stringify(currentWorker)}`);
  }
  return {
    schema_version: "tivdoc-complete-git-proof-v0.4.1",
    original_base: "e978ae5cee4a92f20dcc7db448b275170b8bf724",
    wave1_final: "bb9a61eae55d49529d7cd633a2c9c2615a8d842e",
    wave2_contracts: ["2478e28eb4f31d282dac4b6f8f1fb488fb9b5bca", "c8adca29db4609d7196e30dbd813d334882bfb48"],
    wave2_final: "5ce3eba6ab816cd6a20e101c913f7f1177c7598a",
    wave21_contract: WAVE21_CONTRACT_SHA,
    referenced_object_count: objectTypes.length,
    referenced_objects: objectTypes,
    commit_records: commits,
    v0_4_machine_audits: { wave1: wave1Audit, wave2: wave2Audit },
    current_worker: currentWorker,
    complete_full_length_sha_proof: objectTypes.every((entry) => SHA40.test(entry.sha)),
    every_commit_has_parent_tree_patch_files_and_stat: commits.every((entry) => entry.parents.length > 0 && SHA40.test(entry.tree!) && SHA40.test(entry.patch_id)),
  };
}
