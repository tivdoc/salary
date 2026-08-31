import { createHash } from "node:crypto";

import type { AuditEventInput, AuditEventPort } from "../../../../../engine/wave4/contracts.ts";
import type { DurableJob, DurableJobState } from "../../../jobs/durable-job-queue.ts";
import { canonicalSha256 } from "../../canonical.ts";
import { PlatformPersistenceError } from "../../contracts.ts";
import { statement, type PostgresTransactionContext } from "../contracts.ts";
import {
  assertEnum,
  assertSha256,
  rowBoolean,
  rowJson,
  rowNullableSha256,
  rowNullableString,
  rowObject,
  rowSafeInteger,
  rowSha256,
  rowString,
  rowStringArray,
} from "./codec.ts";
import { CanonicalPostgresError } from "./errors.ts";

const JOB_STATES: readonly DurableJobState[] = ["queued", "leased", "running", "succeeded", "retry_wait", "cancelled", "dead_letter"];

export type DurableJobEnqueue = Readonly<{
  job_id: string;
  tenant_id: string;
  case_id: string | null;
  job_kind: string;
  idempotency_key: string;
  payload_sha256: string;
  payload: unknown;
  pinned_version_sha256s: readonly string[];
  max_attempts: number;
  available_at_ms: number;
}>;

export type DurableOutboxEvent = Readonly<{
  outbox_id: string;
  tenant_id: string;
  case_id: string | null;
  logical_effect_id: string;
  effect_kind: string;
  payload_sha256: string;
  payload: unknown;
  state: "pending" | "leased" | "published";
  fencing_token: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
}>;

const ENQUEUE_JOB = `
insert into public.engine_durable_jobs (
  job_id, tenant_id, canonical_case_id, job_kind, idempotency_key,
  payload, payload_sha256, pinned_version_sha256s, state, revision,
  attempt_count, max_attempts, available_at, fencing_token,
  cancellation_requested, created_at, updated_at
) values (
  $1, $2, $3, $4, $5, $6::jsonb, $7,
  array(select jsonb_array_elements_text($8::jsonb)), 'queued', 1,
  0, $9, to_timestamp($10 / 1000.0), 0, false,
  to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0)
)
on conflict (tenant_id, job_kind, idempotency_key) do nothing`;

const SELECT_JOB_BY_KEY = `
select job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
       payload, payload_sha256, pinned_version_sha256s, state, revision,
       attempt_count, max_attempts, (extract(epoch from available_at) * 1000)::bigint as available_at,
       lease_owner, case when lease_expires_at is null then null else lease_expires_at::text end as lease_expires_at,
       fencing_token, cancellation_requested, terminal_effect_sha256, replayed_from_job_id
from public.engine_durable_jobs
where tenant_id = $1 and job_kind = $2 and idempotency_key = $3
for update`;

const CLAIM_JOBS = `
select job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
       payload, payload_sha256, pinned_version_sha256s, state, revision,
       attempt_count, max_attempts, (extract(epoch from available_at) * 1000)::bigint as available_at,
       lease_owner, case when lease_expires_at is null then null else lease_expires_at::text end as lease_expires_at,
       fencing_token, cancellation_requested, terminal_effect_sha256, replayed_from_job_id
from private.claim_engine_platform_jobs($1, to_timestamp($2 / 1000.0), $3 * interval '1 millisecond', $4)`;

const START_JOB = `
update public.engine_durable_jobs
set state = 'running', revision = revision + 1, updated_at = to_timestamp($5 / 1000.0)
where job_id = $1 and tenant_id = $2 and lease_owner = $3 and fencing_token = $4
  and state = 'leased' and lease_expires_at > to_timestamp($5 / 1000.0)
returning job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
          payload, payload_sha256, pinned_version_sha256s, state, revision,
          attempt_count, max_attempts, (extract(epoch from available_at) * 1000)::bigint as available_at,
          lease_owner, lease_expires_at::text, fencing_token, cancellation_requested,
          terminal_effect_sha256, replayed_from_job_id`;

const HEARTBEAT_JOB = `
update public.engine_durable_jobs
set revision = revision + 1,
    lease_expires_at = to_timestamp(($5 + $6) / 1000.0),
    updated_at = to_timestamp($5 / 1000.0)
where job_id = $1 and tenant_id = $2 and lease_owner = $3 and fencing_token = $4
  and state in ('leased', 'running') and lease_expires_at > to_timestamp($5 / 1000.0)
returning job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
          payload, payload_sha256, pinned_version_sha256s, state, revision,
          attempt_count, max_attempts, (extract(epoch from available_at) * 1000)::bigint as available_at,
          lease_owner, lease_expires_at::text, fencing_token, cancellation_requested,
          terminal_effect_sha256, replayed_from_job_id`;

const FINISH_JOB = `
update public.engine_durable_jobs
set state = $6, revision = revision + 1, terminal_effect_sha256 = $7,
    lease_owner = null, lease_expires_at = null, updated_at = to_timestamp($5 / 1000.0)
where job_id = $1 and tenant_id = $2 and lease_owner = $3 and fencing_token = $4
  and state = 'running' and lease_expires_at > to_timestamp($5 / 1000.0)
returning job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
          payload, payload_sha256, pinned_version_sha256s, state, revision,
          attempt_count, max_attempts, (extract(epoch from available_at) * 1000)::bigint as available_at,
          lease_owner, null::text as lease_expires_at, fencing_token, cancellation_requested,
          terminal_effect_sha256, replayed_from_job_id`;

const RETRY_JOB = `
update public.engine_durable_jobs
set state = case when attempt_count >= max_attempts then 'dead_letter' else 'retry_wait' end,
    revision = revision + 1, available_at = to_timestamp(($5 + $6) / 1000.0),
    lease_owner = null, lease_expires_at = null, updated_at = to_timestamp($5 / 1000.0)
where job_id = $1 and tenant_id = $2 and lease_owner = $3 and fencing_token = $4
  and state = 'running' and lease_expires_at > to_timestamp($5 / 1000.0)
returning job_id, tenant_id, canonical_case_id as case_id, job_kind, idempotency_key,
          payload, payload_sha256, pinned_version_sha256s, state, revision,
          attempt_count, max_attempts, (extract(epoch from available_at) * 1000)::bigint as available_at,
          lease_owner, null::text as lease_expires_at, fencing_token, cancellation_requested,
          terminal_effect_sha256, replayed_from_job_id`;

const ENQUEUE_OUTBOX = `
insert into public.engine_outbox_events (
  outbox_id, tenant_id, canonical_case_id, logical_effect_id, effect_kind,
  payload, payload_sha256, state, fencing_token, created_at
) values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', 0, $8::timestamptz)
on conflict (tenant_id, logical_effect_id, outbox_id) do nothing
returning outbox_id`;

const CLAIM_OUTBOX = `
select outbox_id, tenant_id, canonical_case_id as case_id, logical_effect_id,
       effect_kind, payload, payload_sha256, state, fencing_token, lease_owner,
       case when lease_expires_at is null then null else lease_expires_at::text end as lease_expires_at
from private.claim_engine_platform_outbox($1, to_timestamp($2 / 1000.0), $3 * interval '1 millisecond')`;

const PUBLISH_OUTBOX = `
update public.engine_outbox_events
set state = 'published', published_at = to_timestamp($5 / 1000.0),
    lease_owner = null, lease_expires_at = null
where outbox_id = $1 and tenant_id = $2 and lease_owner = $3 and fencing_token = $4
  and state = 'leased' and lease_expires_at > to_timestamp($5 / 1000.0)
returning logical_effect_id`;

const INSERT_EFFECT = `
insert into public.engine_logical_effect_receipts (
  tenant_id, logical_effect_id, logical_effect_sha256, outbox_id, committed_at
) values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
on conflict (tenant_id, logical_effect_id) do nothing
returning logical_effect_sha256`;

const SELECT_EFFECT = `
select logical_effect_sha256 from public.engine_logical_effect_receipts
where tenant_id = $1 and logical_effect_id = $2`;

const AUDIT_LOCK = "select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))";
const AUDIT_TAIL = `
select case_sequence, event_sha256, occurred_at::text as occurred_at
from public.engine_platform_audit_events
where tenant_id = $1 and canonical_case_id = $2
order by case_sequence desc limit 1 for update`;
const AUDIT_INSERT = `
insert into public.engine_platform_audit_events (
  tenant_id, canonical_case_id, case_sequence, actor_id, action, resource_id,
  resource_revision, resource_sha256, reason_code, previous_sha256,
  event_sha256, occurred_at
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
returning sequence`;
const AUDIT_VERIFY = `
select case_sequence, actor_id, action, resource_id, resource_revision,
       resource_sha256, reason_code, previous_sha256, event_sha256,
       occurred_at::text as occurred_at
from public.engine_platform_audit_events
where tenant_id = $1 and canonical_case_id = $2
order by case_sequence`;

export class PostgresJobsOutboxAuditRepository implements AuditEventPort {
  readonly #context: PostgresTransactionContext;
  readonly #tenantId: string;
  readonly #caseId: string;

  constructor(context: PostgresTransactionContext, tenantId: string, caseId: string) {
    this.#context = context;
    this.#tenantId = tenantId;
    this.#caseId = caseId;
  }

  async enqueue(input: DurableJobEnqueue): Promise<DurableJob> {
    validateJobInput(input);
    await this.#context.client.query(statement("job_enqueue", ENQUEUE_JOB, [
      input.job_id, input.tenant_id, input.case_id, input.job_kind, input.idempotency_key,
      JSON.stringify(input.payload), input.payload_sha256, JSON.stringify(input.pinned_version_sha256s),
      input.max_attempts, input.available_at_ms, input.available_at_ms, input.available_at_ms,
    ]));
    const selected = await this.#context.client.query(statement("job_select_idempotent", SELECT_JOB_BY_KEY, [
      input.tenant_id, input.job_kind, input.idempotency_key,
    ]));
    if (selected.row_count !== 1 || selected.rows.length !== 1) throw new PlatformPersistenceError("RECORD_NOT_FOUND");
    const job = decodeJob(selected.rows[0]);
    if (job.payload_sha256 !== input.payload_sha256) throw new PlatformPersistenceError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
    return job;
  }

  async claim(workerId: string, nowMs: number, leaseMs: number, limit = 1): Promise<readonly DurableJob[]> {
    if (!workerId || !Number.isSafeInteger(nowMs) || leaseMs < 1 || limit < 1) throw new RangeError("JOB_CLAIM_ARGUMENT_INVALID");
    const result = await this.#context.client.query(statement("job_claim", CLAIM_JOBS, [workerId, nowMs, leaseMs, limit]));
    return Object.freeze(result.rows.map(decodeJob));
  }

  start(jobId: string, workerId: string, fencingToken: number, nowMs: number): Promise<DurableJob> {
    return this.transition("job_start", START_JOB, [jobId, this.#tenantId, workerId, fencingToken, nowMs]);
  }

  heartbeat(jobId: string, workerId: string, fencingToken: number, nowMs: number, leaseMs: number): Promise<DurableJob> {
    return this.transition("job_heartbeat", HEARTBEAT_JOB, [jobId, this.#tenantId, workerId, fencingToken, nowMs, leaseMs]);
  }

  async succeed(jobId: string, workerId: string, fencingToken: number, nowMs: number, logicalEffectSha256: string): Promise<DurableJob> {
    assertSha256(logicalEffectSha256);
    return this.transition("job_succeed", FINISH_JOB, [jobId, this.#tenantId, workerId, fencingToken, nowMs, "succeeded", logicalEffectSha256]);
  }

  fail(jobId: string, workerId: string, fencingToken: number, nowMs: number, retryDelayMs: number): Promise<DurableJob> {
    return this.transition("job_retry", RETRY_JOB, [jobId, this.#tenantId, workerId, fencingToken, nowMs, retryDelayMs]);
  }

  async enqueueOutbox(input: Omit<DurableOutboxEvent, "state" | "fencing_token" | "lease_owner" | "lease_expires_at_ms"> & { created_at: string }): Promise<void> {
    assertSha256(input.payload_sha256);
    if (canonicalSha256(input.payload) !== input.payload_sha256) throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH");
    const result = await this.#context.client.query(statement("outbox_enqueue", ENQUEUE_OUTBOX, [
      input.outbox_id, input.tenant_id, input.case_id, input.logical_effect_id, input.effect_kind,
      JSON.stringify(input.payload), input.payload_sha256, input.created_at,
    ]));
    if (result.row_count !== 1) throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH");
  }

  async claimOutbox(workerId: string, nowMs: number, leaseMs: number): Promise<DurableOutboxEvent | null> {
    const result = await this.#context.client.query(statement("outbox_claim", CLAIM_OUTBOX, [workerId, nowMs, leaseMs]));
    if (result.row_count === 0) return null;
    if (result.row_count !== 1 || result.rows.length !== 1) throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH");
    return decodeOutbox(result.rows[0]);
  }

  async publishOutbox(input: Readonly<{
    outbox_id: string;
    worker_id: string;
    fencing_token: number;
    now_ms: number;
    logical_effect_sha256: string;
  }>): Promise<Readonly<{ deduplicated: boolean }>> {
    assertSha256(input.logical_effect_sha256);
    const published = await this.#context.client.query(statement("outbox_publish", PUBLISH_OUTBOX, [
      input.outbox_id, this.#tenantId, input.worker_id, input.fencing_token, input.now_ms,
    ]));
    if (published.row_count !== 1 || published.rows.length !== 1) throw new PlatformPersistenceError("STALE_FENCING_TOKEN");
    const logicalEffectId = rowString(rowObject(published.rows[0]), "logical_effect_id");
    const inserted = await this.#context.client.query(statement("logical_effect_insert", INSERT_EFFECT, [
      this.#tenantId, logicalEffectId, input.logical_effect_sha256, input.outbox_id, input.now_ms,
    ]));
    if (inserted.row_count === 1) return Object.freeze({ deduplicated: false });
    const prior = await this.#context.client.query(statement("logical_effect_select", SELECT_EFFECT, [this.#tenantId, logicalEffectId]));
    if (prior.row_count !== 1 || rowSha256(rowObject(prior.rows[0]), "logical_effect_sha256") !== input.logical_effect_sha256) {
      throw new PlatformPersistenceError("LOGICAL_EFFECT_MISMATCH");
    }
    return Object.freeze({ deduplicated: true });
  }

  async append(input: AuditEventInput): Promise<Readonly<{ sequence: number; previous_sha256: string | null; event_sha256: string }>> {
    validateAuditInput(input);
    await this.#context.client.query(statement("audit_chain_lock", AUDIT_LOCK, [this.#tenantId, this.#caseId]));
    const tail = await this.#context.client.query(statement("audit_tail", AUDIT_TAIL, [this.#tenantId, this.#caseId]));
    const prior = tail.row_count === 0 ? null : rowObject(tail.rows[0]);
    if (prior && Date.parse(rowString(prior, "occurred_at")) > Date.parse(input.occurred_at)) {
      throw new PlatformPersistenceError("INVALID_STATE_TRANSITION");
    }
    const sequence = prior ? rowSafeInteger(prior, "case_sequence", 1) + 1 : 1;
    const previousSha256 = prior ? rowSha256(prior, "event_sha256") : null;
    const eventSha256 = auditSha256(input, sequence, previousSha256);
    const inserted = await this.#context.client.query(statement("audit_append", AUDIT_INSERT, [
      this.#tenantId, this.#caseId, sequence, input.actor_id, input.action, input.resource_id,
      input.resource_revision, input.resource_sha256, input.reason, previousSha256, eventSha256, input.occurred_at,
    ]));
    if (inserted.row_count !== 1) throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH");
    return Object.freeze({ sequence, previous_sha256: previousSha256, event_sha256: eventSha256 });
  }

  async verify(): Promise<Readonly<{ valid: boolean; event_count: number; tail_sha256: string | null }>> {
    const result = await this.#context.client.query(statement("audit_verify", AUDIT_VERIFY, [this.#tenantId, this.#caseId]));
    let previous: string | null = null;
    for (let index = 0; index < result.rows.length; index += 1) {
      const row = rowObject(result.rows[index]);
      const sequence = rowSafeInteger(row, "case_sequence", 1);
      const input: AuditEventInput = Object.freeze({
        actor_id: rowString(row, "actor_id"),
        action: rowString(row, "action"),
        resource_id: rowString(row, "resource_id"),
        resource_revision: rowSafeInteger(row, "resource_revision"),
        resource_sha256: rowSha256(row, "resource_sha256"),
        reason: rowString(row, "reason_code"),
        occurred_at: rowString(row, "occurred_at"),
      });
      const recordedPrevious = rowNullableSha256(row, "previous_sha256");
      const recorded = rowSha256(row, "event_sha256");
      if (sequence !== index + 1 || recordedPrevious !== previous || recorded !== auditSha256(input, sequence, previous)) {
        return Object.freeze({ valid: false, event_count: result.rows.length, tail_sha256: previous });
      }
      previous = recorded;
    }
    return Object.freeze({ valid: true, event_count: result.rows.length, tail_sha256: previous });
  }

  private async transition(name: string, sql: string, values: readonly (string | number | null)[]): Promise<DurableJob> {
    const result = await this.#context.client.query(statement(name, sql, values));
    if (result.row_count !== 1 || result.rows.length !== 1) throw new PlatformPersistenceError("STALE_FENCING_TOKEN");
    return decodeJob(result.rows[0]);
  }
}

function validateJobInput(input: DurableJobEnqueue): void {
  assertSha256(input.payload_sha256);
  input.pinned_version_sha256s.forEach(assertSha256);
  if (canonicalSha256(input.payload) !== input.payload_sha256) throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH");
  if (!Number.isSafeInteger(input.max_attempts) || input.max_attempts < 1 || !Number.isSafeInteger(input.available_at_ms)) {
    throw new RangeError("JOB_ARGUMENT_INVALID");
  }
}

function decodeJob(value: unknown): DurableJob {
  const row = rowObject(value);
  const lease = rowNullableString(row, "lease_expires_at");
  const payload = rowJson(row, "payload");
  const payloadSha256 = rowSha256(row, "payload_sha256");
  if (canonicalSha256(payload) !== payloadSha256) throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH");
  return Object.freeze({
    job_id: rowString(row, "job_id"),
    tenant_id: rowString(row, "tenant_id"),
    case_id: rowNullableString(row, "case_id"),
    job_kind: rowString(row, "job_kind"),
    idempotency_key: rowString(row, "idempotency_key"),
    payload,
    payload_sha256: payloadSha256,
    pinned_version_sha256s: rowStringArray(row, "pinned_version_sha256s"),
    state: assertEnum(rowString(row, "state"), JOB_STATES),
    revision: rowSafeInteger(row, "revision", 1),
    attempt_count: rowSafeInteger(row, "attempt_count"),
    max_attempts: rowSafeInteger(row, "max_attempts", 1),
    available_at_ms: rowSafeInteger(row, "available_at"),
    lease_owner: rowNullableString(row, "lease_owner"),
    lease_expires_at_ms: nullableTimestampMs(lease),
    fencing_token: rowSafeInteger(row, "fencing_token"),
    cancellation_requested: rowBoolean(row, "cancellation_requested"),
    terminal_effect_sha256: rowNullableSha256(row, "terminal_effect_sha256"),
    replayed_from_job_id: rowNullableString(row, "replayed_from_job_id"),
  });
}

function decodeOutbox(value: unknown): DurableOutboxEvent {
  const row = rowObject(value);
  const state = assertEnum(rowString(row, "state"), ["pending", "leased", "published"] as const);
  const lease = rowNullableString(row, "lease_expires_at");
  const payload = rowJson(row, "payload");
  const payloadSha256 = rowSha256(row, "payload_sha256");
  if (canonicalSha256(payload) !== payloadSha256) throw new PlatformPersistenceError("PAYLOAD_HASH_MISMATCH");
  return Object.freeze({
    outbox_id: rowString(row, "outbox_id"),
    tenant_id: rowString(row, "tenant_id"),
    case_id: rowNullableString(row, "case_id"),
    logical_effect_id: rowString(row, "logical_effect_id"),
    effect_kind: rowString(row, "effect_kind"),
    payload,
    payload_sha256: payloadSha256,
    state,
    fencing_token: rowSafeInteger(row, "fencing_token"),
    lease_owner: rowNullableString(row, "lease_owner"),
    lease_expires_at_ms: nullableTimestampMs(lease),
  });
}

function validateAuditInput(input: AuditEventInput): void {
  assertSha256(input.resource_sha256);
  if (!input.actor_id || !input.action || !input.resource_id || !input.reason) throw new TypeError("AUDIT_FIELD_INVALID");
  if (!Number.isSafeInteger(input.resource_revision) || input.resource_revision < 0 || Number.isNaN(Date.parse(input.occurred_at))) {
    throw new TypeError("AUDIT_BINDING_INVALID");
  }
}

function auditSha256(input: AuditEventInput, sequence: number, previousSha256: string | null): string {
  const canonical = JSON.stringify({
    action: input.action,
    actor_id: input.actor_id,
    occurred_at: input.occurred_at,
    previous_sha256: previousSha256,
    reason: input.reason,
    resource_id: input.resource_id,
    resource_revision: input.resource_revision,
    resource_sha256: input.resource_sha256,
    sequence,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function nullableTimestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new CanonicalPostgresError("POSTGRES_ROW_MALFORMED");
  return parsed;
}
