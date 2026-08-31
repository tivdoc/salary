import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CANONICAL_REPOSITORY_MAPPING, REPOSITORY_ENTITIES } from "../../../src/server/platform/persistence/contracts.ts";

const repoRoot = path.resolve(".");
const migrationPath = path.join(repoRoot, "supabase", "migrations", "202608310001_engine_platform_persistence.sql");
const baselinePath = path.join(repoRoot, "supabase", "migrations", "202608290001_engine_persistence_foundation.sql");
const amendmentPath = path.join(repoRoot, "scripts", "canonical-persistence-v091", "foundation", "migration-portability-amendment.json");
const contractPath = path.join(repoRoot, "src", "engine", "wave4", "execution-contract.v0.7.0.json");

const [migration, baselineBytes, contractRaw, amendmentRaw] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(baselinePath),
  readFile(contractPath, "utf8"),
  readFile(amendmentPath, "utf8"),
]);
const contract = JSON.parse(contractRaw) as {
  capability_preflight: Record<string, unknown>;
  global_boundaries: Record<string, number>;
  worker_allowlists: Record<string, string[]>;
};
const amendment = JSON.parse(amendmentRaw) as Record<string, unknown>;

const requiredSql = [
  "engine_case_state",
  "engine_case_lifecycle_revisions",
  "engine_payment_evidence_refs",
  "engine_canonical_fact_versions",
  "engine_rule_input_versions",
  "engine_legal_version_pins",
  "engine_analysis_stage_versions",
  "engine_topic_result_versions",
  "engine_calculation_trace_versions",
  "engine_report_versions",
  "engine_review_task_versions",
  "engine_idempotency_records",
  "engine_durable_jobs",
  "engine_job_history",
  "engine_outbox_events",
  "engine_logical_effect_receipts",
  "engine_platform_audit_events",
  "engine_object_write_sagas",
  "for update skip locked",
  "fencing_token = job.fencing_token + 1",
  "fencing_token = event.fencing_token + 1",
  "finish_engine_platform_job",
  "logical effect hash mismatch",
  "on delete restrict",
  "enable row level security",
  "reject_engine_append_only_mutation",
] as const;

const assertions = {
  exact_repository_entity_count: CANONICAL_REPOSITORY_MAPPING.length === REPOSITORY_ENTITIES.length,
  repository_entities_unique: new Set(CANONICAL_REPOSITORY_MAPPING.map((item) => item.entity)).size === REPOSITORY_ENTITIES.length,
  repository_fields_complete: CANONICAL_REPOSITORY_MAPPING.every((item) => item.primary_key.length > 0 && item.hash_column.length > 0 && item.authorized_actors.length > 0),
  forward_migration_tokens_present: requiredSql.every((token) => migration.toLowerCase().includes(token.toLowerCase())),
  historical_migration_portability_amendment_pinned:
    sha256(normalizeLineEndings(baselineBytes)) === "e4e036fd3c01134a7e449cf50d586d4bf6790c0e00a4f62ad0a898acfec31373"
    && amendment.baseline_sha256_normalized_lf === "cc1b809a012563ca1bc0214ccbd478af988300439e54f0b70968623e2dc4abc1"
    && amendment.amended_sha256_normalized_lf === "e4e036fd3c01134a7e449cf50d586d4bf6790c0e00a4f62ad0a898acfec31373"
    && amendment.sql_semantics_changed === false
    && amendment.status === "PINNED_ONE_TIME_AMENDMENT",
  p1_allowlist_frozen: contract.worker_allowlists.P1?.includes("supabase/migrations/*_engine_platform_*.sql") === true,
  disposable_database_unproven: contract.capability_preflight.disposable_local_database_proven === false,
  prohibited_boundary_count_zero: Object.values(contract.global_boundaries).every((count) => count === 0),
};

const passed = Object.values(assertions).every(Boolean);
const result = {
  schema_version: "tivdoc-v0.7-p1-static-verification-v1",
  status: passed ? "PASS_STATIC_AND_CONTRACT" : "FAIL_STATIC_AND_CONTRACT",
  capability_level: "static_contract",
  assertions,
  repository_mapping_count: CANONICAL_REPOSITORY_MAPPING.length,
  migration: {
    path: path.relative(repoRoot, migrationPath).replaceAll("\\", "/"),
    sha256: sha256(normalizeLineEndings(Buffer.from(migration, "utf8"))),
    required_token_count: requiredSql.length,
  },
  acceptance: {
    "V07-P1-TRANSACTION": "LOCALLY_VERIFIED_IN_MEMORY_DURABLE_SHAPE",
    "V07-P1-IDEMPOTENCY": "LOCALLY_VERIFIED_IN_MEMORY_DURABLE_SHAPE",
    "V07-P1-JOBS": "LOCALLY_VERIFIED_IN_MEMORY_DURABLE_SHAPE",
    "V07-P1-OUTBOX": "LOCALLY_VERIFIED_IN_MEMORY_DURABLE_SHAPE",
    "V07-P1-MIGRATION": "STATIC_VERIFIED_DYNAMIC_PENDING",
  },
  blocker_receipts: [
    {
      item_id: "P1_DYNAMIC_POSTGRESQL_VERIFICATION",
      status: "SKIPPED_BLOCKED",
      blocker_code: "SKIPPED_ENVIRONMENT_DEPENDENCY",
      attempted_action: "Consumed frozen capability preflight; no connection attempted because no disposable local target is proven.",
      evidence: contract.capability_preflight,
      safe_fallback_completed: "Forward-only migration, local durable-shaped adapters, concurrency tests and static verifier completed.",
      affected_acceptance_ids: ["V07-P1-TRANSACTION", "V07-P1-IDEMPOTENCY", "V07-P1-JOBS", "V07-P1-OUTBOX", "V07-P1-MIGRATION"],
      direct_downstream_impact: "PostgreSQL transaction, RLS, migration apply/upgrade, rollback and crash/restart claims remain unproven.",
      next_human_or_environment_action: "Provision an explicitly disposable local PostgreSQL/Supabase instance and follow the runbook without linked or remote credentials.",
    },
  ],
  external_connections: 0,
  customer_data_reads: 0,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = passed ? 0 : 1;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeLineEndings(bytes: Uint8Array): Uint8Array {
  return Buffer.from(Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}
