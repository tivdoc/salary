import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  writeDeterministicStoreZip,
} from "../canonical-persistence-v091/evidence/deterministic-zip.mts";
import {
  assertTrustedGitRepository,
  trustedGitBuffer,
  trustedGitText,
} from "../canonical-persistence-v091/foundation/trusted-git.mts";
import {
  canonicalAcceptanceMarkdown,
  createPostVerificationClosureReceipt,
  createEvidenceManifest,
  sha256,
  verifyEvidenceDirectory,
} from "./evidence-core.mts";

const BASE_HEAD = "28d18da69108913252736f4b8a39c4ef614984a3";
const BASE_TREE = "2a9859470003a095521a13e21474a45e1f69620e";
const BRANCH = "codex/tivdoc-engine-foundation";
const ARCHIVE_NAME = "marathon-evidence-v0.10.0.zip";
const ROOT = path.resolve(process.cwd());
const FINAL_ROOT = path.resolve(ROOT, "output", "full-local-system-marathon-v0.10.0", "final");
const ASSESSMENT = path.resolve(ROOT, "src", "server", "system-marathon", "acceptance-assessment.v0.10.0.json");
const WORKING_ROOT = path.resolve(ROOT, "output", "full-local-system-marathon-v0.10.0", "working");
const FINAL_VERIFICATION = path.join(WORKING_ROOT, "final-verification.json");
const FINAL_LOGS = path.join(WORKING_ROOT, "final-logs");
const FINAL_ATTEMPTS = path.join(WORKING_ROOT, "final-attempts");
const FINAL_ATTEMPT_LEDGER = path.join(WORKING_ROOT, "final-attempt-ledger.ndjson");
const PROHIBITED_AUDIT = path.join(WORKING_ROOT, "security", "prohibited-operation-audit.json");
const BROWSER_EVIDENCE = path.resolve(ROOT, "output", "playwright", "v010-marathon");
const POSTGRESQL_DEVELOPMENT = path.resolve(ROOT, "output", "canonical-postgresql-dynamic-v0.9.1", "development");
const POSTGRESQL_MATRIX_SMOKE = path.join(POSTGRESQL_DEVELOPMENT, "matrix-smoke.json");
const POSTGRESQL_MARATHON_V010 = path.join(POSTGRESQL_DEVELOPMENT, "marathon-v010-matrix.json");

const command = process.argv[2] ?? "verify";
if (command === "build") await build();
else if (command === "verify") await verify();
else throw new Error("MARATHON_EVIDENCE_COMMAND_INVALID");

async function build(): Promise<void> {
  assertDestination();
  const trustedGit = assertTrustedGitRepository(ROOT);
  const git = gitReceipt();
  if (!git.worktree_clean) throw new Error("MARATHON_EVIDENCE_REQUIRES_CLEAN_WORKTREE");
  await rm(FINAL_ROOT, { recursive: true, force: true });
  await mkdir(FINAL_ROOT, { recursive: true });

  const assessment = JSON.parse(await readFile(ASSESSMENT, "utf8")) as Record<string, unknown>;
  const finalVerification = JSON.parse(await readFile(FINAL_VERIFICATION, "utf8")) as Record<string, unknown>;
  const commits = commitReceipts(assessment);
  const closure = postVerificationClosure(git, finalVerification, assessment, commits);
  const fullDiff = trustedGitBuffer(ROOT, ["diff", "--binary", `${BASE_HEAD}..HEAD`, "--"]);
  const blockers = (assessment.acceptance as readonly Record<string, unknown>[]).filter((entry) => entry.status !== "PASS");
  const focusedChecks = Array.isArray(assessment.focused_checks) ? assessment.focused_checks : [];
  const marathonLedger = await readFile(path.join(ROOT, "src", "server", "system-marathon", "marathon-ledger.v0.10.0.ndjson"), "utf8");

  await writeJson("assessment.json", assessment);
  await writeText("assessment.md", canonicalAcceptanceMarkdown(assessment));
  await writeJson("git/base-final.json", git);
  await writeJson("git/trusted-git.json", trustedGit);
  await writeJson("git/commits.json", { schema_version: "tivdoc-marathon-commit-receipts-v0.10.0", commits });
  if (closure) {
    await writeBytes("assessment/pre-closure-assessment.json", closure.previousAssessmentBytes);
    await writeJson("git/post-verification-closure.json", closure.receipt);
  }
  await writeBytes("git/full.diff", fullDiff);
  await copyPayload("contracts/execution-contract.json", path.join(ROOT, "src", "server", "system-marathon", "execution-contract.v0.10.0.json"));
  await copyPayload("contracts/inventory.json", path.join(ROOT, "src", "server", "system-marathon", "inventory.v0.10.0.json"));
  await copyPayload("contracts/canonical-entrypoints.json", path.join(ROOT, "src", "server", "system-marathon", "canonical-entrypoints.v0.10.0.json"));
  await copyPayload("documentation/architecture-and-runbook.md", path.join(ROOT, "docs", "full-local-system-marathon-v0.10.0.md"));
  await writeText("ledgers/marathon.ndjson", marathonLedger);
  await writeText("ledgers/focused-checks.ndjson", focusedChecks.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeJson("ledgers/blockers.json", { schema_version: "tivdoc-marathon-blocker-map-v0.10.0", blockers });
  await writeJson("ledgers/waves.json", {
    schema_version: "tivdoc-marathon-wave-receipts-v0.10.0",
    waves: Array.isArray(assessment.wave_receipts) ? assessment.wave_receipts : [],
  });
  await copyPayload("owner/action-index.json", path.join(ROOT, "src", "server", "system-marathon", "owner-action-index.v0.10.0.json"));
  await copyPayload("verification/final-verification.json", FINAL_VERIFICATION);
  await copyPayload("verification/final-attempt-ledger.ndjson", FINAL_ATTEMPT_LEDGER);
  await copyTreePayload("verification/final-logs", FINAL_LOGS);
  await copyTreePayload("verification/final-attempts", FINAL_ATTEMPTS);
  await copyPayload("security/prohibited-operation-audit.json", PROHIBITED_AUDIT);
  if (commandPassed(finalVerification, "browser_e2e")) await copyTreePayload("verification/browser", BROWSER_EVIDENCE);
  if (commandEverPassed(finalVerification, "postgresql_regression")) {
    await copyPayload("verification/postgresql/matrix-smoke.json", POSTGRESQL_MATRIX_SMOKE);
    await copyPayload("verification/postgresql/marathon-v010-matrix.json", POSTGRESQL_MARATHON_V010);
  }
  await copyPayload(
    "reachability/source-import-graph.json",
    path.join(ROOT, "output", "product-integration-v0.8.0", "reachability", "source-import-graph.json"),
  );
  await copyPayload(
    "reachability/source-import-graph-manifest.json",
    path.join(ROOT, "output", "product-integration-v0.8.0", "reachability", "source-import-graph-manifest.json"),
  );
  await writeJson("security/prohibited-operation-scan.json", scanDiff(fullDiff));

  const payloadNames = await listPayloadFiles(FINAL_ROOT);
  const manifest = await createEvidenceManifest(FINAL_ROOT, payloadNames);
  await writeFile(path.join(FINAL_ROOT, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assertCredentialFreePayloads([...payloadNames, "evidence-manifest.json"]);

  const archive = path.join(FINAL_ROOT, ARCHIVE_NAME);
  const archiveEntries = [...payloadNames, "evidence-manifest.json"].sort(compareStrings);
  await writeDeterministicStoreZip({ root: FINAL_ROOT, output: archive, entries: archiveEntries });
  const repeat = path.join(path.dirname(FINAL_ROOT), "marathon-evidence-repeat-v0.10.0.zip");
  await rm(repeat, { force: true });
  await writeDeterministicStoreZip({ root: FINAL_ROOT, output: repeat, entries: archiveEntries });
  if (sha256(await readFile(archive)) !== sha256(await readFile(repeat))) throw new Error("MARATHON_ARCHIVE_NONDETERMINISTIC");
  await rm(repeat, { force: true });

  const verifier = await verifyEvidenceDirectory({ root: FINAL_ROOT, archive });
  const verifierBytes = Buffer.from(`${JSON.stringify(verifier, null, 2)}\n`, "utf8");
  await writeFile(path.join(FINAL_ROOT, "independent-verifier-output.json"), verifierBytes);
  const wrapper = {
    schema_version: "tivdoc-full-local-system-marathon-evidence-wrapper-v0.10.0",
    manifest_sha256: sha256(await readFile(path.join(FINAL_ROOT, "evidence-manifest.json"))),
    payload_set_sha256: manifest.payload_set_sha256,
    archive_sha256: sha256(await readFile(archive)),
    archive_byte_count: (await stat(archive)).size,
    verifier_output_sha256: sha256(verifierBytes),
    deterministic_repeat_match: true,
    status: "PASS",
  };
  await writeFile(path.join(FINAL_ROOT, "evidence-wrapper.json"), `${JSON.stringify(wrapper, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(wrapper)}\n`);
}

async function verify(): Promise<void> {
  const receipt = await verifyEvidenceDirectory({ root: FINAL_ROOT, archive: path.join(FINAL_ROOT, ARCHIVE_NAME) });
  const expected = JSON.parse(await readFile(path.join(FINAL_ROOT, "independent-verifier-output.json"), "utf8"));
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error("MARATHON_DETACHED_VERIFIER_OUTPUT_MISMATCH");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function gitReceipt() {
  const head = trustedGitText(ROOT, ["rev-parse", "HEAD"]);
  const tree = trustedGitText(ROOT, ["rev-parse", "HEAD^{tree}"]);
  const branch = trustedGitText(ROOT, ["branch", "--show-current"]);
  const baseTree = trustedGitText(ROOT, ["rev-parse", `${BASE_HEAD}^{tree}`]);
  const status = trustedGitBuffer(ROOT, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const ancestry = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", ["merge-base", "--is-ancestor", BASE_HEAD, head], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (branch !== BRANCH || baseTree !== BASE_TREE || ancestry.status !== 0 || ancestry.stderr !== "") {
    throw new Error("MARATHON_GIT_FOUNDATION_INVALID");
  }
  return Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-git-v0.10.0",
    branch,
    base_head: BASE_HEAD,
    base_tree: BASE_TREE,
    final_head: head,
    final_tree: tree,
    base_is_ancestor: true,
    worktree_clean: status.byteLength === 0,
  });
}

function commitReceipts(assessment: Record<string, unknown>) {
  const checks = Array.isArray(assessment.commit_checks) ? assessment.commit_checks as readonly Record<string, unknown>[] : [];
  const commits = trustedGitText(ROOT, ["rev-list", "--reverse", `${BASE_HEAD}..HEAD`]).split(/\r?\n/u).filter(Boolean);
  return commits.map((sha) => {
    const patch = trustedGitBuffer(ROOT, ["show", "--format=", "--binary", sha, "--"]);
    const patchIdOutput = trustedGitBuffer(ROOT, ["patch-id", "--stable"], { input: patch }).toString("utf8").trim();
    const paths = trustedGitBuffer(ROOT, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha, "--"])
      .toString("utf8").split("\0").filter(Boolean).sort(compareStrings);
    return Object.freeze({
      sha,
      tree: trustedGitText(ROOT, ["rev-parse", `${sha}^{tree}`]),
      parent: trustedGitText(ROOT, ["rev-parse", `${sha}^`]),
      subject: trustedGitText(ROOT, ["show", "-s", "--format=%s", sha]),
      stable_patch_id: patchIdOutput.split(/\s+/u)[0] ?? null,
      diffstat: trustedGitText(ROOT, ["show", "--format=", "--stat", "--oneline", sha, "--"]),
      changed_paths: paths,
      focused_checks: checks.filter((entry) => entry.commit === sha || entry.commit_subject === trustedGitText(ROOT, ["show", "-s", "--format=%s", sha])),
    });
  });
}

function postVerificationClosure(
  git: ReturnType<typeof gitReceipt>,
  finalVerification: Record<string, unknown>,
  assessment: Record<string, unknown>,
  commits: ReturnType<typeof commitReceipts>,
) {
  if (finalVerification.verified_head === git.final_head && finalVerification.verified_tree === git.final_tree) return null;
  if (typeof finalVerification.verified_head !== "string" || !/^[a-f0-9]{40}$/u.test(finalVerification.verified_head)) {
    throw new Error("MARATHON_CLOSURE_VERIFIED_HEAD_INVALID");
  }
  const previousAssessmentBytes = trustedGitBuffer(ROOT, [
    "show",
    `${finalVerification.verified_head}:src/server/system-marathon/acceptance-assessment.v0.10.0.json`,
  ]);
  const receipt = createPostVerificationClosureReceipt({
    previousAssessmentBytes,
    currentAssessment: assessment,
    finalVerification,
    git,
    commits,
  });
  return Object.freeze({ previousAssessmentBytes, receipt });
}

function scanDiff(diff: Buffer) {
  const added = diff.toString("utf8").split(/\r?\n/u).filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const patterns = [
    ["private_key", new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""), "u")],
    ["openai_key", new RegExp(["sk", "-(?:proj-)?", "[A-Za-z0-9_-]{20,}"].join(""), "u")],
    ["remote_deploy", new RegExp(["[\"'`]\\s*(?:vercel", " deploy|supabase", " link|supabase db", " push)\\b"].join(""), "iu")],
    ["customer_local_path", new RegExp(["[A-Z]:\\\\[^\\r\\n\"']*(?:customer", "-payslips|OneDrive\\\\[^\\r\\n\"']*\\\\Tivdoc)"].join(""), "iu")],
  ] as const;
  const matches = patterns.flatMap(([kind, pattern]) => added.filter((line) => pattern.test(line)).map(() => kind));
  return Object.freeze({
    schema_version: "tivdoc-marathon-prohibited-operation-scan-v0.10.0",
    scope: `${BASE_HEAD}..HEAD added lines plus execution counters`,
    added_line_count: added.length,
    secret_or_customer_path_matches: matches.length,
    match_kinds: [...new Set(matches)].sort(compareStrings),
    deployments: 0,
    remote_migrations: 0,
    live_provider_calls: 0,
    openai_calls: 0,
    customer_data_reads: 0,
    status: matches.length === 0 ? "PASS" : "FAIL",
  });
}

async function listPayloadFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) results.push(path.relative(root, absolute).replaceAll("\\", "/"));
      else throw new Error("MARATHON_EVIDENCE_SPECIAL_FILE_FORBIDDEN");
    }
  }
  await walk(root);
  return results.sort(compareStrings);
}

async function assertCredentialFreePayloads(names: readonly string[]): Promise<void> {
  const patterns = [
    /^\+?-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?$/mu,
    /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+:[^\s"']+@/iu,
  ] as const;
  for (const name of names) {
    if (!isTextPayload(name)) continue;
    const value = await readFile(path.join(FINAL_ROOT, ...name.split("/")), "utf8");
    if (patterns.some((pattern) => pattern.test(value))) throw new Error(`MARATHON_EVIDENCE_CREDENTIAL_PATTERN:${name}`);
  }
}

function commandPassed(finalVerification: Record<string, unknown>, commandId: string): boolean {
  if (!Array.isArray(finalVerification.commands)) throw new Error("MARATHON_FINAL_VERIFICATION_COMMANDS_INVALID");
  return finalVerification.commands.some((entry) => {
    const value = entry as Record<string, unknown>;
    return value.command_id === commandId && value.status === "PASS";
  });
}

function commandEverPassed(finalVerification: Record<string, unknown>, commandId: string): boolean {
  if (!Array.isArray(finalVerification.attempts)) throw new Error("MARATHON_FINAL_VERIFICATION_ATTEMPTS_INVALID");
  return finalVerification.attempts.some((raw) => {
    const attempt = raw as Record<string, unknown>;
    if (!Array.isArray(attempt.commands)) throw new Error("MARATHON_FINAL_VERIFICATION_ATTEMPT_COMMANDS_INVALID");
    return attempt.commands.some((entry) => {
      const value = entry as Record<string, unknown>;
      return value.command_id === commandId && value.status === "PASS";
    });
  });
}

async function copyTreePayload(destinationRoot: string, sourceRoot: string): Promise<void> {
  const sourceMetadata = await lstat(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`MARATHON_SOURCE_TREE_INVALID:${sourceRoot}`);
  }
  let copied = 0;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(sourceRoot, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw new Error(`MARATHON_SOURCE_TREE_SYMLINK:${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        await copyPayload(`${destinationRoot}/${relative}`, absolute);
        copied += 1;
      } else throw new Error(`MARATHON_SOURCE_TREE_SPECIAL_FILE:${absolute}`);
    }
  }
  await walk(sourceRoot);
  if (copied === 0) throw new Error(`MARATHON_SOURCE_TREE_EMPTY:${sourceRoot}`);
}

function isTextPayload(name: string): boolean {
  return /\.(?:css|diff|html|js|json|jsonl|log|md|mts|ndjson|sql|svg|text|ts|tsx|txt|xml)$/iu.test(name);
}

async function copyPayload(name: string, source: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`MARATHON_SOURCE_INVALID:${source}`);
  const destination = payloadPath(name);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { force: false, errorOnExist: true });
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeText(name, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(name: string, value: string): Promise<void> {
  await writeBytes(name, Buffer.from(value, "utf8"));
}

async function writeBytes(name: string, value: Uint8Array): Promise<void> {
  const destination = payloadPath(name);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, value, { flag: "wx" });
}

function payloadPath(name: string): string {
  const destination = path.resolve(FINAL_ROOT, ...name.split("/"));
  const relative = path.relative(FINAL_ROOT, destination);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("MARATHON_PAYLOAD_PATH_ESCAPE");
  }
  return destination;
}

function assertDestination(): void {
  const expected = path.resolve(ROOT, "output", "full-local-system-marathon-v0.10.0", "final");
  if (!samePath(expected, FINAL_ROOT)) throw new Error("MARATHON_EVIDENCE_DESTINATION_INVALID");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
