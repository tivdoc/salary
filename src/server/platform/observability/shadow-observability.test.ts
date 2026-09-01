import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOfflineShadowScheduler } from "../../engine/shadow/durable-scheduler.ts";
import { buildDurableSyntheticShadowEnvelope } from "../../engine/shadow/durable-synthetic-fixtures.ts";
import { LocalFileDurableShadowStateStore } from "../../engine/shadow/durable-store.ts";
import { SafeMetricsRegistry } from "./safe-observability.ts";
import { SafeShadowObservability, SHADOW_OPERATIONS_RUNBOOK } from "./shadow-observability.ts";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("MC-25 / V010-W7.3 safe Shadow observability", () => {
  it("emits only hashed correlations and bounded synthetic/offline labels with retention deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-shadow-observability-"));
    roots.push(root);
    const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
    const scheduler = new DurableOfflineShadowScheduler({
      store,
      flags: { enabled: true, synthetic_enabled: true, public_enabled: false },
      limits: { max_jobs: 2, max_queued: 2, max_concurrent_leases: 1, max_attempts: 2, max_dataset_bytes: 10_000, max_lease_ms: 1_000 },
      now: () => "2042-01-01T00:00:00.000Z",
    });
    await scheduler.schedule(buildDurableSyntheticShadowEnvelope(), { idempotency_key: "idempotency_observation_001", correlation_id: "correlation_private_marker_001" });
    const observation = new SafeShadowObservability({ now: () => "2042-01-01T00:00:01.000Z", max_records: 4, retention_ms: 1_000 });
    observation.ingest(await scheduler.snapshot(), "2042-01-01T00:00:01.000Z", 8);
    const serialized = JSON.stringify({ records: observation.records(), logs: observation.logs(), metrics: observation.metrics() });
    expect(serialized).not.toContain("correlation_private_marker_001");
    expect(serialized).not.toMatch(/salary|signed[_ -]?url|raw[_ -]?document|customer[_ -]?report/i);
    expect(observation.records()[0]).toMatchObject({ mode: "offline_synthetic", integrity: "valid", run_state: "scheduled" });
    expect(observation.deleteExpired("2042-01-01T00:00:02.001Z")).toEqual({ deleted: 1, deleted_logs: 1, retained: 0, mode: "offline_synthetic" });
    expect(observation.logs()).toHaveLength(0);
    expect(SHADOW_OPERATIONS_RUNBOOK).toMatchObject({ classification: "offline_synthetic_only", customer_execution_allowed: false, production_promotion_allowed: false, raw_diagnostics_allowed: false });
  });

  it("fails closed on audit tampering and rejects high-cardinality labels", async () => {
    const metrics = new SafeMetricsRegistry();
    expect(() => metrics.record("shadow_run_health", "gauge", 1, { mode: "customer-case-123" })).toThrow("METRIC_LABEL_VALUE_UNBOUNDED");
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-shadow-observability-tamper-"));
    roots.push(root);
    const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
    const scheduler = new DurableOfflineShadowScheduler({
      store,
      flags: { enabled: true, synthetic_enabled: true, public_enabled: false },
      limits: { max_jobs: 1, max_queued: 1, max_concurrent_leases: 1, max_attempts: 1, max_dataset_bytes: 10_000, max_lease_ms: 1_000 },
      now: () => "2042-01-01T00:00:00.000Z",
    });
    await scheduler.schedule(buildDurableSyntheticShadowEnvelope(), { idempotency_key: "idempotency_tamper_001", correlation_id: "correlation_tamper_001" });
    const snapshot = await scheduler.snapshot();
    const tampered = { ...snapshot, audit: [{ ...snapshot.audit[0], action: "failed" }] };
    const observation = new SafeShadowObservability({ now: () => "2042-01-01T00:00:01.000Z", max_records: 4, retention_ms: 1_000 });
    expect(() => observation.ingest(tampered, "2042-01-01T00:00:01.000Z")).toThrow("SHADOW_AUDIT_INVALID");
    expect(observation.metrics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "shadow_audit_chain_valid", value: 0, labels: expect.objectContaining({ integrity: "invalid" }) }),
    ]));
  });
});
