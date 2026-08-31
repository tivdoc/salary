import type { PersistenceEnvironmentReceipt } from "./isolated-environment.ts";

export type IsolatedPostgresVerificationReceipt = Readonly<{
  schema_version: "tivdoc-isolated-postgres-verification-v1";
  status: "SKIPPED_BLOCKED";
  blocker_code: "SKIPPED_ENVIRONMENT_DEPENDENCY" | "DYNAMIC_POSTGRESQL_VERIFICATION_HARNESS_REQUIRED";
  attempted_action: string;
  detector_capability: PersistenceEnvironmentReceipt["capability"];
  database_connection_attempts: 0;
  database_semantics_verified: false;
  static_wiring_verified_separately: true;
  driver_harness_verified: false;
  affected_capabilities: readonly string[];
  next_environment_action: string;
  external_connections: 0;
  remote_migrations: 0;
  customer_data_reads: 0;
}>;

/**
 * Dynamic evidence must exercise the real application PostgreSQL adapters.
 * This environment gate never substitutes psql, a recording driver or the
 * memory adapter for application PostgreSQL execution proof.
 */
export function verifyIsolatedPostgresAvailability(
  environment: PersistenceEnvironmentReceipt,
): IsolatedPostgresVerificationReceipt {
  const environmentBlocked = environment.capability === "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED";
  return Object.freeze({
    schema_version: "tivdoc-isolated-postgres-verification-v1",
    status: "SKIPPED_BLOCKED",
    blocker_code: environmentBlocked
      ? "SKIPPED_ENVIRONMENT_DEPENDENCY"
      : "DYNAMIC_POSTGRESQL_VERIFICATION_HARNESS_REQUIRED",
    attempted_action: environmentBlocked
      ? "Inspected only local binaries, cached local images and the three explicit Tivdoc isolated-target variables; no approved loopback target plus psql was available, so no connection was attempted."
      : "Validated an explicitly supplied loopback disposable target, but did not connect because this environment gate cannot substitute for the complete V0.9 clean/upgrade/RLS/concurrency/restart/rollback/backup harness.",
    detector_capability: environment.capability,
    database_connection_attempts: 0,
    database_semantics_verified: false,
    static_wiring_verified_separately: true,
    driver_harness_verified: false,
    affected_capabilities: Object.freeze([
      "migration_apply_and_upgrade",
      "application_postgresql_restart_and_replay",
      "rls_actor_matrix",
      "failure_atomicity",
      "approval_race_safety",
      "backup_restore",
    ]),
    next_environment_action: environmentBlocked
      ? "Provision an explicitly disposable loopback-only PostgreSQL target named tivdoc_isolated_<random>, its matching target ID and ownership token; then run the V0.9 dynamic PostgreSQL acceptance harness."
      : "Run the complete V0.9 dynamic PostgreSQL acceptance harness against this validated disposable target.",
    external_connections: 0,
    remote_migrations: 0,
    customer_data_reads: 0,
  });
}
