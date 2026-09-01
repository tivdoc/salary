import { z } from "zod";
import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";

const id = z.string().regex(/^[a-z][a-z0-9:._-]{2,159}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/u);

const ordinaryPinSchema = z.object({
  pin_id: id,
  version,
  sha256: sha,
}).strict();

const envelopeContentObjectSchema = z.object({
  schema_version: z.literal("tivdoc-durable-offline-shadow-envelope-v0.10.0"),
  run_id: id,
  execution_mode: z.literal("offline_synthetic_only"),
  dataset_pin: ordinaryPinSchema.extend({
    classification: z.literal("deterministic_synthetic"),
    byte_count: z.number().int().positive().max(128 * 1024 * 1024),
    customer_material: z.literal(false),
  }).strict(),
  ground_truth_pin: ordinaryPinSchema.extend({
    classification: z.literal("synthetic_mechanics_ground_truth"),
    customer_material: z.literal(false),
    human_ground_truth_count: z.literal(0),
  }).strict(),
  source_state_pin: ordinaryPinSchema.extend({
    mode: z.literal("synthetic_placeholder_only"),
    active_real_source_count: z.literal(0),
    selected_real_source_count: z.literal(0),
  }).strict(),
  parameter_state_pin: ordinaryPinSchema.extend({ active_real_parameter_count: z.literal(0) }).strict(),
  rule_state_pin: ordinaryPinSchema.extend({ active_real_rule_count: z.literal(0) }).strict(),
  approved_baseline_pin: ordinaryPinSchema.extend({ approval_receipt_sha256: sha }).strict(),
  candidate_pin: ordinaryPinSchema,
  code_pin: ordinaryPinSchema,
  config_pin: ordinaryPinSchema,
  threshold_policy_pin: ordinaryPinSchema,
  requested_at: timestamp,
  scheduled_for: timestamp,
  network_allowed: z.literal(false),
  external_provider_allowed: z.literal(false),
  customer_input_allowed: z.literal(false),
  delivery_allowed: z.literal(false),
  automatic_customer_promotion: z.literal(false),
  automatic_production_promotion: z.literal(false),
}).strict();

const envelopeContentSchema = envelopeContentObjectSchema.readonly();

export const durableShadowRunEnvelopeSchema = z.object({
  ...envelopeContentObjectSchema.shape,
  envelope_sha256: sha,
}).strict().superRefine((value, context) => {
  const { envelope_sha256: expected, ...content } = value;
  if (canonicalSha256(content) !== expected) context.addIssue({ code: "custom", message: "SHADOW_ENVELOPE_HASH_MISMATCH" });
}).readonly();

export type DurableShadowRunEnvelope = z.infer<typeof durableShadowRunEnvelopeSchema>;

export function createDurableShadowRunEnvelope(input: z.input<typeof envelopeContentSchema>): DurableShadowRunEnvelope {
  const content = envelopeContentSchema.parse(input);
  if (content.approved_baseline_pin.sha256 === content.candidate_pin.sha256) throw new Error("SHADOW_BASELINE_CANDIDATE_PIN_COLLISION");
  return deepFreeze(durableShadowRunEnvelopeSchema.parse({ ...content, envelope_sha256: canonicalSha256(content) })) as DurableShadowRunEnvelope;
}

export const shadowJobStates = ["scheduled", "queued", "leased", "running", "completed", "failed", "cancelled"] as const;
export type ShadowJobState = (typeof shadowJobStates)[number];

export type DurableShadowJob = Readonly<{
  run_id: string;
  envelope: DurableShadowRunEnvelope;
  state: ShadowJobState;
  revision: number;
  attempt: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  recovery_count: number;
  result_sha256: string | null;
  comparison_sha256: string | null;
  disagreement_id: string | null;
  safe_error_code: string | null;
  created_at: string;
  updated_at: string;
  automatic_customer_promotion: false;
  automatic_production_promotion: false;
  job_sha256: string;
}>;

export type ShadowSchedulerAuditEvent = Readonly<{
  sequence: number;
  action: "scheduled" | "enqueued" | "leased" | "started" | "completed" | "failed" | "retried" | "cancelled" | "scheduler_paused" | "scheduler_resumed" | "kill_switch_engaged" | "kill_switch_released" | "lease_recovered";
  run_id: string | null;
  resource_revision: number;
  resource_sha256: string;
  correlation_id: string;
  mode: "offline_synthetic_only";
  occurred_at: string;
  previous_event_sha256: string | null;
  event_sha256: string;
}>;

export type ShadowSchedulerSnapshot = Readonly<{
  schema_version: "tivdoc-durable-shadow-scheduler-state-v0.10.0";
  snapshot_revision: number;
  previous_snapshot_sha256: string | null;
  scheduler_paused: boolean;
  kill_switch: Readonly<{ engaged: boolean; revision: number; reason_code: string | null }>;
  jobs: Readonly<Record<string, DurableShadowJob>>;
  idempotency: Readonly<Record<string, Readonly<{ command_sha256: string; run_id: string }>>>;
  audit: readonly ShadowSchedulerAuditEvent[];
  snapshot_sha256: string;
}>;

export type ShadowSchedulerLimits = Readonly<{
  max_jobs: number;
  max_queued: number;
  max_concurrent_leases: number;
  max_attempts: number;
  max_dataset_bytes: number;
  max_lease_ms: number;
}>;

export type ShadowLease = Readonly<{
  run_id: string;
  worker_id: string;
  fencing_token: number;
  attempt: number;
  lease_expires_at: string;
  envelope_sha256: string;
}>;

export function shadowJobContent(job: Omit<DurableShadowJob, "job_sha256">) {
  return job;
}

export function sealShadowJob(job: Omit<DurableShadowJob, "job_sha256">): DurableShadowJob {
  return deepFreeze({ ...job, job_sha256: canonicalSha256(job) }) as DurableShadowJob;
}

export function validateShadowJob(job: DurableShadowJob) {
  const expectedKeys = [
    "attempt", "automatic_customer_promotion", "automatic_production_promotion", "available_at", "comparison_sha256",
    "created_at", "disagreement_id", "envelope", "fencing_token", "job_sha256", "lease_expires_at", "lease_owner",
    "recovery_count", "result_sha256", "revision", "run_id", "safe_error_code", "state", "updated_at",
  ];
  if (!job || typeof job !== "object" || Object.keys(job).sort().join("|") !== expectedKeys.join("|")
    || !id.safeParse(job.run_id).success || !job.envelope || typeof job.envelope !== "object" || job.envelope.run_id !== job.run_id
    || !shadowJobStates.includes(job.state)
    || !Number.isSafeInteger(job.revision) || job.revision < 1
    || !Number.isSafeInteger(job.attempt) || job.attempt < 0
    || !Number.isSafeInteger(job.fencing_token) || job.fencing_token < 0
    || !Number.isSafeInteger(job.recovery_count) || job.recovery_count < 0
    || !timestamp.safeParse(job.available_at).success || !timestamp.safeParse(job.created_at).success || !timestamp.safeParse(job.updated_at).success
    || (job.result_sha256 !== null && !sha.safeParse(job.result_sha256).success)
    || (job.comparison_sha256 !== null && !sha.safeParse(job.comparison_sha256).success)
    || (job.disagreement_id !== null && !id.safeParse(job.disagreement_id).success)
    || (job.safe_error_code !== null && !/^[A-Z][A-Z0-9_]{2,95}$/u.test(job.safe_error_code))) throw new Error("SHADOW_JOB_INVALID");
  const activelyLeased = job.state === "leased" || job.state === "running";
  if (activelyLeased !== (job.lease_owner !== null && job.lease_expires_at !== null)
    || (job.lease_owner !== null && !id.safeParse(job.lease_owner).success)
    || (job.lease_expires_at !== null && !timestamp.safeParse(job.lease_expires_at).success)
    || (job.state === "completed" && (job.result_sha256 === null || job.comparison_sha256 === null || job.safe_error_code !== null))
    || (job.state !== "completed" && (job.result_sha256 !== null || job.comparison_sha256 !== null || job.disagreement_id !== null))
    || (job.state === "failed" && job.safe_error_code === null)) throw new Error("SHADOW_JOB_STATE_INVARIANT_INVALID");
  const { job_sha256: expected, ...content } = job;
  durableShadowRunEnvelopeSchema.parse(content.envelope);
  if (canonicalSha256(content) !== expected) throw new Error("SHADOW_JOB_HASH_MISMATCH");
  if (content.automatic_customer_promotion || content.automatic_production_promotion) throw new Error("SHADOW_AUTOMATIC_PROMOTION_FORBIDDEN");
  return job;
}
