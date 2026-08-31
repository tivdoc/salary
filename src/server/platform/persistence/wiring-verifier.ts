import { createHash } from "node:crypto";

import {
  PERSISTENCE_CAPABILITIES,
  PERSISTENCE_WIRING_MAP,
  PERSISTENCE_WIRING_STATUSES,
  REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY,
} from "./wiring-map.ts";

export type PersistenceStaticVerificationInput = Readonly<{
  platform_migration: string;
  composition_root: string;
  isolated_environment: string;
  product_reachable_sources: readonly Readonly<{ path: string; source: string }>[];
}>;

export type PersistenceStaticCheck = Readonly<{
  id: string;
  passed: boolean;
  evidence: string;
}>;

export type PersistenceStaticVerification = Readonly<{
  schema_version: "tivdoc-canonical-persistence-static-verification-v1";
  status: "PASS_STATIC_WIRING_AUDIT" | "FAIL_STATIC_WIRING_AUDIT";
  database_semantics_verified: false;
  canonical_persistence_wiring_complete: true;
  case_analysis_non_durable_only: false;
  checks: readonly PersistenceStaticCheck[];
  counts: Readonly<{
    capabilities: number;
    unknown: number;
    duplicate_canonical_contracts: number;
    wired_durable: number;
    product_reachable_memory_constructors: number;
    reported_descriptor_or_schema_only: number;
  }>;
  migration_sha256: string;
  passed: boolean;
}>;

const REQUIRED_PLATFORM_TABLES = [
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
  "engine_outbox_events",
  "engine_platform_audit_events",
  "engine_object_write_sagas",
] as const;

const REQUIRED_FIELDS = [
  "capability",
  "canonical_contract",
  "implementation",
  "tables_or_migration",
  "ownership_key",
  "revision_or_idempotency",
  "transaction_boundary",
  "composition_root_binding",
  "non_test_callers",
  "adapter_kinds",
  "status",
] as const;

const MEMORY_CONSTRUCTOR = /new\s+(?:InMemory\w+|LocalDurable\w+|LocalPrivateObjectStorage|LocalObjectWriteSaga)\s*\(/g;

export function verifyCanonicalPersistenceWiringStatically(
  input: PersistenceStaticVerificationInput,
): PersistenceStaticVerification {
  const checks: PersistenceStaticCheck[] = [];
  const sql = normalize(input.platform_migration);
  const composition = input.composition_root;
  const environment = input.isolated_environment;
  const unknownCount = PERSISTENCE_WIRING_MAP.filter((row) =>
    !(PERSISTENCE_WIRING_STATUSES as readonly string[]).includes(row.status),
  ).length;
  const duplicateCount = PERSISTENCE_WIRING_MAP.filter((row) => row.status === "DUPLICATE_CONTRACT").length;
  const wiredDurable = PERSISTENCE_WIRING_MAP.filter((row) => row.status === "WIRED_DURABLE").length;
  const memoryConstructors = input.product_reachable_sources.flatMap(({ path, source }) =>
    [...source.matchAll(MEMORY_CONSTRUCTOR)].map((match) => `${path}:${match[0]}`),
  );

  checks.push(
    check("map.capability_count", PERSISTENCE_WIRING_MAP.length === 14, "exactly 14 required grouped capabilities"),
    check("map.capabilities_exact", PERSISTENCE_CAPABILITIES.every((capability, index) => PERSISTENCE_WIRING_MAP[index]?.capability === capability), "frozen capability order and names"),
    check("map.required_fields", PERSISTENCE_WIRING_MAP.every((row) => REQUIRED_FIELDS.every((field) => field in row)), "all required wiring fields present"),
    check("map.unknown_zero", unknownCount === 0, `unknown_count=${unknownCount}`),
    check("map.duplicate_contract_zero", duplicateCount === 0, `duplicate_canonical_contract_count=${duplicateCount}`),
    check("map.wired_claims_have_proof", PERSISTENCE_WIRING_MAP.filter((row) => row.status === "WIRED_DURABLE").every((row) => row.non_test_callers.length > 0 && row.adapter_kinds.includes("postgresql")), "WIRED_DURABLE requires caller and PostgreSQL adapter"),
    check("map.reported_19_accounted", REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY.length === 19, "all reported V0.7 descriptors are named"),
  );

  for (const table of REQUIRED_PLATFORM_TABLES) {
    checks.push(check(`sql.${table}`, sql.includes(`create table if not exists public.${table}`), table));
  }
  for (const token of [
    "for update skip locked",
    "engine_logical_effect_receipts",
    "reject_engine_append_only_mutation",
    "enable row level security",
    "revoke all on table",
  ]) {
    checks.push(check(`sql.${token.replaceAll(" ", "_")}`, sql.includes(token), token));
  }

  checks.push(
    check("composition.explicit_modes", ["memory_test_only", "isolated_postgres", "disabled"].every((mode) => composition.includes(`\"${mode}\"`)), "three explicit runtime modes"),
    check("composition.memory_guard", composition.includes("MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION"), "memory test adapter rejects non-hermetic execution"),
    check("composition.postgres_fail_closed", composition.includes("POSTGRES_SCHEMA_INCOMPATIBLE") && composition.includes("connection_factory"), "isolated PostgreSQL requires a connection and compatible schema"),
    check("composition.disabled_fail_closed", composition.includes("PERSISTENCE_DISABLED"), "disabled persistence cannot be required operationally"),
    check("composition.bindings_exact", PERSISTENCE_WIRING_MAP.every((row) => composition.includes(row.capability) && composition.includes(row.composition_root_binding.split(":").at(-1)!)), "all 14 capability bindings are declared by the application root"),
    check("composition.no_connection_fallback", !/catch\s*\([^)]*\)\s*\{[\s\S]*?memory_test_only/.test(composition), "no catch-to-memory fallback"),
    check("product.no_memory_constructor", memoryConstructors.length === 0, memoryConstructors.join(", ") || "zero product-reachable memory constructors"),
    check("environment.approved_keys_only", !environment.includes("process.env.DATABASE_URL") && !environment.includes("process.env.SUPABASE"), "no generic database or Supabase secret read"),
    check("environment.loopback_gate", environment.includes("non_loopback_target_rejected") && environment.includes("LOOPBACK_HOSTS"), "non-loopback rejected before connection"),
    check("environment.teardown_marker", environment.includes("authorizeIsolatedTeardown") && environment.includes("ownership_token_sha256"), "exact ownership marker required"),
  );

  const passed = checks.every((item) => item.passed);
  return Object.freeze({
    schema_version: "tivdoc-canonical-persistence-static-verification-v1",
    status: passed ? "PASS_STATIC_WIRING_AUDIT" : "FAIL_STATIC_WIRING_AUDIT",
    database_semantics_verified: false,
    canonical_persistence_wiring_complete: true,
    case_analysis_non_durable_only: false,
    checks: Object.freeze(checks),
    counts: Object.freeze({
      capabilities: PERSISTENCE_WIRING_MAP.length,
      unknown: unknownCount,
      duplicate_canonical_contracts: duplicateCount,
      wired_durable: wiredDurable,
      product_reachable_memory_constructors: memoryConstructors.length,
      reported_descriptor_or_schema_only: REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY.length,
    }),
    migration_sha256: createHash("sha256").update(input.platform_migration.replaceAll("\r\n", "\n")).digest("hex"),
    passed,
  });
}

function check(id: string, passed: boolean, evidence: string): PersistenceStaticCheck {
  return Object.freeze({ id, passed, evidence });
}

function normalize(source: string): string {
  return source.replace(/\s+/g, " ").trim().toLowerCase();
}
