import { describe, expect, it } from "vitest";

import { coarseHealth, coarseReadiness } from "./health";
import { SafeLogSink, SafeMetricsRegistry, SafeTraceSink } from "./safe-observability";

describe("V07-P7-OBSERVABILITY", () => {
  it("emits correlation-bound records without arbitrary payload fields", () => {
    const sink = new SafeLogSink(() => "2026-08-30T00:00:00.000Z");
    const input = {
      level: "info",
      event: "job_transition",
      component: "jobs",
      outcome: "succeeded",
      correlation: { request_id: "request_00000001", job_id: "job_00000001" },
      duration_ms: 7,
    } as const;
    const record = sink.emit(input);
    expect(record.sequence).toBe(1);
    expect(JSON.stringify(record)).not.toMatch(/customer|salary|signed_url|citation|ocr/i);
    expect(() => sink.emit({ ...input, correlation: { request_id: "person@example.test" } })).toThrow("SAFE_CORRELATION_INVALID");
    expect(() => sink.emit({ ...input, message: "forbidden free text" } as never)).toThrow("SAFE_LOG_FIELD_FORBIDDEN");
    expect(() => sink.emit({ ...input, correlation: { request_id: "request_00000001", customer_id: "forbidden" } } as never)).toThrow("SAFE_CORRELATION_FIELD_FORBIDDEN");
  });

  it("permits only fixed, bounded metric label dimensions", () => {
    const metrics = new SafeMetricsRegistry();
    metrics.record("job_depth", "gauge", 3, { queue: "analysis" });
    metrics.record("authorization_denials_total", "counter", 1, { component: "operations", outcome: "blocked" });
    expect(metrics.samples()).toHaveLength(2);
    expect(() => metrics.record("job_depth", "gauge", 1, { queue: "opaque-case-id" })).toThrow("METRIC_LABEL_VALUE_UNBOUNDED");
    expect(() => metrics.record("job_depth", "gauge", Number.NaN)).toThrow("METRIC_VALUE_INVALID");
  });

  it("creates bounded spans and refuses double completion", () => {
    const ticks = [1000, 1008];
    const trace = new SafeTraceSink(() => ticks.shift() ?? 1008);
    const active = trace.start({ name: "backup_drill", component: "backup", correlation: { run_id: "run_00000001" } });
    expect(active.end("succeeded").duration_ms).toBe(8);
    expect(() => active.end("failed")).toThrow("SAFE_SPAN_ALREADY_ENDED");
  });

  it("returns only coarse health and fail-closed readiness", () => {
    const dependencies = [
      { dependency: "audit" as const, available: true, required_for_readiness: true },
      { dependency: "persistence" as const, available: false, required_for_readiness: true },
    ];
    expect(coarseHealth(dependencies)).toEqual({ schema_version: "tivdoc-coarse-health-v0.7.0", status: "degraded" });
    expect(coarseReadiness(dependencies, true).ready).toBe(false);
    expect(coarseHealth([]).status).toBe("unavailable");
    expect(Object.keys(coarseReadiness([], false))).toEqual(["schema_version", "ready", "status"]);
  });
});
