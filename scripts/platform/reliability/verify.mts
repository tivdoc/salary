import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });

try {
  const backup = await server.ssrLoadModule("/src/server/platform/backup/backup-service.ts");
  const operations = await server.ssrLoadModule("/src/server/platform/operations/controls.ts");
  const observability = await server.ssrLoadModule("/src/server/platform/observability/safe-observability.ts");
  const health = await server.ssrLoadModule("/src/server/platform/observability/health.ts");

  const bundle = await backup.createLocalBackup(
    new backup.InMemoryBackupSource([{ path: "state/jobs.json", bytes: new TextEncoder().encode("[]") }]),
    { backup_id: "backup_verify_0001", created_at: "2026-08-30T00:00:00.000Z", watermark: "watermark_verify_01", key_version: "keyversion_verify_1" },
  );
  const backupResult = backup.verifyLocalBackup(bundle, "keyversion_verify_1");
  const restorePlan = backup.planLocalRestore(bundle, "local_memory_staging", "keyversion_verify_1");
  const restoreReceipt = await backup.restoreLocalFixture(bundle, new backup.InMemoryRestoreTarget(), "keyversion_verify_1");
  const operator = new operations.LocalDryRunOperator(() => "2026-08-30T00:00:00.000Z");
  const operatorPlan = operator.execute({
    schema_version: "tivdoc-operator-command-v0.7.0",
    action: "backup_drill",
    actor_id: "actor_verify_001",
    reason_code: "BACKUP_DRILL_SCHEDULED",
    idempotency_key: "idem_verify_0001",
    correlation_id: "request_verify_1",
    dry_run: true,
    target_ref: "fixture_verify_1",
  });
  const metrics = new observability.SafeMetricsRegistry();
  metrics.record("backup_drill_status", "gauge", backupResult.valid ? 1 : 0, { outcome: backupResult.valid ? "succeeded" : "failed" });
  const readiness = health.coarseReadiness([
    { dependency: "local_backup", available: backupResult.valid, required_for_readiness: true },
    { dependency: "persistence", available: false, required_for_readiness: true },
  ], true);

  const result = {
    schema_version: "tivdoc-p7-local-verification-v0.7.0",
    status: backupResult.valid && operatorPlan.mutation_applied === false && restorePlan.dry_run && !readiness.ready ? "PASS_LOCAL_STATIC_ADAPTERS" : "FAIL",
    acceptance: {
      "V07-P7-OBSERVABILITY": metrics.samples().length === 1,
      "V07-P7-OPERATIONS": operator.verifyAuditChain().valid,
      "V07-P7-BACKUP": backupResult.valid,
    },
    backup: backupResult,
    restore: { plan: restorePlan, receipt: restoreReceipt },
    operator: { mutation_applied: operatorPlan.mutation_applied, audit: operator.verifyAuditChain() },
    readiness,
    isolated_database: {
      status: "SKIPPED_BLOCKED",
      blocker_code: "ISOLATED_DATABASE_BACKUP_RESTORE_TARGET_UNAVAILABLE",
      attempted_action: "consume frozen execution-contract capability preflight",
      evidence: "disposable_local_database_proven=false",
      safe_fallback_completed: true,
      affected_acceptance_ids: ["V07-P7-BACKUP"],
      direct_downstream_impact: "no dynamic database backup/restore, RPO, or RTO claim",
      next_human_or_environment_action: "provide an explicitly disposable isolated local database target",
    },
    prohibited_action_counters: {
      customer_data_reads: 0,
      production_connections: 0,
      remote_migrations: 0,
      external_calls: 0,
      deliveries: 0,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "PASS_LOCAL_STATIC_ADAPTERS") process.exitCode = 1;
} finally {
  await server.close();
}
