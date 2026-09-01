import { createHash } from "node:crypto";
import path from "node:path";

export const V0101_HEADLINES = Object.freeze([
  "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
  "V0101_ENGINEERING_INTEGRATION_PARTIAL",
  "BLOCKED_SAFETY_OR_REPOSITORY_STATE",
] as const);

export const V0101_RESULT_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED"] as const);
export type V0101ResultStatus = (typeof V0101_RESULT_STATUSES)[number];

export type V0101EvidenceEntry = Readonly<{
  path: string;
  sha256: string;
  byte_count: number;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
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
        && (!SHA256.test(String(record.commit_sha)) || !SHA256.test(String(record.tree_sha))
          || !SHA256.test(String(record.parent_sha)) || typeof record.subject !== "string")) {
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
  if (!SHA256.test(String(assessment.verified_head)) || !SHA256.test(String(assessment.verified_tree))) {
    throw new Error("V0101_ASSESSMENT_GIT_INVALID");
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
      || verification.verified_head !== assessment.verified_head
      || verification.verified_tree !== assessment.verified_tree
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
        || command.verified_head !== assessment.verified_head
        || command.verified_tree !== assessment.verified_tree
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
  if (truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF !== command("postgresql_full_regression").status
      || truth.REAL_BROWSER_DURABLE_PRODUCT_PATH !== command("browser_e2e_full").status
      || results.get("IR-25")?.status !== verification.status) {
    throw new Error("V0101_RUNTIME_TRUTH_CONTRADICTION");
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
