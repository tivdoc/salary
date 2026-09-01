import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateV0101AssessmentAgainstReceipts,
  V0101_COMMAND_FAILURE_IMPACTS,
  V0101_FINAL_COMMAND_IDS,
  V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS,
  type V0101ResultStatus,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";

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
