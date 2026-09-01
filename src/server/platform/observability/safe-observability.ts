import { createHash } from "node:crypto";

import {
  SAFE_COMPONENTS,
  SAFE_ERROR_CODES,
  SAFE_EVENT_NAMES,
  SAFE_METRIC_NAMES,
  SAFE_OUTCOMES,
  type CorrelationContext,
  type MetricLabelKey,
  type SafeLogInput,
  type SafeLogRecord,
  type SafeMetricLabels,
  type SafeMetricName,
  type SafeMetricSample,
  type SafeSpan,
} from "./contracts";

const OPAQUE_ID = /^[a-z][a-z0-9_-]{7,63}$/;
const SAFE_LEVELS = new Set(["debug", "info", "warn", "error"]);
const SAFE_QUEUE_VALUES = new Set(["analysis", "audit", "delivery", "reports"]);
const SAFE_REVIEW_VALUES = new Set(["extraction", "facts", "legal", "report"]);
const SAFE_SCHEMA_VALUES = new Set(["analysis", "audit", "backup", "jobs", "shadow", "storage"]);
const SAFE_MODE_VALUES = new Set(["offline_synthetic"]);
const SAFE_RUN_STATE_VALUES = new Set(["scheduled", "queued", "leased", "running", "completed", "failed", "cancelled", "degraded"]);
const SAFE_INTEGRITY_VALUES = new Set(["valid", "invalid"]);
const LABEL_KEYS = new Set<MetricLabelKey>(["component", "outcome", "queue", "review_stage", "schema_family", "mode", "run_state", "integrity"]);

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function assertOpaqueCorrelation(context: CorrelationContext): void {
  if (Object.keys(context).some((key) => !["request_id", "run_id", "job_id"].includes(key))) {
    throw new Error("SAFE_CORRELATION_FIELD_FORBIDDEN");
  }
  const values = [context.request_id, context.run_id, context.job_id].filter((value): value is string => value !== undefined);
  if (values.length === 0 || values.some((value) => !OPAQUE_ID.test(value))) {
    throw new Error("SAFE_CORRELATION_INVALID");
  }
}

function assertFiniteBounded(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(code);
  }
}

export class SafeLogSink {
  readonly #records: SafeLogRecord[] = [];
  readonly #now: () => string;
  #sequence = 0;

  constructor(now: () => string) {
    this.#now = now;
  }

  emit(input: SafeLogInput): SafeLogRecord {
    if (Object.keys(input).some((key) => !["level", "event", "component", "outcome", "correlation", "error_code", "duration_ms"].includes(key))) {
      throw new Error("SAFE_LOG_FIELD_FORBIDDEN");
    }
    assertOpaqueCorrelation(input.correlation);
    if (!SAFE_LEVELS.has(input.level)) throw new Error("SAFE_LOG_LEVEL_INVALID");
    if (!includes(SAFE_EVENT_NAMES, input.event) || !includes(SAFE_COMPONENTS, input.component) || !includes(SAFE_OUTCOMES, input.outcome)) {
      throw new Error("SAFE_LOG_ENUM_INVALID");
    }
    if (input.error_code !== undefined && !includes(SAFE_ERROR_CODES, input.error_code)) {
      throw new Error("SAFE_LOG_ERROR_CODE_INVALID");
    }
    if (input.duration_ms !== undefined) assertFiniteBounded(input.duration_ms, "SAFE_LOG_DURATION_INVALID");
    const correlation = Object.freeze({
      ...(input.correlation.request_id === undefined ? {} : { request_id: input.correlation.request_id }),
      ...(input.correlation.run_id === undefined ? {} : { run_id: input.correlation.run_id }),
      ...(input.correlation.job_id === undefined ? {} : { job_id: input.correlation.job_id }),
    });
    const record: SafeLogRecord = Object.freeze({
      schema_version: "tivdoc-safe-log-v0.7.0",
      timestamp: this.#now(),
      sequence: ++this.#sequence,
      level: input.level,
      event: input.event,
      component: input.component,
      outcome: input.outcome,
      correlation,
      ...(input.error_code === undefined ? {} : { error_code: input.error_code }),
      ...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms }),
    });
    this.#records.push(record);
    return record;
  }

  records(): readonly SafeLogRecord[] {
    return this.#records.map((record) => Object.freeze({ ...record, correlation: Object.freeze({ ...record.correlation }) }));
  }

  deleteBefore(timestamp: string): number {
    const boundary = Date.parse(timestamp);
    if (!Number.isFinite(boundary)) throw new Error("SAFE_LOG_RETENTION_TIME_INVALID");
    const retained = this.#records.filter((record) => Date.parse(record.timestamp) >= boundary);
    const deleted = this.#records.length - retained.length;
    this.#records.splice(0, this.#records.length, ...retained);
    return deleted;
  }

  deleteAll(): number {
    const deleted = this.#records.length;
    this.#records.splice(0, deleted);
    return deleted;
  }
}

function assertLabels(labels: SafeMetricLabels): void {
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_KEYS.has(key as MetricLabelKey) || typeof value !== "string") throw new Error("METRIC_LABEL_INVALID");
    const allowed =
      (key === "component" && includes(SAFE_COMPONENTS, value)) ||
      (key === "outcome" && includes(SAFE_OUTCOMES, value)) ||
      (key === "queue" && SAFE_QUEUE_VALUES.has(value)) ||
      (key === "review_stage" && SAFE_REVIEW_VALUES.has(value)) ||
      (key === "schema_family" && SAFE_SCHEMA_VALUES.has(value)) ||
      (key === "mode" && SAFE_MODE_VALUES.has(value)) ||
      (key === "run_state" && SAFE_RUN_STATE_VALUES.has(value)) ||
      (key === "integrity" && SAFE_INTEGRITY_VALUES.has(value));
    if (!allowed) throw new Error("METRIC_LABEL_VALUE_UNBOUNDED");
  }
}

function canonicalLabels(labels: SafeMetricLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export class SafeMetricsRegistry {
  readonly #samples = new Map<string, SafeMetricSample>();

  record(name: SafeMetricName, kind: "counter" | "gauge", value: number, labels: SafeMetricLabels = {}): SafeMetricSample {
    if (!includes(SAFE_METRIC_NAMES, name)) throw new Error("METRIC_NAME_INVALID");
    assertFiniteBounded(value, "METRIC_VALUE_INVALID");
    assertLabels(labels);
    const key = `${name}|${canonicalLabels(labels)}`;
    const previous = this.#samples.get(key);
    if (previous && previous.kind !== kind) throw new Error("METRIC_KIND_CONFLICT");
    const nextValue = kind === "counter" ? (previous?.value ?? 0) + value : value;
    const sample = Object.freeze({ name, kind, value: nextValue, labels: Object.freeze({ ...labels }) });
    this.#samples.set(key, sample);
    return sample;
  }

  samples(): readonly SafeMetricSample[] {
    return [...this.#samples.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, sample]) => sample);
  }

  clear(): number {
    const deleted = this.#samples.size;
    this.#samples.clear();
    return deleted;
  }
}

export class SafeTraceSink {
  readonly #spans: SafeSpan[] = [];
  readonly #nowMs: () => number;

  constructor(nowMs: () => number) {
    this.#nowMs = nowMs;
  }

  start(input: Pick<SafeSpan, "name" | "component" | "correlation"> & Readonly<{ parent_span_id?: string }>): Readonly<{
    end(outcome: SafeSpan["outcome"]): SafeSpan;
  }> {
    assertOpaqueCorrelation(input.correlation);
    if (!includes(SAFE_EVENT_NAMES, input.name) || !includes(SAFE_COMPONENTS, input.component)) throw new Error("SAFE_SPAN_ENUM_INVALID");
    if (input.parent_span_id !== undefined && !OPAQUE_ID.test(input.parent_span_id)) throw new Error("SAFE_PARENT_SPAN_INVALID");
    const startedMs = this.#nowMs();
    const spanId = `span_${createHash("sha256").update(`${this.#spans.length}:${startedMs}:${JSON.stringify(input.correlation)}`).digest("hex").slice(0, 24)}`;
    let ended = false;
    return Object.freeze({
      end: (outcome: SafeSpan["outcome"]): SafeSpan => {
        if (ended) throw new Error("SAFE_SPAN_ALREADY_ENDED");
        ended = true;
        if (!includes(SAFE_OUTCOMES, outcome)) throw new Error("SAFE_SPAN_OUTCOME_INVALID");
        const endedMs = this.#nowMs();
        if (endedMs < startedMs) throw new Error("SAFE_SPAN_CLOCK_REGRESSION");
        const span: SafeSpan = Object.freeze({
          schema_version: "tivdoc-safe-span-v0.7.0",
          span_id: spanId,
          parent_span_id: input.parent_span_id ?? null,
          name: input.name,
          component: input.component,
          outcome,
          correlation: Object.freeze({
            ...(input.correlation.request_id === undefined ? {} : { request_id: input.correlation.request_id }),
            ...(input.correlation.run_id === undefined ? {} : { run_id: input.correlation.run_id }),
            ...(input.correlation.job_id === undefined ? {} : { job_id: input.correlation.job_id }),
          }),
          started_at: new Date(startedMs).toISOString(),
          ended_at: new Date(endedMs).toISOString(),
          duration_ms: endedMs - startedMs,
        });
        this.#spans.push(span);
        return span;
      },
    });
  }

  spans(): readonly SafeSpan[] {
    return [...this.#spans];
  }
}
