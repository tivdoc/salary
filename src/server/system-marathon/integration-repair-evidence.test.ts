import { describe, expect, it } from "vitest";

import {
  assertPortableEvidencePath,
  canonicalPayloadSetHash,
  parseOrderedIntegrationLedger,
  validateV0101Assessment,
  validateV0101AssessmentAgainstReceipts,
} from "./integration-repair-evidence.ts";

const HASH = "a".repeat(64);
const GIT_HASH = "b".repeat(40);
const COMMAND_IDS = [
  "focused_acceptance", "full_suite", "eslint", "typescript", "production_build", "postgresql_full_regression",
  "browser_e2e_full", "prohibited_operation_audit", "canonical_reachability", "persistence_wiring",
] as const;

function result(
  prefix: "MC" | "IR",
  index: number,
  status: "PASS" | "FAIL" | "BLOCKED" = "PASS",
  reason = "EXACT_BLOCKER_REASON",
) {
  return {
    id: `${prefix}-${String(index).padStart(2, "0")}`,
    status,
    evidence: ["receipt.json"],
    ...(status === "PASS" ? {} : { reason }),
  };
}

function assessment() {
  const mc = Array.from({ length: 39 }, (_, index) => result("MC", index + 1));
  mc[2] = result("MC", 3, "BLOCKED", "SUPABASE_CLI_NOT_FOUND and SUPABASE_CONTAINER_ENGINE_NOT_FOUND");
  mc[9] = result("MC", 10, "BLOCKED", "PARSER_OS_SANDBOX_NOT_VERIFIED: NODE_PERMISSION_MODEL_HAS_NO_KERNEL_NETWORK_OR_RESOURCE_BOUNDARY");
  mc[26] = result("MC", 27, "BLOCKED", "OFF_HOST_AUDIT_CUSTODY_PENDING and DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED");
  const ir = Array.from({ length: 27 }, (_, index) => result("IR", index + 1));
  ir[21] = result("IR", 22, "BLOCKED", "SUPABASE_CLI_NOT_FOUND and SUPABASE_CONTAINER_ENGINE_NOT_FOUND");
  ir[22] = result("IR", 23, "BLOCKED", "PARSER_OS_SANDBOX_NOT_VERIFIED: NODE_PERMISSION_MODEL_HAS_NO_KERNEL_NETWORK_OR_RESOURCE_BOUNDARY");
  ir[23] = result("IR", 24, "BLOCKED", "OFF_HOST_AUDIT_CUSTODY_PENDING and DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED");
  const results = [...mc, ...ir];
  return {
    schema_version: "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1",
    headline: "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
    verified_head: GIT_HASH,
    verified_tree: GIT_HASH,
    matrix_head: GIT_HASH,
    matrix_tree: GIT_HASH,
    post_matrix_evidence_only_repair: null as Record<string, unknown> | null,
    mc_results: mc,
    ir_results: ir,
    blockers: results.filter((item) => item.status !== "PASS")
      .map((item) => ({ id: item.id, status: item.status, reason: item.reason })),
    run_counts: {
      FULL_SUITE_RUN_COUNT: 1,
      PRODUCTION_BUILD_RUN_COUNT: 1,
      BROWSER_E2E_FULL_RUN_COUNT: 1,
      POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
    },
    truth: {
      CORE_LOCAL_MC_PASS: "36/36",
      CORE_LOCAL_MC_FAIL: 0,
      REAL_POSTGRESQL_CURRENT_HEAD_PROOF: "PASS",
      REAL_BROWSER_DURABLE_PRODUCT_PATH: "PASS",
      PROCESS_LOCAL_PRODUCT_REPOSITORIES: 0,
      PARTIAL_OR_UNWIRED_STABLE_ENTRYPOINTS: 0,
      KNOWN_STAGED_SOURCE_OBSERVATIONS_IN_DURABLE_QUEUE: 0,
      REAL_LEGAL_TOPICS_READY: "0/7",
      REAL_SOURCES_ACTIVE: 0,
      REAL_PARAMETERS_ACTIVE: 0,
      REAL_RULES_ACTIVE: 0,
      REAL_CALCULATIONS_OR_FINDINGS: 0,
      HUMAN_GROUND_TRUTH_LOCKED: 0,
      REAL_CUSTOMER_DATA_READS: 0,
      CUSTOMER_PROCESSING_ENABLED: "NO",
      CUSTOMER_SHADOW_AUTHORIZED: "NO",
      PRODUCTION_DELIVERY_ENABLED: "NO",
      DEPLOYMENTS: 0,
      REMOTE_MIGRATIONS: 0,
      LIVE_PROVIDER_CALLS: 0,
      OPENAI_CALLS: 0,
      PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
      FULL_SUITE_RUN_COUNT: 1,
      PRODUCTION_BUILD_RUN_COUNT: 1,
      BROWSER_E2E_FULL_RUN_COUNT: 1,
      POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
    },
  };
}

describe("V0.10.1 evidence contracts", () => {
  it("hashes a unique portable payload set independent of input order", () => {
    const entries = [
      { path: "receipts/b.json", sha256: HASH, byte_count: 2 },
      { path: "receipts/a.json", sha256: HASH, byte_count: 1 },
    ];
    expect(canonicalPayloadSetHash(entries)).toBe(canonicalPayloadSetHash([...entries].reverse()));
    expect(() => canonicalPayloadSetHash([...entries, { ...entries[0], path: "RECEIPTS/B.JSON" }]))
      .toThrow("V0101_EVIDENCE_PATH_DUPLICATE");
  });

  it("rejects traversal, absolute and reserved evidence paths", () => {
    for (const name of ["../escape.json", "C:/escape.json", "/escape.json", "a//b.json", "con.txt"]) {
      expect(() => assertPortableEvidencePath(name)).toThrow("V0101_EVIDENCE_PATH_UNSAFE");
    }
  });

  it("requires an ordered machine-readable ledger", () => {
    expect(parseOrderedIntegrationLedger('{"event_id":"IRL-0001","kind":"plan","status":"PASS"}\n{"event_id":"IRL-0002","kind":"check","status":"PASS"}')).toHaveLength(2);
    expect(() => parseOrderedIntegrationLedger('{"event_id":"IRL-0002","kind":"plan","status":"PASS"}')).toThrow("V0101_LEDGER_ORDER_INVALID");
    const commit = JSON.stringify({
      event_id: "IRL-0001", kind: "integration_commit", status: "PASS",
      commit_sha: GIT_HASH, tree_sha: GIT_HASH, parent_sha: GIT_HASH, subject: "evidence repair",
    });
    expect(parseOrderedIntegrationLedger(commit)).toHaveLength(1);
    expect(() => parseOrderedIntegrationLedger(commit.replace(GIT_HASH, "f".repeat(39))))
      .toThrow("V0101_LEDGER_COMMIT_INVALID");
  });

  it("accepts honest counters and rejects blockers labelled PASS", () => {
    expect(() => validateV0101Assessment(assessment())).not.toThrow();
    const contradictory = assessment();
    contradictory.mc_results[2] = result("MC", 3, "PASS");
    contradictory.mc_results[3] = result("MC", 4, "FAIL");
    contradictory.headline = "V0101_ENGINEERING_INTEGRATION_PARTIAL";
    contradictory.truth.CORE_LOCAL_MC_PASS = "35/36";
    contradictory.truth.CORE_LOCAL_MC_FAIL = 1;
    expect(() => validateV0101Assessment(contradictory)).toThrow("V0101_BLOCKER_FALSE_PASS");
  });

  it("permits BLOCKED only for the three environment/external pairs", () => {
    const value = assessment();
    value.mc_results[3] = result("MC", 4, "BLOCKED");
    expect(() => validateV0101Assessment(value)).toThrow("V0101_BLOCKED_ID_INVALID:MC-04");
  });

  it("rejects omitted blockers and command failures labelled PASS", () => {
    const omitted = assessment();
    omitted.blockers.pop();
    expect(() => validateV0101Assessment(omitted)).toThrow("V0101_BLOCKER_SET_INCOMPLETE");

    const value = assessment();
    value.headline = "V0101_ENGINEERING_INTEGRATION_PARTIAL";
    value.mc_results[33] = result("MC", 34, "FAIL");
    value.ir_results[24] = result("IR", 25, "FAIL");
    value.truth.CORE_LOCAL_MC_PASS = "35/36";
    value.truth.CORE_LOCAL_MC_FAIL = 1;
    value.truth.REAL_BROWSER_DURABLE_PRODUCT_PATH = "PASS";
    value.blockers.push(
      { id: "MC-34", status: "FAIL", reason: "EXACT_BLOCKER_REASON" },
      { id: "IR-25", status: "FAIL", reason: "EXACT_BLOCKER_REASON" },
    );
    const verification = finalVerification(["typescript"]);
    const gates = externalGates();
    expect(() => validateV0101AssessmentAgainstReceipts(value, verification, gates)).not.toThrow();
    value.ir_results[24] = result("IR", 25, "PASS");
    value.blockers = value.blockers.filter((item) => item.id !== "IR-25");
    expect(() => validateV0101AssessmentAgainstReceipts(value, verification, gates))
      .toThrow("V0101_COMMAND_FAILURE_FALSE_PASS");
  });

  it("requires stale matrix browser and PostgreSQL impacts to fail after an evidence-only repair", () => {
    const value = assessment();
    const finalHead = "c".repeat(40);
    const finalTree = "d".repeat(40);
    value.headline = "V0101_ENGINEERING_INTEGRATION_PARTIAL";
    value.verified_head = finalHead;
    value.verified_tree = finalTree;
    value.post_matrix_evidence_only_repair = {
      from_head: GIT_HASH,
      from_tree: GIT_HASH,
      to_head: finalHead,
      to_tree: finalTree,
      scope: "EVIDENCE_TOOLING_ONLY_NO_PRODUCT_RUNTIME_CHANGE",
      product_runtime_changed: false,
      changed_paths: ["scripts/canonical-integration-repair-v0101/assess.mts"],
      matrix_reused_as_final_head_proof: false,
    };
    const failedMc = [6, 7, 8, 11, 29, 34];
    const failedIr = [2, 3, 5, 6, 7, 8, 17, 20, 21, 25];
    for (const index of failedMc) value.mc_results[index - 1] = result("MC", index, "FAIL");
    for (const index of failedIr) value.ir_results[index - 1] = result("IR", index, "FAIL");
    value.blockers = [...value.mc_results, ...value.ir_results]
      .filter((item) => item.status !== "PASS")
      .map((item) => ({ id: item.id, status: item.status, reason: item.reason }));
    value.truth.CORE_LOCAL_MC_PASS = "30/36";
    value.truth.CORE_LOCAL_MC_FAIL = 6;
    value.truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF = "FAIL";
    value.truth.REAL_BROWSER_DURABLE_PRODUCT_PATH = "FAIL";
    expect(() => validateV0101AssessmentAgainstReceipts(value, finalVerification([]), externalGates())).not.toThrow();

    value.mc_results[10] = result("MC", 11, "PASS");
    value.blockers = value.blockers.filter((item) => item.id !== "MC-11");
    value.truth.CORE_LOCAL_MC_PASS = "31/36";
    value.truth.CORE_LOCAL_MC_FAIL = 5;
    expect(() => validateV0101AssessmentAgainstReceipts(value, finalVerification([]), externalGates()))
      .toThrow("V0101_EXACT_FINAL_HEAD_PROOF_FALSE_PASS:postgresql_full_regression:MC-11");
  });
});

function finalVerification(failedCommands: readonly string[]) {
  const failed = new Set(failedCommands);
  return {
    schema_version: "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1",
    status: failed.size === 0 ? "PASS" : "FAIL",
    verified_branch: "codex/tivdoc-engine-foundation",
    verified_head: GIT_HASH,
    verified_tree: GIT_HASH,
    command_count: COMMAND_IDS.length,
    execution_order: COMMAND_IDS,
    commands: COMMAND_IDS.map((command_id, index) => {
      const status = failed.has(command_id) ? "FAIL" : "PASS";
      return {
        command_id, status, execution_status: status, proof_contract_status: status,
        attempt_ordinal: 1, execution_ordinal: index + 1, verified_head: GIT_HASH, verified_tree: GIT_HASH,
        started_epoch_ms: index + 1, finished_epoch_ms: index + 2,
        stdout_sha256: HASH, stderr_sha256: HASH, stdout_byte_count: 0, stderr_byte_count: 0,
        stdout_log: `final-logs/${command_id}.stdout.log`, stderr_log: `final-logs/${command_id}.stderr.log`,
      };
    }),
    run_counts: {
      FULL_SUITE_RUN_COUNT: 1,
      PRODUCTION_BUILD_RUN_COUNT: 1,
      BROWSER_E2E_FULL_RUN_COUNT: 1,
      POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
    },
    exact_once: true,
    working_preflight: "FRESH_DIRECTORY_CREATED_BEFORE_FIRST_COMMAND",
    journal_log: "final-command-journal.ndjson",
    journal_sha256: HASH,
    journal_byte_count: 1,
  };
}

function externalGates() {
  return {
    schema_version: "tivdoc-canonical-integration-durability-repair-external-gates-v0.10.1",
    bounded_checks_performed_once: true,
    bounded_check_run_count: 1,
    final_head_reexecution_forbidden_by_task: true,
    gates: [
      gate("MC-03", ["supabase", "docker", "podman"],
        ["SUPABASE_CLI_NOT_FOUND", "SUPABASE_CONTAINER_ENGINE_NOT_FOUND"]),
      gate("MC-10", ["node", "WindowsSandbox.exe", "docker.exe", "podman.exe"],
        ["PARSER_OS_SANDBOX_NOT_VERIFIED", "NODE_PERMISSION_MODEL_HAS_NO_KERNEL_NETWORK_OR_RESOURCE_BOUNDARY"]),
      gate("MC-27", ["configured_off_host_destination"],
        ["OFF_HOST_AUDIT_CUSTODY_PENDING", "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED"]),
    ],
    deployments: 0, remote_migrations: 0, live_provider_calls: 0, openai_calls: 0,
  };
}

function gate(id: string, tools: readonly string[], reasonCodes: readonly string[]) {
  const observed = id === "MC-03"
    ? { supabase_cli: false, container_engine: null, cached_images_complete: false, platform_proof_performed: false }
    : id === "MC-10"
      ? { node_version: "22.22.2", kernel_network_or_resource_boundary: false, persistent_owner_import_enabled: false }
      : { managed_destination_available: false, off_host_transfer_performed: false };
  const probeStatuses = id === "MC-03" ? ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]
    : id === "MC-10" ? ["PRESENT_INSUFFICIENT_ISOLATION", "NOT_FOUND", "NOT_DETECTED", "NOT_DETECTED"]
      : ["NOT_CONFIGURED"];
  const found = id === "MC-10" ? [true, false, false, false] : tools.map(() => false);
  return {
    id,
    status: "BLOCKED",
    detector_execution: { run_count: 1, process_exit_code: null, exit_code_state: "NO_CHILD_PROCESS" },
    reason_codes: reasonCodes,
    checked_tools: tools.map((tool, index) => ({
      tool,
      version: null,
      probe_status: probeStatuses[index],
      found: found[index],
      exit_code: null,
      exit_code_state: "NO_CHILD_PROCESS",
      exact_reason: "EXACT_TOOL_REASON",
    })),
    observed,
    external_mutations: 0,
  };
}
