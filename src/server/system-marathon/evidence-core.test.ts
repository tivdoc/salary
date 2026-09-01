import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../engine/rule-runtime/canonical.ts";
import { writeDeterministicStoreZip } from "../../../scripts/canonical-persistence-v091/evidence/deterministic-zip.mts";
import {
  canonicalAcceptanceMarkdown,
  createPostVerificationClosureReceipt,
  createEvidenceManifest,
  sha256,
  verifyEvidenceDirectory,
  verifyPostVerificationClosure,
} from "../../../scripts/full-local-system-marathon/evidence-core.mts";

const temporaryRoots: string[] = [];
const FINAL_HEAD = "b".repeat(40);
const FINAL_TREE = "c".repeat(40);
const ATTEMPT_HEAD = "a".repeat(40);
const ATTEMPT_TREE = "1".repeat(40);
const POSTGRESQL_MARATHON_RECEIPT_PATH =
  "output/canonical-postgresql-dynamic-v0.9.1/development/marathon-v010-matrix.json";

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function postgresqlEvidenceFixture() {
  const truthCounters = {
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
  };
  const beforeRows = postgresqlRows(2);
  const finalRows = postgresqlRows(3);
  const capabilityStateSeed = {
    schema_version: "tivdoc-canonical-persistence-v091-durable-state-v1",
    fixture_suffix: "fixture010",
    tenant_id: "tenant:synthetic-marathon-v010",
    case_id: "00000000-0000-4000-8000-000000000010",
  };
  const capabilityState = {
    ...capabilityStateSeed,
    durable_state_sha256: canonicalSha256(capabilityStateSeed),
  };
  const checkpointSeed = {
    schema_version: "tivdoc-marathon-v010-postgresql-checkpoint-v1",
    build_identity_sha: FINAL_HEAD,
    target_id: "tivdoc-v010-synthetic-target",
    fixture_suffix: "fixture010",
    tenant_ordinal: 3,
    capability_state: capabilityState,
    before_restart_rows: beforeRows,
    before_restart_rows_sha256: canonicalSha256(beforeRows),
  };
  const checkpoint = { ...checkpointSeed, checkpoint_sha256: canonicalSha256(checkpointSeed) };
  const before = {
    schema_version: "tivdoc-marathon-v010-postgresql-before-restart-v1",
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL",
    status: "PASS",
    capability_seed: {
      tenant_ordinal: 3,
      tenant_id: capabilityState.tenant_id,
      case_id: capabilityState.case_id,
      capability_count: 14,
      capability_matrix_sha256: "1".repeat(64),
      durable_state_sha256: capabilityState.durable_state_sha256,
    },
    controlled_import: {
      reserve_idempotency_replay: true,
      idempotency_binding_mismatch_rejected: true,
      unpublished_bytes_denied: true,
      stale_fencing_token_rejected: true,
      toctou_reopen_rejected: true,
      exact_bytes_staged: true,
      publication_idempotency_replay: true,
      published_exact_bytes_reopened: true,
      audit_event_rows: 5,
    },
    durable_boundaries: {
      identity_registration_replayed: true,
      identity_rotation_persisted: true,
      stale_identity_rotation_rejected: true,
      owner_binding_replayed: true,
      cross_owner_denied: true,
      privacy_revision_replayed: true,
      privacy_revision_count: 2,
      report_binding_replayed: true,
      report_approval_replayed: true,
      wrong_report_binding_denied: true,
      exact_report_bytes_read: true,
      report_byte_provider: "EXPLICIT_SYNTHETIC_TEST_DOUBLE_NOT_PRODUCT_COMPOSITION",
      managed_storage_proof_claimed: false,
    },
    row_counts: beforeRows,
    connection_attempts: {
      capability_seed: 10,
      service_role: 8,
      administrative_count_probe: 1,
      observed_total: 19,
    },
    checkpoint,
    truth_counters: truthCounters,
  };
  const after = {
    schema_version: "tivdoc-marathon-v010-postgresql-after-restart-v1",
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL",
    status: "PASS",
    restart: {
      externally_managed_genuine_stop_start: true,
      same_cluster_restarted: true,
      all_pre_restart_pools_closed: true,
      fresh_capability_replay_pool: true,
      fresh_boundary_pool: true,
      target_id_unchanged: true,
    },
    durable_replay: {
      capability_count: 14,
      capability_matrix_unchanged: true,
      import_status_reloaded: true,
      import_publication_replayed: true,
      published_exact_bytes_reopened: true,
      pre_revocation_rows_unchanged: true,
      identity_rotation_reloaded: true,
      owner_binding_reloaded: true,
      privacy_revision_replayed: true,
      approved_report_exact_bytes_reloaded: true,
    },
    fail_closed_revocation: {
      identity_revoked: true,
      revoked_identity_rotation_denied: true,
      owner_revoked: true,
      owner_read_denied: true,
      report_revoked: true,
      report_read_denied_before_provider_access: true,
      privacy_completion_revision_persisted: true,
    },
    pre_revocation_row_counts: beforeRows,
    final_row_counts: finalRows,
    connection_attempts: {
      capability_replay: 10,
      service_role: 5,
      administrative_count_probe: 2,
      observed_total: 17,
    },
    checkpoint_sha256: checkpoint.checkpoint_sha256,
    truth_counters: truthCounters,
  };
  const detailed = {
    schema_version: "tivdoc-marathon-v010-postgresql-matrix-v1",
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL",
    receipt_path: POSTGRESQL_MARATHON_RECEIPT_PATH,
    target_id: checkpoint.target_id,
    tenant_ordinal: 3,
    genuine_server_stop_start: true,
    same_cluster_restarted: true,
    pre_restart_pools_closed: true,
    fresh_post_restart_pools: true,
    before_restart: before,
    after_restart: after,
    final_row_counts: finalRows,
    truth_counters: truthCounters,
    status: "PASS",
  };
  const detailedBytes = `${JSON.stringify(detailed, null, 2)}\n`;
  const matrix = {
    schema_version: "tivdoc-real-postgresql-matrix-smoke-v0.9.1",
    status: "PASS",
    postgres_version: "17.11",
    runtime_provenance: {
      source_kind: "edb_authenticode_signed_windows_installer",
      source_sha256: "f104c552d8495a6f20738c2a03f643164bc64b9985363329e314dec24559f0b7",
      source_integrity: "PINNED_SHA256_AND_VALID_AUTHENTICODE",
      distribution_file_count: 20_569,
      distribution_bytes: 948_935_114,
      distribution_tree_sha256: "bd43ff63eac0a3592b495af1a31da9d532ab553846f9a6cf4fab1d76b98cc7d9",
      binary_sha256: {
        postgres: "4125c1e963072d929f6468a449ad184b26d3be7d97cae3181c3d613dace49c8d",
        initdb: "6978bdb96e1e515285eb7bbf8915c4a254644107b1fcb44917e52f707dbe798a",
        pg_ctl: "5afdea4f4860b52cd03cee4c51be5d034a51f7ed63312acc3b6abee9006fa0ba",
        psql: "5bb3fad8a7ff555abff37921a24ee3d9e377c15408b5e7267aa9245596965ca0",
        createdb: "1e8322a28156e0c33a668a2a9a1cf3c8f24e36951e461c8f3bfa60dfb0a80ef9",
        dropdb: "10fabb879e3dcef64f23484b35c508a7665c6a00d7feae0c0cf87ffbe9eb0a30",
        pg_dump: "ff766351cc88b0ea2bc7b6e365777cb51f792b16000688a378f64124810ffa88",
        pg_restore: "ae002028451e79240eaad9838d9eb0b644436a05decb3888468a529bf881ac6c",
        pg_isready: "15242279c66680141586747a475090d70f83874cc19dc63709be6b57b0ba411c",
      },
      authenticode_status: "Valid",
      authenticode_subject: "CN=EnterpriseDB Corporation, O=EnterpriseDB Corporation, L=Wilmington, S=Delaware, C=US",
      authenticode_issuer: "CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=\"DigiCert, Inc.\", C=US",
      authenticode_thumbprint: "7BEDD1269FCCF7A5D95F18274750B79893C06C70",
    },
    migrations: "PASS",
    migration_count: 14,
    capabilities: 14,
    restart: "PASS",
    rls: "PASS",
    atomicity: "PASS",
    concurrency: "PASS",
    backup_restore: "BLOCKED_ENVIRONMENT",
    marathon_v010: "PASS",
    marathon_v010_receipt_path: POSTGRESQL_MARATHON_RECEIPT_PATH,
    marathon_v010_receipt_sha256: sha256(detailedBytes),
    marathon_v010_checkpoint_sha256: checkpoint.checkpoint_sha256,
    marathon_v010_tenant_ordinal: 3,
    real_connection_attempts: 169,
    credentials_recorded: 0,
  };
  return { detailed, detailedBytes, matrix, matrixBytes: `${JSON.stringify(matrix, null, 2)}\n` };
}

function postgresqlRows(privacyRevisions: 2 | 3) {
  return [
    ["private.controlled_import_requests", 1],
    ["private.controlled_import_artifacts", 1],
    ["private.controlled_import_audit_events", 5],
    ["public.controlled_import_publication_markers", 1],
    ["public.product_identity_sessions", 1],
    ["public.product_case_owners", 1],
    ["public.product_privacy_request_versions", privacyRevisions],
    ["public.product_private_report_objects", 1],
  ].map(([table, rowCount], index) => ({
    table: String(table),
    row_count: Number(rowCount),
    state_sha256: String(index + 1).repeat(64),
  }));
}

function exhaustedClosureFixture() {
  const blocked = new Set([3, 10, 27]);
  const failed = new Set([2, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18]);
  const acceptance = Array.from({ length: 39 }, (_, index) => ({
    id: `MC-${String(index + 1).padStart(2, "0")}`,
    status: blocked.has(index + 1) ? "BLOCKED" : failed.has(index + 1) ? "FAIL" : "PASS",
    evidence: `pre-closure-evidence-${index + 1}`,
  }));
  const previousAssessment = {
    schema_version: "tivdoc-full-local-system-marathon-assessment-v0.10.0",
    final_status: "LOCAL_SYSTEM_ENGINEERING_MARATHON_PARTIAL",
    status_constants: [
      "LEGAL_SOURCE_CORPUS_INCOMPLETE",
      "CUSTOMER_SHADOW_NOT_AUTHORIZED",
      "PRODUCTION_DELIVERY_DISABLED",
    ],
    acceptance,
    acceptance_counts: { PASS: 22, FAIL: 14, BLOCKED: 3, SKIPPED_DEPENDENCY: 0, NOT_APPLICABLE: 0 },
    truth_counters: {
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
      FULL_SUITE_RUN_COUNT: 2,
      PRODUCTION_BUILD_RUN_COUNT: 2,
      BROWSER_E2E_FULL_RUN_COUNT: 2,
    },
    wave_receipts: [{
      wave: "W2",
      local_status: "PARTIAL",
      completed: ["durable PostgreSQL report pipeline", "real V0.10 restart matrix"],
      remaining: ["stable product composition not wired"],
      truth: { memory_fallbacks: 0 },
    }],
    commit_checks: [{
      commit_subject: "test(postgres): add V0.10 durable restart matrix",
      checks: ["FC-008"],
      status: "PASS",
    }],
  };
  const currentAssessment = structuredClone(previousAssessment);
  currentAssessment.acceptance[0]!.evidence =
    "attempt HEAD and assessment-only closure HEAD are independently bound by "
    + "git/post-verification-closure.json and assessment/pre-closure-assessment.json";
  currentAssessment.acceptance[10]!.status = "FAIL";
  currentAssessment.acceptance[10]!.evidence =
    "dynamic PostgreSQL regression remains FAILED_LOCAL_WITH_EVIDENCE: POSTGRES_TRANSACTION_FAILED";
  currentAssessment.acceptance[33]!.status = "FAIL";
  currentAssessment.acceptance[33]!.evidence =
    "2/2 complete final attempts exhausted with FAIL: BROWSER_E2E_SERVER_EXITED:1 and POSTGRES_TRANSACTION_FAILED";
  currentAssessment.acceptance_counts.PASS = 20;
  currentAssessment.acceptance_counts.FAIL = 16;
  currentAssessment.wave_receipts[0]!.completed[1] =
    "V0.10 restart-matrix tooling and targeted exact-byte repair";
  currentAssessment.wave_receipts[0]!.remaining.push(
    "complete V0.10 dynamic restart regression remains FAILED_LOCAL_WITH_EVIDENCE",
  );
  currentAssessment.commit_checks.push({
    commit_subject: "fix(postgres): reuse canonical report bytes in matrix",
    checks: ["FC-008", "FC-010"],
    status: "PASS",
  });

  const repairHead = "2".repeat(40);
  const toolingHead = "3".repeat(40);
  const commits = [
    commitReceipt(ATTEMPT_HEAD, ATTEMPT_TREE, "0".repeat(40), "attempt-verified", ["attempt.txt"]),
    commitReceipt(
      repairHead,
      "4".repeat(40),
      ATTEMPT_HEAD,
      "fix(postgres): reuse canonical report bytes in matrix",
      [
        "scripts/canonical-persistence-v091/matrix/marathon-v010.mts",
        "scripts/canonical-persistence-v091/matrix/marathon-v010.test.mjs",
      ],
    ),
    commitReceipt(
      toolingHead,
      "5".repeat(40),
      repairHead,
      "fix(marathon): support exhausted-attempt evidence closure",
      [
        "scripts/full-local-system-marathon/evidence-core.mts",
        "scripts/full-local-system-marathon/run.mts",
        "src/server/system-marathon/evidence-core.test.ts",
      ],
    ),
    commitReceipt(
      FINAL_HEAD,
      FINAL_TREE,
      toolingHead,
      "docs(marathon): record exhausted final verification",
      ["src/server/system-marathon/acceptance-assessment.v0.10.0.json"],
    ),
  ];
  const finalVerification = {
    schema_version: "tivdoc-full-local-system-marathon-final-verification-v0.10.0",
    status: "FAIL",
    verified_head: ATTEMPT_HEAD,
    verified_tree: ATTEMPT_TREE,
    commands: [],
    attempts: [
      { attempt_number: 1, status: "FAIL", verified_head: "9".repeat(40), verified_tree: "8".repeat(40), commands: [] },
      { attempt_number: 2, status: "FAIL", verified_head: ATTEMPT_HEAD, verified_tree: ATTEMPT_TREE, commands: [] },
    ],
    run_counts: { complete_final_attempts: 2 },
    complete_attempt_limit: 2,
  };
  const git = { final_head: FINAL_HEAD, final_tree: FINAL_TREE };
  const previousAssessmentBytes = Buffer.from(`${JSON.stringify(previousAssessment, null, 2)}\n`, "utf8");
  const input = { previousAssessmentBytes, currentAssessment, finalVerification, git, commits };
  const receipt = createPostVerificationClosureReceipt(input);
  return { ...input, receipt };
}

function commitReceipt(
  sha: string,
  tree: string,
  parent: string,
  subject: string,
  changedPaths: readonly string[],
) {
  return {
    sha,
    tree,
    parent,
    subject,
    stable_patch_id: "d".repeat(40),
    diffstat: "synthetic diffstat",
    changed_paths: [...changedPaths],
    focused_checks: [],
  };
}

async function fixture(options: Readonly<{ postgresql?: boolean }> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "tivdoc-marathon-evidence-"));
  temporaryRoots.push(root);
  const acceptance = Array.from({ length: 39 }, (_, index) => ({
    id: `MC-${String(index + 1).padStart(2, "0")}`,
    status: [3, 10, 27].includes(index + 1) ? "BLOCKED" : "PASS",
    evidence: `synthetic-evidence-${index + 1}`,
  }));
  const assessment = {
    schema_version: "tivdoc-full-local-system-marathon-assessment-v0.10.0",
    final_status: "LOCAL_SYSTEM_ENGINEERING_MARATHON_PARTIAL",
    status_constants: [
      "LEGAL_SOURCE_CORPUS_INCOMPLETE",
      "CUSTOMER_SHADOW_NOT_AUTHORIZED",
      "PRODUCTION_DELIVERY_DISABLED",
    ],
    acceptance,
    acceptance_counts: { PASS: 36, FAIL: 0, BLOCKED: 3, SKIPPED_DEPENDENCY: 0, NOT_APPLICABLE: 0 },
    truth_counters: {
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
    },
  };
  const postgresql = options.postgresql ? postgresqlEvidenceFixture() : null;
  const commandIds = [
    "focused_marathon",
    "full_suite",
    "eslint",
    "typescript",
    "production_build",
    "browser_e2e",
    ...(postgresql ? ["postgresql_regression"] : []),
    "prohibited_operation_audit",
    "canonical_reachability",
    "persistence_wiring",
  ];
  const files: Record<string, string | Buffer> = {};
  const commands = commandIds.map((commandId) => {
    const stdout = commandId === "postgresql_regression"
      ? `${JSON.stringify(postgresql!.matrix)}\n`
      : `PASS:${commandId}\n`;
    const stderr = "";
    const stdoutLog = `final-logs/attempt-01/${commandId}.stdout.log`;
    const stderrLog = `final-logs/attempt-01/${commandId}.stderr.log`;
    files[`verification/${stdoutLog}`] = stdout;
    files[`verification/${stderrLog}`] = stderr;
    return {
      command_id: commandId,
      status: "PASS",
      exit_code: 0,
      signal: null,
      elapsed_ms: 1,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_byte_count: Buffer.byteLength(stdout),
      stderr_byte_count: 0,
      stdout_log: stdoutLog,
      stderr_log: stderrLog,
    };
  });
  const attempt = {
    schema_version: "tivdoc-full-local-system-marathon-final-attempt-v0.10.0",
    attempt_number: 1,
    status: "PASS",
    migration_or_persistence_changed: postgresql !== null,
    verified_head: FINAL_HEAD,
    verified_tree: FINAL_TREE,
    commands,
  };
  for (const command of commands) {
    files[`verification/final-attempts/attempt-01/${command.command_id}.json`] = `${JSON.stringify(command)}\n`;
    files[`verification/final-attempts/attempt-01/${command.command_id}.started.json`] = `${JSON.stringify({
      schema_version: "tivdoc-full-local-system-marathon-command-start-v0.10.0",
      attempt_number: 1,
      command_id: command.command_id,
    })}\n`;
  }
  const finalVerification = {
    schema_version: "tivdoc-full-local-system-marathon-final-verification-v0.10.0",
    status: "PASS",
    migration_or_persistence_changed: postgresql !== null,
    verified_head: FINAL_HEAD,
    verified_tree: FINAL_TREE,
    commands,
    attempts: [attempt],
    run_counts: {
      full_suite: 1,
      production_build: 1,
      browser_e2e_full: 1,
      postgresql_regression: postgresql ? 1 : 0,
      complete_final_attempts: 1,
    },
    complete_attempt_limit: 2,
  };
  const snapshot = Buffer.from("synthetic rendered browser snapshot\n", "utf8");
  files["verification/browser/portal-desktop.md"] = snapshot;
  if (postgresql) {
    files["verification/postgresql/matrix-smoke.json"] = postgresql.matrixBytes;
    files["verification/postgresql/marathon-v010-matrix.json"] = postgresql.detailedBytes;
  }
  files["assessment.json"] = `${JSON.stringify(assessment)}\n`;
  files["assessment.md"] = canonicalAcceptanceMarkdown(assessment);
  files["ledgers/marathon.ndjson"] = `${JSON.stringify({ event_id: "MCL-0001", status: "PASS" })}\n`;
  files["ledgers/focused-checks.ndjson"] = `${JSON.stringify({ check_id: "CHECK-0001", status: "PASS" })}\n`;
  files["verification/final-verification.json"] = `${JSON.stringify(finalVerification)}\n`;
  files["verification/final-attempt-ledger.ndjson"] = `${JSON.stringify(attempt)}\n`;
  files["verification/final-attempts/attempt-01/attempt.json"] = `${JSON.stringify(attempt)}\n`;
  files["verification/final-attempts/attempt-01/attempt-start.json"] = `${JSON.stringify({
    schema_version: "tivdoc-full-local-system-marathon-final-attempt-start-v0.10.0",
    attempt_number: 1,
    migration_or_persistence_changed: postgresql !== null,
    verified_head: FINAL_HEAD,
    verified_tree: FINAL_TREE,
    command_ids: commandIds,
  })}\n`;
  files["verification/browser/browser-e2e-receipt.json"] = `${JSON.stringify({
    schema_version: "tivdoc-full-local-system-marathon-browser-e2e-v0.10.0",
    status: "PASS",
    real_browser_cli: true,
    direct_service_shortcuts: false,
    snapshots: [{
      path: "output/playwright/v010-marathon/portal-desktop.md",
      byte_count: snapshot.byteLength,
      sha256: sha256(snapshot),
    }],
  })}\n`;
  files["git/base-final.json"] = `${JSON.stringify({ schema_version: "tivdoc-full-local-system-marathon-git-v0.10.0", branch: "codex/tivdoc-engine-foundation", base_head: "28d18da69108913252736f4b8a39c4ef614984a3", base_tree: "2a9859470003a095521a13e21474a45e1f69620e", final_head: FINAL_HEAD, final_tree: FINAL_TREE, base_is_ancestor: true, worktree_clean: true })}\n`;
  files["git/commits.json"] = `${JSON.stringify({
    schema_version: "tivdoc-marathon-commit-receipts-v0.10.0",
    commits: [{
      sha: FINAL_HEAD,
      tree: FINAL_TREE,
      parent: "28d18da69108913252736f4b8a39c4ef614984a3",
      subject: "test: synthetic evidence fixture",
      stable_patch_id: "d".repeat(40),
      diffstat: " fixture.txt | 1 +",
      changed_paths: ["fixture.txt"],
      focused_checks: [],
    }],
  })}\n`;
  files["git/full.diff"] = "diff --git a/fixture.txt b/fixture.txt\n+synthetic\n";
  files["security/prohibited-operation-scan.json"] = `${JSON.stringify({ schema_version: "tivdoc-marathon-prohibited-operation-scan-v0.10.0", status: "PASS", secret_or_customer_path_matches: 0, deployments: 0, remote_migrations: 0, live_provider_calls: 0, openai_calls: 0, customer_data_reads: 0 })}\n`;
  files["security/prohibited-operation-audit.json"] = `${JSON.stringify({ schema_version: "tivdoc-full-local-system-marathon-security-audit-v0.10.0", status: "PASS", finding_count: 0, findings: [], truth_counters: { customer_data_reads: 0, deployments: 0, remote_migrations: 0, live_provider_calls: 0, openai_calls: 0 } })}\n`;
  files["owner/action-index.json"] = `${JSON.stringify({
    schema_version: "tivdoc-owner-action-index-v0.10.0",
    baseline_truth: {
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
    },
    groups: Array.from({ length: 11 }, (_, index) => ({
      group_id: `OA-${String(index + 1).padStart(2, "0")}`,
      actions: [{ status: "BLOCKED_EXTERNAL", locally_solvable_engineering: false, evidence_required: ["real external evidence"] }],
    })),
  })}\n`;

  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const names = Object.keys(files).sort();
  const manifest = await createEvidenceManifest(root, names);
  await writeFile(path.join(root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const archive = path.join(root, "marathon-evidence-v0.10.0.zip");
  await writeDeterministicStoreZip({ root, output: archive, entries: [...names, "evidence-manifest.json"].sort() });
  return { root, archive, assessment, finalVerification, manifest };
}

async function rebuild(value: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const names = value.manifest.payload_files.map((entry) => entry.path);
  const manifest = await createEvidenceManifest(value.root, names);
  value.manifest = manifest;
  await writeFile(path.join(value.root, "evidence-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(value.archive);
  await writeDeterministicStoreZip({ root: value.root, output: value.archive, entries: [...names, "evidence-manifest.json"].sort() });
}

describe("Marathon independent evidence verifier", () => {
  it("accepts only the fixed three-commit exhausted-attempt closure", () => {
    const value = exhaustedClosureFixture();
    expect(() => verifyPostVerificationClosure(value)).not.toThrow();
    expect(value.receipt.final_verification_status).toBe("FAIL");
    expect(value.receipt.complete_final_attempts).toBe(2);
  });

  it("rejects a closure unless two failed complete attempts are exhausted", () => {
    const value = exhaustedClosureFixture();
    value.finalVerification.status = "PASS";
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_REQUIRES_EXHAUSTED_FAILURE");

    const count = exhaustedClosureFixture();
    count.finalVerification.attempts.pop();
    count.finalVerification.run_counts.complete_final_attempts = 1;
    expect(() => verifyPostVerificationClosure(count)).toThrow("MARATHON_CLOSURE_REQUIRES_EXHAUSTED_FAILURE");
  });

  it("rejects a non-linear, reordered or renamed post-attempt suffix", () => {
    const value = exhaustedClosureFixture();
    value.commits[2]!.parent = ATTEMPT_HEAD;
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");

    const renamed = exhaustedClosureFixture();
    renamed.commits[1]!.subject = "fix(postgres): almost the expected repair";
    expect(() => verifyPostVerificationClosure(renamed)).toThrow("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");

    const reordered = exhaustedClosureFixture();
    [reordered.commits[1], reordered.commits[2]] = [reordered.commits[2]!, reordered.commits[1]!];
    expect(() => verifyPostVerificationClosure(reordered)).toThrow("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");
  });

  it("rejects any path outside the three fixed closure path sets", () => {
    const value = exhaustedClosureFixture();
    value.commits[3]!.changed_paths.push("src/server/system-marathon/extra.json");
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_COMMIT_SUFFIX_INVALID");
  });

  it("rejects a pre-closure assessment whose exact byte hash is not bound", () => {
    const value = exhaustedClosureFixture();
    value.previousAssessmentBytes = Buffer.concat([value.previousAssessmentBytes, Buffer.from(" ")]);
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_RECEIPT_INVALID");
  });

  it("rejects assessment inflation beyond MC-01, MC-11, MC-34 and exact counts", () => {
    const value = exhaustedClosureFixture();
    value.currentAssessment.acceptance[18]!.evidence = "unapproved semantic change";
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  });

  it("requires MC-11 and MC-34 to remain honest FAIL after the repair", () => {
    const value = exhaustedClosureFixture();
    value.currentAssessment.acceptance[10]!.status = "PASS";
    value.currentAssessment.acceptance_counts.PASS = 21;
    value.currentAssessment.acceptance_counts.FAIL = 15;
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");

    const mc34 = exhaustedClosureFixture();
    mc34.currentAssessment.acceptance[33]!.status = "PASS";
    mc34.currentAssessment.acceptance_counts.PASS = 21;
    mc34.currentAssessment.acceptance_counts.FAIL = 15;
    expect(() => verifyPostVerificationClosure(mc34)).toThrow("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  });

  it("rejects false MC evidence that omits the recorded exhausted-attempt failures", () => {
    const value = exhaustedClosureFixture();
    value.currentAssessment.acceptance[33]!.evidence = "2/2 attempts passed after repair";
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_ASSESSMENT_EVIDENCE_INVALID");

    const mc01 = exhaustedClosureFixture();
    mc01.currentAssessment.acceptance[0]!.evidence = "the current HEAD is clean";
    expect(() => verifyPostVerificationClosure(mc01)).toThrow("MARATHON_CLOSURE_ASSESSMENT_EVIDENCE_INVALID");

    const mc11 = exhaustedClosureFixture();
    mc11.currentAssessment.acceptance[10]!.evidence = "the targeted repair proves PostgreSQL PASS";
    expect(() => verifyPostVerificationClosure(mc11)).toThrow("MARATHON_CLOSURE_ASSESSMENT_EVIDENCE_INVALID");
  });

  it("requires the exact W2 and commit-check repair disclosures", () => {
    const value = exhaustedClosureFixture();
    value.currentAssessment.wave_receipts[0]!.remaining.pop();
    expect(() => verifyPostVerificationClosure(value)).toThrow("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");

    const checks = exhaustedClosureFixture();
    checks.currentAssessment.commit_checks.at(-1)!.checks = ["FC-008"];
    expect(() => verifyPostVerificationClosure(checks)).toThrow("MARATHON_CLOSURE_ASSESSMENT_DELTA_INVALID");
  });

  it("recomputes every payload, final log, receipt and deterministic archive", async () => {
    const value = await fixture();
    const receipt = await verifyEvidenceDirectory(value);
    expect(receipt.status).toBe("PASS");
    expect(receipt.acceptance_pass).toBe(36);
    expect(receipt.acceptance_non_pass).toBe(3);
  });

  it("verifies the current matrix-smoke receipt and detailed V0.10 PostgreSQL proof", async () => {
    const value = await fixture({ postgresql: true });
    const receipt = await verifyEvidenceDirectory(value);
    expect(receipt.status).toBe("PASS");
  });

  it("rejects the historical 24/24 acceptance receipt as current PostgreSQL regression proof", async () => {
    const value = await fixture({ postgresql: true });
    await writeFile(path.join(value.root, "verification", "postgresql", "matrix-smoke.json"), `${JSON.stringify({
      schema_version: "tivdoc-canonical-postgresql-dynamic-acceptance-v0.9.1",
      status: "PASS",
      acceptance_result: "ACCEPTANCE_24_OF_24_PASS",
      pc_22: "PC-22_PASS",
      counts: { total: 24, pass: 24, fail: 0, skipped: 0 },
    })}\n`);
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("POSTGRESQL_MATRIX_RECEIPT_FAILED");
  });

  it("rejects a detailed PostgreSQL receipt that drops a fail-closed revocation proof", async () => {
    const value = await fixture({ postgresql: true });
    const detailedPath = path.join(value.root, "verification", "postgresql", "marathon-v010-matrix.json");
    const matrixPath = path.join(value.root, "verification", "postgresql", "matrix-smoke.json");
    const detailed = JSON.parse(await readFile(detailedPath, "utf8"));
    detailed.after_restart.fail_closed_revocation.owner_read_denied = false;
    const detailedBytes = `${JSON.stringify(detailed, null, 2)}\n`;
    await writeFile(detailedPath, detailedBytes);
    const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
    matrix.marathon_v010_receipt_sha256 = sha256(detailedBytes);
    await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("POSTGRESQL_V010_REVOCATION_INVALID");
  });

  it("rejects case-folded duplicate and self-referential payload paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tivdoc-marathon-evidence-paths-"));
    temporaryRoots.push(root);
    await writeFile(path.join(root, "a.json"), "{}\n");
    await writeFile(path.join(root, "A.json"), "{}\n");
    await expect(createEvidenceManifest(root, ["a.json", "A.json"])).rejects.toThrow("DUPLICATE_NORMALIZED_PATH");
    await expect(createEvidenceManifest(root, ["evidence-manifest.json"])).rejects.toThrow("PAYLOAD_PATH_UNSAFE");
  });

  it("rejects a false external-gate PASS even when hashes are rebuilt", async () => {
    const value = await fixture();
    const assessment = structuredClone(value.assessment);
    assessment.acceptance[2]!.status = "PASS";
    assessment.acceptance_counts.PASS += 1;
    assessment.acceptance_counts.BLOCKED -= 1;
    await writeFile(path.join(value.root, "assessment.json"), `${JSON.stringify(assessment)}\n`);
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("BLOCKED_GATE_FALSE_PASS:MC-03");
  });

  it("rejects truth-inflated run counts even when payload hashes are rebuilt", async () => {
    const value = await fixture();
    const assessment = structuredClone(value.assessment);
    assessment.truth_counters.FULL_SUITE_RUN_COUNT = 2;
    await writeFile(path.join(value.root, "assessment.json"), `${JSON.stringify(assessment)}\n`);
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("ASSESSMENT_RUN_COUNT_CONTRADICTION");
  });

  it("rejects a semantically mismatched final log even when manifest hashes are rebuilt", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "verification", "final-logs", "attempt-01", "full_suite.stdout.log"), "tampered\n");
    await rebuild(value);
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("FINAL_LOG_HASH_MISMATCH");
  });

  it("rejects byte tampering before interpreting claims", async () => {
    const value = await fixture();
    await writeFile(path.join(value.root, "assessment.json"), "{}\n");
    await expect(verifyEvidenceDirectory(value)).rejects.toThrow("MANIFEST_RECOMPUTE_MISMATCH");
    expect((await readFile(value.archive)).byteLength).toBeGreaterThan(0);
  });
});
