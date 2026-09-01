import { createHash } from "node:crypto";
import type { ShadowJobState, ShadowSchedulerAuditEvent, ShadowSchedulerSnapshot } from "../../engine/shadow/durable-contracts.ts";
import { validateShadowSchedulerSnapshot, verifySchedulerAuditChain } from "../../engine/shadow/durable-store.ts";
import type { SafeErrorCode, SafeLogRecord } from "./contracts.ts";
import { SafeLogSink, SafeMetricsRegistry } from "./safe-observability.ts";

export const SHADOW_OPERATIONS_RUNBOOK = Object.freeze({
  schema_version: "tivdoc-offline-synthetic-shadow-runbook-v0.10.0" as const,
  classification: "offline_synthetic_only" as const,
  restart: Object.freeze([
    "verify_append_only_state_and_audit_chain",
    "recover_expired_leases_with_new_fencing_tokens",
    "resume_only_after_coarse_health_is_ready",
  ] as const),
  degraded_mode: Object.freeze([
    "engage_kill_switch_on_integrity_failure",
    "retain_only_allowlisted_low_cardinality_telemetry",
    "require_human_resolution_before_any_release",
  ] as const),
  customer_execution_allowed: false as const,
  production_promotion_allowed: false as const,
  raw_diagnostics_allowed: false as const,
});

export type SafeShadowObservation = Readonly<{
  schema_version: "tivdoc-safe-shadow-observation-v0.10.0";
  observed_at: string;
  correlation_id: string;
  action: ShadowSchedulerAuditEvent["action"];
  run_state: ShadowJobState | "degraded";
  mode: "offline_synthetic";
  integrity: "valid" | "invalid";
  event_fingerprint: string;
  duration_ms: number | null;
}>;

function opaque(prefix: "request" | "run", value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function safeState(event: ShadowSchedulerAuditEvent, snapshot: ShadowSchedulerSnapshot): SafeShadowObservation["run_state"] {
  if (event.run_id === null) return snapshot.kill_switch.engaged || snapshot.scheduler_paused ? "degraded" : "queued";
  return snapshot.jobs[event.run_id]?.state ?? "degraded";
}

function outcome(event: ShadowSchedulerAuditEvent): "accepted" | "blocked" | "failed" | "replayed" | "succeeded" {
  if (event.action === "failed") return "failed";
  if (event.action === "cancelled" || event.action === "kill_switch_engaged" || event.action === "scheduler_paused") return "blocked";
  if (event.action === "retried" || event.action === "lease_recovered") return "replayed";
  return "succeeded";
}

function safeError(event: ShadowSchedulerAuditEvent): SafeErrorCode | undefined {
  if (event.action === "failed") return "SHADOW_WORKER_FAILURE";
  return undefined;
}

export class SafeShadowObservability {
  readonly #logs: SafeLogSink;
  readonly #metrics: SafeMetricsRegistry;
  readonly #maxRecords: number;
  readonly #retentionMs: number;
  readonly #records: SafeShadowObservation[] = [];
  readonly #seen = new Set<string>();

  constructor(input: Readonly<{
    now: () => string;
    max_records: number;
    retention_ms: number;
    logs?: SafeLogSink;
    metrics?: SafeMetricsRegistry;
  }>) {
    if (!Number.isSafeInteger(input.max_records) || input.max_records < 1 || input.max_records > 100_000
      || !Number.isSafeInteger(input.retention_ms) || input.retention_ms < 1 || input.retention_ms > 366 * 24 * 60 * 60 * 1_000) throw new Error("SHADOW_OBSERVABILITY_RETENTION_INVALID");
    this.#logs = input.logs ?? new SafeLogSink(input.now);
    this.#metrics = input.metrics ?? new SafeMetricsRegistry();
    this.#maxRecords = input.max_records;
    this.#retentionMs = input.retention_ms;
  }

  ingest(snapshotInput: unknown, observedAt: string, durationMs = 0) {
    if (!Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > Number.MAX_SAFE_INTEGER) throw new Error("SHADOW_OBSERVATION_INPUT_INVALID");
    let snapshot: ShadowSchedulerSnapshot;
    try {
      snapshot = validateShadowSchedulerSnapshot(snapshotInput);
      verifySchedulerAuditChain(snapshot.audit);
    } catch {
      this.#metrics.record("shadow_audit_chain_valid", "gauge", 0, { component: "shadow", mode: "offline_synthetic", integrity: "invalid" });
      this.#metrics.record("shadow_run_health", "gauge", 0, { component: "shadow", mode: "offline_synthetic", run_state: "degraded" });
      throw new Error("SHADOW_AUDIT_INVALID");
    }
    for (const event of snapshot.audit) {
      if (this.#seen.has(event.event_sha256)) continue;
      const runState = safeState(event, snapshot);
      const record = Object.freeze({
        schema_version: "tivdoc-safe-shadow-observation-v0.10.0" as const,
        observed_at: observedAt,
        correlation_id: opaque("request", event.correlation_id),
        action: event.action,
        run_state: runState,
        mode: "offline_synthetic" as const,
        integrity: "valid" as const,
        event_fingerprint: event.event_sha256,
        duration_ms: durationMs,
      });
      this.#records.push(record);
      this.#seen.add(event.event_sha256);
      this.#logs.emit({
        level: event.action === "failed" ? "error" : event.action.includes("kill_switch") ? "warn" : "info",
        event: "shadow_run_transition",
        component: "shadow",
        outcome: outcome(event),
        correlation: {
          request_id: record.correlation_id,
          ...(event.run_id === null ? {} : { run_id: opaque("run", event.run_id) }),
        },
        ...(safeError(event) === undefined ? {} : { error_code: safeError(event) }),
        duration_ms: durationMs,
      });
      this.#metrics.record("shadow_run_latency_ms", "gauge", durationMs, { component: "shadow", mode: "offline_synthetic", run_state: runState });
      this.#metrics.record("shadow_run_health", "gauge", runState === "failed" || runState === "degraded" ? 0 : 1, { component: "shadow", mode: "offline_synthetic", run_state: runState });
      if (event.action === "failed") this.#metrics.record("shadow_errors_total", "counter", 1, { component: "shadow", mode: "offline_synthetic", run_state: runState });
      if (event.action === "retried" || event.action === "lease_recovered") this.#metrics.record("shadow_retries_total", "counter", 1, { component: "shadow", mode: "offline_synthetic", run_state: runState });
    }
    this.#metrics.record("shadow_audit_chain_valid", "gauge", 1, { component: "shadow", mode: "offline_synthetic", integrity: "valid" });
    this.deleteExpired(observedAt);
    if (this.#records.length > this.#maxRecords) this.#records.splice(0, this.#records.length - this.#maxRecords);
    return Object.freeze({ valid: true as const, ingested: snapshot.audit.length, retained: this.#records.length });
  }

  deleteExpired(now: string) {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("SHADOW_RETENTION_TIME_INVALID");
    const before = this.#records.length;
    const retained = this.#records.filter((record) => nowMs - Date.parse(record.observed_at) <= this.#retentionMs);
    this.#records.splice(0, this.#records.length, ...retained);
    const deletedLogs = this.#logs.deleteBefore(new Date(nowMs - this.#retentionMs).toISOString());
    return Object.freeze({ deleted: before - retained.length, deleted_logs: deletedLogs, retained: retained.length, mode: "offline_synthetic" as const });
  }

  deleteAll() {
    const deleted = this.#records.length;
    this.#records.splice(0, deleted);
    this.#seen.clear();
    const deletedLogs = this.#logs.deleteAll();
    const deletedMetrics = this.#metrics.clear();
    return Object.freeze({ deleted, deleted_logs: deletedLogs, deleted_metrics: deletedMetrics, retained: 0, mode: "offline_synthetic" as const });
  }

  records(): readonly SafeShadowObservation[] {
    return this.#records.map((record) => Object.freeze({ ...record }));
  }

  logs(): readonly SafeLogRecord[] {
    return this.#logs.records();
  }

  metrics() {
    return this.#metrics.samples();
  }
}
