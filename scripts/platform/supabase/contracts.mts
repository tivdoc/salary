export const SUPABASE_HARNESS_SCHEMA = "tivdoc-isolated-supabase-harness-v0.10.0" as const;
export const SUPABASE_BLOCKER_SCHEMA = "tivdoc-isolated-supabase-blocker-receipt-v0.10.0" as const;
export const SUPABASE_EXPECTED_MATRIX_SCHEMA = "tivdoc-isolated-supabase-expected-matrix-v0.10.0" as const;

export type SupabasePlatformCheckId =
  | "SUPABASE_CLEAN_MIGRATION_CHAIN"
  | "SUPABASE_UPGRADE_MIGRATION_CHAIN"
  | "SUPABASE_POSTGREST_REACHABILITY"
  | "SUPABASE_JWT_CLAIM_PROPAGATION"
  | "SUPABASE_RLS_THROUGH_PLATFORM_API"
  | "SUPABASE_STORAGE_PRIVATE_POLICY"
  | "SUPABASE_POOLER_SESSION_MODE"
  | "SUPABASE_POOLER_TRANSACTION_MODE"
  | "SUPABASE_CLEAN_TEARDOWN";

export type ExpectedSupabasePlatformCheck = Readonly<{
  check_id: SupabasePlatformCheckId;
  required_result: "PASS";
  proof_boundary: "SUPABASE_PLATFORM_API" | "SUPABASE_PLATFORM_RUNTIME";
  plain_postgresql_substitution_allowed: false;
  required_evidence: readonly string[];
}>;

export const EXPECTED_SUPABASE_PLATFORM_MATRIX: readonly ExpectedSupabasePlatformCheck[] = Object.freeze([
  Object.freeze({
    check_id: "SUPABASE_CLEAN_MIGRATION_CHAIN",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_RUNTIME",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["fresh generated project", "complete ordered migration chain", "zero skipped migrations"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_UPGRADE_MIGRATION_CHAIN",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_RUNTIME",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["baseline state", "forward migration application", "schema reconciliation"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_POSTGREST_REACHABILITY",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_API",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["owned loopback endpoint", "PostgREST response", "no remote host"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_JWT_CLAIM_PROPAGATION",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_API",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["locally issued synthetic JWT", "server-observed claims", "expired and malformed denial"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_RLS_THROUGH_PLATFORM_API",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_API",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["owner allow", "cross-owner concealment", "anonymous denial", "service-key bypass excluded from proof"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_STORAGE_PRIVATE_POLICY",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_API",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["private bucket", "public read denial", "owner-scoped write/read", "cross-owner concealment"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_POOLER_SESSION_MODE",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_RUNTIME",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["local pooler endpoint", "session-mode compatibility receipt"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_POOLER_TRANSACTION_MODE",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_RUNTIME",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["local pooler endpoint", "transaction-mode compatibility receipt"]),
  }),
  Object.freeze({
    check_id: "SUPABASE_CLEAN_TEARDOWN",
    required_result: "PASS",
    proof_boundary: "SUPABASE_PLATFORM_RUNTIME",
    plain_postgresql_substitution_allowed: false,
    required_evidence: Object.freeze(["owned generated root", "local services stopped", "no remote mutation"]),
  }),
]);

export type SupabaseEnvironmentBlockerCode =
  | "SUPABASE_CLI_NOT_FOUND"
  | "SUPABASE_CONTAINER_ENGINE_NOT_FOUND"
  | "SUPABASE_REMOTE_CONTAINER_ENGINE_PRESENT"
  | "SUPABASE_REQUIRED_CACHED_IMAGES_MISSING"
  | "SUPABASE_MIGRATION_CHAIN_NOT_FOUND"
  | "SUPABASE_REMOTE_CREDENTIAL_ENV_PRESENT"
  | "SUPABASE_REMOTE_OR_LINKED_PROJECT_PRESENT";

export type SupabaseEnvironmentBlocker = Readonly<{
  code: SupabaseEnvironmentBlockerCode;
  exact_reason: string;
  operator_action: string;
}>;

export type SupabaseEnvironmentDetection = Readonly<{
  schema: typeof SUPABASE_HARNESS_SCHEMA;
  capability_id: "MC-03";
  status: "BLOCKED_ENVIRONMENT" | "READY_FOR_EXPLICIT_LOCAL_RUN";
  safety: Readonly<{
    loopback_only: true;
    remote_project_access_allowed: false;
    remote_migration_allowed: false;
    network_pull_allowed: false;
    customer_data_allowed: false;
  }>;
  discovered: Readonly<{
    supabase_cli: boolean;
    container_engine: "docker" | "podman" | null;
    cached_image_families_complete: boolean;
    migration_count: number;
    linked_project_marker: boolean;
    remote_credential_environment: boolean;
  }>;
  blockers: readonly SupabaseEnvironmentBlocker[];
  proof_distinction: Readonly<{
    portable_postgresql_v091: "PROVEN_SEPARATELY_NOT_SUPABASE_PLATFORM_PROOF";
    isolated_supabase_platform: "NOT_PERFORMED";
    substitution_allowed: false;
  }>;
}>;

export type SupabaseBlockerReceipt = Readonly<{
  schema: typeof SUPABASE_BLOCKER_SCHEMA;
  capability_id: "MC-03";
  operation: "detect" | "bootstrap" | "verify" | "teardown";
  status: "BLOCKED";
  reason_class: "EXTERNAL_OR_HUMAN_BLOCKED";
  detection: SupabaseEnvironmentDetection;
  expected_matrix: Readonly<{
    schema: typeof SUPABASE_EXPECTED_MATRIX_SCHEMA;
    results: readonly Readonly<{
      check_id: SupabasePlatformCheckId;
      status: "BLOCKED_ENVIRONMENT";
      plain_postgresql_substitution_used: false;
    }>[];
  }>;
  dependent_acceptance: readonly ["MC-03"];
  reproducible_runner: Readonly<{
    generated_owned_root_required: true;
    explicit_local_sentinel: "TIVDOC_ISOLATED_SUPABASE_EXECUTION=LOCAL_SYNTHETIC_ONLY";
    commands: Readonly<{
      detect: string;
      bootstrap: string;
      verify: string;
      teardown: string;
    }>;
  }>;
  independent_work_may_continue: true;
  live_provider_calls: 0;
  remote_migrations: 0;
  deployments: 0;
}>;

export function buildSupabaseBlockerReceipt(
  operation: SupabaseBlockerReceipt["operation"],
  detection: SupabaseEnvironmentDetection,
): SupabaseBlockerReceipt {
  if (detection.status !== "BLOCKED_ENVIRONMENT") throw new Error("SUPABASE_BLOCKER_RECEIPT_REQUIRES_BLOCKED_ENVIRONMENT");
  return Object.freeze({
    schema: SUPABASE_BLOCKER_SCHEMA,
    capability_id: "MC-03",
    operation,
    status: "BLOCKED",
    reason_class: "EXTERNAL_OR_HUMAN_BLOCKED",
    detection,
    expected_matrix: Object.freeze({
      schema: SUPABASE_EXPECTED_MATRIX_SCHEMA,
      results: Object.freeze(EXPECTED_SUPABASE_PLATFORM_MATRIX.map((entry) => Object.freeze({
        check_id: entry.check_id,
        status: "BLOCKED_ENVIRONMENT" as const,
        plain_postgresql_substitution_used: false as const,
      }))),
    }),
    dependent_acceptance: Object.freeze(["MC-03"] as const),
    reproducible_runner: Object.freeze({
      generated_owned_root_required: true,
      explicit_local_sentinel: "TIVDOC_ISOLATED_SUPABASE_EXECUTION=LOCAL_SYNTHETIC_ONLY",
      commands: Object.freeze({
        detect: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/supabase/detect.mts",
        bootstrap: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/supabase/bootstrap.mts",
        verify: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/supabase/verify.mts",
        teardown: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/platform/supabase/teardown.mts",
      }),
    }),
    independent_work_may_continue: true,
    live_provider_calls: 0,
    remote_migrations: 0,
    deployments: 0,
  });
}
