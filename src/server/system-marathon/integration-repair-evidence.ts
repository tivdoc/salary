import { createHash } from "node:crypto";
import path from "node:path";

export const V0101_HEADLINES = Object.freeze([
  "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
  "V0101_ENGINEERING_INTEGRATION_PARTIAL",
  "BLOCKED_SAFETY_OR_REPOSITORY_STATE",
] as const);

export const V0101_RESULT_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED"] as const);
export type V0101ResultStatus = (typeof V0101_RESULT_STATUSES)[number];

export const RUNTIME_PRODUCT_CLOSURE_HEADLINES = Object.freeze([
  "V0102_LOCAL_ENGINEERING_CLOSURE_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
  "V0102_LOCAL_ENGINEERING_CLOSURE_PARTIAL",
  "BLOCKED_SAFETY_OR_REPOSITORY_STATE",
] as const);
export const RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS = Object.freeze([
  "focused_v0102_acceptance",
  "full_suite",
  "eslint",
  "typescript",
  "production_build",
  "postgresql_full_regression",
  "browser_durable_product_e2e",
  "security_limits_negative_matrix",
  "reachability_wiring_capability_audit",
  "evidence_build",
  "detached_verifier",
  "repeat_archive_hash_verifier",
] as const);
export const RUNTIME_PRODUCT_CLOSURE_SELF_REFERENCE_BASENAMES = Object.freeze([
  "manifest.json",
  "tivdoc-runtime-product-closure-v0.10.2-evidence.zip",
  "tivdoc-runtime-product-closure-v0.10.2-evidence.zip.sha256",
  "detached-verifier-output.json",
  "final-verification.json",
  "final-command-journal.ndjson",
] as const);

export type IntegrationEvidenceProfile = Readonly<{
  contract_schema_version: string;
  branch: string;
  base_head: string;
  base_tree: string;
  final_output_root: string;
  mc_ids: readonly string[];
  ir_ids: readonly string[];
  cr_ids: readonly string[];
  closure_map: Readonly<Record<string, readonly string[]>>;
  final_command_ids: readonly string[];
  external_blocked_pairs: Readonly<Record<string, string>>;
  truth_baseline: Readonly<Record<string, unknown>>;
}>;

export type V0101EvidenceEntry = Readonly<{
  path: string;
  sha256: string;
  byte_count: number;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUNTIME_PRODUCT_CLOSURE_CONTRACT_SCHEMA = "tivdoc-runtime-product-closure-contract-v0.10.2";
const RUNTIME_PRODUCT_CLOSURE_ASSESSMENT_SCHEMA =
  "tivdoc-canonical-integration-durability-repair-assessment-v0.10.2";
const RUNTIME_PRODUCT_CLOSURE_FINAL_VERIFICATION_SCHEMA =
  "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.2";
const RUNTIME_PRODUCT_CLOSURE_OUTPUT = "output/runtime-product-closure-v0.10.2/final";
const RUNTIME_PRODUCT_EXTERNAL_BLOCKED_PAIRS = Object.freeze({
  "MC-03": "IR-22",
  "MC-10": "IR-23",
  "MC-27": "IR-24",
} as const);
const RUNTIME_PRODUCT_TRUTH_BASELINE = Object.freeze({
  REAL_LEGAL_TOPICS_READY: "0/7",
  REAL_SOURCES_ACTIVE: 0,
  REAL_PARAMETERS_ACTIVE: 0,
  REAL_RULES_ACTIVE: 0,
  REAL_CALCULATIONS_OR_FINDINGS: 0,
  HUMAN_GROUND_TRUTH_LOCKED: 0,
  GENERATED_HUMAN_DECISIONS: 0,
  GENERATED_HUMAN_SIGNATURES: 0,
  MANUFACTURED_HUMAN_EVIDENCE: 0,
  REAL_ACTIVATIONS: 0,
  REAL_CUSTOMER_DATA_READS: 0,
  CUSTOMER_PROCESSING_ENABLED: "NO",
  CUSTOMER_SHADOW_AUTHORIZED: "NO",
  PRODUCTION_DELIVERY_ENABLED: "NO",
  DEPLOYMENTS: 0,
  REMOTE_MIGRATIONS: 0,
  LIVE_PROVIDER_CALLS: 0,
  OPENAI_CALLS: 0,
  PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
} as const);
const REQUIRED_ZERO_COUNTERS = Object.freeze([
  "REAL_SOURCES_ACTIVE",
  "REAL_PARAMETERS_ACTIVE",
  "REAL_RULES_ACTIVE",
  "REAL_CALCULATIONS_OR_FINDINGS",
  "HUMAN_GROUND_TRUTH_LOCKED",
  "REAL_CUSTOMER_DATA_READS",
  "DEPLOYMENTS",
  "REMOTE_MIGRATIONS",
  "LIVE_PROVIDER_CALLS",
  "OPENAI_CALLS",
  "PRODUCT_REACHABLE_MEMORY_FALLBACKS",
] as const);
const REQUIRED_NO_COUNTERS = Object.freeze([
  "CUSTOMER_PROCESSING_ENABLED",
  "CUSTOMER_SHADOW_AUTHORIZED",
  "PRODUCTION_DELIVERY_ENABLED",
] as const);
const REQUIRED_PROOF_STATUSES = Object.freeze([
  "REAL_POSTGRESQL_CURRENT_HEAD_PROOF",
  "REAL_BROWSER_DURABLE_PRODUCT_PATH",
] as const);
const REQUIRED_NONNEGATIVE_COUNTERS = Object.freeze([
  "PROCESS_LOCAL_PRODUCT_REPOSITORIES",
  "PARTIAL_OR_UNWIRED_STABLE_ENTRYPOINTS",
  "KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE",
] as const);
export const V0101_RUN_COUNT_NAMES = Object.freeze([
  "FULL_SUITE_RUN_COUNT",
  "PRODUCTION_BUILD_RUN_COUNT",
  "BROWSER_E2E_FULL_RUN_COUNT",
  "POSTGRESQL_FULL_REGRESSION_RUN_COUNT",
] as const);
export const V0101_FINAL_COMMAND_IDS = Object.freeze([
  "focused_acceptance",
  "full_suite",
  "eslint",
  "typescript",
  "production_build",
  "postgresql_full_regression",
  "browser_e2e_full",
  "prohibited_operation_audit",
  "canonical_reachability",
  "persistence_wiring",
] as const);
export const V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS = Object.freeze([
  "scripts/canonical-integration-repair-v0101/assess.mts",
  "scripts/canonical-integration-repair-v0101/build.mts",
  "scripts/canonical-integration-repair-v0101/verify.mts",
  "src/server/system-marathon/integration-repair-evidence.test.ts",
  "src/server/system-marathon/integration-repair-evidence.ts",
] as const);
export const V0101_COMMAND_FAILURE_IMPACTS: Readonly<Record<
  (typeof V0101_FINAL_COMMAND_IDS)[number], readonly string[]
>> = Object.freeze({
  focused_acceptance: Object.freeze([
    "MC-01", "MC-04", "MC-08", "MC-13", "MC-15", "MC-32", "MC-33", "MC-34", "MC-35",
    "IR-01", "IR-04", "IR-09", "IR-12", "IR-18", "IR-19", "IR-25", "IR-26", "IR-27",
  ]),
  full_suite: Object.freeze(["MC-34", "IR-25"]),
  eslint: Object.freeze(["MC-34", "IR-25"]),
  typescript: Object.freeze(["MC-34", "IR-25"]),
  production_build: Object.freeze(["MC-34", "IR-25"]),
  browser_e2e_full: Object.freeze([
    "MC-06", "MC-07", "MC-08", "MC-29", "MC-34",
    "IR-02", "IR-05", "IR-06", "IR-07", "IR-17", "IR-21", "IR-25",
  ]),
  postgresql_full_regression: Object.freeze([
    "MC-08", "MC-11", "MC-34", "IR-03", "IR-08", "IR-20", "IR-25",
  ]),
  prohibited_operation_audit: Object.freeze(["MC-30", "MC-34", "IR-21", "IR-25", "IR-27"]),
  canonical_reachability: Object.freeze(["MC-02", "MC-29", "MC-34", "IR-17", "IR-25"]),
  persistence_wiring: Object.freeze(["MC-09", "MC-29", "MC-34", "IR-17", "IR-19", "IR-25"]),
});

export function assertPortableEvidencePath(value: string): void {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || path.posix.normalize(value) !== value || !/^[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error("V0101_EVIDENCE_PATH_UNSAFE");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
      || segment.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new Error("V0101_EVIDENCE_PATH_UNSAFE");
  }
}

export function canonicalPayloadSetHash(entries: readonly V0101EvidenceEntry[]): string {
  const unique = new Set<string>();
  const portable = new Set<string>();
  const sorted = [...entries].sort((left, right) => compare(left.path, right.path));
  for (const entry of sorted) {
    assertPortableEvidencePath(entry.path);
    const folded = entry.path.toLowerCase();
    if (unique.has(entry.path) || portable.has(folded)) throw new Error("V0101_EVIDENCE_PATH_DUPLICATE");
    if (!SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.byte_count) || entry.byte_count < 0) {
      throw new Error("V0101_EVIDENCE_ENTRY_INVALID");
    }
    unique.add(entry.path);
    portable.add(folded);
  }
  const payload = sorted.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join("");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function parseIntegrationEvidenceProfile(value: unknown): IntegrationEvidenceProfile {
  const contract = record(value, "INTEGRATION_EVIDENCE_CONTRACT_MALFORMED");
  if (contract.schema_version !== RUNTIME_PRODUCT_CLOSURE_CONTRACT_SCHEMA || contract.frozen !== true) {
    throw new Error("INTEGRATION_EVIDENCE_CONTRACT_IDENTITY_INVALID");
  }
  const base = record(contract.base, "INTEGRATION_EVIDENCE_CONTRACT_BASE_INVALID");
  if (base.branch !== "codex/tivdoc-engine-foundation" || !GIT_OBJECT_ID.test(String(base.head))
      || !GIT_OBJECT_ID.test(String(base.tree)) || base.ancestry_required !== true || base.clean_required !== true) {
    throw new Error("INTEGRATION_EVIDENCE_CONTRACT_BASE_INVALID");
  }
  if (contract.final_output_root !== RUNTIME_PRODUCT_CLOSURE_OUTPUT) {
    throw new Error("INTEGRATION_EVIDENCE_OUTPUT_ROOT_INVALID");
  }
  assertPortableEvidencePath(String(contract.final_output_root));

  const mcIds = exactRequirementIds(contract.acceptance_requirements, "MC", 39);
  const irIds = exactRequirementIds(contract.integration_requirements, "IR", 27);
  const crIds = exactIds("CR", 22);
  const validDependencies = new Set([...mcIds, ...irIds, "GOVERNANCE_FUNCTION_ACL_RLS_SECURITY"]);
  const rawClosure = record(contract.closure_map, "INTEGRATION_EVIDENCE_CLOSURE_MAP_INVALID");
  if (JSON.stringify(Object.keys(rawClosure)) !== JSON.stringify(crIds)) {
    throw new Error("INTEGRATION_EVIDENCE_CLOSURE_MAP_INVALID");
  }
  const closureMap: Record<string, readonly string[]> = {};
  for (const id of crIds) {
    const dependencies = array(rawClosure[id], "INTEGRATION_EVIDENCE_CLOSURE_MAP_INVALID");
    if (dependencies.length < 1 || dependencies.some((entry) => typeof entry !== "string"
        || !validDependencies.has(entry)) || new Set(dependencies).size !== dependencies.length) {
      throw new Error(`INTEGRATION_EVIDENCE_CLOSURE_MAP_INVALID:${id}`);
    }
    if ((id === "CR-22") !== (dependencies.length === 1
        && dependencies[0] === "GOVERNANCE_FUNCTION_ACL_RLS_SECURITY")) {
      throw new Error(`INTEGRATION_EVIDENCE_CLOSURE_MAP_INVALID:${id}`);
    }
    closureMap[id] = Object.freeze(dependencies.map(String));
  }

  const finalCommandIds = array(contract.final_command_ids, "INTEGRATION_EVIDENCE_COMMAND_SET_INVALID");
  if (JSON.stringify(finalCommandIds) !== JSON.stringify(RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS)) {
    throw new Error("INTEGRATION_EVIDENCE_COMMAND_SET_INVALID");
  }
  const externalBlockedPairs = record(contract.external_blocked_pairs,
    "INTEGRATION_EVIDENCE_EXTERNAL_BLOCKERS_INVALID");
  if (JSON.stringify(externalBlockedPairs) !== JSON.stringify(RUNTIME_PRODUCT_EXTERNAL_BLOCKED_PAIRS)) {
    throw new Error("INTEGRATION_EVIDENCE_EXTERNAL_BLOCKERS_INVALID");
  }
  const truthBaseline = record(contract.truth_baseline, "INTEGRATION_EVIDENCE_TRUTH_BASELINE_INVALID");
  if (JSON.stringify(truthBaseline) !== JSON.stringify(RUNTIME_PRODUCT_TRUTH_BASELINE)) {
    throw new Error("INTEGRATION_EVIDENCE_TRUTH_BASELINE_INVALID");
  }

  return Object.freeze({
    contract_schema_version: RUNTIME_PRODUCT_CLOSURE_CONTRACT_SCHEMA,
    branch: String(base.branch),
    base_head: String(base.head),
    base_tree: String(base.tree),
    final_output_root: RUNTIME_PRODUCT_CLOSURE_OUTPUT,
    mc_ids: Object.freeze(mcIds),
    ir_ids: Object.freeze(irIds),
    cr_ids: Object.freeze(crIds),
    closure_map: Object.freeze(closureMap),
    final_command_ids: Object.freeze(finalCommandIds.map(String)),
    external_blocked_pairs: Object.freeze({ ...RUNTIME_PRODUCT_EXTERNAL_BLOCKED_PAIRS }),
    truth_baseline: Object.freeze({ ...truthBaseline }),
  });
}

export function assertEvidenceSelfReferenceAbsent(
  paths: readonly string[],
  excludedBasenames: readonly string[] = RUNTIME_PRODUCT_CLOSURE_SELF_REFERENCE_BASENAMES,
): void {
  const excluded = new Set(excludedBasenames.map((entry) => entry.toLowerCase()));
  const seen = new Set<string>();
  for (const entry of paths) {
    assertPortableEvidencePath(entry);
    const folded = entry.toLowerCase();
    if (seen.has(folded)) throw new Error("INTEGRATION_EVIDENCE_PATH_DUPLICATE");
    seen.add(folded);
    if (excluded.has(path.posix.basename(entry).toLowerCase()) || folded.startsWith("outer-matrix/")) {
      throw new Error(`INTEGRATION_EVIDENCE_SELF_REFERENCE:${entry}`);
    }
  }
}

export function validateRuntimeProductClosureAssessment(
  profile: IntegrationEvidenceProfile,
  value: unknown,
): void {
  runtimeAssessment(profile, value);
}

export function validateRuntimeProductClosureAssessmentAgainstReceipts(
  profile: IntegrationEvidenceProfile,
  assessmentValue: unknown,
  finalVerificationValue: unknown,
): void {
  const parsed = runtimeAssessment(profile, assessmentValue);
  const assessment = parsed.assessment;
  const verification = record(finalVerificationValue, "INTEGRATION_EVIDENCE_FINAL_VERIFICATION_MALFORMED");
  if (verification.schema_version !== RUNTIME_PRODUCT_CLOSURE_FINAL_VERIFICATION_SCHEMA
      || verification.contract_schema_version !== profile.contract_schema_version
      || verification.verified_branch !== profile.branch
      || verification.verified_head !== assessment.verified_head
      || verification.verified_tree !== assessment.verified_tree
      || verification.exact_once !== true
      || verification.working_preflight !== "FRESH_DIRECTORY_CREATED_BEFORE_FIRST_COMMAND"
      || verification.journal_log !== "outer-matrix/final-command-journal.ndjson"
      || !SHA256.test(String(verification.journal_sha256))
      || !positiveInteger(verification.journal_byte_count)) {
    throw new Error("INTEGRATION_EVIDENCE_FINAL_VERIFICATION_IDENTITY_INVALID");
  }
  if (JSON.stringify(verification.execution_order) !== JSON.stringify(profile.final_command_ids)) {
    throw new Error("INTEGRATION_EVIDENCE_COMMAND_SET_INVALID");
  }
  const rawCommands = array(verification.commands, "INTEGRATION_EVIDENCE_COMMAND_SET_INVALID");
  if (rawCommands.length !== profile.final_command_ids.length || verification.command_count !== rawCommands.length) {
    throw new Error("INTEGRATION_EVIDENCE_COMMAND_SET_INVALID");
  }
  const commands = rawCommands.map((entry, index) => validateFinalCommandReceipt(
    entry,
    profile.final_command_ids[index]!,
    index + 1,
    String(assessment.verified_head),
    String(assessment.verified_tree),
  ));
  const allPass = commands.every((command) => command.status === "PASS");
  if (verification.status !== (allPass ? "PASS" : "FAIL")) {
    throw new Error("INTEGRATION_EVIDENCE_FINAL_STATUS_CONTRADICTION");
  }

  const resultMap = new Map([...parsed.mc, ...parsed.ir, ...parsed.cr].map((entry) => [entry.id, entry]));
  const command = (id: string) => commands.find((entry) => entry.command_id === id)!;
  const assertNonPass = (commandId: string, ids: readonly string[]) => {
    if (command(commandId).status === "PASS") return;
    for (const id of ids) {
      if (resultMap.get(id)?.status === "PASS") {
        throw new Error(`INTEGRATION_EVIDENCE_COMMAND_FAILURE_FALSE_PASS:${commandId}:${id}`);
      }
    }
  };
  for (const commandId of ["focused_v0102_acceptance", "full_suite", "eslint", "typescript", "production_build"] as const) {
    assertNonPass(commandId, ["MC-34", "IR-25", "CR-01"]);
  }
  assertNonPass("postgresql_full_regression", ["MC-08", "MC-11", "MC-34", "IR-03", "IR-08", "IR-20", "IR-25", "CR-03"]);
  assertNonPass("browser_durable_product_e2e", ["MC-04", "MC-05", "MC-06", "MC-07", "MC-08", "MC-34",
    "IR-02", "IR-04", "IR-05", "IR-06", "IR-07", "IR-08", "IR-21", "IR-25", "CR-02", "CR-04", "CR-05", "CR-06"]);
  assertNonPass("security_limits_negative_matrix", ["MC-34", "MC-39", "IR-18", "IR-21", "IR-25", "CR-17", "CR-18"]);
  assertNonPass("reachability_wiring_capability_audit", ["MC-02", "MC-09", "MC-29", "MC-34", "MC-39",
    "IR-17", "IR-18", "IR-19", "IR-25", "CR-16", "CR-17", "CR-19"]);
  for (const commandId of ["evidence_build", "detached_verifier", "repeat_archive_hash_verifier"] as const) {
    assertNonPass(commandId, ["MC-35", "IR-26", "CR-21"]);
  }

  const truth = parsed.truth;
  const proofStatus = (id: string) => command(id).status;
  if (truth.TYPESCRIPT !== proofStatus("typescript")
      || truth.PRODUCTION_BUILD !== proofStatus("production_build")
      || truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF !== proofStatus("postgresql_full_regression")
      || truth.REAL_BROWSER_DURABLE_PRODUCT_PATH !== proofStatus("browser_durable_product_e2e")) {
    throw new Error("INTEGRATION_EVIDENCE_RUNTIME_TRUTH_CONTRADICTION");
  }
  const assessmentRunCounts = record(assessment.run_counts, "INTEGRATION_EVIDENCE_RUN_COUNTS_INVALID");
  const verificationRunCounts = record(verification.run_counts, "INTEGRATION_EVIDENCE_RUN_COUNTS_INVALID");
  for (const name of V0101_RUN_COUNT_NAMES) {
    const count = verificationRunCounts[name];
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 2
        || assessmentRunCounts[name] !== count || truth[name] !== count) {
      throw new Error(`INTEGRATION_EVIDENCE_RUN_COUNT_CONTRADICTION:${name}`);
    }
  }
}

export function parseOrderedIntegrationLedger(raw: string): readonly Readonly<Record<string, unknown>>[] {
  const lines = raw.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length < 1) throw new Error("V0101_LEDGER_EMPTY");
  const entries = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("V0101_LEDGER_MALFORMED");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_LEDGER_MALFORMED");
    const record = value as Record<string, unknown>;
    const expected = `IRL-${String(index + 1).padStart(4, "0")}`;
    if (record.event_id !== expected) throw new Error("V0101_LEDGER_ORDER_INVALID");
    if (typeof record.kind !== "string" || record.kind.length < 3
        || typeof record.status !== "string" || record.status.length < 3) {
      throw new Error("V0101_LEDGER_MALFORMED");
    }
    if (record.kind === "integration_commit"
        && (!GIT_OBJECT_ID.test(String(record.commit_sha)) || !GIT_OBJECT_ID.test(String(record.tree_sha))
          || !GIT_OBJECT_ID.test(String(record.parent_sha)) || typeof record.subject !== "string")) {
      throw new Error("V0101_LEDGER_COMMIT_INVALID");
    }
    return Object.freeze(record);
  });
  return Object.freeze(entries);
}

export function validateV0101Assessment(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_ASSESSMENT_MALFORMED");
  const assessment = value as Record<string, unknown>;
  if (assessment.schema_version !== "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1") {
    throw new Error("V0101_ASSESSMENT_SCHEMA_INVALID");
  }
  if (!(V0101_HEADLINES as readonly unknown[]).includes(assessment.headline)) throw new Error("V0101_ASSESSMENT_HEADLINE_INVALID");
  if (!GIT_OBJECT_ID.test(String(assessment.verified_head)) || !GIT_OBJECT_ID.test(String(assessment.verified_tree))
      || !GIT_OBJECT_ID.test(String(assessment.matrix_head)) || !GIT_OBJECT_ID.test(String(assessment.matrix_tree))) {
    throw new Error("V0101_ASSESSMENT_GIT_INVALID");
  }
  if (assessment.matrix_head === assessment.verified_head && assessment.matrix_tree === assessment.verified_tree) {
    if (assessment.post_matrix_evidence_only_repair !== null) throw new Error("V0101_POST_MATRIX_REPAIR_INVALID");
  } else {
    const repair = record(assessment.post_matrix_evidence_only_repair, "V0101_POST_MATRIX_REPAIR_INVALID");
    const changedPaths = Array.isArray(repair.changed_paths) ? repair.changed_paths : [];
    if (repair.from_head !== assessment.matrix_head || repair.from_tree !== assessment.matrix_tree
        || repair.to_head !== assessment.verified_head || repair.to_tree !== assessment.verified_tree
        || repair.scope !== "EVIDENCE_TOOLING_ONLY_NO_PRODUCT_RUNTIME_CHANGE"
        || repair.product_runtime_changed !== false || repair.matrix_reused_as_final_head_proof !== false
        || changedPaths.length < 1 || changedPaths.some((entry) => typeof entry !== "string")
        || new Set(changedPaths).size !== changedPaths.length
        || JSON.stringify(changedPaths) !== JSON.stringify([...changedPaths].sort(compare))
        || changedPaths.some((entry) => !(V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS as readonly unknown[]).includes(entry))) {
      throw new Error("V0101_POST_MATRIX_REPAIR_INVALID");
    }
  }
  const mc = exactResults(assessment.mc_results, "MC", 39);
  const ir = exactResults(assessment.ir_results, "IR", 27);
  const permittedBlocked = new Set(["MC-03", "MC-10", "MC-27", "IR-22", "IR-23", "IR-24"]);
  for (const item of [...mc, ...ir]) {
    if (item.status === "BLOCKED" && !permittedBlocked.has(item.id)) {
      throw new Error(`V0101_BLOCKED_ID_INVALID:${item.id}`);
    }
  }
  const truth = record(assessment.truth, "V0101_ASSESSMENT_TRUTH_INVALID");
  for (const name of REQUIRED_ZERO_COUNTERS) {
    if (truth[name] !== 0) throw new Error(`V0101_TRUTH_COUNTER_NOT_ZERO:${name}`);
  }
  for (const name of REQUIRED_NO_COUNTERS) {
    if (truth[name] !== "NO") throw new Error(`V0101_TRUTH_COUNTER_NOT_NO:${name}`);
  }
  if (truth.REAL_LEGAL_TOPICS_READY !== "0/7") throw new Error("V0101_REAL_LEGAL_TOPICS_INVALID");
  for (const name of REQUIRED_PROOF_STATUSES) {
    if (!(V0101_RESULT_STATUSES as readonly unknown[]).includes(truth[name])) {
      throw new Error(`V0101_TRUTH_PROOF_STATUS_INVALID:${name}`);
    }
  }
  for (const name of REQUIRED_NONNEGATIVE_COUNTERS) {
    if (!Number.isSafeInteger(truth[name]) || (truth[name] as number) < 0) {
      throw new Error(`V0101_TRUTH_COUNTER_INVALID:${name}`);
    }
  }
  const corePass = mc.filter((item) => !["MC-03", "MC-10", "MC-27"].includes(item.id) && item.status === "PASS").length;
  const coreFail = mc.filter((item) => !["MC-03", "MC-10", "MC-27"].includes(item.id) && item.status === "FAIL").length;
  if (corePass + coreFail !== 36) throw new Error("V0101_CORE_STATUS_SET_INVALID");
  if (truth.CORE_LOCAL_MC_PASS !== `${corePass}/36` || truth.CORE_LOCAL_MC_FAIL !== coreFail) {
    throw new Error("V0101_CORE_COUNTER_CONTRADICTION");
  }
  const runCounts = record(assessment.run_counts, "V0101_RUN_COUNTS_INVALID");
  for (const name of V0101_RUN_COUNT_NAMES) {
    if (runCounts[name] !== 1) throw new Error(`V0101_RUN_COUNT_INVALID:${name}`);
    if (truth[name] !== runCounts[name]) throw new Error(`V0101_RUN_COUNT_CONTRADICTION:${name}`);
  }
  const blockers = Array.isArray(assessment.blockers) ? assessment.blockers : [];
  const nonPass = [...mc, ...ir].filter((item) => item.status !== "PASS");
  if (blockers.length !== nonPass.length) throw new Error("V0101_BLOCKER_SET_INCOMPLETE");
  const seenBlockers = new Set<string>();
  for (const item of blockers) {
    const blocker = record(item, "V0101_BLOCKER_INVALID");
    const id = String(blocker.id);
    const result = [...mc, ...ir].find((candidate) => candidate.id === id);
    if (!result || result.status === "PASS" || seenBlockers.has(id)) throw new Error("V0101_BLOCKER_FALSE_PASS");
    if (blocker.status !== result.status || blocker.reason !== result.reason) {
      throw new Error("V0101_BLOCKER_REASON_INVALID");
    }
    seenBlockers.add(id);
  }
  if (assessment.headline === "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN"
      && (corePass !== 36 || coreFail !== 0
        || ir.some((item) => !["IR-22", "IR-23", "IR-24"].includes(item.id) && item.status !== "PASS"))) {
    throw new Error("V0101_COMPLETE_HEADLINE_CONTRADICTION");
  }
}

export function validateV0101AssessmentAgainstReceipts(
  assessmentValue: unknown,
  finalVerificationValue: unknown,
  externalGatesValue: unknown,
): void {
  validateV0101Assessment(assessmentValue);
  const assessment = record(assessmentValue, "V0101_ASSESSMENT_MALFORMED");
  const verification = record(finalVerificationValue, "V0101_FINAL_VERIFICATION_MALFORMED");
  if (verification.schema_version !== "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1"
      || verification.verified_branch !== "codex/tivdoc-engine-foundation"
      || verification.verified_head !== assessment.matrix_head
      || verification.verified_tree !== assessment.matrix_tree
      || verification.exact_once !== true
      || verification.working_preflight !== "FRESH_DIRECTORY_CREATED_BEFORE_FIRST_COMMAND"
      || verification.journal_log !== "final-command-journal.ndjson"
      || !SHA256.test(String(verification.journal_sha256))
      || !Number.isSafeInteger(verification.journal_byte_count)
      || (verification.journal_byte_count as number) < 1
      || JSON.stringify(verification.execution_order) !== JSON.stringify(V0101_FINAL_COMMAND_IDS)) {
    throw new Error("V0101_FINAL_VERIFICATION_IDENTITY_INVALID");
  }
  if (!Array.isArray(verification.commands) || verification.commands.length !== V0101_FINAL_COMMAND_IDS.length
      || verification.command_count !== V0101_FINAL_COMMAND_IDS.length) {
    throw new Error("V0101_FINAL_COMMAND_SET_INVALID");
  }
  const commands = verification.commands.map((value, index) => {
    const command = record(value, "V0101_FINAL_COMMAND_INVALID");
    if (command.command_id !== V0101_FINAL_COMMAND_IDS[index]
        || (command.status !== "PASS" && command.status !== "FAIL")
        || (command.execution_status !== "PASS" && command.execution_status !== "FAIL")
        || command.proof_contract_status !== command.status
        || (command.status === "PASS" && command.execution_status !== "PASS")
        || command.attempt_ordinal !== 1 || command.execution_ordinal !== index + 1
        || command.verified_head !== assessment.matrix_head
        || command.verified_tree !== assessment.matrix_tree
        || !Number.isSafeInteger(command.started_epoch_ms) || !Number.isSafeInteger(command.finished_epoch_ms)
        || (command.finished_epoch_ms as number) < (command.started_epoch_ms as number)
        || !SHA256.test(String(command.stdout_sha256)) || !SHA256.test(String(command.stderr_sha256))
        || !Number.isSafeInteger(command.stdout_byte_count) || (command.stdout_byte_count as number) < 0
        || !Number.isSafeInteger(command.stderr_byte_count) || (command.stderr_byte_count as number) < 0
        || command.stdout_log !== `final-logs/${String(command.command_id)}.stdout.log`
        || command.stderr_log !== `final-logs/${String(command.command_id)}.stderr.log`) {
      throw new Error("V0101_FINAL_COMMAND_INVALID");
    }
    return command;
  });
  const allCommandsPass = commands.every((command) => command.status === "PASS");
  if (verification.status !== (allCommandsPass ? "PASS" : "FAIL")) {
    throw new Error("V0101_FINAL_STATUS_CONTRADICTION");
  }
  const assessmentRunCounts = record(assessment.run_counts, "V0101_RUN_COUNTS_INVALID");
  const verificationRunCounts = record(verification.run_counts, "V0101_FINAL_RUN_COUNTS_INVALID");
  for (const name of V0101_RUN_COUNT_NAMES) {
    if (verificationRunCounts[name] !== 1 || assessmentRunCounts[name] !== verificationRunCounts[name]) {
      throw new Error(`V0101_FINAL_RUN_COUNT_CONTRADICTION:${name}`);
    }
  }
  const results = new Map<string, Readonly<Record<string, unknown>>>();
  for (const item of [...array(assessment.mc_results, "V0101_MC_RESULTS_INVALID"),
    ...array(assessment.ir_results, "V0101_IR_RESULTS_INVALID")]) {
    const result = record(item, "V0101_RESULT_INVALID");
    results.set(String(result.id), result);
  }
  for (const command of commands) {
    if (command.status !== "FAIL") continue;
    for (const id of V0101_COMMAND_FAILURE_IMPACTS[
      command.command_id as (typeof V0101_FINAL_COMMAND_IDS)[number]
    ]) {
      if (results.get(id)?.status === "PASS") throw new Error(`V0101_COMMAND_FAILURE_FALSE_PASS:${command.command_id}:${id}`);
    }
  }
  const command = (id: (typeof V0101_FINAL_COMMAND_IDS)[number]) => commands.find((item) => item.command_id === id)!;
  const truth = record(assessment.truth, "V0101_ASSESSMENT_TRUTH_INVALID");
  const finalMatrixStatus = verification.status === "PASS"
    && assessment.post_matrix_evidence_only_repair === null ? "PASS" : "FAIL";
  const exactFinalHeadProof = (id: (typeof V0101_FINAL_COMMAND_IDS)[number]) => command(id).status === "PASS"
    && assessment.post_matrix_evidence_only_repair === null ? "PASS" : "FAIL";
  if (truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF !== exactFinalHeadProof("postgresql_full_regression")
      || truth.REAL_BROWSER_DURABLE_PRODUCT_PATH !== exactFinalHeadProof("browser_e2e_full")
      || results.get("IR-25")?.status !== finalMatrixStatus) {
    throw new Error("V0101_RUNTIME_TRUTH_CONTRADICTION");
  }
  for (const commandId of ["postgresql_full_regression", "browser_e2e_full"] as const) {
    if (exactFinalHeadProof(commandId) === "PASS") continue;
    for (const id of V0101_COMMAND_FAILURE_IMPACTS[commandId]) {
      if (results.get(id)?.status === "PASS") {
        throw new Error(`V0101_EXACT_FINAL_HEAD_PROOF_FALSE_PASS:${commandId}:${id}`);
      }
    }
  }

  validateExternalGates(assessment, externalGatesValue, results);
}

function exactResults(value: unknown, prefix: "MC" | "IR", count: number): readonly Readonly<{
  id: string;
  status: V0101ResultStatus;
  reason?: string;
}>[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error(`V0101_${prefix}_RESULT_COUNT_INVALID`);
  return Object.freeze(value.map((item, index) => {
    const result = record(item, `V0101_${prefix}_RESULT_INVALID`);
    const expected = `${prefix}-${String(index + 1).padStart(2, "0")}`;
    if (result.id !== expected || !(V0101_RESULT_STATUSES as readonly unknown[]).includes(result.status)) {
      throw new Error(`V0101_${prefix}_RESULT_INVALID`);
    }
    if (!Array.isArray(result.evidence) || result.evidence.length < 1
        || result.evidence.some((entry) => typeof entry !== "string" || entry.length < 1)) {
      throw new Error(`V0101_${prefix}_EVIDENCE_INVALID`);
    }
    for (const entry of result.evidence as string[]) assertPortableEvidencePath(entry);
    if (result.status !== "PASS" && (typeof result.reason !== "string" || result.reason.length < 3)) {
      throw new Error(`V0101_${prefix}_NONPASS_REASON_INVALID`);
    }
    return Object.freeze({ id: expected, status: result.status as V0101ResultStatus,
      ...(typeof result.reason === "string" ? { reason: result.reason } : {}) });
  }));
}

function validateExternalGates(
  assessment: Record<string, unknown>,
  externalGatesValue: unknown,
  results: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): void {
  const external = record(externalGatesValue, "V0101_EXTERNAL_GATES_MALFORMED");
  if (external.schema_version !== "tivdoc-canonical-integration-durability-repair-external-gates-v0.10.1"
      || external.bounded_checks_performed_once !== true || external.bounded_check_run_count !== 1
      || external.final_head_reexecution_forbidden_by_task !== true
      || external.deployments !== 0 || external.remote_migrations !== 0
      || external.live_provider_calls !== 0 || external.openai_calls !== 0) {
    throw new Error("V0101_EXTERNAL_GATES_INVALID");
  }
  const expected = Object.freeze([
    Object.freeze({ mc: "MC-03", ir: "IR-22", tools: Object.freeze(["supabase", "docker", "podman"]),
      reasons: Object.freeze(["SUPABASE_CLI_NOT_FOUND", "SUPABASE_CONTAINER_ENGINE_NOT_FOUND"]),
      found: Object.freeze([false, false, false]), statuses: Object.freeze(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]) }),
    Object.freeze({ mc: "MC-10", ir: "IR-23", tools: Object.freeze(["node", "WindowsSandbox.exe", "docker.exe", "podman.exe"]),
      reasons: Object.freeze(["PARSER_OS_SANDBOX_NOT_VERIFIED", "NODE_PERMISSION_MODEL_HAS_NO_KERNEL_NETWORK_OR_RESOURCE_BOUNDARY"]),
      found: Object.freeze([true, false, false, false]),
      statuses: Object.freeze(["PRESENT_INSUFFICIENT_ISOLATION", "NOT_FOUND", "NOT_DETECTED", "NOT_DETECTED"]) }),
    Object.freeze({ mc: "MC-27", ir: "IR-24", tools: Object.freeze(["configured_off_host_destination"]),
      reasons: Object.freeze(["OFF_HOST_AUDIT_CUSTODY_PENDING", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED"]),
      found: Object.freeze([false]), statuses: Object.freeze(["NOT_CONFIGURED"]) }),
  ]);
  const gates = array(external.gates, "V0101_EXTERNAL_GATES_INVALID");
  if (gates.length !== expected.length) throw new Error("V0101_EXTERNAL_GATES_INVALID");
  gates.forEach((value, index) => {
    const gate = record(value, "V0101_EXTERNAL_GATE_INVALID");
    const pin = expected[index]!;
    const reasonCodes = array(gate.reason_codes, "V0101_EXTERNAL_GATE_REASON_INVALID");
    if (gate.id !== pin.mc || gate.status !== "BLOCKED" || gate.external_mutations !== 0
        || JSON.stringify(reasonCodes) !== JSON.stringify(pin.reasons)) {
      throw new Error("V0101_EXTERNAL_GATE_INVALID");
    }
    const execution = record(gate.detector_execution, "V0101_EXTERNAL_GATE_EXECUTION_INVALID");
    if (execution.run_count !== 1 || (execution.process_exit_code !== null
        && !Number.isSafeInteger(execution.process_exit_code))) {
      throw new Error("V0101_EXTERNAL_GATE_EXECUTION_INVALID");
    }
    if (execution.process_exit_code === null
        && typeof execution.exit_code_state !== "string") {
      throw new Error("V0101_EXTERNAL_GATE_EXECUTION_INVALID");
    }
    const checkedTools = array(gate.checked_tools, "V0101_EXTERNAL_GATE_TOOLS_INVALID");
    if (JSON.stringify(checkedTools.map((value) => record(value, "V0101_EXTERNAL_GATE_TOOL_INVALID").tool))
        !== JSON.stringify(pin.tools)
        || JSON.stringify(checkedTools.map((value) => record(value, "V0101_EXTERNAL_GATE_TOOL_INVALID").found))
          !== JSON.stringify(pin.found)
        || JSON.stringify(checkedTools.map((value) => record(value, "V0101_EXTERNAL_GATE_TOOL_INVALID").probe_status))
          !== JSON.stringify(pin.statuses)) {
      throw new Error("V0101_EXTERNAL_GATE_TOOLS_INVALID");
    }
    for (const value of checkedTools) {
      const tool = record(value, "V0101_EXTERNAL_GATE_TOOL_INVALID");
      if (typeof tool.tool !== "string" || typeof tool.probe_status !== "string"
          || typeof tool.exact_reason !== "string" || tool.exact_reason.length < 3
          || (tool.version !== null && typeof tool.version !== "string")
          || (tool.exit_code !== null && !Number.isSafeInteger(tool.exit_code))) {
        throw new Error("V0101_EXTERNAL_GATE_TOOL_INVALID");
      }
      if (tool.exit_code === null && typeof tool.exit_code_state !== "string") {
        throw new Error("V0101_EXTERNAL_GATE_TOOL_INVALID");
      }
    }
    const observed = record(gate.observed, "V0101_EXTERNAL_GATE_OBSERVED_INVALID");
    if ((pin.mc === "MC-03" && (observed.supabase_cli !== false || observed.container_engine !== null
        || observed.cached_images_complete !== false || observed.platform_proof_performed !== false))
        || (pin.mc === "MC-10" && (observed.node_version !== "22.22.2"
          || observed.kernel_network_or_resource_boundary !== false || observed.persistent_owner_import_enabled !== false))
        || (pin.mc === "MC-27" && (observed.managed_destination_available !== false
          || observed.off_host_transfer_performed !== false))) {
      throw new Error("V0101_EXTERNAL_GATE_OBSERVED_INVALID");
    }
    for (const id of [pin.mc, pin.ir]) {
      const result = results.get(id);
      if (result?.status !== "BLOCKED" || typeof result.reason !== "string"
          || reasonCodes.some((reason) => !String(result.reason).includes(String(reason)))) {
        throw new Error(`V0101_EXTERNAL_GATE_FALSE_PASS:${id}`);
      }
    }
  });
  const truth = record(assessment.truth, "V0101_ASSESSMENT_TRUTH_INVALID");
  if (truth.DEPLOYMENTS !== external.deployments || truth.REMOTE_MIGRATIONS !== external.remote_migrations
      || truth.LIVE_PROVIDER_CALLS !== external.live_provider_calls || truth.OPENAI_CALLS !== external.openai_calls) {
    throw new Error("V0101_EXTERNAL_TRUTH_CONTRADICTION");
  }
}

type RuntimeClosureResult = Readonly<{
  id: string;
  status: V0101ResultStatus;
  evidence: readonly string[];
  reason?: string;
}>;

type ParsedRuntimeAssessment = Readonly<{
  assessment: Record<string, unknown>;
  mc: readonly RuntimeClosureResult[];
  ir: readonly RuntimeClosureResult[];
  cr: readonly RuntimeClosureResult[];
  truth: Record<string, unknown>;
}>;

function runtimeAssessment(profile: IntegrationEvidenceProfile, value: unknown): ParsedRuntimeAssessment {
  const assessment = record(value, "INTEGRATION_EVIDENCE_ASSESSMENT_MALFORMED");
  if (assessment.schema_version !== RUNTIME_PRODUCT_CLOSURE_ASSESSMENT_SCHEMA
      || assessment.contract_schema_version !== profile.contract_schema_version
      || !(RUNTIME_PRODUCT_CLOSURE_HEADLINES as readonly unknown[]).includes(assessment.headline)
      || !GIT_OBJECT_ID.test(String(assessment.verified_head))
      || !GIT_OBJECT_ID.test(String(assessment.verified_tree))
      || assessment.matrix_head !== assessment.verified_head
      || assessment.matrix_tree !== assessment.verified_tree
      || assessment.post_matrix_evidence_only_repair !== null) {
    throw new Error("INTEGRATION_EVIDENCE_ASSESSMENT_IDENTITY_INVALID");
  }
  const mc = exactRuntimeResults(assessment.mc_results, "MC", profile.mc_ids);
  const ir = exactRuntimeResults(assessment.ir_results, "IR", profile.ir_ids);
  const cr = exactRuntimeResults(assessment.cr_results, "CR", profile.cr_ids);
  const permittedBlocked = new Set([
    ...Object.keys(profile.external_blocked_pairs),
    ...Object.values(profile.external_blocked_pairs),
  ]);
  for (const item of [...mc, ...ir]) {
    if (permittedBlocked.has(item.id)) {
      if (item.status !== "BLOCKED") throw new Error(`INTEGRATION_EVIDENCE_EXTERNAL_GATE_FALSE_PASS:${item.id}`);
    } else if (item.status === "BLOCKED") {
      throw new Error(`INTEGRATION_EVIDENCE_BLOCKED_ID_INVALID:${item.id}`);
    }
  }

  const truth = record(assessment.truth, "INTEGRATION_EVIDENCE_TRUTH_INVALID");
  for (const [name, expected] of Object.entries(profile.truth_baseline)) {
    if (truth[name] !== expected) throw new Error(`INTEGRATION_EVIDENCE_TRUTH_BASELINE_CONTRADICTION:${name}`);
  }
  const coreMc = mc.filter((item) => !permittedBlocked.has(item.id));
  const localIr = ir.filter((item) => !permittedBlocked.has(item.id));
  const corePass = coreMc.filter((item) => item.status === "PASS").length;
  const coreFail = coreMc.filter((item) => item.status === "FAIL").length;
  const localIrPass = localIr.filter((item) => item.status === "PASS").length;
  const localIrFail = localIr.filter((item) => item.status === "FAIL").length;
  if (coreMc.length !== 36 || corePass + coreFail !== 36 || localIr.length !== 24
      || localIrPass + localIrFail !== 24) {
    throw new Error("INTEGRATION_EVIDENCE_LOCAL_DENOMINATOR_INVALID");
  }
  if (truth.CORE_LOCAL_MC_PASS !== `${corePass}/36` || truth.CORE_LOCAL_MC_FAIL !== coreFail
      || truth.LOCALLY_SOLVABLE_IR_PASS !== `${localIrPass}/24`
      || truth.LOCALLY_SOLVABLE_IR_FAIL !== localIrFail) {
    throw new Error("INTEGRATION_EVIDENCE_LOCAL_COUNTER_CONTRADICTION");
  }
  for (const name of ["TYPESCRIPT", "PRODUCTION_BUILD", "REAL_POSTGRESQL_CURRENT_HEAD_PROOF",
    "REAL_BROWSER_DURABLE_PRODUCT_PATH"] as const) {
    if (truth[name] !== "PASS" && truth[name] !== "FAIL") {
      throw new Error(`INTEGRATION_EVIDENCE_TRUTH_STATUS_INVALID:${name}`);
    }
  }
  if (truth.CANONICAL_SESSION_STARTUP_INSTALLED !== "YES" && truth.CANONICAL_SESSION_STARTUP_INSTALLED !== "NO") {
    throw new Error("INTEGRATION_EVIDENCE_SESSION_TRUTH_INVALID");
  }
  for (const name of ["PROCESS_LOCAL_PRODUCT_REPOSITORIES", "PARTIAL_OR_UNWIRED_PRODUCT_STABLE_ENTRYPOINTS",
    "UNSAFE_OR_UNEXPLAINED_FUNCTIONS"] as const) {
    if (!nonnegativeIntegerValue(truth[name])) throw new Error(`INTEGRATION_EVIDENCE_TRUTH_COUNTER_INVALID:${name}`);
  }
  if (!boundedFraction(truth.DURABLE_GOVERNANCE_REPLACEMENTS_WIRED, 4)
      || !boundedFraction(truth.KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE, 71)
      || truth.GOVERNANCE_SECURITY_DEFINER_FUNCTIONS !== 32
      || truth.GOVERNANCE_EXPOSED_FUNCTIONS !== 21
      || truth.CROSS_TENANT_RPC_SUCCESSES !== 0 || truth.POOL_CONTEXT_LEAKS !== 0
      || truth.ISOLATED_SUPABASE_PLATFORM_PROOF !== "BLOCKED"
      || truth.PARSER_OS_SANDBOX_PROOF !== "BLOCKED"
      || truth.OFF_HOST_AUDIT_CUSTODY !== "BLOCKED"
      || truth.MANAGED_IDENTITY_PROVIDER_VERIFIED !== "NO"
      || truth.MANAGED_PRIVATE_STORAGE_VERIFIED !== "NO") {
    throw new Error("INTEGRATION_EVIDENCE_TRUTH_COUNTER_INVALID");
  }

  const governance = record(assessment.governance_security, "INTEGRATION_EVIDENCE_GOVERNANCE_SECURITY_INVALID");
  const governanceEvidence = array(governance.evidence, "INTEGRATION_EVIDENCE_GOVERNANCE_SECURITY_INVALID");
  if (governanceEvidence.length < 1 || governanceEvidence.some((entry) => typeof entry !== "string")) {
    throw new Error("INTEGRATION_EVIDENCE_GOVERNANCE_SECURITY_INVALID");
  }
  for (const entry of governanceEvidence as string[]) assertPortableEvidencePath(entry);
  const governanceSafe = governance.security_definer_functions === 32 && governance.exposed_functions === 21
    && governance.unsafe_or_unexplained_functions === 0 && governance.cross_tenant_rpc_successes === 0
    && governance.pool_context_leaks === 0;
  const governanceStatus: V0101ResultStatus = governanceSafe ? "PASS" : "FAIL";
  if (governance.status !== governanceStatus
      || truth.GOVERNANCE_SECURITY_DEFINER_FUNCTIONS !== governance.security_definer_functions
      || truth.GOVERNANCE_EXPOSED_FUNCTIONS !== governance.exposed_functions
      || truth.UNSAFE_OR_UNEXPLAINED_FUNCTIONS !== governance.unsafe_or_unexplained_functions
      || truth.CROSS_TENANT_RPC_SUCCESSES !== governance.cross_tenant_rpc_successes
      || truth.POOL_CONTEXT_LEAKS !== governance.pool_context_leaks) {
    throw new Error("INTEGRATION_EVIDENCE_GOVERNANCE_SECURITY_CONTRADICTION");
  }

  const resultMap = new Map([...mc, ...ir].map((item) => [item.id, item]));
  for (const closure of cr) {
    const dependencies = profile.closure_map[closure.id]!;
    const expectedStatus = dependencies[0] === "GOVERNANCE_FUNCTION_ACL_RLS_SECURITY"
      ? governanceStatus
      : combinedStatus(dependencies.map((id) => resultMap.get(id)?.status));
    if (closure.status !== expectedStatus) {
      throw new Error(`INTEGRATION_EVIDENCE_CLOSURE_CONTRADICTION:${closure.id}`);
    }
  }

  const allResults = [...mc, ...ir, ...cr];
  const nonPass = allResults.filter((item) => item.status !== "PASS");
  const blockers = array(assessment.blockers, "INTEGRATION_EVIDENCE_BLOCKER_SET_INVALID");
  if (blockers.length !== nonPass.length) throw new Error("INTEGRATION_EVIDENCE_BLOCKER_SET_INVALID");
  const seenBlockers = new Set<string>();
  for (const raw of blockers) {
    const blocker = record(raw, "INTEGRATION_EVIDENCE_BLOCKER_INVALID");
    const result = nonPass.find((entry) => entry.id === blocker.id);
    if (!result || seenBlockers.has(result.id) || blocker.status !== result.status || blocker.reason !== result.reason) {
      throw new Error("INTEGRATION_EVIDENCE_BLOCKER_CONTRADICTION");
    }
    seenBlockers.add(result.id);
  }
  const complete = corePass === 36 && coreFail === 0 && localIrPass === 24 && localIrFail === 0
    && cr.every((item) => item.status === "PASS");
  if (complete && (truth.TYPESCRIPT !== "PASS" || truth.PRODUCTION_BUILD !== "PASS"
      || truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF !== "PASS"
      || truth.REAL_BROWSER_DURABLE_PRODUCT_PATH !== "PASS"
      || truth.CANONICAL_SESSION_STARTUP_INSTALLED !== "YES"
      || truth.PROCESS_LOCAL_PRODUCT_REPOSITORIES !== 0
      || truth.DURABLE_GOVERNANCE_REPLACEMENTS_WIRED !== "4/4"
      || truth.PARTIAL_OR_UNWIRED_PRODUCT_STABLE_ENTRYPOINTS !== 0
      || truth.KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE !== "71/71"
      || truth.UNSAFE_OR_UNEXPLAINED_FUNCTIONS !== 0)) {
    throw new Error("INTEGRATION_EVIDENCE_COMPLETE_TRUTH_CONTRADICTION");
  }
  const expectedHeadline = complete
    ? "V0102_LOCAL_ENGINEERING_CLOSURE_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN"
    : "V0102_LOCAL_ENGINEERING_CLOSURE_PARTIAL";
  if (assessment.headline !== expectedHeadline) {
    if (assessment.headline !== "BLOCKED_SAFETY_OR_REPOSITORY_STATE"
        || typeof assessment.safety_blocker !== "string" || assessment.safety_blocker.length < 3) {
      throw new Error("INTEGRATION_EVIDENCE_HEADLINE_CONTRADICTION");
    }
  }

  return Object.freeze({ assessment, mc, ir, cr, truth });
}

function validateFinalCommandReceipt(
  value: unknown,
  expectedId: string,
  expectedOrdinal: number,
  expectedHead: string,
  expectedTree: string,
): Record<string, unknown> {
  const command = record(value, "INTEGRATION_EVIDENCE_COMMAND_INVALID");
  if (!Array.isArray(command.argv) || !Array.isArray(command.environment_allowlist_names)
      || !command.input_hashes || typeof command.input_hashes !== "object" || Array.isArray(command.input_hashes)
      || !command.toolchain || typeof command.toolchain !== "object" || Array.isArray(command.toolchain)) {
    throw new Error(`INTEGRATION_EVIDENCE_COMMAND_PROVENANCE_INVALID:${expectedId}`);
  }
  const argv = command.argv;
  const environmentNames = command.environment_allowlist_names;
  const inputHashes = record(command.input_hashes, `INTEGRATION_EVIDENCE_COMMAND_PROVENANCE_INVALID:${expectedId}`);
  const toolchain = record(command.toolchain, `INTEGRATION_EVIDENCE_COMMAND_PROVENANCE_INVALID:${expectedId}`);
  if (command.command_id !== expectedId || command.attempt_ordinal !== 1
      || command.execution_ordinal !== expectedOrdinal || command.verified_head !== expectedHead
      || command.verified_tree !== expectedTree || (command.status !== "PASS" && command.status !== "FAIL")
      || (command.execution_status !== "PASS" && command.execution_status !== "FAIL")
      || command.proof_contract_status !== command.status
      || (command.status === "PASS" && command.execution_status !== "PASS")
      || !nonnegativeIntegerValue(command.started_epoch_ms) || !nonnegativeIntegerValue(command.finished_epoch_ms)
      || (command.finished_epoch_ms as number) < (command.started_epoch_ms as number)
      || !positiveInteger(command.timeout_ms) || typeof command.executable !== "string" || command.executable.length < 1
      || typeof command.cwd !== "string" || command.cwd.length < 1 || typeof command.command_text !== "string"
      || command.command_text.length < 1 || argv.some((entry) => typeof entry !== "string")
      || environmentNames.length < 1 || environmentNames.some((entry) => typeof entry !== "string")
      || new Set(environmentNames).size !== environmentNames.length
      || JSON.stringify(environmentNames) !== JSON.stringify([...environmentNames].sort(compare))
      || !SHA256.test(String(command.environment_allowlist_sha256))
      || !SHA256.test(String(command.command_text_sha256))
      || command.command_text_sha256 !== sha256Utf8(String(command.command_text))
      || !SHA256.test(String(command.command_fingerprint_sha256))
      || command.command_fingerprint_sha256 !== sha256Utf8(JSON.stringify({
        executable: command.executable, argv, cwd: command.cwd,
      }))
      || !SHA256.test(String(inputHashes.package_json_sha256))
      || !SHA256.test(String(inputHashes.package_lock_sha256))
      || !SHA256.test(String(inputHashes.contract_sha256))
      || typeof toolchain.node !== "string" || typeof toolchain.platform !== "string" || typeof toolchain.arch !== "string"
      || !SHA256.test(String(command.stdout_sha256)) || !SHA256.test(String(command.stderr_sha256))
      || !nonnegativeIntegerValue(command.stdout_byte_count) || !nonnegativeIntegerValue(command.stderr_byte_count)
      || command.stdout_log !== `outer-matrix/final-logs/${expectedId}.stdout.log`
      || command.stderr_log !== `outer-matrix/final-logs/${expectedId}.stderr.log`) {
    throw new Error(`INTEGRATION_EVIDENCE_COMMAND_PROVENANCE_INVALID:${expectedId}`);
  }
  return command;
}

function exactRuntimeResults(
  value: unknown,
  prefix: "MC" | "IR" | "CR",
  expectedIds: readonly string[],
): readonly RuntimeClosureResult[] {
  const values = array(value, `INTEGRATION_EVIDENCE_${prefix}_RESULTS_INVALID`);
  if (values.length !== expectedIds.length) throw new Error(`INTEGRATION_EVIDENCE_${prefix}_RESULT_COUNT_INVALID`);
  return Object.freeze(values.map((raw, index) => {
    const result = record(raw, `INTEGRATION_EVIDENCE_${prefix}_RESULT_INVALID`);
    const evidence = array(result.evidence, `INTEGRATION_EVIDENCE_${prefix}_EVIDENCE_INVALID`);
    if (result.id !== expectedIds[index] || !(V0101_RESULT_STATUSES as readonly unknown[]).includes(result.status)
        || evidence.length < 1 || evidence.some((entry) => typeof entry !== "string")) {
      throw new Error(`INTEGRATION_EVIDENCE_${prefix}_RESULT_INVALID`);
    }
    const portable = new Set<string>();
    for (const entry of evidence as string[]) {
      assertPortableEvidencePath(entry);
      const folded = entry.toLowerCase();
      if (portable.has(folded)) throw new Error(`INTEGRATION_EVIDENCE_${prefix}_EVIDENCE_DUPLICATE`);
      portable.add(folded);
    }
    if (result.status !== "PASS" && (typeof result.reason !== "string" || result.reason.length < 3)) {
      throw new Error(`INTEGRATION_EVIDENCE_${prefix}_NONPASS_REASON_INVALID`);
    }
    return Object.freeze({
      id: String(result.id),
      status: result.status as V0101ResultStatus,
      evidence: Object.freeze((evidence as string[]).map(String)),
      ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    });
  }));
}

function exactRequirementIds(value: unknown, prefix: "MC" | "IR", count: number): string[] {
  const requirements = record(value, "INTEGRATION_EVIDENCE_REQUIREMENTS_INVALID");
  const ids = exactIds(prefix, count);
  if (JSON.stringify(Object.keys(requirements)) !== JSON.stringify(ids)
      || ids.some((id) => typeof requirements[id] !== "string" || String(requirements[id]).length < 30)) {
    throw new Error(`INTEGRATION_EVIDENCE_${prefix}_REQUIREMENTS_INVALID`);
  }
  return ids;
}

function exactIds(prefix: "MC" | "IR" | "CR", count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}

function combinedStatus(statuses: readonly (V0101ResultStatus | undefined)[]): V0101ResultStatus {
  if (statuses.length < 1 || statuses.some((status) => status === undefined)) {
    throw new Error("INTEGRATION_EVIDENCE_CLOSURE_DEPENDENCY_MISSING");
  }
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  return "PASS";
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeIntegerValue(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedFraction(value: unknown, denominator: number): boolean {
  const match = /^(\d+)\/(\d+)$/u.exec(String(value));
  if (!match || Number(match[2]) !== denominator) return false;
  const numerator = Number(match[1]);
  return Number.isSafeInteger(numerator) && numerator >= 0 && numerator <= denominator;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
