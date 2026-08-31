import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

const TRUSTED_GIT_VERSION = "git version 2.52.0.windows.1";
const TRUSTED_GIT_COMMAND = "C:\\Program Files\\Git\\cmd\\git.exe";
const TRUSTED_GIT_BINARY = "C:\\Program Files\\Git\\mingw64\\bin\\git.exe";
const TRUSTED_GIT_EXEC_PATH = "C:\\Program Files\\Git\\mingw64\\libexec\\git-core";
const TRUSTED_GIT_COMMAND_BYTES = 46_480;
const TRUSTED_GIT_BINARY_BYTES = 4_321_168;
const TRUSTED_GIT_COMMAND_SHA256 =
  "3cbd024d9d11ef08bd6a0cb5a973613c50825b4952bc6006f3f4222f436091e5";
const TRUSTED_GIT_BINARY_SHA256 =
  "fc0f1cae1304fcdcf4d0749f421c5ed21471efc856301f92f56d4b844be84363";
const TRUSTED_GIT_TIMEOUT_MS = 60_000;
const TRUSTED_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type TrustedGitRepositoryReceipt = Readonly<{
  schema_version: "tivdoc-trusted-git-repository-v0.9.1";
  git_version: typeof TRUSTED_GIT_VERSION;
  command_path: typeof TRUSTED_GIT_COMMAND;
  command_sha256: typeof TRUSTED_GIT_COMMAND_SHA256;
  binary_path: typeof TRUSTED_GIT_BINARY;
  binary_sha256: typeof TRUSTED_GIT_BINARY_SHA256;
  repository_root: string;
  top_level: string;
  git_dir: string;
  common_dir: string;
  index_path: string;
  object_directory: string;
  replacement_refs: 0;
  grafts_present: false;
  assume_unchanged_entries: 0;
  skip_worktree_entries: 0;
  index_entries_checked: number;
  fsmonitor_disabled: true;
  untracked_cache_disabled: true;
  global_and_system_config_neutralized: true;
  status: "PASS";
}>;

type TrustedGitBufferOptions = Readonly<{
  input?: string | Buffer;
  maxBuffer?: number;
}>;

type TrustedToolchainReceipt = Readonly<{
  version: typeof TRUSTED_GIT_VERSION;
}>;

let cachedToolchain: TrustedToolchainReceipt | undefined;

/** Runs a trusted, non-interactive Git command and returns stdout without surrounding whitespace. */
export function trustedGitText(repositoryRoot: string, args: readonly string[]): string {
  return trustedGitBuffer(repositoryRoot, args).toString("utf8").trim();
}

/** Runs a trusted, non-interactive Git command and preserves stdout byte-for-byte. */
export function trustedGitBuffer(
  repositoryRoot: string,
  args: readonly string[],
  options: TrustedGitBufferOptions = {},
): Buffer {
  const root = assertOrdinaryPhysicalDirectory(repositoryRoot, "TRUSTED_GIT_REPOSITORY_ROOT_INVALID");
  assertTrustedToolchain();
  assertCommandArguments(args);
  const maxBuffer = options.maxBuffer ?? TRUSTED_GIT_MAX_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 256 * 1024 * 1024) {
    throw new Error("TRUSTED_GIT_MAX_BUFFER_INVALID");
  }
  const result = spawnSync(TRUSTED_GIT_COMMAND, trustedArguments(args), {
    cwd: root,
    env: trustedEnvironment(),
    encoding: null,
    windowsHide: true,
    timeout: TRUSTED_GIT_TIMEOUT_MS,
    maxBuffer,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error("TRUSTED_GIT_COMMAND_FAILED");
  }
  const stderr = asBuffer(result.stderr);
  if (stderr.byteLength !== 0) throw new Error("TRUSTED_GIT_COMMAND_STDERR_REJECTED");
  return Buffer.from(asBuffer(result.stdout));
}

/**
 * Proves that Git resolves exactly the requested ordinary checkout and that no
 * replacement-ref, graft, assume-unchanged, or skip-worktree mechanism can
 * alter the repository view used by the verification harness.
 */
export function assertTrustedGitRepository(repositoryRoot: string): TrustedGitRepositoryReceipt {
  const root = assertOrdinaryPhysicalDirectory(repositoryRoot, "TRUSTED_GIT_REPOSITORY_ROOT_INVALID");
  const topLevel = assertOrdinaryPhysicalDirectory(
    trustedGitText(root, ["rev-parse", "--show-toplevel"]),
    "TRUSTED_GIT_TOPLEVEL_INVALID",
  );
  if (!samePath(root, topLevel)) throw new Error("TRUSTED_GIT_TOPLEVEL_MISMATCH");
  if (trustedGitText(root, ["rev-parse", "--is-inside-work-tree"]) !== "true"
      || trustedGitText(root, ["rev-parse", "--is-bare-repository"]) !== "false") {
    throw new Error("TRUSTED_GIT_WORKTREE_INVALID");
  }

  const expectedGitDir = path.join(root, ".git");
  const gitDir = assertOrdinaryPhysicalDirectory(
    trustedGitText(root, ["rev-parse", "--absolute-git-dir"]),
    "TRUSTED_GIT_DIRECTORY_INVALID",
  );
  if (!samePath(gitDir, expectedGitDir) || !isContained(root, gitDir)) {
    throw new Error("TRUSTED_GIT_DIRECTORY_MISMATCH");
  }
  const commonDir = assertOrdinaryPhysicalDirectory(
    trustedGitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "TRUSTED_GIT_COMMON_DIRECTORY_INVALID",
  );
  if (!samePath(commonDir, gitDir)) throw new Error("TRUSTED_GIT_COMMON_DIRECTORY_MISMATCH");

  const indexPath = assertOrdinaryPhysicalFile(
    trustedGitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
    "TRUSTED_GIT_INDEX_INVALID",
  );
  if (!samePath(indexPath, path.join(gitDir, "index")) || !isContained(gitDir, indexPath)) {
    throw new Error("TRUSTED_GIT_INDEX_PATH_MISMATCH");
  }
  const objectDirectory = assertOrdinaryPhysicalDirectory(
    trustedGitText(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
    "TRUSTED_GIT_OBJECT_DIRECTORY_INVALID",
  );
  if (!samePath(objectDirectory, path.join(gitDir, "objects")) || !isContained(gitDir, objectDirectory)) {
    throw new Error("TRUSTED_GIT_OBJECT_DIRECTORY_MISMATCH");
  }
  if (pathExists(path.join(objectDirectory, "info", "alternates"))) {
    throw new Error("TRUSTED_GIT_OBJECT_ALTERNATES_FORBIDDEN");
  }

  const graftsPath = path.join(gitDir, "info", "grafts");
  if (pathExists(graftsPath)) throw new Error("TRUSTED_GIT_GRAFTS_FORBIDDEN");
  const replacementRefs = trustedGitText(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ]);
  if (replacementRefs !== "") throw new Error("TRUSTED_GIT_REPLACEMENT_REFS_FORBIDDEN");

  const indexFlags = inspectIndexFlags(trustedGitBuffer(root, ["ls-files", "-v", "-z", "--"]));
  if (indexFlags.assumeUnchanged !== 0 || indexFlags.skipWorktree !== 0) {
    throw new Error("TRUSTED_GIT_INDEX_FLAGS_FORBIDDEN");
  }

  return Object.freeze({
    schema_version: "tivdoc-trusted-git-repository-v0.9.1",
    git_version: TRUSTED_GIT_VERSION,
    command_path: TRUSTED_GIT_COMMAND,
    command_sha256: TRUSTED_GIT_COMMAND_SHA256,
    binary_path: TRUSTED_GIT_BINARY,
    binary_sha256: TRUSTED_GIT_BINARY_SHA256,
    repository_root: root,
    top_level: topLevel,
    git_dir: gitDir,
    common_dir: commonDir,
    index_path: indexPath,
    object_directory: objectDirectory,
    replacement_refs: 0,
    grafts_present: false,
    assume_unchanged_entries: 0,
    skip_worktree_entries: 0,
    index_entries_checked: indexFlags.entries,
    fsmonitor_disabled: true,
    untracked_cache_disabled: true,
    global_and_system_config_neutralized: true,
    status: "PASS",
  });
}

function assertTrustedToolchain(): TrustedToolchainReceipt {
  if (cachedToolchain) return cachedToolchain;
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("TRUSTED_GIT_PLATFORM_INVALID");
  }
  assertPinnedExecutable(
    TRUSTED_GIT_COMMAND,
    TRUSTED_GIT_COMMAND_BYTES,
    TRUSTED_GIT_COMMAND_SHA256,
    "TRUSTED_GIT_COMMAND_BINARY_INVALID",
  );
  assertPinnedExecutable(
    TRUSTED_GIT_BINARY,
    TRUSTED_GIT_BINARY_BYTES,
    TRUSTED_GIT_BINARY_SHA256,
    "TRUSTED_GIT_MINGW_BINARY_INVALID",
  );
  assertGitVersion(TRUSTED_GIT_COMMAND);
  assertGitVersion(TRUSTED_GIT_BINARY);
  cachedToolchain = Object.freeze({ version: TRUSTED_GIT_VERSION });
  return cachedToolchain;
}

function assertPinnedExecutable(
  executable: string,
  expectedBytes: number,
  expectedSha256: string,
  code: string,
): void {
  let metadata;
  try {
    metadata = lstatSync(executable);
  } catch {
    throw new Error(code);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedBytes
      || !samePath(realpathSync.native(executable), executable)
      || sha256(readFileSync(executable)) !== expectedSha256) {
    throw new Error(code);
  }
}

function assertGitVersion(executable: string): void {
  const result = spawnSync(executable, ["--version"], {
    cwd: path.dirname(executable),
    env: trustedEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null
      || result.stderr !== "" || result.stdout.trim() !== TRUSTED_GIT_VERSION) {
    throw new Error("TRUSTED_GIT_VERSION_INVALID");
  }
}

function trustedArguments(args: readonly string[]): string[] {
  return [
    "--no-pager",
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    ...args,
  ];
}

function trustedEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  environment.SystemRoot ??= systemRoot;
  environment.WINDIR ??= systemRoot;
  environment.Path = [
    path.dirname(TRUSTED_GIT_COMMAND),
    path.dirname(TRUSTED_GIT_BINARY),
    TRUSTED_GIT_EXEC_PATH,
    path.join(systemRoot, "System32"),
  ].join(path.delimiter);
  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "NUL";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = "NUL";
  environment.GIT_EXEC_PATH = TRUSTED_GIT_EXEC_PATH;
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function assertCommandArguments(args: readonly string[]): void {
  if (args.length === 0 || !/^[a-z][a-z0-9-]*$/u.test(args[0] ?? "")) {
    throw new Error("TRUSTED_GIT_ARGUMENTS_INVALID");
  }
  for (const argument of args) {
    if (typeof argument !== "string" || argument.includes("\0")
        || argument.includes("\r") || argument.includes("\n")) {
      throw new Error("TRUSTED_GIT_ARGUMENTS_INVALID");
    }
  }
}

function inspectIndexFlags(bytes: Buffer): Readonly<{
  entries: number;
  assumeUnchanged: number;
  skipWorktree: number;
}> {
  let entries = 0;
  let assumeUnchanged = 0;
  let skipWorktree = 0;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = bytes.indexOf(0, offset);
    if (end === -1 || end - offset < 3 || bytes[offset + 1] !== 0x20) {
      throw new Error("TRUSTED_GIT_INDEX_LISTING_INVALID");
    }
    const tag = bytes[offset]!;
    if (tag >= 0x61 && tag <= 0x7a) assumeUnchanged += 1;
    if (tag === 0x53 || tag === 0x73) skipWorktree += 1;
    entries += 1;
    offset = end + 1;
  }
  return Object.freeze({ entries, assumeUnchanged, skipWorktree });
}

function assertOrdinaryPhysicalDirectory(candidate: string, code: string): string {
  const resolved = path.resolve(candidate);
  let metadata;
  let physical: string;
  try {
    metadata = lstatSync(resolved);
    physical = realpathSync.native(resolved);
  } catch {
    throw new Error(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(resolved, physical)) {
    throw new Error(code);
  }
  return physical;
}

function assertOrdinaryPhysicalFile(candidate: string, code: string): string {
  const resolved = path.resolve(candidate);
  let metadata;
  let physical: string;
  try {
    metadata = lstatSync(resolved);
    physical = realpathSync.native(resolved);
  } catch {
    throw new Error(code);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(resolved, physical)) {
    throw new Error(code);
  }
  return physical;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function pathExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("TRUSTED_GIT_PATH_INSPECTION_FAILED");
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function asBuffer(value: Buffer | string | null): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.alloc(0);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
