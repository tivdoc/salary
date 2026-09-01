import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateV0101Assessment, type V0101ResultStatus } from "../../src/server/system-marathon/integration-repair-evidence.ts";

const ROOT = path.resolve(process.cwd());
const WORKING = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "working");
const FINAL_VERIFICATION = path.join(WORKING, "final-verification.json");
const OUTPUT = path.join(WORKING, "integration-repair-assessment.v0.10.1.json");

const verification = record(JSON.parse(await readFile(FINAL_VERIFICATION, "utf8")));
const head = git("HEAD");
const tree = git("HEAD^{tree}");
if (verification.verified_head !== head || verification.verified_tree !== tree) {
  throw new Error("V0101_ASSESS_FINAL_VERIFICATION_STALE");
}
const commands = Array.isArray(verification.commands) ? verification.commands.map(record) : [];
const commandStatus = (id: string): V0101ResultStatus => commands.find((item) => item.command_id === id)?.status === "PASS" ? "PASS" : "FAIL";
const postgres = commandStatus("postgresql_full_regression");
const browserCommand = commandStatus("browser_e2e_full");
const finalMatrix = verification.status === "PASS" ? "PASS" : "FAIL";
const runCounts = record(verification.run_counts);

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
  "MC-34": "FAILED_LOCAL_WITH_EVIDENCE: the one final quality matrix is non-PASS because the required rendered durable browser-product proof did not complete.",
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
  if (id === "MC-11" && postgres !== "PASS") return result(id, "FAIL", mcRequirements[index]!, "REAL_POSTGRESQL_CURRENT_HEAD_PROOF did not pass; current-head controlled-import migration behavior is unproven.");
  if (mcFailures[id]) return result(id, "FAIL", mcRequirements[index]!, mcFailures[id]);
  return result(id, "PASS", mcRequirements[index]!);
});

const browserReason = "REGRESSION_FAILED / FAILED_LOCAL_WITH_EVIDENCE: Webpack rejected node:crypto with UnhandledSchemeError while compiling src/instrumentation.ts -> src/server/product/integration/browser-runtime.ts before readiness, session issuance or route navigation. The prior TEST_IDENTITY_PRODUCTION_FORBIDDEN defect is no longer observed and its production guard remains fail-closed.";
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
  if (id === "IR-02" && browserCommand !== "PASS") return result(id, "FAIL", irRequirements[index]!, browserReason);
  if (["IR-03", "IR-08", "IR-20"].includes(id) && postgres !== "PASS") {
    return result(id, "FAIL", irRequirements[index]!, "REAL_POSTGRESQL_CURRENT_HEAD_PROOF failed; the required current-head durable regression was not established.");
  }
  if (id === "IR-25" && finalMatrix !== "PASS") return result(id, "FAIL", irRequirements[index]!, "The single final integrated quality matrix contains one or more failed commands.");
  if (irFailureReasons[id]) return result(id, "FAIL", irRequirements[index]!, irFailureReasons[id]);
  return result(id, "PASS", irRequirements[index]!);
});

const corePass = mcResults.filter((entry) => !["MC-03", "MC-10", "MC-27"].includes(entry.id) && entry.status === "PASS").length;
const coreFail = 36 - corePass;
const blockers = [...mcResults, ...irResults]
  .filter((entry) => entry.status !== "PASS")
  .map((entry) => Object.freeze({ id: entry.id, status: entry.status, reason: entry.reason }));
const assessment = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1",
  headline: "V0101_ENGINEERING_INTEGRATION_PARTIAL",
  verified_head: head,
  verified_tree: tree,
  mc_results: mcResults,
  ir_results: irResults,
  blockers,
  run_counts: runCounts,
  truth: Object.freeze({
    CORE_LOCAL_MC_PASS: `${corePass}/36`, CORE_LOCAL_MC_FAIL: coreFail,
    REAL_POSTGRESQL_CURRENT_HEAD_PROOF: postgres,
    REAL_BROWSER_DURABLE_PRODUCT_PATH: "FAIL",
    PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
    PROCESS_LOCAL_PRODUCT_REPOSITORIES: 4,
    PARTIAL_OR_UNWIRED_STABLE_ENTRYPOINTS: 46,
    KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE: 0,
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
validateV0101Assessment(assessment);
await writeFile(OUTPUT, `${JSON.stringify(assessment, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ status: "PASS", headline: assessment.headline, core_pass: corePass, core_fail: coreFail,
  postgres, browser_command: browserCommand, verified_head: head, verified_tree: tree })}\n`);

function result(
  id: string,
  status: V0101ResultStatus,
  requirement: string,
  reason?: string,
  evidence: readonly string[] = ["payload/working/final-verification.json"],
): Readonly<Record<string, unknown>> {
  return Object.freeze({ id, requirement, status, evidence: Object.freeze([...evidence]), ...(status === "PASS" ? {} : { reason }) });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_ASSESS_INPUT_INVALID");
  return value as Record<string, unknown>;
}

function git(revision: string): string {
  const result = spawnSync("git", ["rev-parse", revision], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0101_ASSESS_GIT_FAILED");
  return result.stdout.trim();
}
