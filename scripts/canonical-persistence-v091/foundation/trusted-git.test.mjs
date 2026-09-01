import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertTrustedGitRepository,
  trustedGitText,
} from "./trusted-git.mts";

const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V0.9.1 trusted Git foundation", () => {
  it("pins the exact Git toolchain and physical repository", () => {
    const receipt = assertTrustedGitRepository(process.cwd());
    expect(receipt).toMatchObject({
      git_version: "git version 2.52.0.windows.1",
      command_sha256: "3cbd024d9d11ef08bd6a0cb5a973613c50825b4952bc6006f3f4222f436091e5",
      binary_sha256: "fc0f1cae1304fcdcf4d0749f421c5ed21471efc856301f92f56d4b844be84363",
      replacement_refs: 0,
      grafts_present: false,
      assume_unchanged_entries: 0,
      skip_worktree_entries: 0,
      status: "PASS",
    });
    expect(receipt.index_entries_checked).toBeGreaterThan(0);
  });

  it("ignores hostile inherited GIT_* variables", () => {
    const poisoned = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_DIR: "Z:\\untrusted\\repository",
      GIT_INDEX_FILE: "Z:\\untrusted\\index",
      GIT_NO_REPLACE_OBJECTS: "0",
      GIT_OBJECT_DIRECTORY: "Z:\\untrusted\\objects",
      GIT_WORK_TREE: "Z:\\untrusted\\worktree",
    };
    const previous = Object.fromEntries(Object.keys(poisoned).map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, poisoned);
      expect(path.resolve(trustedGitText(process.cwd(), ["rev-parse", "--show-toplevel"])))
        .toBe(path.resolve(process.cwd()));
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects replacement refs and hidden index flags", async () => {
    const root = await createRepository();
    assertTrustedGitRepository(root);

    rawGit(root, ["update-index", "--assume-unchanged", "tracked.txt"]);
    expect(() => assertTrustedGitRepository(root)).toThrow("TRUSTED_GIT_INDEX_FLAGS_FORBIDDEN");
    rawGit(root, ["update-index", "--no-assume-unchanged", "tracked.txt"]);

    rawGit(root, ["update-index", "--skip-worktree", "tracked.txt"]);
    expect(() => assertTrustedGitRepository(root)).toThrow("TRUSTED_GIT_INDEX_FLAGS_FORBIDDEN");
    rawGit(root, ["update-index", "--no-skip-worktree", "tracked.txt"]);

    await writeFile(path.join(root, "tracked.txt"), "second\n", "utf8");
    rawGit(root, ["add", "tracked.txt"]);
    rawGit(root, [
      "-c", "user.name=Tivdoc Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "second",
    ]);
    rawGit(root, ["replace", "HEAD", "HEAD~1"]);
    expect(() => assertTrustedGitRepository(root)).toThrow("TRUSTED_GIT_REPLACEMENT_REFS_FORBIDDEN");
  }, 20_000);

  it("rejects a subdirectory and legacy grafts as repository roots", async () => {
    const root = await createRepository();
    const nested = path.join(root, "nested");
    await mkdir(nested);
    expect(() => assertTrustedGitRepository(nested)).toThrow("TRUSTED_GIT_TOPLEVEL_MISMATCH");

    const gitDir = rawGit(root, ["rev-parse", "--absolute-git-dir"]).trim();
    await mkdir(path.join(gitDir, "info"), { recursive: true });
    await writeFile(path.join(gitDir, "info", "grafts"), "# forbidden\n", "utf8");
    expect(() => assertTrustedGitRepository(root)).toThrow();
  });
});

async function createRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "tivdoc-trusted-git-"));
  temporaryRoots.push(root);
  rawGit(root, ["init", "--initial-branch=main"]);
  await writeFile(path.join(root, "tracked.txt"), "first\n", "utf8");
  rawGit(root, ["add", "tracked.txt"]);
  rawGit(root, [
    "-c", "user.name=Tivdoc Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "initial",
  ]);
  return root;
}

function rawGit(root, args) {
  return execFileSync(GIT, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "NUL",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
