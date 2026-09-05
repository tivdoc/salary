import "../production-refusal.mjs";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseIntegrationEvidenceProfile,
  validateRuntimeProductClosureAssessment,
  validateV0101AssessmentAgainstReceipts,
  V0101_COMMAND_FAILURE_IMPACTS,
  V0101_FINAL_COMMAND_IDS,
  V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS,
  type IntegrationEvidenceProfile,
  type V0101ResultStatus,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";

const runtimeProductContractPath = contractArgumentV0102(process.argv.slice(2));
if (runtimeProductContractPath !== null) {
  await assessRuntimeProductClosure(runtimeProductContractPath);
} else {

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const BRANCH = "codex/tivdoc-engine-foundation";
const WORKING = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "working");
const FINAL_VERIFICATION = path.join(WORKING, "final-verification.json");
const OUTPUT = path.join(WORKING, "integration-repair-assessment.v0.10.1.json");
const EXTERNAL_GATES = path.join(ROOT, "src", "server", "system-marathon", "external-gates.v0.10.1.json");
const METRICS = path.join(ROOT, "src", "server", "system-marathon", "integration-repair-metrics.v0.10.1.json");
const BROWSER_REGRESSION = path.join(WORKING, "regressions", "browser.json");

const verification = record(JSON.parse(await readFile(FINAL_VERIFICATION, "utf8")));
const externalGates = record(JSON.parse(await readFile(EXTERNAL_GATES, "utf8")));
const metrics = record(JSON.parse(await readFile(METRICS, "utf8")));
const browserRegression = record(JSON.parse(await readFile(BROWSER_REGRESSION, "utf8")));
const head = git("HEAD");
const tree = git("HEAD^{tree}");
if (gitOutput(["branch", "--show-current"]) !== BRANCH) throw new Error("V0101_ASSESS_BRANCH_INVALID");
if (spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT, windowsHide: true }).status !== 0) {
  throw new Error("V0101_ASSESS_BASE_NOT_ANCESTOR");
}
if (gitOutput(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("V0101_ASSESS_WORKTREE_NOT_CLEAN");
}
const matrixHead = String(verification.verified_head);
const matrixTree = String(verification.verified_tree);
if (git(`${matrixHead}^{tree}`) !== matrixTree) throw new Error("V0101_ASSESS_MATRIX_TREE_INVALID");
if (browserRegression.verified_head !== matrixHead || browserRegression.verified_tree !== matrixTree) {
  throw new Error("V0101_ASSESS_BROWSER_REGRESSION_STALE");
}
const postMatrixRepair = matrixHead === head && matrixTree === tree ? null : postMatrixEvidenceRepair(matrixHead, matrixTree, head, tree);
const persistenceMetrics = record(metrics.persistence_capabilities);
const entrypointMetrics = record(metrics.canonical_entrypoints);
const processLocalMetrics = record(metrics.process_local_product_repositories);
const legalObservationMetrics = record(metrics.legal_observations);
if (metrics.schema_version !== "tivdoc-canonical-integration-durability-repair-metrics-v0.10.1"
    || persistenceMetrics.product_reachable_memory_fallbacks !== 0
    || processLocalMetrics.durable_governance_replacement_wired_to_stable_product !== false
    || legalObservationMetrics.known_staged_observations_reported !== 71
    || legalObservationMetrics.activation_allowed !== false) {
  throw new Error("V0101_ASSESS_METRICS_INVALID");
}
const processLocalRepositoryCount = nonnegativeInteger(processLocalMetrics.count, "V0101_ASSESS_METRICS_INVALID");
const partialOrUnwiredEntrypoints = nonnegativeInteger(entrypointMetrics.partial_or_unwired, "V0101_ASSESS_METRICS_INVALID");
const queuedObservations = nonnegativeInteger(
  legalObservationMetrics.known_staged_observations_in_durable_queue,
  "V0101_ASSESS_METRICS_INVALID",
);
const commands = Array.isArray(verification.commands) ? verification.commands.map(record) : [];
const commandStatus = (id: string): V0101ResultStatus => commands.find((item) => item.command_id === id)?.status === "PASS" ? "PASS" : "FAIL";
const matrixPostgresCommand = commandStatus("postgresql_full_regression");
const matrixBrowserCommand = commandStatus("browser_e2e_full");
const postgres = matrixPostgresCommand === "PASS" && postMatrixRepair === null ? "PASS" : "FAIL";
const browserCommand = matrixBrowserCommand === "PASS" && postMatrixRepair === null ? "PASS" : "FAIL";
const finalMatrix = verification.status === "PASS" && postMatrixRepair === null ? "PASS" : "FAIL";
const runCounts = record(verification.run_counts);
const commandFailureReason = (id: string): string | undefined => {
  const failed = V0101_FINAL_COMMAND_IDS.filter((commandId) => commandStatus(commandId) === "FAIL"
    && V0101_COMMAND_FAILURE_IMPACTS[commandId].includes(id));
  return failed.length > 0 ? `FINAL_COMMAND_FAILED: ${failed.join(", ")}.` : undefined;
};

const mcFailures: Readonly<Record<string, string>> = Object.freeze({
  "MC-04": "IMPLEMENTED_NOT_WIRED: the durable cryptographic session reader and shared route boundary exist, but no non-test startup root installs the durable verifier for every stable product entrypoint.",
  "MC-06": "IMPLEMENTED_NOT_WIRED: /portal remains without a canonical real-PostgreSQL/private-storage application installation; the browser harness is synthetic and recording-only.",
  "MC-07": "IMPLEMENTED_NOT_WIRED: /operations is not proven on the same durable owner, session and case revision as the portal.",
  "MC-08": "PARTIAL: PRODUCT_REPORT_CANONICAL_BINDING_MISMATCH was repaired, but no unified durable UI-to-worker-to-storage-to-download product timeline exists.",
  "MC-13": "IMPLEMENTED_NOT_WIRED: durable reviewer-trust repository and forward schema exist, while stable operations composition, restart and race proof remain absent.",
  "MC-14": "PROCESS_LOCAL_ONLY: the seven-topic human review service is not wired to the durable governance repository or stable 11-tab workspace.",
  "MC-15": "IMPLEMENTED_NOT_WIRED: separate durable parameter and RuleSpec repository boundaries exist, but stable services and real signed restart/race proof remain absent.",
  "MC-17": "IMPLEMENTED_NOT_WIRED / HUMAN_GROUND_TRUTH_REQUIRED: durable repository boundaries are not the active product workflow and no genuine human lock exists.",
  "MC-19": "PARTIAL: 0 of the reported 71 staged observations were imported into the durable canonical reconciliation queue.",
  "MC-20": "IMPLEMENTED_NOT_WIRED: RuleSpec lifecycle and approvals remain outside the stable durable product composition.",
  "MC-21": "PARTIAL: the required complete synthetic golden, mutation and property matrix plus human-reviewed cases is not complete.",
  "MC-22": "PARTIAL: dependency invalidation is not proven across every run, report, approval and access grant.",
  "MC-29": "IMPLEMENTED_NOT_WIRED: 46 canonical inventory entries remain PARTIAL or IMPLEMENTED_NOT_WIRED.",
  "MC-37": "PARTIAL: immutable twelve-month multi-document currentness, conflict and adaptive clarification are not integrated into the durable product path.",
  "MC-38": "IMPLEMENTED_NOT_WIRED: the 11-tab operations workspace is not bound to the durable Legal, Parameters, Rules, Golden and Ground Truth queues.",
  "MC-39": "PARTIAL: capability projection, startup prerequisites, limits, cancellation and partial-state enforcement do not cover every stable entrypoint.",
});
const mcBlocked: Readonly<Record<string, string>> = Object.freeze({
  "MC-03": "SUPABASE_CLI_NOT_FOUND and SUPABASE_CONTAINER_ENGINE_NOT_FOUND",
  "MC-10": "PARSER_OS_SANDBOX_NOT_VERIFIED: NODE_PERMISSION_MODEL_HAS_NO_KERNEL_NETWORK_OR_RESOURCE_BOUNDARY",
  "MC-27": "OFF_HOST_AUDIT_CUSTODY_PENDING and DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
});
const mcRequirements = [
  "Git/base/contract integrity", "canonical reachability", "isolated Supabase", "durable identity", "private storage",
  "portal product path", "operations product path", "worker/report/download timeline", "canonical persistence", "parser OS sandbox",
  "controlled import", "parser attack matrix", "reviewer trust", "seven-topic review", "parameter and RuleSpec approvals",
  "legal catalog safety", "Ground Truth workflow", "evidence handoff", "legal reconciliation queue", "RuleSpec lifecycle",
  "golden/mutation/property tooling", "global invalidation", "durable scheduler", "disagreement queue", "safe observability",
  "object custody", "off-host custody", "privacy reconciliation", "canonical entrypoints", "prohibited-operation safety",
  "action ownership", "fail-closed runtime flags", "ordered execution ledger", "final verification", "deterministic evidence",
  "human/external action index", "multi-document clarification", "11-tab workspace", "capabilities and partial-state safety",
];

const mcResults = Array.from({ length: 39 }, (_, index) => {
  const id = `MC-${String(index + 1).padStart(2, "0")}`;
  if (mcBlocked[id]) return result(id, "BLOCKED", mcRequirements[index]!, mcBlocked[id], ["payload/repository/src/server/system-marathon/external-gates.v0.10.1.json"]);
  if (id === "MC-11" && postgres !== "PASS") return result(id, "FAIL", mcRequirements[index]!,
    postMatrixRepair === null
      ? "REAL_POSTGRESQL_CURRENT_HEAD_PROOF did not pass; current-head controlled-import migration behavior is unproven."
      : "CURRENT_HEAD_PROOF_ABSENT: the PostgreSQL regression passed on the pre-repair matrix commit, but exact final-head controlled-import migration proof was not rerun after the disclosed evidence-tooling repair.");
  if (id === "MC-08" && postgres !== "PASS") return result(id, "FAIL", mcRequirements[index]!,
    postMatrixRepair === null
      ? "REGRESSION_FAILED: the current-head PostgreSQL regression failed, so canonical report binding is not dynamically proven; the unified durable UI-to-worker-to-storage-to-download product timeline is also absent."
      : "CURRENT_HEAD_PROOF_ABSENT: PostgreSQL passed on the pre-repair matrix commit, but exact final-head proof was not rerun after the disclosed evidence-tooling repair; the unified durable UI-to-worker-to-storage-to-download product timeline is also absent.",
    ["payload/working/regressions/postgresql.json", "payload/working/product/unified-timeline.json"]);
  if (id === "MC-34" && finalMatrix !== "PASS") return result(id, "FAIL", mcRequirements[index]!,
    finalMatrixFailureReason(commands, postMatrixRepair), ["payload/working/final-verification.json"]);
  if (mcFailures[id]) return result(id, "FAIL", mcRequirements[index]!, mcFailures[id], mcEvidence(id));
  const commandFailure = commandFailureReason(id);
  if (commandFailure) return result(id, "FAIL", mcRequirements[index]!, commandFailure);
  return result(id, "PASS", mcRequirements[index]!);
});

const browserReason = browserFailureReason(browserRegression, commands);
const irRequirements = [
  "exact base/ancestry/contract/clean tree", "browser instrumentation repair", "current-head PostgreSQL report binding",
  "durable identity on stable entrypoints", "portal PostgreSQL/private storage", "shared operations revision", "unified restart timeline",
  "exact stored/downloaded/exported PDF bytes", "durable reviewer trust and workspace", "durable Ground Truth", "durable legal reconciliation",
  "separate parameter and RuleSpec workflows", "non-operative RuleSpec lifecycle", "golden/mutation/property runner", "global invalidation",
  "multi-document clarification", "canonical stable entrypoints", "capability projection everywhere", "zero product memory fallback",
  "restart/transaction/idempotency/concurrency", "security and negative matrix", "isolated Supabase", "parser OS sandbox",
  "off-host custody", "one final quality matrix", "deterministic evidence and verifier", "honest legal/customer/human truth",
];
const irFailureReasons: Readonly<Record<string, string>> = Object.freeze({
  "IR-04": mcFailures["MC-04"]!,
  "IR-05": mcFailures["MC-06"]!,
  "IR-06": mcFailures["MC-07"]!,
  "IR-07": "No real UI-to-HTTP-to-worker-to-private-storage-to-download timeline with restart was produced.",
  "IR-09": mcFailures["MC-13"]!,
  "IR-10": mcFailures["MC-17"]!,
  "IR-11": mcFailures["MC-19"]!,
  "IR-12": mcFailures["MC-15"]!,
  "IR-13": mcFailures["MC-20"]!,
  "IR-14": mcFailures["MC-21"]!,
  "IR-15": mcFailures["MC-22"]!,
  "IR-16": mcFailures["MC-37"]!,
  "IR-17": mcFailures["MC-29"]!,
  "IR-18": mcFailures["MC-39"]!,
  "IR-21": "The complete rendered auth/tenant/CSRF/stale/idempotency/invalidation/limits/cancellation negative matrix did not pass on a durable browser-product path.",
});
const irBlocked: Readonly<Record<string, string>> = Object.freeze({
  "IR-22": mcBlocked["MC-03"]!, "IR-23": mcBlocked["MC-10"]!, "IR-24": mcBlocked["MC-27"]!,
});
const irResults = Array.from({ length: 27 }, (_, index) => {
  const id = `IR-${String(index + 1).padStart(2, "0")}`;
  if (irBlocked[id]) return result(id, "BLOCKED", irRequirements[index]!, irBlocked[id], ["payload/repository/src/server/system-marathon/external-gates.v0.10.1.json"]);
  if (id === "IR-02" && browserCommand !== "PASS") return result(id, "FAIL", irRequirements[index]!, browserReason,
    ["payload/working/regressions/browser.json"]);
  if (["IR-03", "IR-08", "IR-20"].includes(id) && postgres !== "PASS") {
    return result(id, "FAIL", irRequirements[index]!, postMatrixRepair === null
      ? "REAL_POSTGRESQL_CURRENT_HEAD_PROOF failed; the required current-head durable regression was not established."
      : "REAL_POSTGRESQL_CURRENT_HEAD_PROOF is absent: PostgreSQL passed on the pre-repair matrix commit, but was not rerun on the exact final evidence-tooling-repair HEAD.",
      ["payload/working/regressions/postgresql.json"]);
  }
  if (id === "IR-25" && finalMatrix !== "PASS") return result(id, "FAIL", irRequirements[index]!,
    finalMatrixFailureReason(commands, postMatrixRepair));
  if (irFailureReasons[id]) return result(id, "FAIL", irRequirements[index]!, irFailureReasons[id], irEvidence(id));
  const commandFailure = commandFailureReason(id);
  if (commandFailure) return result(id, "FAIL", irRequirements[index]!, commandFailure);
  return result(id, "PASS", irRequirements[index]!);
});

const corePass = mcResults.filter((entry) => !["MC-03", "MC-10", "MC-27"].includes(entry.id) && entry.status === "PASS").length;
const coreFail = mcResults.filter((entry) => !["MC-03", "MC-10", "MC-27"].includes(entry.id) && entry.status === "FAIL").length;
if (corePass + coreFail !== 36) throw new Error("V0101_ASSESS_CORE_STATUS_INVALID");
const headline = corePass === 36 && coreFail === 0
  && irResults.every((entry) => ["IR-22", "IR-23", "IR-24"].includes(entry.id) || entry.status === "PASS")
  ? "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN"
  : "V0101_ENGINEERING_INTEGRATION_PARTIAL";
const blockers = [...mcResults, ...irResults]
  .filter((entry) => entry.status !== "PASS")
  .map((entry) => Object.freeze({ id: entry.id, status: entry.status, reason: entry.reason }));
const assessment = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1",
  headline,
  verified_head: head,
  verified_tree: tree,
  matrix_head: matrixHead,
  matrix_tree: matrixTree,
  post_matrix_evidence_only_repair: postMatrixRepair,
  mc_results: mcResults,
  ir_results: irResults,
  blockers,
  run_counts: runCounts,
  truth: Object.freeze({
    CORE_LOCAL_MC_PASS: `${corePass}/36`, CORE_LOCAL_MC_FAIL: coreFail,
    REAL_POSTGRESQL_CURRENT_HEAD_PROOF: postgres,
    REAL_BROWSER_DURABLE_PRODUCT_PATH: browserCommand,
    PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
    PROCESS_LOCAL_PRODUCT_REPOSITORIES: processLocalRepositoryCount,
    PARTIAL_OR_UNWIRED_STABLE_ENTRYPOINTS: partialOrUnwiredEntrypoints,
    KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE: queuedObservations,
    REAL_LEGAL_TOPICS_READY: "0/7", REAL_SOURCES_ACTIVE: 0, REAL_PARAMETERS_ACTIVE: 0,
    REAL_RULES_ACTIVE: 0, REAL_CALCULATIONS_OR_FINDINGS: 0, HUMAN_GROUND_TRUTH_LOCKED: 0,
    REAL_CUSTOMER_DATA_READS: 0, CUSTOMER_PROCESSING_ENABLED: "NO", CUSTOMER_SHADOW_AUTHORIZED: "NO",
    PRODUCTION_DELIVERY_ENABLED: "NO", DEPLOYMENTS: 0, REMOTE_MIGRATIONS: 0, LIVE_PROVIDER_CALLS: 0, OPENAI_CALLS: 0,
    FULL_SUITE_RUN_COUNT: runCounts.FULL_SUITE_RUN_COUNT,
    PRODUCTION_BUILD_RUN_COUNT: runCounts.PRODUCTION_BUILD_RUN_COUNT,
    BROWSER_E2E_FULL_RUN_COUNT: runCounts.BROWSER_E2E_FULL_RUN_COUNT,
    POSTGRESQL_FULL_REGRESSION_RUN_COUNT: runCounts.POSTGRESQL_FULL_REGRESSION_RUN_COUNT,
  }),
});
validateV0101AssessmentAgainstReceipts(assessment, verification, externalGates);
await writeFile(OUTPUT, `${JSON.stringify(assessment, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "PASS", headline: assessment.headline, core_pass: corePass, core_fail: coreFail,
  postgres, browser_command: browserCommand, verified_head: head, verified_tree: tree })}\n`);

type AssessmentResult = Readonly<{
  id: string;
  requirement: string;
  status: V0101ResultStatus;
  evidence: readonly string[];
  reason?: string;
}>;

function result(
  id: string,
  status: V0101ResultStatus,
  requirement: string,
  reason?: string,
  evidence?: readonly string[],
): AssessmentResult {
  const resolvedEvidence = evidence ?? (["MC-35", "IR-26"].includes(id)
    ? ["detached-verifier-output.json"]
    : ["payload/working/final-verification.json"]);
  return Object.freeze({ id, requirement, status, evidence: Object.freeze([...resolvedEvidence]), ...(status === "PASS" ? {} : { reason }) });
}

function mcEvidence(id: string): readonly string[] {
  if (["MC-06", "MC-07", "MC-08", "MC-34"].includes(id)) {
    return ["payload/working/regressions/browser.json", "payload/working/product/unified-timeline.json"];
  }
  if (["MC-13", "MC-14", "MC-15", "MC-17", "MC-19", "MC-20", "MC-21", "MC-22", "MC-29", "MC-37", "MC-38", "MC-39"].includes(id)) {
    return ["payload/repository/src/server/system-marathon/integration-repair-metrics.v0.10.1.json",
      "payload/repository/src/server/system-marathon/integration-repair-audit.v0.10.1.json"];
  }
  return ["payload/working/final-verification.json"];
}

function irEvidence(id: string): readonly string[] {
  if (["IR-02", "IR-05", "IR-06", "IR-07", "IR-21"].includes(id)) {
    return ["payload/working/regressions/browser.json", "payload/working/product/unified-timeline.json"];
  }
  return ["payload/repository/src/server/system-marathon/integration-repair-metrics.v0.10.1.json",
    "payload/repository/src/server/system-marathon/integration-repair-audit.v0.10.1.json"];
}

function finalMatrixFailureReason(
  finalCommands: readonly Record<string, unknown>[],
  postMatrixRepair: Readonly<Record<string, unknown>> | null,
): string {
  const failed = finalCommands.filter((command) => command.status !== "PASS")
    .map((command) => String(command.command_id));
  const repair = postMatrixRepair === null ? ""
    : " The final commit also contains a disclosed evidence-tooling-only repair after the one-shot matrix, so the matrix is not exact final-head proof.";
  return `FAILED_LOCAL_WITH_EVIDENCE: the one-shot final quality matrix is non-PASS; failed command IDs: ${failed.join(", ") || "none"}.${repair}`;
}

function browserFailureReason(
  regression: Record<string, unknown>,
  finalCommands: readonly Record<string, unknown>[],
): string {
  const after = record(regression.after);
  const browser = finalCommands.find((command) => command.command_id === "browser_e2e_full");
  const observed = typeof after.observed_error === "string" ? after.observed_error : null;
  const failureCode = typeof browser?.failure_code === "string" ? browser.failure_code : "BROWSER_DURABLE_PROOF_ABSENT";
  const ready = after.next_ready_observed === true ? "Next.js readiness was observed" : "Next.js readiness was not proven";
  const routeState = Array.isArray(after.routes_not_observed_in_logs)
    ? `routes not observed in the captured logs: ${after.routes_not_observed_in_logs.map(String).join(", ") || "none"}`
    : "route evidence was unavailable";
  return `REGRESSION_FAILED / FAILED_LOCAL_WITH_EVIDENCE: ${ready}; browser proof code ${failureCode}; ${routeState}; observed error: ${observed ?? "none captured"}. The TEST_IDENTITY_PRODUCTION_FORBIDDEN guard remains fail-closed, and no current-head durable signed-session/PostgreSQL/private-storage browser receipt was established.`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_ASSESS_INPUT_INVALID");
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function postMatrixEvidenceRepair(
  fromHead: string,
  fromTree: string,
  toHead: string,
  toTree: string,
): Readonly<Record<string, unknown>> {
  const allowed = new Set<string>(V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS);
  if (gitMergeBase(fromHead, toHead) !== fromHead) throw new Error("V0101_ASSESS_POST_MATRIX_ANCESTRY_INVALID");
  const changedPaths = gitDiffPaths(fromHead, toHead);
  if (changedPaths.length < 1 || changedPaths.some((entry) => !allowed.has(entry))) {
    throw new Error("V0101_ASSESS_POST_MATRIX_SCOPE_INVALID");
  }
  return Object.freeze({
    from_head: fromHead,
    from_tree: fromTree,
    to_head: toHead,
    to_tree: toTree,
    scope: "EVIDENCE_TOOLING_ONLY_NO_PRODUCT_RUNTIME_CHANGE",
    product_runtime_changed: false,
    changed_paths: Object.freeze(changedPaths),
    matrix_reused_as_final_head_proof: false,
  });
}

function git(revision: string): string {
  return gitOutput(["rev-parse", revision]);
}

function gitOutput(args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0101_ASSESS_GIT_FAILED");
  return result.stdout.trim();
}

function gitMergeBase(left: string, right: string): string {
  const result = spawnSync("git", ["merge-base", left, right], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0101_ASSESS_GIT_FAILED");
  return result.stdout.trim();
}

function gitDiffPaths(left: string, right: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", `${left}..${right}`], {
    cwd: ROOT, encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0 || result.error) throw new Error("V0101_ASSESS_GIT_FAILED");
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).sort();
}

}

const V0102_ASSESSMENT_SCHEMA =
  "tivdoc-canonical-integration-durability-repair-assessment-v0.10.2" as const;
const V0102_MATRIX_SCHEMA = "tivdoc-runtime-product-closure-runtime-matrix-progress-v0.10.2" as const;
const V0102_FIRST_NINE = Object.freeze([
  "focused_v0102_acceptance",
  "full_suite",
  "eslint",
  "typescript",
  "production_build",
  "postgresql_full_regression",
  "browser_durable_product_e2e",
  "security_limits_negative_matrix",
  "reachability_wiring_capability_audit",
] as const);

type RuntimeProductAssessmentResult = Readonly<{
  id: string;
  requirement: string;
  status: V0101ResultStatus;
  evidence: readonly string[];
  reason?: string;
}>;

function contractArgumentV0102(args: readonly string[]): string | null {
  if (!args.includes("--contract")) return null;
  if (args.length !== 2 || args[0] !== "--contract" || !args[1] || args[1].startsWith("-")) {
    throw new Error("V0102_ASSESS_CONTRACT_ARGUMENT_INVALID");
  }
  return args[1];
}

async function assessRuntimeProductClosure(contractInput: string): Promise<void> {
  const root = path.resolve(process.cwd());
  const expectedContract = path.join(
    root,
    "src",
    "server",
    "system-marathon",
    "runtime-product-closure-contract.v0.10.2.json",
  );
  const contractPath = path.resolve(root, contractInput);
  if (contractPath !== expectedContract) throw new Error("V0102_ASSESS_CONTRACT_PATH_INVALID");
  const contract = recordV0102(JSON.parse(await readFile(contractPath, "utf8")), "V0102_ASSESS_CONTRACT_INVALID");
  const profile = parseIntegrationEvidenceProfile(contract);
  const working = path.join(root, "output", "runtime-product-closure-v0.10.2", "working");
  const matrix = await jsonFileV0102(path.join(working, "runtime-matrix-progress.json"));
  const external = await jsonFileV0102(path.join(working, "external-gates.json"));
  const browser = await jsonFileV0102(path.join(working, "regressions", "browser.json"));
  const postgres = await jsonFileV0102(path.join(working, "regressions", "postgresql.json"));
  const timeline = await jsonFileV0102(path.join(working, "product", "unified-timeline.json"));
  const governance = await jsonFileV0102(path.join(working, "security", "governance-function-acl-rls.json"));
  const observations = await jsonFileV0102(path.join(working, "legal", "observation-import.json"));
  const workflows = await jsonFileV0102(path.join(working, "workflows", "human-legal-ground-truth.json"));
  const golden = await jsonFileV0102(path.join(working, "quality", "golden-mutation-property.json"));
  const invalidation = await jsonFileV0102(path.join(working, "product", "global-invalidation.json"));
  const entrypoints = await jsonFileV0102(path.join(working, "product", "entrypoint-disposition.json"));
  const capability = await jsonFileV0102(path.join(working, "verification", "capability-limits-cancellation.json"));
  const safety = await jsonFileV0102(path.join(working, "verification", "safety-and-reachability.json"));
  const branch = gitOutputV0102(root, ["branch", "--show-current"]);
  const head = gitOutputV0102(root, ["rev-parse", "HEAD"]);
  const tree = gitOutputV0102(root, ["rev-parse", "HEAD^{tree}"]);
  if (branch !== profile.branch
      || gitStatusV0102(root, ["merge-base", "--is-ancestor", profile.base_head, head]) !== 0
      || gitOutputV0102(root, ["rev-parse", `${profile.base_head}^{tree}`]) !== profile.base_tree
      || gitOutputV0102(root, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("V0102_ASSESS_REPOSITORY_STATE_INVALID");
  }
  validateAssessmentInputsV0102({
    profile,
    matrix,
    external,
    browser,
    postgres,
    timeline,
    governance,
    observations,
    workflows,
    golden,
    invalidation,
    entrypoints,
    capability,
    safety,
    branch,
    head,
    tree,
  });

  const acceptanceRequirements = recordV0102(contract.acceptance_requirements,
    "V0102_ASSESS_MC_REQUIREMENTS_INVALID");
  const integrationRequirements = recordV0102(contract.integration_requirements,
    "V0102_ASSESS_IR_REQUIREMENTS_INVALID");
  const gateReasons = externalGateReasonsV0102(external, profile);
  const mcResults = profile.mc_ids.map((id) => runtimeResultV0102(
    id,
    String(acceptanceRequirements[id]),
    Object.hasOwn(profile.external_blocked_pairs, id) ? "BLOCKED" : "PASS",
    evidenceForV0102(id),
    gateReasons.get(id),
  ));
  const blockedIrIds = new Set(Object.values(profile.external_blocked_pairs));
  const irResults = profile.ir_ids.map((id) => runtimeResultV0102(
    id,
    String(integrationRequirements[id]),
    blockedIrIds.has(id) ? "BLOCKED" : "PASS",
    evidenceForV0102(id),
    gateReasons.get(id),
  ));
  const resultMap = new Map([...mcResults, ...irResults].map((entry) => [entry.id, entry]));
  const crResults = profile.cr_ids.map((id) => closureResultV0102(profile, id, resultMap));
  const nonPass = [...mcResults, ...irResults, ...crResults].filter((entry) => entry.status !== "PASS");
  const runCounts = Object.freeze({
    FULL_SUITE_RUN_COUNT: 1,
    PRODUCTION_BUILD_RUN_COUNT: 1,
    BROWSER_E2E_FULL_RUN_COUNT: 1,
    POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
  });
  const assessment = Object.freeze({
    schema_version: V0102_ASSESSMENT_SCHEMA,
    contract_schema_version: profile.contract_schema_version,
    headline: "V0102_LOCAL_ENGINEERING_CLOSURE_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
    verified_head: head,
    verified_tree: tree,
    matrix_head: head,
    matrix_tree: tree,
    post_matrix_evidence_only_repair: null,
    mc_results: Object.freeze(mcResults),
    ir_results: Object.freeze(irResults),
    cr_results: Object.freeze(crResults),
    governance_security: Object.freeze({
      status: "PASS",
      security_definer_functions: governance.security_definer_functions,
      exposed_functions: governance.exposed_functions,
      unsafe_or_unexplained_functions: governance.unsafe_or_unexplained_functions,
      cross_tenant_rpc_successes: governance.cross_tenant_rpc_successes,
      pool_context_leaks: governance.pool_context_leaks,
      evidence: Object.freeze(["security/governance-function-acl-rls.json"]),
    }),
    blockers: Object.freeze(nonPass.map((entry) => Object.freeze({
      id: entry.id,
      status: entry.status,
      reason: entry.reason,
    }))),
    run_counts: runCounts,
    truth: Object.freeze({
      ...profile.truth_baseline,
      CORE_LOCAL_MC_PASS: "36/36",
      CORE_LOCAL_MC_FAIL: 0,
      LOCALLY_SOLVABLE_IR_PASS: "24/24",
      LOCALLY_SOLVABLE_IR_FAIL: 0,
      REAL_POSTGRESQL_CURRENT_HEAD_PROOF: "PASS",
      REAL_BROWSER_DURABLE_PRODUCT_PATH: "PASS",
      TYPESCRIPT: "PASS",
      PRODUCTION_BUILD: "PASS",
      CANONICAL_SESSION_STARTUP_INSTALLED: "YES",
      PROCESS_LOCAL_PRODUCT_REPOSITORIES: 0,
      DURABLE_GOVERNANCE_REPLACEMENTS_WIRED: "4/4",
      PARTIAL_OR_UNWIRED_PRODUCT_STABLE_ENTRYPOINTS: 0,
      KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE: "71/71",
      GOVERNANCE_SECURITY_DEFINER_FUNCTIONS: 32,
      GOVERNANCE_EXPOSED_FUNCTIONS: 21,
      UNSAFE_OR_UNEXPLAINED_FUNCTIONS: 0,
      CROSS_TENANT_RPC_SUCCESSES: 0,
      POOL_CONTEXT_LEAKS: 0,
      ISOLATED_SUPABASE_PLATFORM_PROOF: "BLOCKED",
      PARSER_OS_SANDBOX_PROOF: "BLOCKED",
      OFF_HOST_AUDIT_CUSTODY: "BLOCKED",
      MANAGED_IDENTITY_PROVIDER_VERIFIED: "NO",
      MANAGED_PRIVATE_STORAGE_VERIFIED: "NO",
      ...runCounts,
    }),
  });
  validateRuntimeProductClosureAssessment(profile, assessment);
  await writeFile(
    path.join(working, "runtime-product-closure-assessment.v0.10.2.json"),
    `${JSON.stringify(assessment, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    headline: assessment.headline,
    verified_head: head,
    verified_tree: tree,
    mc_pass: 36,
    mc_blocked: 3,
    ir_pass: 24,
    ir_blocked: 3,
    cr_pass: 22,
  })}\n`);
}

function validateAssessmentInputsV0102(input: Readonly<{
  profile: IntegrationEvidenceProfile;
  matrix: Record<string, unknown>;
  external: Record<string, unknown>;
  browser: Record<string, unknown>;
  postgres: Record<string, unknown>;
  timeline: Record<string, unknown>;
  governance: Record<string, unknown>;
  observations: Record<string, unknown>;
  workflows: Record<string, unknown>;
  golden: Record<string, unknown>;
  invalidation: Record<string, unknown>;
  entrypoints: Record<string, unknown>;
  capability: Record<string, unknown>;
  safety: Record<string, unknown>;
  branch: string;
  head: string;
  tree: string;
}>): void {
  const commands = Array.isArray(input.matrix.commands) ? input.matrix.commands.map((entry) =>
    recordV0102(entry, "V0102_ASSESS_COMMAND_INVALID")) : [];
  if (input.matrix.schema_version !== V0102_MATRIX_SCHEMA || input.matrix.status !== "PASS"
      || input.matrix.contract_schema_version !== input.profile.contract_schema_version
      || input.matrix.verified_branch !== input.branch || input.matrix.verified_head !== input.head
      || input.matrix.verified_tree !== input.tree || input.matrix.command_count !== V0102_FIRST_NINE.length
      || JSON.stringify(input.matrix.execution_order) !== JSON.stringify(V0102_FIRST_NINE)
      || commands.length !== V0102_FIRST_NINE.length
      || commands.some((command, index) => command.command_id !== V0102_FIRST_NINE[index]
        || command.status !== "PASS" || command.execution_status !== "PASS"
        || command.proof_contract_status !== "PASS" || command.verified_head !== input.head
        || command.verified_tree !== input.tree)) {
    throw new Error("V0102_ASSESS_MATRIX_INVALID");
  }
  const artifacts = [input.browser, input.postgres, input.timeline, input.governance, input.observations,
    input.workflows, input.golden, input.invalidation, input.entrypoints, input.capability, input.safety];
  if (artifacts.some((artifact) => artifact.status !== "PASS" || artifact.verified_head !== input.head
      || artifact.verified_tree !== input.tree)) {
    throw new Error("V0102_ASSESS_ARTIFACT_STALE_OR_FAILED");
  }
  if (input.browser.durable_product_path !== true || input.browser.canonical_session_startup_installed !== true
      || input.postgres.acceptance_result !== "ACCEPTANCE_24_OF_24_PASS"
      || input.timeline.status !== "PASS" || input.governance.security_definer_functions !== 32
      || input.governance.exposed_functions !== 21 || input.governance.unsafe_or_unexplained_functions !== 0
      || input.governance.cross_tenant_rpc_successes !== 0 || input.governance.pool_context_leaks !== 0
      || input.observations.durable_queue_observations !== 71 || input.observations.activation_allowed !== false
      || input.workflows.durable_governance_replacements_wired !== 4
      || input.workflows.genuine_human_locks !== 0 || input.golden.synthetic_topics_covered !== 7
      || input.invalidation.epochs_reset !== false || input.invalidation.idempotent_replay !== true
      || input.entrypoints.denominator !== 95 || input.entrypoints.product_stable_denominator !== 84
      || input.entrypoints.after_product_stable_partial_or_unwired !== 0
      || input.entrypoints.process_local_product_repositories !== 0
      || input.entrypoints.product_reachable_memory_fallbacks !== 0
      || input.capability.partial_or_unwired_product_stable_entrypoints !== 0
      || input.external.schema_version !== "tivdoc-runtime-product-closure-external-gates-v0.10.2"
      || input.external.status !== "BLOCKED" || input.external.verified_head !== input.head
      || input.external.verified_tree !== input.tree || input.external.detector_run_count !== 1
      || input.external.managed_identity_provider_verified !== false
      || input.external.managed_private_storage_verified !== false) {
    throw new Error("V0102_ASSESS_TRUTH_CONTRADICTION");
  }
}

function externalGateReasonsV0102(
  external: Record<string, unknown>,
  profile: IntegrationEvidenceProfile,
): ReadonlyMap<string, string> {
  const gates = Array.isArray(external.gates) ? external.gates.map((entry) =>
    recordV0102(entry, "V0102_ASSESS_EXTERNAL_GATE_INVALID")) : [];
  const reasons = new Map<string, string>();
  for (const [mcId, irId] of Object.entries(profile.external_blocked_pairs)) {
    const gate = gates.find((entry) => entry.mc_id === mcId && entry.ir_id === irId);
    const codes = gate && Array.isArray(gate.reason_codes) ? gate.reason_codes.map(String) : [];
    if (!gate || gate.status !== "BLOCKED" || codes.length < 1 || gate.external_mutations !== 0) {
      throw new Error(`V0102_ASSESS_EXTERNAL_GATE_INVALID:${mcId}`);
    }
    const reason = codes.join(", ");
    reasons.set(mcId, reason);
    reasons.set(irId, reason);
  }
  if (gates.length !== Object.keys(profile.external_blocked_pairs).length) {
    throw new Error("V0102_ASSESS_EXTERNAL_GATE_SET_INVALID");
  }
  return reasons;
}

function runtimeResultV0102(
  id: string,
  requirement: string,
  status: V0101ResultStatus,
  evidence: readonly string[],
  reason?: string,
): RuntimeProductAssessmentResult {
  if (!requirement || evidence.length < 1 || (status === "BLOCKED" && !reason)) {
    throw new Error(`V0102_ASSESS_RESULT_INVALID:${id}`);
  }
  return Object.freeze({
    id,
    requirement,
    status,
    evidence: Object.freeze([...evidence]),
    ...(status === "PASS" ? {} : { reason }),
  });
}

function closureResultV0102(
  profile: IntegrationEvidenceProfile,
  id: string,
  results: ReadonlyMap<string, RuntimeProductAssessmentResult>,
): RuntimeProductAssessmentResult {
  const dependencies = profile.closure_map[id]!;
  if (dependencies.length === 1 && dependencies[0] === "GOVERNANCE_FUNCTION_ACL_RLS_SECURITY") {
    return runtimeResultV0102(id, "Derived closure: governance function ACL and RLS security.", "PASS",
      ["security/governance-function-acl-rls.json"]);
  }
  const dependenciesResults = dependencies.map((dependency) => results.get(dependency));
  if (dependenciesResults.some((entry) => !entry || entry.status !== "PASS")) {
    throw new Error(`V0102_ASSESS_LOCAL_CLOSURE_NONPASS:${id}`);
  }
  const evidence = [...new Set(dependenciesResults.flatMap((entry) => entry!.evidence))].sort();
  return runtimeResultV0102(id, `Derived closure: ${dependencies.join(", ")}.`, "PASS", evidence);
}

function evidenceForV0102(id: string): readonly string[] {
  if (["MC-03", "MC-10", "MC-27", "IR-22", "IR-23", "IR-24"].includes(id)) {
    return ["external-gates.json"];
  }
  if (["MC-04", "MC-05", "MC-06", "MC-07", "IR-02", "IR-04", "IR-05", "IR-06", "IR-08"].includes(id)) {
    return ["regressions/browser.json"];
  }
  if (["MC-08", "IR-07"].includes(id)) return ["product/unified-timeline.json"];
  if (["MC-11", "IR-03", "IR-20"].includes(id)) return ["regressions/postgresql.json"];
  if (["MC-13", "MC-14", "MC-15", "MC-16", "MC-17", "MC-20", "MC-31", "MC-38",
    "IR-09", "IR-10", "IR-12", "IR-13", "IR-27"].includes(id)) {
    return ["workflows/human-legal-ground-truth.json"];
  }
  if (["MC-19", "IR-11"].includes(id)) return ["legal/observation-import.json"];
  if (["MC-21", "IR-14"].includes(id)) return ["quality/golden-mutation-property.json"];
  if (["MC-22", "IR-15"].includes(id)) return ["product/global-invalidation.json"];
  if (["MC-02", "MC-09", "MC-29", "IR-17", "IR-19"].includes(id)) {
    return ["product/entrypoint-disposition.json"];
  }
  if (["MC-12", "MC-39", "IR-18", "IR-21"].includes(id)) {
    return ["verification/capability-limits-cancellation.json"];
  }
  return ["verification/safety-and-reachability.json"];
}

async function jsonFileV0102(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`V0102_ASSESS_JSON_INVALID:${path.basename(file)}`);
  }
  return recordV0102(value, `V0102_ASSESS_JSON_INVALID:${path.basename(file)}`);
}

function recordV0102(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function gitOutputV0102(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0102_ASSESS_GIT_FAILED");
  return result.stdout.trim();
}

function gitStatusV0102(root: string, args: readonly string[]): number {
  const result = spawnSync("git", args, { cwd: root, windowsHide: true });
  if (result.error || result.status === null) throw new Error("V0102_ASSESS_GIT_FAILED");
  return result.status;
}
