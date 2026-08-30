export const SAFE_COMPONENTS = [
  "analysis",
  "audit",
  "backup",
  "delivery",
  "jobs",
  "operations",
  "reports",
  "storage",
] as const;

export type SafeComponent = (typeof SAFE_COMPONENTS)[number];

export const SAFE_OUTCOMES = ["accepted", "blocked", "failed", "replayed", "succeeded"] as const;
export type SafeOutcome = (typeof SAFE_OUTCOMES)[number];

export const SAFE_EVENT_NAMES = [
  "authorization_decision",
  "backup_drill",
  "health_probe",
  "job_transition",
  "kill_switch_decision",
  "operator_command",
  "queue_observation",
  "restore_verification",
] as const;
export type SafeEventName = (typeof SAFE_EVENT_NAMES)[number];

export const SAFE_ERROR_CODES = [
  "AUTHORIZATION_DENIED",
  "BACKUP_CORRUPT",
  "BACKUP_INCOMPLETE",
  "DEPENDENCY_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
  "KILL_SWITCH_DISABLED",
  "STALE_REVISION",
] as const;
export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

export type CorrelationContext = Readonly<{
  request_id?: string;
  run_id?: string;
  job_id?: string;
}>;

export type SafeLogInput = Readonly<{
  level: "debug" | "info" | "warn" | "error";
  event: SafeEventName;
  component: SafeComponent;
  outcome: SafeOutcome;
  correlation: CorrelationContext;
  error_code?: SafeErrorCode;
  duration_ms?: number;
}>;

export type SafeLogRecord = SafeLogInput & Readonly<{
  schema_version: "tivdoc-safe-log-v0.7.0";
  timestamp: string;
  sequence: number;
}>;

export const SAFE_METRIC_NAMES = [
  "authorization_denials_total",
  "backup_drill_status",
  "idempotent_replays_total",
  "job_attempts_total",
  "job_dead_letter_total",
  "job_depth",
  "job_lease_expiry_total",
  "job_oldest_age_seconds",
  "lifecycle_conflicts_total",
  "review_backlog",
  "review_oldest_age_seconds",
  "schema_version_info",
  "storage_orphans",
  "storage_quarantine",
] as const;
export type SafeMetricName = (typeof SAFE_METRIC_NAMES)[number];

export type MetricLabelKey = "component" | "outcome" | "queue" | "review_stage" | "schema_family";
export type SafeMetricLabels = Readonly<Partial<Record<MetricLabelKey, string>>>;

export type SafeMetricSample = Readonly<{
  name: SafeMetricName;
  kind: "counter" | "gauge";
  value: number;
  labels: SafeMetricLabels;
}>;

export type SafeSpan = Readonly<{
  schema_version: "tivdoc-safe-span-v0.7.0";
  span_id: string;
  parent_span_id: string | null;
  name: SafeEventName;
  component: SafeComponent;
  outcome: SafeOutcome;
  correlation: CorrelationContext;
  started_at: string;
  ended_at: string;
  duration_ms: number;
}>;
