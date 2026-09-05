import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertEvidenceSelfReferenceAbsent,
  assertPortableEvidencePath,
  canonicalPayloadSetHash,
  parseIntegrationEvidenceProfile,
  parseOrderedIntegrationLedger,
  RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS,
  validateRuntimeProductClosureAssessment,
  validateV0101AssessmentAgainstReceipts,
  V0101_FINAL_COMMAND_IDS,
  V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS,
  V0101_RUN_COUNT_NAMES,
  type IntegrationEvidenceProfile,
  type V0101EvidenceEntry,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";
import { inspectDeterministicStoreZip } from "../canonical-persistence-v091/evidence/deterministic-zip.mts";

const ROOT = path.resolve(process.cwd());
const GIT_READ_ONLY_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const BRANCH = "codex/tivdoc-engine-foundation";
const FINAL = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "final");
const MANIFEST_PATH = path.join(FINAL, "manifest.json");
const ARCHIVE_PATH = path.join(FINAL, "tivdoc-v0101-evidence.zip");
const ARCHIVE_HASH_PATH = `${ARCHIVE_PATH}.sha256`;
const OUTPUT_PATH = path.join(FINAL, "detached-verifier-output.json");
const ASSESSMENT_ENTRY = "payload/working/integration-repair-assessment.v0.10.1.json";
const FINAL_VERIFICATION_ENTRY = "payload/working/final-verification.json";
const EXTERNAL_GATES_ENTRY = "payload/repository/src/server/system-marathon/external-gates.v0.10.1.json";
const LEDGER_ENTRY = "payload/repository/src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson";
const FIXED_WORKING_FILES = Object.freeze([
  "final-command-journal.ndjson",
  "final-verification.json",
  "integration-repair-assessment.v0.10.1.json",
  "product/unified-timeline.json",
  "regressions/browser.json",
  "regressions/postgresql.json",
  "verification/safety-and-reachability.json",
  ...V0101_FINAL_COMMAND_IDS.flatMap((id) => [
    `final-logs/${id}.stderr.log`,
    `final-logs/${id}.stdout.log`,
  ]),
]);

const V0102_CONTRACT_RELATIVE =
  "src/server/system-marathon/runtime-product-closure-contract.v0.10.2.json" as const;
const V0102_FIRST_NINE = Object.freeze(RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS.slice(0, 9));
const V0102_ARCHIVE_BASENAME = "tivdoc-runtime-product-closure-v0.10.2-evidence.zip" as const;
const V0102_MANIFEST_SCHEMA = "tivdoc-runtime-product-closure-inner-manifest-v0.10.2" as const;
const V0102_SELF_REFERENCE_RULE =
  "manifest_archive_hash_verifier_outputs_and_outer_matrix_sidecars_are_excluded_from_the_inner_payload" as const;
const V0102_REPOSITORY_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  V0102_CONTRACT_RELATIVE,
  "src/server/system-marathon/integration-repair-evidence.ts",
  "scripts/canonical-integration-repair-v0101/build.mts",
  "scripts/canonical-integration-repair-v0101/verify.mts",
  "scripts/canonical-integration-repair-v0101/finalize.mts",
  "scripts/canonical-integration-repair-v0101/record.mts",
  "scripts/canonical-integration-repair-v0101/assess.mts",
] as const);

const runtimeProductVerification = contractArgumentsV0102(process.argv.slice(2));
if (runtimeProductVerification !== null) {
  await verifyRuntimeProductClosure(runtimeProductVerification);
  process.exit(0);
}

const manifestBytes = await ordinaryBytes(MANIFEST_PATH);
const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "V0101_VERIFY_MANIFEST_INVALID");
if (manifest.schema_version !== "tivdoc-canonical-integration-durability-repair-manifest-v0.10.1"
    || manifest.branch !== BRANCH || manifest.base_head !== BASE
    || manifest.self_reference_rule !== "manifest_archive_hash_and_detached_verifier_are_not_payload_files") {
  throw new Error("V0101_VERIFY_MANIFEST_INVALID");
}
const payload = entries(manifest.payload_files);
if (manifest.payload_file_count !== payload.length
    || manifest.payload_bytes !== payload.reduce((sum, entry) => sum + entry.byte_count, 0)
    || manifest.payload_set_sha256 !== canonicalPayloadSetHash(payload)) {
  throw new Error("V0101_VERIFY_PAYLOAD_SET_INVALID");
}
const payloadMap = new Map(payload.map((entry) => [entry.path, entry]));
for (const required of [ASSESSMENT_ENTRY, FINAL_VERIFICATION_ENTRY, EXTERNAL_GATES_ENTRY, LEDGER_ENTRY]) {
  if (!payloadMap.has(required)) throw new Error(`V0101_VERIFY_REQUIRED_PAYLOAD_MISSING:${required}`);
}
if (payload.some((entry) => /(?:^|\/)(?:manifest\.json|tivdoc-v0101-evidence\.zip(?:\.sha256)?|detached-verifier-output\.json)$/u
  .test(entry.path))) throw new Error("V0101_VERIFY_SELF_REFERENCE_IN_PAYLOAD");

for (const entry of payload) {
  const bytes = await ordinaryBytes(path.join(FINAL, ...entry.path.split("/")));
  if (bytes.byteLength !== entry.byte_count || sha256(bytes) !== entry.sha256) {
    throw new Error(`V0101_VERIFY_PAYLOAD_BYTES_INVALID:${entry.path}`);
  }
}

const inspection = await inspectDeterministicStoreZip(ARCHIVE_PATH);
const expectedArchive = Object.freeze([
  Object.freeze({ path: "manifest.json", sha256: sha256(manifestBytes), byte_count: manifestBytes.byteLength }),
  ...payload,
].sort((left, right) => compare(left.path, right.path)));
const actualArchive = [...inspection.entries]
  .map((entry) => ({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count }))
  .sort((left, right) => compare(left.path, right.path));
if (JSON.stringify(actualArchive) !== JSON.stringify(expectedArchive)) {
  throw new Error("V0101_VERIFY_ARCHIVE_ENTRY_SET_INVALID");
}

const archiveBytes = await ordinaryBytes(ARCHIVE_PATH);
const archiveSha256 = sha256(archiveBytes);
const declaredHash = (await ordinaryBytes(ARCHIVE_HASH_PATH)).toString("ascii").trim();
if (declaredHash !== `${archiveSha256}  ${path.basename(ARCHIVE_PATH)}`) {
  throw new Error("V0101_VERIFY_ARCHIVE_HASH_INVALID");
}

const assessment = await jsonPayload(ASSESSMENT_ENTRY, "V0101_VERIFY_ASSESSMENT_INVALID");
const finalVerification = await jsonPayload(FINAL_VERIFICATION_ENTRY, "V0101_VERIFY_FINAL_VERIFICATION_INVALID");
const externalGates = await jsonPayload(EXTERNAL_GATES_ENTRY, "V0101_VERIFY_EXTERNAL_GATES_INVALID");
const matrixHead = String(assessment.matrix_head);
const matrixTree = String(assessment.matrix_tree);
validateV0101AssessmentAgainstReceipts(assessment, finalVerification, externalGates);
parseOrderedIntegrationLedger((await payloadBytes(LEDGER_ENTRY)).toString("utf8"));
await validateFinalVerificationReferences(finalVerification);
await validateAssessmentEvidencePaths(assessment);

const head = git(["rev-parse", "HEAD"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
const branch = git(["branch", "--show-current"]);
if (branch !== BRANCH || manifest.final_head !== head || manifest.final_tree !== tree
    || assessment.verified_head !== head || assessment.verified_tree !== tree
    || finalVerification.verified_branch !== branch || finalVerification.verified_head !== matrixHead
    || finalVerification.verified_tree !== matrixTree) {
  throw new Error("V0101_VERIFY_STALE_HEAD");
}
validatePostMatrixRepair(assessment, matrixHead, matrixTree, head, tree);
await validateWorkingArtifactSet(branch, head, tree, matrixHead, matrixTree, finalVerification);
const gitProof = await jsonPayload("payload/git/base-final.json", "V0101_VERIFY_GIT_PROOF_INVALID");
if (gitProof.branch !== branch || gitProof.base_head !== BASE || gitProof.final_head !== head
    || gitProof.final_tree !== tree || gitProof.base_is_ancestor !== true || gitProof.worktree_clean_before_build !== true) {
  throw new Error("V0101_VERIFY_GIT_PROOF_INVALID");
}
if (spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], {
  cwd: ROOT,
  env: GIT_READ_ONLY_ENV,
}).status !== 0) {
  throw new Error("V0101_VERIFY_BASE_NOT_ANCESTOR");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("V0101_VERIFY_WORKTREE_NOT_CLEAN");
}

const closureResults = new Map<string, Record<string, unknown>>();
for (const value of [...array(assessment.mc_results, "V0101_VERIFY_RESULTS_INVALID"),
  ...array(assessment.ir_results, "V0101_VERIFY_RESULTS_INVALID")]) {
  const result = record(value, "V0101_VERIFY_RESULT_INVALID");
  closureResults.set(String(result.id), result);
}
for (const id of ["MC-35", "IR-26"] as const) {
  const result = closureResults.get(id);
  if (result?.status !== "PASS" || JSON.stringify(result.evidence) !== JSON.stringify(["detached-verifier-output.json"])) {
    throw new Error(`V0101_VERIFY_DETACHED_CLOSURE_NOT_ADMISSIBLE:${id}`);
  }
}

const receipt = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-detached-verifier-v0.10.1",
  status: "PASS",
  verified_branch: branch,
  final_head: head,
  final_tree: tree,
  matrix_head: matrixHead,
  matrix_tree: matrixTree,
  post_matrix_evidence_only_repair_verified: assessment.post_matrix_evidence_only_repair !== null,
  manifest_sha256: sha256(manifestBytes),
  payload_file_count: payload.length,
  payload_set_sha256: manifest.payload_set_sha256,
  archive_entry_count: inspection.entry_count,
  archive_sha256: archiveSha256,
  traversal_rejected: true,
  duplicate_normalized_paths_rejected: true,
  out_of_root_evidence_rejected: true,
  missing_evidence_rejected: true,
  malformed_ledgers_rejected: true,
  self_reference_absent: true,
  stale_head_rejected: true,
  contradictory_statuses_rejected: true,
  blocked_gate_false_pass_rejected: true,
  detached_closure: Object.freeze({
    status: "PASS",
    closes_assessment_ids: Object.freeze(["MC-35", "IR-26"]),
    proof_established_after_manifest_payload_archive_and_status_verification: true,
    self_reference_rule_preserved: true,
  }),
});
await writeFile(OUTPUT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);

type RuntimeProductVerificationArguments = Readonly<{
  contract: string;
  repeat: boolean;
  no_write_requested: boolean;
}>;

type RuntimeProductVerificationContext = Readonly<{
  profile: IntegrationEvidenceProfile;
  contract_path: string;
  contract_relative: string;
  contract_bytes: Buffer;
  contract_sha256: string;
  final: string;
  manifest: string;
  archive: string;
  archive_hash: string;
  repeat: boolean;
  no_write_requested: boolean;
}>;

function contractArgumentsV0102(args: readonly string[]): RuntimeProductVerificationArguments | null {
  if (!args.includes("--contract")) return null;
  const base = args.length === 2 && args[0] === "--contract" && Boolean(args[1]) && !args[1]!.startsWith("-");
  const repeat = args.length === 4 && args[0] === "--contract" && Boolean(args[1])
    && !args[1]!.startsWith("-") && args[2] === "--repeat" && args[3] === "--no-write";
  if (!base && !repeat) throw new Error("V0102_VERIFY_CONTRACT_ARGUMENT_INVALID");
  return Object.freeze({ contract: args[1]!, repeat, no_write_requested: repeat });
}

async function verifyRuntimeProductClosure(argumentsValue: RuntimeProductVerificationArguments): Promise<void> {
  const context = await runtimeProductVerificationContext(argumentsValue);
  const manifestBytes = await ordinaryRuntimeProductBytes(context.manifest);
  const manifest = jsonRuntimeProductPayload(manifestBytes, "V0102_VERIFY_MANIFEST_INVALID");
  if (manifest.schema_version !== V0102_MANIFEST_SCHEMA
      || manifest.contract_schema_version !== context.profile.contract_schema_version
      || manifest.branch !== context.profile.branch || manifest.base_head !== context.profile.base_head
      || manifest.base_tree !== context.profile.base_tree || manifest.contract_path !== context.contract_relative
      || manifest.contract_sha256 !== context.contract_sha256
      || manifest.self_reference_rule !== V0102_SELF_REFERENCE_RULE
      || manifest.outer_matrix_sidecars_in_payload !== 0) {
    throw new Error("V0102_VERIFY_MANIFEST_INVALID");
  }
  const payload = runtimeProductEntries(manifest.payload_files);
  if (JSON.stringify(payload.map((entry) => entry.path))
        !== JSON.stringify([...payload].map((entry) => entry.path).sort(compare))
      || manifest.payload_file_count !== payload.length
      || manifest.payload_bytes !== payload.reduce((sum, entry) => sum + entry.byte_count, 0)
      || manifest.payload_set_sha256 !== canonicalPayloadSetHash(payload)) {
    throw new Error("V0102_VERIFY_PAYLOAD_SET_INVALID");
  }
  assertEvidenceSelfReferenceAbsent(payload.map((entry) => entry.path));
  const payloadMap = new Map(payload.map((entry) => [entry.path, entry]));
  const payloadBytes = async (entryPath: string): Promise<Buffer> => {
    assertPortableEvidencePath(entryPath);
    const declared = payloadMap.get(entryPath);
    if (!declared) throw new Error(`V0102_VERIFY_REQUIRED_PAYLOAD_MISSING:${entryPath}`);
    const absolute = path.join(context.final, ...entryPath.split("/"));
    if (!containedRuntimeProductPath(context.final, absolute)) throw new Error("V0102_VERIFY_PAYLOAD_PATH_ESCAPE");
    const bytes = await ordinaryRuntimeProductBytes(absolute);
    if (bytes.byteLength !== declared.byte_count || sha256(bytes) !== declared.sha256) {
      throw new Error(`V0102_VERIFY_PAYLOAD_BYTES_INVALID:${entryPath}`);
    }
    return bytes;
  };
  for (const entry of payload) await payloadBytes(entry.path);

  const requiredPayloads = [
    `payload/repository/${V0102_CONTRACT_RELATIVE}`,
    "payload/repository/package.json",
    "payload/repository/package-lock.json",
    "payload/repository/src/server/system-marathon/integration-repair-evidence.ts",
    "payload/repository/scripts/canonical-integration-repair-v0101/build.mts",
    "payload/repository/scripts/canonical-integration-repair-v0101/verify.mts",
    "payload/repository/scripts/canonical-integration-repair-v0101/finalize.mts",
    "payload/repository/scripts/canonical-integration-repair-v0101/record.mts",
    "payload/repository/scripts/canonical-integration-repair-v0101/assess.mts",
    "payload/working/runtime-matrix-progress.json",
    "payload/working/runtime-command-journal.ndjson",
    "payload/working/runtime-product-closure-assessment.v0.10.2.json",
    "payload/git/base-final.json",
    "payload/git/full.diff",
    "payload/git/commit-provenance.json",
  ];
  for (const required of requiredPayloads) {
    if (!payloadMap.has(required)) throw new Error(`V0102_VERIFY_REQUIRED_PAYLOAD_MISSING:${required}`);
  }
  for (const source of V0102_REPOSITORY_FILES) {
    const packaged = await payloadBytes(`payload/repository/${source}`);
    const current = await ordinaryRuntimeProductBytes(path.join(ROOT, ...source.split("/")));
    if (!packaged.equals(current)) throw new Error(`V0102_VERIFY_REPOSITORY_SOURCE_MISMATCH:${source}`);
  }
  const packagedContract = await payloadBytes(`payload/repository/${V0102_CONTRACT_RELATIVE}`);
  if (!packagedContract.equals(context.contract_bytes)) throw new Error("V0102_VERIFY_CONTRACT_BYTES_MISMATCH");
  const packagedProfile = parseIntegrationEvidenceProfile(
    jsonRuntimeProductPayload(packagedContract, "V0102_VERIFY_CONTRACT_INVALID"),
  );
  if (JSON.stringify(packagedProfile) !== JSON.stringify(context.profile)) {
    throw new Error("V0102_VERIFY_CONTRACT_PROFILE_MISMATCH");
  }

  const inspection = await inspectDeterministicStoreZip(context.archive);
  const expectedArchive = Object.freeze([
    Object.freeze({ path: "manifest.json", sha256: sha256(manifestBytes), byte_count: manifestBytes.byteLength }),
    ...payload,
  ].sort((left, right) => compare(left.path, right.path)));
  const actualArchive = [...inspection.entries].map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    byte_count: entry.byte_count,
  })).sort((left, right) => compare(left.path, right.path));
  if (JSON.stringify(actualArchive) !== JSON.stringify(expectedArchive)) {
    throw new Error("V0102_VERIFY_ARCHIVE_ENTRY_SET_INVALID");
  }
  assertEvidenceSelfReferenceAbsent(actualArchive.filter((entry) => entry.path !== "manifest.json")
    .map((entry) => entry.path));
  const archiveBytes = await ordinaryRuntimeProductBytes(context.archive);
  const archiveSha256 = sha256(archiveBytes);
  const declaredHash = (await ordinaryRuntimeProductBytes(context.archive_hash)).toString("ascii").trim();
  if (declaredHash !== `${archiveSha256}  ${V0102_ARCHIVE_BASENAME}`) {
    throw new Error("V0102_VERIFY_ARCHIVE_HASH_INVALID");
  }

  const branch = git(["branch", "--show-current"]);
  const head = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  if (branch !== context.profile.branch || manifest.final_head !== head || manifest.final_tree !== tree
      || git(["rev-parse", `${context.profile.base_head}^{tree}`]) !== context.profile.base_tree
      || spawnSync("git", ["merge-base", "--is-ancestor", context.profile.base_head, head], {
        cwd: ROOT,
        env: GIT_READ_ONLY_ENV,
      }).status !== 0
      || git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("V0102_VERIFY_STALE_HEAD");
  }
  await validateRuntimeProductGitProvenance(context, payloadBytes, branch, head, tree);

  const assessment = jsonRuntimeProductPayload(
    await payloadBytes("payload/working/runtime-product-closure-assessment.v0.10.2.json"),
    "V0102_VERIFY_ASSESSMENT_INVALID",
  );
  validateRuntimeProductClosureAssessment(context.profile, assessment);
  if (assessment.verified_head !== head || assessment.verified_tree !== tree
      || assessment.matrix_head !== head || assessment.matrix_tree !== tree) {
    throw new Error("V0102_VERIFY_ASSESSMENT_STALE_HEAD");
  }
  const readWorking = (relative: string) => payloadBytes(`payload/working/${relative}`);
  const runtime = await validateRuntimeProductProgressV0102({
    profile: context.profile,
    branch,
    head,
    tree,
    contract_sha256: context.contract_sha256,
    read: readWorking,
    package_json_sha256: sha256(await payloadBytes("payload/repository/package.json")),
    package_lock_sha256: sha256(await payloadBytes("payload/repository/package-lock.json")),
  });
  await validateRuntimeProductAssessmentBindingsV0102(
    context.profile,
    assessment,
    runtime.commands,
    runtime.progress,
    head,
    tree,
    readWorking,
  );
  await validateRuntimeProductInternalStages(manifest, payloadBytes, head, tree);

  const innerWorkingPaths = [...payloadMap.keys()].filter((entry) => entry.startsWith("payload/working/"))
    .map((entry) => entry.slice("payload/working/".length)).sort(compare);
  if (manifest.inner_working_file_count !== innerWorkingPaths.length) {
    throw new Error("V0102_VERIFY_INNER_WORKING_COUNT_INVALID");
  }
  for (const relative of innerWorkingPaths) {
    if (relative.startsWith("final-logs/")) {
      const allowed = V0102_FIRST_NINE.some((id) => relative === `final-logs/${id}.stdout.log`
        || relative === `final-logs/${id}.stderr.log`);
      if (!allowed) throw new Error(`V0102_VERIFY_OUTER_LOG_IN_INNER_SET:${relative}`);
    }
  }

  const verifierReceipt = Object.freeze({
    schema_version: "tivdoc-runtime-product-closure-detached-verifier-v0.10.2",
    status: "PASS",
    verified_branch: branch,
    final_head: head,
    final_tree: tree,
    contract_sha256: context.contract_sha256,
    repeat_verification: context.repeat,
    no_write_requested: context.no_write_requested,
    read_only: true,
    writes_performed: 0,
    manifest_sha256: sha256(manifestBytes),
    payload_file_count: payload.length,
    payload_set_sha256: manifest.payload_set_sha256,
    archive_entry_count: inspection.entry_count,
    archive_sha256: archiveSha256,
    deterministic_archive_verified: true,
    provenance_verified: true,
    runtime_command_ledger_verified: true,
    assessment_profile_verified: true,
    traversal_rejected: true,
    duplicate_normalized_paths_rejected: true,
    malformed_provenance_rejected: true,
    malformed_ledgers_rejected: true,
    contradictory_statuses_rejected: true,
    stale_head_rejected: true,
    self_reference_absent: true,
    outer_matrix_sidecars_in_payload: 0,
    detached_closure: Object.freeze({
      status: "PASS",
      closes_assessment_ids: Object.freeze(["MC-35", "IR-26", "CR-21"]),
      proof_established_after_inner_manifest_payload_and_archive_verification: true,
    }),
  });
  process.stdout.write(`${JSON.stringify(verifierReceipt)}\n`);
}

async function runtimeProductVerificationContext(
  argumentsValue: RuntimeProductVerificationArguments,
): Promise<RuntimeProductVerificationContext> {
  const contractPath = path.resolve(ROOT, argumentsValue.contract);
  const expectedContract = path.join(ROOT, ...V0102_CONTRACT_RELATIVE.split("/"));
  if (contractPath !== expectedContract || !containedRuntimeProductPath(ROOT, contractPath)) {
    throw new Error("V0102_VERIFY_CONTRACT_PATH_INVALID");
  }
  const contractBytes = await ordinaryRuntimeProductBytes(contractPath);
  const profile = parseIntegrationEvidenceProfile(
    jsonRuntimeProductPayload(contractBytes, "V0102_VERIFY_CONTRACT_INVALID"),
  );
  const final = path.resolve(ROOT, ...profile.final_output_root.split("/"));
  if (!containedRuntimeProductPath(ROOT, final)
      || final !== path.join(ROOT, "output", "runtime-product-closure-v0.10.2", "final")) {
    throw new Error("V0102_VERIFY_OUTPUT_PATH_INVALID");
  }
  return Object.freeze({
    profile,
    contract_path: contractPath,
    contract_relative: V0102_CONTRACT_RELATIVE,
    contract_bytes: contractBytes,
    contract_sha256: sha256(contractBytes),
    final,
    manifest: path.join(final, "manifest.json"),
    archive: path.join(final, V0102_ARCHIVE_BASENAME),
    archive_hash: path.join(final, `${V0102_ARCHIVE_BASENAME}.sha256`),
    repeat: argumentsValue.repeat,
    no_write_requested: argumentsValue.no_write_requested,
  });
}

async function validateRuntimeProductGitProvenance(
  context: RuntimeProductVerificationContext,
  payloadBytes: (entryPath: string) => Promise<Buffer>,
  branch: string,
  head: string,
  tree: string,
): Promise<void> {
  const proof = jsonRuntimeProductPayload(
    await payloadBytes("payload/git/base-final.json"),
    "V0102_VERIFY_GIT_PROOF_INVALID",
  );
  if (proof.schema_version !== "tivdoc-runtime-product-closure-git-provenance-v0.10.2"
      || proof.branch !== branch || proof.base_head !== context.profile.base_head
      || proof.base_tree !== context.profile.base_tree || proof.final_head !== head || proof.final_tree !== tree
      || proof.base_is_ancestor !== true || proof.worktree_clean_before_build !== true
      || proof.contract_path !== context.contract_relative || proof.contract_sha256 !== context.contract_sha256) {
    throw new Error("V0102_VERIFY_GIT_PROOF_INVALID");
  }
  const fullDiff = await payloadBytes("payload/git/full.diff");
  const expectedDiff = Buffer.from(execFileSync("git", [
    "diff", "--binary", "--full-index", `${context.profile.base_head}..${head}`,
  ], { cwd: ROOT, env: GIT_READ_ONLY_ENV, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }));
  if (!fullDiff.equals(expectedDiff)) throw new Error("V0102_VERIFY_GIT_DIFF_INVALID");

  const provenance = jsonRuntimeProductPayload(
    await payloadBytes("payload/git/commit-provenance.json"),
    "V0102_VERIFY_COMMIT_PROVENANCE_INVALID",
  );
  const commits = array(provenance.commits, "V0102_VERIFY_COMMIT_PROVENANCE_INVALID")
    .map((entry) => record(entry, "V0102_VERIFY_COMMIT_PROVENANCE_INVALID"));
  const expectedCommits = git(["rev-list", "--reverse", `${context.profile.base_head}..${head}`])
    .split(/\r?\n/u).filter(Boolean);
  if (provenance.schema_version !== "tivdoc-runtime-product-closure-commit-provenance-v0.10.2"
      || provenance.branch !== branch || provenance.base_head !== context.profile.base_head
      || provenance.final_head !== head || provenance.final_tree !== tree
      || provenance.commit_count !== expectedCommits.length || commits.length !== expectedCommits.length) {
    throw new Error("V0102_VERIFY_COMMIT_PROVENANCE_INVALID");
  }
  for (const [index, commit] of commits.entries()) {
    const expected = expectedCommits[index]!;
    const expectedParents = git(["show", "-s", "--format=%P", expected]).split(" ").filter(Boolean);
    const expectedPaths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", expected])
      .split(/\r?\n/u).filter(Boolean).sort(compare);
    expectedPaths.forEach(assertPortableEvidencePath);
    if (commit.ordinal !== index + 1 || commit.commit !== expected
        || commit.tree !== git(["rev-parse", `${expected}^{tree}`])
        || JSON.stringify(commit.parents) !== JSON.stringify(expectedParents)
        || commit.subject !== git(["show", "-s", "--format=%s", expected])
        || JSON.stringify(commit.changed_paths) !== JSON.stringify(expectedPaths)) {
      throw new Error(`V0102_VERIFY_COMMIT_PROVENANCE_INVALID:${String(index + 1)}`);
    }
  }
}

async function validateRuntimeProductProgressV0102(input: Readonly<{
  profile: IntegrationEvidenceProfile;
  branch: string;
  head: string;
  tree: string;
  contract_sha256: string;
  package_json_sha256: string;
  package_lock_sha256: string;
  read: (relative: string) => Promise<Buffer>;
}>): Promise<Readonly<{ progress: Record<string, unknown>; commands: readonly Record<string, unknown>[] }>> {
  const progress = jsonRuntimeProductPayload(await input.read("runtime-matrix-progress.json"),
    "V0102_VERIFY_MATRIX_INVALID");
  const commands = array(progress.commands, "V0102_VERIFY_MATRIX_COMMANDS_INVALID")
    .map((value) => record(value, "V0102_VERIFY_MATRIX_COMMAND_INVALID"));
  if (progress.schema_version !== "tivdoc-runtime-product-closure-runtime-matrix-progress-v0.10.2"
      || progress.status !== "PASS" || progress.contract_schema_version !== input.profile.contract_schema_version
      || progress.verified_branch !== input.branch || progress.verified_head !== input.head
      || progress.verified_tree !== input.tree || progress.command_count !== V0102_FIRST_NINE.length
      || JSON.stringify(progress.execution_order) !== JSON.stringify(V0102_FIRST_NINE)
      || commands.length !== V0102_FIRST_NINE.length || progress.exact_once !== true
      || progress.journal_log !== "runtime-command-journal.ndjson") {
    throw new Error("V0102_VERIFY_MATRIX_INVALID");
  }
  for (const [index, command] of commands.entries()) {
    const id = V0102_FIRST_NINE[index]!;
    const argv = array(command.argv, `V0102_VERIFY_COMMAND_PROVENANCE_INVALID:${id}`);
    const environment = array(command.environment_allowlist_names,
      `V0102_VERIFY_COMMAND_PROVENANCE_INVALID:${id}`);
    const hashes = record(command.input_hashes, `V0102_VERIFY_COMMAND_PROVENANCE_INVALID:${id}`);
    const toolchain = record(command.toolchain, `V0102_VERIFY_COMMAND_PROVENANCE_INVALID:${id}`);
    const fingerprint = sha256(Buffer.from(JSON.stringify({
      executable: command.executable,
      argv,
      cwd: command.cwd,
    }), "utf8"));
    if (command.command_id !== id || command.attempt_ordinal !== 1 || command.execution_ordinal !== index + 1
        || command.status !== "PASS" || command.execution_status !== "PASS"
        || command.proof_contract_status !== "PASS" || command.verified_head !== input.head
        || command.verified_tree !== input.tree || !nonnegativeRuntimeProductInteger(command.started_epoch_ms)
        || !nonnegativeRuntimeProductInteger(command.finished_epoch_ms)
        || (command.finished_epoch_ms as number) < (command.started_epoch_ms as number)
        || !positiveRuntimeProductInteger(command.timeout_ms) || typeof command.executable !== "string"
        || command.executable.length < 1 || typeof command.cwd !== "string" || command.cwd.length < 1
        || typeof command.command_text !== "string" || command.command_text.length < 1
        || argv.some((entry) => typeof entry !== "string") || environment.length < 1
        || environment.some((entry) => typeof entry !== "string")
        || new Set(environment).size !== environment.length
        || JSON.stringify(environment) !== JSON.stringify([...environment].sort(compare))
        || command.command_text_sha256 !== sha256(Buffer.from(command.command_text, "utf8"))
        || command.command_fingerprint_sha256 !== fingerprint
        || !runtimeProductSha256(command.environment_allowlist_sha256)
        || hashes.package_json_sha256 !== input.package_json_sha256
        || hashes.package_lock_sha256 !== input.package_lock_sha256
        || hashes.contract_sha256 !== input.contract_sha256 || toolchain.node !== process.version
        || toolchain.platform !== process.platform || toolchain.arch !== process.arch) {
      throw new Error(`V0102_VERIFY_COMMAND_PROVENANCE_INVALID:${id}`);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const relative = `final-logs/${id}.${stream}.log`;
      if (command[`working_${stream}_log`] !== relative
          || command[`${stream}_log`] !== `outer-matrix/${relative}`) {
        throw new Error(`V0102_VERIFY_COMMAND_LOG_REFERENCE_INVALID:${id}`);
      }
      const bytes = await input.read(relative);
      if (command[`${stream}_sha256`] !== sha256(bytes)
          || command[`${stream}_byte_count`] !== bytes.byteLength) {
        throw new Error(`V0102_VERIFY_COMMAND_LOG_HASH_INVALID:${id}`);
      }
    }
  }
  const runCounts = record(progress.run_counts, "V0102_VERIFY_RUN_COUNTS_INVALID");
  for (const name of V0101_RUN_COUNT_NAMES) {
    if (runCounts[name] !== 1) throw new Error(`V0102_VERIFY_RUN_COUNT_INVALID:${name}`);
  }
  const journal = await input.read("runtime-command-journal.ndjson");
  if (progress.journal_sha256 !== sha256(journal) || progress.journal_byte_count !== journal.byteLength) {
    throw new Error("V0102_VERIFY_JOURNAL_HASH_INVALID");
  }
  validateRuntimeProductJournalV0102(journal, commands);
  return Object.freeze({ progress, commands: Object.freeze(commands) });
}

async function validateRuntimeProductAssessmentBindingsV0102(
  profile: IntegrationEvidenceProfile,
  assessment: Record<string, unknown>,
  commands: readonly Record<string, unknown>[],
  progress: Record<string, unknown>,
  head: string,
  tree: string,
  read: (relative: string) => Promise<Buffer>,
): Promise<void> {
  const command = (id: string) => commands.find((entry) => entry.command_id === id)!;
  const truth = record(assessment.truth, "V0102_VERIFY_ASSESSMENT_TRUTH_INVALID");
  const assessmentCounts = record(assessment.run_counts, "V0102_VERIFY_ASSESSMENT_RUN_COUNTS_INVALID");
  const progressCounts = record(progress.run_counts, "V0102_VERIFY_MATRIX_RUN_COUNTS_INVALID");
  if (truth.TYPESCRIPT !== command("typescript").status
      || truth.PRODUCTION_BUILD !== command("production_build").status
      || truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF !== command("postgresql_full_regression").status
      || truth.REAL_BROWSER_DURABLE_PRODUCT_PATH !== command("browser_durable_product_e2e").status) {
    throw new Error("V0102_VERIFY_ASSESSMENT_COMMAND_CONTRADICTION");
  }
  for (const name of V0101_RUN_COUNT_NAMES) {
    if (assessmentCounts[name] !== 1 || progressCounts[name] !== 1 || truth[name] !== 1) {
      throw new Error(`V0102_VERIFY_ASSESSMENT_RUN_COUNT_CONTRADICTION:${name}`);
    }
  }
  const schemas = new Map<string, Readonly<{
    schema: string;
    status: "PASS" | "BLOCKED";
    branch_required: boolean;
  }>>([
    ["external-gates.json", { schema: "tivdoc-runtime-product-closure-external-gates-v0.10.2", status: "BLOCKED", branch_required: false }],
    ["regressions/browser.json", { schema: "tivdoc-runtime-product-browser-regression-v0.10.2", status: "PASS", branch_required: true }],
    ["regressions/postgresql.json", { schema: "tivdoc-runtime-product-postgresql-regression-v0.10.2", status: "PASS", branch_required: true }],
    ["product/unified-timeline.json", { schema: "tivdoc-runtime-product-unified-durable-timeline-v0.10.2", status: "PASS", branch_required: true }],
    ["security/governance-function-acl-rls.json", { schema: "tivdoc-runtime-product-governance-function-acl-rls-v0.10.2", status: "PASS", branch_required: true }],
    ["legal/observation-import.json", { schema: "tivdoc-runtime-product-observation-import-v0.10.2", status: "PASS", branch_required: true }],
    ["workflows/human-legal-ground-truth.json", { schema: "tivdoc-runtime-product-human-legal-ground-truth-workflows-v0.10.2", status: "PASS", branch_required: true }],
    ["quality/golden-mutation-property.json", { schema: "tivdoc-runtime-product-synthetic-golden-mutation-property-v0.10.2", status: "PASS", branch_required: true }],
    ["product/global-invalidation.json", { schema: "tivdoc-runtime-product-global-invalidation-v0.10.2", status: "PASS", branch_required: true }],
    ["product/entrypoint-disposition.json", { schema: "tivdoc-runtime-product-entrypoint-disposition-v0.10.2", status: "PASS", branch_required: true }],
    ["verification/capability-limits-cancellation.json", { schema: "tivdoc-runtime-product-capability-limits-cancellation-v0.10.2", status: "PASS", branch_required: true }],
    ["verification/safety-and-reachability.json", { schema: "tivdoc-runtime-product-safety-reachability-v0.10.2", status: "PASS", branch_required: true }],
  ]);
  for (const [relative, expectation] of schemas) {
    const artifact = jsonRuntimeProductPayload(await read(relative), `V0102_VERIFY_ARTIFACT_INVALID:${relative}`);
    if (artifact.schema_version !== expectation.schema || artifact.status !== expectation.status
        || artifact.verified_head !== head || artifact.verified_tree !== tree
        || (expectation.branch_required && artifact.verified_branch !== profile.branch)) {
      throw new Error(`V0102_VERIFY_ARTIFACT_STALE_OR_CONTRADICTORY:${relative}`);
    }
  }
  const evidenceResults = [
    ...array(assessment.mc_results, "V0102_VERIFY_RESULTS_INVALID"),
    ...array(assessment.ir_results, "V0102_VERIFY_RESULTS_INVALID"),
    ...array(assessment.cr_results, "V0102_VERIFY_RESULTS_INVALID"),
  ];
  const governance = record(assessment.governance_security, "V0102_VERIFY_GOVERNANCE_INVALID");
  evidenceResults.push({ evidence: governance.evidence });
  for (const value of evidenceResults) {
    const result = record(value, "V0102_VERIFY_RESULT_INVALID");
    for (const raw of array(result.evidence, "V0102_VERIFY_RESULT_EVIDENCE_INVALID")) {
      if (typeof raw !== "string" || raw.startsWith("payload/")) {
        throw new Error("V0102_VERIFY_RESULT_EVIDENCE_INVALID");
      }
      assertPortableEvidencePath(raw);
      assertEvidenceSelfReferenceAbsent([`payload/working/${raw}`]);
      await read(raw);
    }
  }
}

async function validateRuntimeProductInternalStages(
  manifest: Record<string, unknown>,
  payloadBytes: (entryPath: string) => Promise<Buffer>,
  head: string,
  tree: string,
): Promise<void> {
  const stages = array(manifest.internal_stages, "V0102_VERIFY_INTERNAL_STAGES_INVALID")
    .map((value) => record(value, "V0102_VERIFY_INTERNAL_STAGE_INVALID"));
  if (stages.length !== 2) throw new Error("V0102_VERIFY_INTERNAL_STAGES_INVALID");
  for (const [index, stage] of stages.entries()) {
    const expected = index === 0 ? "record" : "assess";
    if (stage.stage !== expected
        || stage.stdout_path !== `payload/working/internal-stages/${expected}.stdout.log`
        || stage.stderr_path !== `payload/working/internal-stages/${expected}.stderr.log`
        || !runtimeProductSha256(stage.stdout_sha256) || !runtimeProductSha256(stage.stderr_sha256)
        || !nonnegativeRuntimeProductInteger(stage.stdout_byte_count)
        || !nonnegativeRuntimeProductInteger(stage.stderr_byte_count)) {
      throw new Error(`V0102_VERIFY_INTERNAL_STAGE_INVALID:${expected}`);
    }
    const stdout = await payloadBytes(String(stage.stdout_path));
    const stderr = await payloadBytes(String(stage.stderr_path));
    if (stage.stdout_sha256 !== sha256(stdout) || stage.stdout_byte_count !== stdout.byteLength
        || stage.stderr_sha256 !== sha256(stderr) || stage.stderr_byte_count !== stderr.byteLength) {
      throw new Error(`V0102_VERIFY_INTERNAL_STAGE_HASH_INVALID:${expected}`);
    }
    const receipt = lastRuntimeProductJson(stdout.toString("utf8"));
    const identityValid = receipt?.status === "PASS" && receipt.verified_head === head && receipt.verified_tree === tree;
    const stageValid = expected === "record"
      ? receipt?.schema_version === "tivdoc-runtime-product-record-v0.10.2"
        && receipt.first_nine_commands === V0102_FIRST_NINE.length && receipt.derived_artifacts === 11
      : receipt?.headline === "V0102_LOCAL_ENGINEERING_CLOSURE_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN"
        && receipt.mc_pass === 36 && receipt.mc_blocked === 3 && receipt.ir_pass === 24
        && receipt.ir_blocked === 3 && receipt.cr_pass === 22;
    if (!identityValid || !stageValid) throw new Error(`V0102_VERIFY_INTERNAL_STAGE_RECEIPT_INVALID:${expected}`);
  }
}

function validateRuntimeProductJournalV0102(
  bytes: Buffer,
  commands: readonly Record<string, unknown>[],
): void {
  const lines = bytes.toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== commands.length * 2) throw new Error("V0102_VERIFY_JOURNAL_EVENT_COUNT_INVALID");
  const events = lines.map((line) => {
    try {
      return record(JSON.parse(line), "V0102_VERIFY_JOURNAL_INVALID");
    } catch {
      throw new Error("V0102_VERIFY_JOURNAL_INVALID");
    }
  });
  for (const [index, command] of commands.entries()) {
    const started = events[index * 2]!;
    const completed = events[index * 2 + 1]!;
    if (started.event_id !== `V0102-FINAL-${String(index * 2 + 1).padStart(4, "0")}`
        || completed.event_id !== `V0102-FINAL-${String(index * 2 + 2).padStart(4, "0")}`
        || started.event_type !== "COMMAND_STARTED" || completed.event_type !== "COMMAND_COMPLETED"
        || started.command_id !== command.command_id || completed.command_id !== command.command_id
        || started.attempt_ordinal !== 1 || completed.attempt_ordinal !== 1
        || started.execution_ordinal !== index + 1 || completed.execution_ordinal !== index + 1
        || started.verified_head !== command.verified_head || started.verified_tree !== command.verified_tree
        || started.command_text_sha256 !== command.command_text_sha256
        || started.command_fingerprint_sha256 !== command.command_fingerprint_sha256
        || completed.status !== command.status || completed.execution_status !== command.execution_status
        || completed.proof_contract_status !== command.proof_contract_status
        || completed.stdout_sha256 !== command.stdout_sha256 || completed.stderr_sha256 !== command.stderr_sha256
        || completed.finished_epoch_ms !== command.finished_epoch_ms) {
      throw new Error("V0102_VERIFY_JOURNAL_COMMAND_MISMATCH");
    }
  }
}

function runtimeProductEntries(value: unknown): V0101EvidenceEntry[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("V0102_VERIFY_PAYLOAD_ENTRIES_INVALID");
  return value.map((item) => {
    const entry = record(item, "V0102_VERIFY_PAYLOAD_ENTRY_INVALID");
    if (typeof entry.path !== "string" || !entry.path.startsWith("payload/")
        || !runtimeProductSha256(entry.sha256) || !nonnegativeRuntimeProductInteger(entry.byte_count)) {
      throw new Error("V0102_VERIFY_PAYLOAD_ENTRY_INVALID");
    }
    assertPortableEvidencePath(entry.path);
    return Object.freeze({ path: entry.path, sha256: String(entry.sha256), byte_count: entry.byte_count as number });
  });
}

function lastRuntimeProductJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Child diagnostics are not evidence receipts.
    }
  }
  return null;
}

function jsonRuntimeProductPayload(bytes: Uint8Array, code: string): Record<string, unknown> {
  try {
    return record(JSON.parse(Buffer.from(bytes).toString("utf8")), code);
  } catch {
    throw new Error(code);
  }
}

async function ordinaryRuntimeProductBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size > 128 * 1024 * 1024) {
    throw new Error("V0102_VERIFY_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0102_VERIFY_FILE_CHANGED");
  return bytes;
}

function containedRuntimeProductPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function runtimeProductSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonnegativeRuntimeProductInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveRuntimeProductInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

async function validateFinalVerificationReferences(verification: Record<string, unknown>): Promise<void> {
  const commands = array(verification.commands, "V0101_VERIFY_FINAL_COMMANDS_INVALID").map((value) => record(value,
    "V0101_VERIFY_FINAL_COMMAND_INVALID"));
  if (commands.length !== V0101_FINAL_COMMAND_IDS.length
      || JSON.stringify(verification.execution_order) !== JSON.stringify(V0101_FINAL_COMMAND_IDS)) {
    throw new Error("V0101_VERIFY_FINAL_COMMANDS_INVALID");
  }
  for (const [index, command] of commands.entries()) {
    const id = V0101_FINAL_COMMAND_IDS[index]!;
    if (command.command_id !== id || command.attempt_ordinal !== 1 || command.execution_ordinal !== index + 1) {
      throw new Error("V0101_VERIFY_FINAL_COMMAND_INVALID");
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const relative = `final-logs/${id}.${stream}.log`;
      if (command[`${stream}_log`] !== relative) throw new Error("V0101_VERIFY_LOG_REFERENCE_INVALID");
      const bytes = await payloadBytes(`payload/working/${relative}`);
      if (command[`${stream}_sha256`] !== sha256(bytes) || command[`${stream}_byte_count`] !== bytes.byteLength) {
        throw new Error("V0101_VERIFY_LOG_HASH_INVALID");
      }
    }
  }
  if (verification.journal_log !== "final-command-journal.ndjson") throw new Error("V0101_VERIFY_JOURNAL_REFERENCE_INVALID");
  const journal = await payloadBytes("payload/working/final-command-journal.ndjson");
  if (verification.journal_sha256 !== sha256(journal) || verification.journal_byte_count !== journal.byteLength) {
    throw new Error("V0101_VERIFY_JOURNAL_HASH_INVALID");
  }
  const events = journal.toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return record(JSON.parse(line), "V0101_VERIFY_JOURNAL_INVALID"); } catch { throw new Error("V0101_VERIFY_JOURNAL_INVALID"); }
  });
  if (events.length !== commands.length * 2) throw new Error("V0101_VERIFY_JOURNAL_INVALID");
  for (const [index, command] of commands.entries()) {
    const started = events[index * 2]!;
    const completed = events[index * 2 + 1]!;
    if (started.event_id !== `V0101-FINAL-${String(index * 2 + 1).padStart(4, "0")}`
        || completed.event_id !== `V0101-FINAL-${String(index * 2 + 2).padStart(4, "0")}`
        || started.event_type !== "COMMAND_STARTED" || completed.event_type !== "COMMAND_COMPLETED"
        || started.command_id !== command.command_id || completed.command_id !== command.command_id
        || started.attempt_ordinal !== 1 || completed.attempt_ordinal !== 1
        || completed.status !== command.status || completed.stdout_sha256 !== command.stdout_sha256
        || completed.stderr_sha256 !== command.stderr_sha256) {
      throw new Error("V0101_VERIFY_JOURNAL_COMMAND_MISMATCH");
    }
  }
}

function validatePostMatrixRepair(
  assessment: Record<string, unknown>,
  matrixHead: string,
  matrixTree: string,
  finalHead: string,
  finalTree: string,
): void {
  if (git(["rev-parse", `${matrixHead}^{tree}`]) !== matrixTree) {
    throw new Error("V0101_VERIFY_MATRIX_TREE_INVALID");
  }
  if (matrixHead === finalHead && matrixTree === finalTree) {
    if (assessment.post_matrix_evidence_only_repair !== null) throw new Error("V0101_VERIFY_POST_MATRIX_REPAIR_INVALID");
    return;
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", matrixHead, finalHead], {
    cwd: ROOT,
    env: GIT_READ_ONLY_ENV,
  }).status !== 0) {
    throw new Error("V0101_VERIFY_POST_MATRIX_ANCESTRY_INVALID");
  }
  const repair = record(assessment.post_matrix_evidence_only_repair, "V0101_VERIFY_POST_MATRIX_REPAIR_INVALID");
  const changedPaths = git(["diff", "--name-only", `${matrixHead}..${finalHead}`])
    .split(/\r?\n/u).filter(Boolean).sort(compare);
  if (changedPaths.length < 1
      || changedPaths.some((entry) => !(V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS as readonly string[]).includes(entry))
      || JSON.stringify(repair.changed_paths) !== JSON.stringify(changedPaths)
      || repair.from_head !== matrixHead || repair.from_tree !== matrixTree
      || repair.to_head !== finalHead || repair.to_tree !== finalTree
      || repair.scope !== "EVIDENCE_TOOLING_ONLY_NO_PRODUCT_RUNTIME_CHANGE"
      || repair.product_runtime_changed !== false || repair.matrix_reused_as_final_head_proof !== false) {
    throw new Error("V0101_VERIFY_POST_MATRIX_REPAIR_INVALID");
  }
}

async function validateWorkingArtifactSet(
  expectedBranch: string,
  finalHead: string,
  finalTree: string,
  matrixHead: string,
  matrixTree: string,
  verification: Record<string, unknown>,
): Promise<void> {
  const schemaArtifacts = [
    ["regressions/browser.json", "tivdoc-canonical-integration-durability-repair-browser-regression-v0.10.1", matrixHead, matrixTree, true],
    ["regressions/postgresql.json", "tivdoc-canonical-integration-durability-repair-postgresql-regression-v0.10.1", matrixHead, matrixTree, true],
    ["product/unified-timeline.json", "tivdoc-canonical-integration-durability-repair-product-timeline-v0.10.1", matrixHead, matrixTree, true],
    ["verification/safety-and-reachability.json", "tivdoc-canonical-integration-durability-repair-safety-reachability-v0.10.1", matrixHead, matrixTree, true],
    ["integration-repair-assessment.v0.10.1.json", "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1", finalHead, finalTree, false],
  ] as const;
  for (const [relative, schema, artifactHead, artifactTree, requiresBranch] of schemaArtifacts) {
    const value = await jsonPayload(`payload/working/${relative}`, "V0101_VERIFY_WORKING_JSON_INVALID");
    if (value.schema_version !== schema || value.verified_head !== artifactHead || value.verified_tree !== artifactTree
        || (requiresBranch && value.verified_branch !== expectedBranch)) {
      throw new Error(`V0101_VERIFY_WORKING_IDENTITY_INVALID:${relative}`);
    }
  }

  const postgresRegression = await jsonPayload("payload/working/regressions/postgresql.json",
    "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  const after = record(postgresRegression.after, "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  const copied = array(after.copied_receipts, "V0101_VERIFY_POSTGRES_COPIES_INVALID")
    .map((value) => record(value, "V0101_VERIFY_POSTGRES_COPY_INVALID"));
  const commands = array(verification.commands, "V0101_VERIFY_FINAL_COMMANDS_INVALID")
    .map((value) => record(value, "V0101_VERIFY_FINAL_COMMAND_INVALID"));
  await validateRecordedArtifactBindings(commands);
  const postgresCommand = commands.find((command) => command.command_id === "postgresql_full_regression");
  const allowedPostgres = new Map([
    ["postgresql/matrix-smoke.json", "tivdoc-real-postgresql-matrix-smoke-v0.9.1"],
    ["postgresql/marathon-v010-matrix.json", "tivdoc-marathon-v010-postgresql-matrix-v1"],
  ]);
  if (!postgresCommand || (postgresCommand.status === "PASS" && copied.length !== allowedPostgres.size)
      || (postgresCommand.status === "FAIL" && copied.length !== 0)) {
    throw new Error("V0101_VERIFY_POSTGRES_COPIES_INVALID");
  }
  const postgresFiles: string[] = [];
  for (const copy of copied) {
    const destination = String(copy.destination);
    const expectedSchema = allowedPostgres.get(destination);
    if (!expectedSchema || postgresFiles.includes(destination) || copy.status !== "PASS"
        || copy.schema_version !== expectedSchema || copy.current_head_bound_by_command !== matrixHead
        || copy.current_tree_bound_by_command !== matrixTree) {
      throw new Error("V0101_VERIFY_POSTGRES_COPY_INVALID");
    }
    const entryPath = `payload/working/${destination}`;
    const bytes = await payloadBytes(entryPath);
    const value = record(JSON.parse(bytes.toString("utf8")), "V0101_VERIFY_POSTGRES_COPY_INVALID");
    if (copy.sha256 !== sha256(bytes) || copy.byte_count !== bytes.byteLength
        || value.schema_version !== expectedSchema || value.status !== "PASS") {
      throw new Error("V0101_VERIFY_POSTGRES_COPY_INVALID");
    }
    postgresFiles.push(destination);
  }

  const expectedFiles = [...FIXED_WORKING_FILES, ...postgresFiles].sort(compare);
  const actualFiles = [...payloadMap.keys()].filter((entry) => entry.startsWith("payload/working/"))
    .map((entry) => entry.slice("payload/working/".length)).sort(compare);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("V0101_VERIFY_WORKING_ARTIFACT_SET_INVALID");
  }
}

async function validateRecordedArtifactBindings(commands: readonly Record<string, unknown>[]): Promise<void> {
  const command = (id: string) => {
    const value = commands.find((entry) => entry.command_id === id);
    if (!value) throw new Error(`V0101_VERIFY_ARTIFACT_COMMAND_MISSING:${id}`);
    return value;
  };
  const browser = command("browser_e2e_full");
  const postgres = command("postgresql_full_regression");
  const browserRegression = await jsonPayload("payload/working/regressions/browser.json",
    "V0101_VERIFY_BROWSER_REGRESSION_INVALID");
  const browserAfter = record(browserRegression.after, "V0101_VERIFY_BROWSER_REGRESSION_INVALID");
  const browserDurableProof = browser.status === "PASS" && browser.proof_contract_status === "PASS";
  if (browserAfter.status !== browser.status || browserAfter.execution_status !== browser.execution_status
      || browserAfter.proof_contract_status !== browser.proof_contract_status
      || browserAfter.durable_identity_postgres_private_storage_proven !== browserDurableProof
      || JSON.stringify(browserAfter.command_receipt) !== JSON.stringify(browser)) {
    throw new Error("V0101_VERIFY_BROWSER_COMMAND_BINDING_INVALID");
  }

  const postgresRegression = await jsonPayload("payload/working/regressions/postgresql.json",
    "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  const postgresAfter = record(postgresRegression.after, "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  if (postgresAfter.status !== postgres.status
      || JSON.stringify(postgresAfter.command_receipt) !== JSON.stringify(postgres)) {
    throw new Error("V0101_VERIFY_POSTGRES_COMMAND_BINDING_INVALID");
  }

  const timeline = await jsonPayload("payload/working/product/unified-timeline.json", "V0101_VERIFY_TIMELINE_INVALID");
  const expectedSteps = [
    { step: "durable_cookie_identity", status: "IMPLEMENTED_NOT_INSTALLED" },
    { step: "portal_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "operations_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "postgres_worker_report_private_object_restart", status: postgres.status },
    { step: "rendered_browser_download", status: browserDurableProof ? "PASS" : "NOT_PROVEN" },
  ];
  if (timeline.status !== "FAIL" || JSON.stringify(timeline.steps) !== JSON.stringify(expectedSteps)
      || timeline.exact_pdf_bytes_at_postgres_boundary !== (postgres.status === "PASS")
      || timeline.durable_browser_product_path !== browserDurableProof) {
    throw new Error("V0101_VERIFY_TIMELINE_COMMAND_BINDING_INVALID");
  }

  const safety = await jsonPayload("payload/working/verification/safety-and-reachability.json",
    "V0101_VERIFY_SAFETY_INVALID");
  for (const [field, id] of [
    ["prohibited_operation_audit", "prohibited_operation_audit"],
    ["canonical_reachability", "canonical_reachability"],
    ["persistence_wiring", "persistence_wiring"],
  ] as const) {
    if (JSON.stringify(safety[field]) !== JSON.stringify(command(id))) {
      throw new Error(`V0101_VERIFY_SAFETY_COMMAND_BINDING_INVALID:${id}`);
    }
  }
  const counters = record(safety.counters, "V0101_VERIFY_SAFETY_COUNTERS_INVALID");
  for (const name of ["deployments", "remote_migrations", "customer_data_reads", "live_provider_calls", "openai_calls",
    "real_activations", "manufactured_human_evidence"] as const) {
    if (counters[name] !== 0) throw new Error(`V0101_VERIFY_SAFETY_COUNTER_INVALID:${name}`);
  }
}

async function validateAssessmentEvidencePaths(assessment: Record<string, unknown>): Promise<void> {
  for (const value of [...array(assessment.mc_results, "V0101_VERIFY_RESULTS_INVALID"),
    ...array(assessment.ir_results, "V0101_VERIFY_RESULTS_INVALID")]) {
    const result = record(value, "V0101_VERIFY_RESULT_INVALID");
    const evidence = array(result.evidence, "V0101_VERIFY_EVIDENCE_INVALID");
    if (result.id === "MC-35" || result.id === "IR-26") {
      if (evidence.length !== 1 || evidence[0] !== "detached-verifier-output.json") {
        throw new Error("V0101_VERIFY_DETACHED_CLOSURE_REFERENCE_INVALID");
      }
      continue;
    }
    for (const raw of evidence) {
      if (typeof raw !== "string") throw new Error("V0101_VERIFY_EVIDENCE_INVALID");
      assertPortableEvidencePath(raw);
      if (!raw.startsWith("payload/") || !payloadMap.has(raw)) throw new Error(`V0101_VERIFY_EVIDENCE_MISSING:${raw}`);
      await payloadBytes(raw);
    }
  }
}

function entries(value: unknown): V0101EvidenceEntry[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("V0101_VERIFY_PAYLOAD_ENTRIES_INVALID");
  return value.map((item) => {
    const entry = record(item, "V0101_VERIFY_PAYLOAD_ENTRY_INVALID");
    if (typeof entry.path !== "string" || !entry.path.startsWith("payload/")
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || !Number.isSafeInteger(entry.byte_count) || (entry.byte_count as number) < 0) {
      throw new Error("V0101_VERIFY_PAYLOAD_ENTRY_INVALID");
    }
    assertPortableEvidencePath(entry.path);
    return Object.freeze({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count as number });
  });
}

async function payloadBytes(entryPath: string): Promise<Buffer> {
  if (!payloadMap.has(entryPath)) throw new Error(`V0101_VERIFY_REQUIRED_PAYLOAD_MISSING:${entryPath}`);
  return await ordinaryBytes(path.join(FINAL, ...entryPath.split("/")));
}

async function jsonPayload(entryPath: string, code: string): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse((await payloadBytes(entryPath)).toString("utf8")), code);
  } catch {
    throw new Error(code);
  }
}

async function ordinaryBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 128 * 1024 * 1024) {
    throw new Error("V0101_VERIFY_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0101_VERIFY_FILE_CHANGED");
  return bytes;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    env: GIT_READ_ONLY_ENV,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
