import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { canonicalSha256 } from "../../src/engine/rule-runtime/canonical.ts";
import { DurableOfflineShadowScheduler } from "../../src/server/engine/shadow/durable-scheduler.ts";
import { buildDurableSyntheticShadowEnvelope } from "../../src/server/engine/shadow/durable-synthetic-fixtures.ts";
import { LocalFileDurableShadowStateStore, verifySchedulerAuditChain } from "../../src/server/engine/shadow/durable-store.ts";

if (process.env.NODE_ENV === "production") throw new Error("SHADOW_OFFLINE_SYNTHETIC_FORBIDDEN_IN_PRODUCTION");

const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-shadow-v010-verify-"));
try {
  const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
  const options = {
    store,
    flags: { enabled: true, synthetic_enabled: true, public_enabled: false } as const,
    limits: { max_jobs: 2, max_queued: 2, max_concurrent_leases: 1, max_attempts: 2, max_dataset_bytes: 16_384, max_lease_ms: 1_000 },
    now: () => "2042-01-01T00:00:00.000Z",
  };
  const first = new DurableOfflineShadowScheduler(options);
  const scheduled = await first.schedule(buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.script.001" }), {
    idempotency_key: "idempotency_script_schedule_001",
    correlation_id: "correlation_script_schedule_001",
  });
  await first.enqueue({
    run_id: scheduled.run_id,
    expected_revision: scheduled.revision,
    idempotency_key: "idempotency_script_enqueue_001",
    correlation_id: "correlation_script_enqueue_001",
  });
  const [lease] = await first.lease({
    worker_id: "worker_script_001",
    now: "2042-01-01T00:00:00.000Z",
    lease_ms: 1_000,
    limit: 1,
    correlation_id: "correlation_script_lease_001",
  });
  const restarted = new DurableOfflineShadowScheduler(options);
  const completed = await restarted.executeLease(lease, "correlation_script_execute_001", async () => ({
    result_sha256: canonicalSha256({ classification: "synthetic_mechanics", result: "pass" }),
    comparison_sha256: canonicalSha256({ classification: "synthetic_mechanics", comparison: "manual_review" }),
    disagreement_id: "disagreement.script.001",
    monetary_output_count: 0 as const,
    finding_count: 0 as const,
    customer_report_count: 0 as const,
    automatic_customer_promotion: false as const,
    automatic_production_promotion: false as const,
  }));
  const snapshot = await restarted.snapshot();
  const audit = verifySchedulerAuditChain(snapshot.audit);
  if (completed.state !== "completed" || completed.automatic_customer_promotion || completed.automatic_production_promotion) {
    throw new Error("SHADOW_V010_VERIFICATION_INVARIANT_FAILED");
  }
  console.log(JSON.stringify({
    schema_version: "tivdoc-offline-synthetic-shadow-verification-v0.10.0",
    status: "PASS",
    mode: "offline_synthetic_only",
    restart_verified: true,
    audit_event_count: audit.event_count,
    audit_tail_sha256: audit.tail_sha256,
    final_state: completed.state,
    monetary_output_count: 0,
    finding_count: 0,
    customer_report_count: 0,
    automatic_customer_promotion: false,
    automatic_production_promotion: false,
    network_calls: 0,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
