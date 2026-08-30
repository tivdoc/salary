export const KILL_SWITCHES = ["analysis", "customer_processing", "delivery", "export", "offline_shadow"] as const;
export type KillSwitch = (typeof KILL_SWITCHES)[number];

export const OPERATOR_ACTIONS = [
  "audit_verify",
  "backup_drill",
  "case_hold",
  "job_inspect",
  "job_replay",
  "object_quarantine",
] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

export const OPERATOR_REASON_CODES = [
  "BACKUP_DRILL_SCHEDULED",
  "CORRUPTION_SUSPECTED",
  "INCIDENT_CONTAINMENT",
  "JOB_RECOVERY",
  "PERIODIC_AUDIT",
  "PRIVACY_REQUEST",
] as const;
export type OperatorReasonCode = (typeof OPERATOR_REASON_CODES)[number];

export type OperatorCommand = Readonly<{
  schema_version: "tivdoc-operator-command-v0.7.0";
  action: OperatorAction;
  actor_id: string;
  reason_code: OperatorReasonCode;
  idempotency_key: string;
  correlation_id: string;
  dry_run: true;
  target_ref: string;
}>;

export type OperatorAuditReceipt = Readonly<{
  schema_version: "tivdoc-operator-audit-v0.7.0";
  sequence: number;
  action: OperatorAction;
  actor_id: string;
  reason_code: OperatorReasonCode;
  idempotency_key: string;
  command_sha256: string;
  previous_sha256: string | null;
  receipt_sha256: string;
  outcome: "DRY_RUN_PLANNED";
  occurred_at: string;
}>;

export type OperatorPlan = Readonly<{
  action: OperatorAction;
  target_ref: string;
  mutation_applied: false;
  idempotent_replay: boolean;
  required_kill_switch: KillSwitch | null;
  receipt: OperatorAuditReceipt;
}>;
