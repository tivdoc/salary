import "./server-boundary.ts";

import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { statement, type PostgresTransactionContext } from "../../platform/persistence/postgres/contracts.ts";
import {
  rowBoolean,
  rowJson,
  rowNullableSha256,
  rowObject,
  rowSafeInteger,
  rowSha256,
  rowString,
  rowStringArray,
} from "../../platform/persistence/postgres/runtime/codec.ts";
import { CanonicalPostgresError } from "../../platform/persistence/postgres/runtime/errors.ts";
import { PostgresJobsOutboxAuditRepository } from "../../platform/persistence/postgres/runtime/jobs-outbox-audit.ts";
import type { DurableProductRouteSessionContextPort } from "../routes/durable-registration.ts";
import {
  GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
  GLOBAL_DEPENDENCY_STAGES,
  GlobalDependencyInvalidationService,
  type AppliedGlobalDependencyInvalidation,
  type DependencyIdempotencyRecord,
  type DependencyWorkerFence,
  type DurableGlobalDependencyInvalidationPort,
  type DurableGlobalDependencyInvalidationTransaction,
  type GlobalDependencyCurrentState,
  type GlobalDependencyInvalidationPlan,
  type GlobalDependencyInvalidationReceipt,
  type GlobalDependencyStage,
} from "./global-invalidation.ts";

const IDEMPOTENCY_SCOPE = "global_dependency_invalidation";
const HASH = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const LIFECYCLE_STATES = new Set([
  "awaiting_payment", "awaiting_documents", "awaiting_extraction_review",
  "awaiting_fact_resolution", "ready_for_legal_evaluation", "awaiting_legal_review",
  "awaiting_report_approval", "report_ready", "release_hold", "delivered", "cancelled",
]);

const CASE_LOCK_SQL = `
select private.global_dependency_actor_assert($3),
       pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended($1 || ':' || $2 || ':global-dependency-invalidation', 0)
)`;

const IDEMPOTENCY_READ_SQL = `
select command_sha256, result_sha256, result_payload, state
from public.engine_idempotency_records
where tenant_id = $1 and canonical_case_id = $2
  and scope = $3 and idempotency_key = $4
for update`;

const CURRENT_LOCK_SQL = `
with locked as materialized (
  select dependency.tenant_id,
         dependency.canonical_case_id,
         dependency.case_revision as dependency_case_revision,
         state.revision as authoritative_case_revision,
         dependency.dependency_epoch,
         dependency.cache_epoch,
         dependency.download_grant_epoch,
         dependency.current_dependency_sha256,
         dependency.stale_stages,
         dependency.release_hold,
         dependency.dependencies_approved,
         dependency.execution_binding_sha256,
         dependency.approval_binding_sha256,
         dependency.download_binding_sha256,
         dependency.latest_invalidation_sha256,
         state.lifecycle_state,
         greatest(dependency.updated_at, state.updated_at) as updated_at,
       (
         select history.event_sha256
         from public.engine_case_lifecycle_revisions history
         where history.tenant_id = state.tenant_id and history.case_id = state.case_id
         order by history.revision desc limit 1
       ) as lifecycle_previous_sha256
  from public.engine_global_dependency_state dependency
  join public.engine_case_state state
    on state.tenant_id = dependency.tenant_id
   and state.canonical_case_id = dependency.canonical_case_id
  where dependency.tenant_id = $1 and dependency.canonical_case_id = $2
  for update of dependency, state
), synchronized as (
  update public.engine_global_dependency_state dependency
     set case_revision = locked.authoritative_case_revision,
         release_hold = dependency.release_hold
           or locked.lifecycle_state in ('release_hold','cancelled'),
         updated_at = locked.updated_at
    from locked
   where dependency.tenant_id = locked.tenant_id
     and dependency.canonical_case_id = locked.canonical_case_id
     and dependency.case_revision = locked.dependency_case_revision
     and locked.authoritative_case_revision > locked.dependency_case_revision
  returning dependency.case_revision
)
select locked.authoritative_case_revision::text as case_revision,
       locked.dependency_epoch::text,
       locked.cache_epoch::text,
       locked.download_grant_epoch::text,
       locked.current_dependency_sha256,
       locked.stale_stages,
       locked.release_hold or locked.lifecycle_state in ('release_hold','cancelled') as release_hold,
       locked.dependencies_approved,
       locked.execution_binding_sha256,
       locked.approval_binding_sha256,
       locked.download_binding_sha256,
       locked.latest_invalidation_sha256,
       locked.lifecycle_state,
       locked.updated_at,
       locked.lifecycle_previous_sha256
from locked
where locked.authoritative_case_revision = locked.dependency_case_revision
   or exists (select 1 from synchronized)`;

const WORKER_FENCE_SQL = `
select job_id, lease_owner,
       fencing_token::text,
       (extract(epoch from lease_expires_at) * 1000)::bigint::text as lease_expires_at_ms
from public.engine_durable_jobs
where tenant_id = $1 and canonical_case_id = $2 and job_id = $3
  and state = 'running' and lease_owner = $4 and fencing_token = $5
  and lease_expires_at > to_timestamp($6 / 1000.0)
  and (extract(epoch from lease_expires_at) * 1000)::bigint = $7
for update`;

const CASE_ADVANCE_SQL = `
with lifecycle as (
  insert into public.engine_case_lifecycle_revisions (
    case_id, tenant_id, revision, state_before, state_after, event_kind,
    command_sha256, event_sha256, previous_sha256, occurred_at
  )
  select state.case_id, state.tenant_id, $3, $4, $5,
         'global_dependency_invalidated', $6, $7, $8, $9::timestamptz
  from public.engine_case_state state
  where state.tenant_id = $1 and state.canonical_case_id = $2
    and state.revision = $10 and state.lifecycle_state = $4
  returning case_id
)
update public.engine_case_state state
set revision = $3, lifecycle_state = $5, state_sha256 = $11,
    updated_at = $9::timestamptz
from lifecycle
where state.case_id = lifecycle.case_id and state.tenant_id = $1
  and state.canonical_case_id = $2 and state.revision = $10
returning state.revision::text`;

const APPROVALS_INVALIDATE_SQL = `
with latest as materialized (
  select distinct on (review.task_id) review.*
  from public.engine_review_task_versions review
  where review.tenant_id = $1 and review.canonical_case_id = $2
    and review.task_kind = 'report_approval'
  order by review.task_id, review.revision desc
), invalidated as (
  insert into public.engine_review_task_versions (
    task_id, revision, tenant_id, case_id, task_kind, input_sha256,
    output_sha256, task_sha256, decision_payload, decision_sha256,
    invalidated_at, created_at, report_id, report_revision, report_sha256,
    release_state, canonical_case_id
  )
  select prior.task_id, prior.revision + 1, prior.tenant_id, prior.case_id,
         prior.task_kind, prior.input_sha256, $3,
         pg_catalog.encode(public.digest(pg_catalog.convert_to(
           $4::text || ':' || prior.task_id || ':' || (prior.revision + 1)::text,
           'UTF8'
         ), 'sha256'), 'hex'),
         pg_catalog.jsonb_build_object(
           'decision', 'invalidated', 'reason_code', $5::text,
           'invalidation_id', $6::text, 'mutation_kind', $7::text,
           'prior_revision', prior.revision
         ),
         pg_catalog.encode(public.digest(pg_catalog.convert_to(
           $4::text || ':' || prior.task_id || ':' || (prior.revision + 1)::text,
           'UTF8'
         ), 'sha256'), 'hex'),
         $8::timestamptz, $8::timestamptz,
         prior.report_id, prior.report_revision, prior.report_sha256,
         'invalidated', prior.canonical_case_id
  from latest prior
  where prior.release_state = 'approved' and prior.invalidated_at is null
  returning task_id
)
select count(*)::text as approvals_invalidated from invalidated`;

const REPORT_OBJECTS_REVOKE_SQL = `
with candidates as materialized (
  select object.tenant_id, object.canonical_case_id, object.report_id,
         object.report_revision, object.state as prior_state
  from public.product_private_report_objects object
  where object.tenant_id = $1 and object.canonical_case_id = $2
    and object.state in ('staged','approved') and object.revoked_at is null
  for update
), revoked as (
  update public.product_private_report_objects object
  set state = 'revoked', grant_epoch = object.grant_epoch + 1,
      revocation_receipt_sha256 = $3, revoked_at = $4::timestamptz
  from candidates candidate
  where object.tenant_id = candidate.tenant_id
    and object.canonical_case_id = candidate.canonical_case_id
    and object.report_id = candidate.report_id
    and object.report_revision = candidate.report_revision
  returning object.report_id, object.report_revision
)
select count(*) filter (where candidate.prior_state = 'approved')::text as grants_revoked,
       count(*)::text as objects_revoked
from candidates candidate
join revoked on revoked.report_id = candidate.report_id
 and revoked.report_revision = candidate.report_revision`;

const JOBS_CANCEL_SQL = `
with candidates as materialized (
  select job.job_id, job.state as prior_state, job.revision as prior_revision,
         job.fencing_token,
         (
           select history.event_sha256 from public.engine_job_history history
           where history.job_id = job.job_id
           order by history.sequence desc limit 1
         ) as previous_sha256
  from public.engine_durable_jobs job
  where job.tenant_id = $1 and job.canonical_case_id = $2
    and job.job_id <> $3
    and job.state in ('queued','leased','running','retry_wait')
  for update of job
), cancelled as (
  update public.engine_durable_jobs job
  set state = 'cancelled', revision = job.revision + 1,
      cancellation_requested = true, lease_owner = null, lease_expires_at = null,
      updated_at = $4::timestamptz
  from candidates candidate
  where job.tenant_id = $1 and job.job_id = candidate.job_id
  returning job.job_id, job.revision, job.fencing_token
), history as (
  insert into public.engine_job_history (
    job_id, from_state, to_state, revision, fencing_token, reason_code,
    previous_sha256, event_sha256, occurred_at, tenant_id, canonical_case_id
  )
  select candidate.job_id, candidate.prior_state, 'cancelled', cancelled.revision,
         cancelled.fencing_token, $5, candidate.previous_sha256,
         pg_catalog.encode(public.digest(pg_catalog.convert_to(
           $1 || ':' || candidate.job_id || ':' || cancelled.revision::text || ':' ||
           cancelled.fencing_token::text || ':' || $6 || ':' ||
           coalesce(candidate.previous_sha256, ''), 'UTF8'
         ), 'sha256'), 'hex'),
         $4::timestamptz, $1, $2
  from candidates candidate
  join cancelled on cancelled.job_id = candidate.job_id
  returning job_id
)
select count(*)::text as jobs_cancelled from history`;

const OUTBOX_SUPERSEDE_SQL = `
update public.engine_outbox_events
set state = 'superseded', lease_owner = null, lease_expires_at = null,
    superseded_at = $4::timestamptz, superseded_by_invalidation_id = $3
where tenant_id = $1 and canonical_case_id = $2
  and state in ('pending','leased') and outbox_id <> $5`;

const CURRENT_UPDATE_SQL = `
update public.engine_global_dependency_state
set case_revision = $3, dependency_epoch = $4, cache_epoch = $5,
    download_grant_epoch = $6, current_dependency_sha256 = $7,
    stale_stages = array(select pg_catalog.jsonb_array_elements_text($8::jsonb)),
    release_hold = $9, dependencies_approved = false,
    execution_binding_sha256 = null, approval_binding_sha256 = null,
    download_binding_sha256 = null, latest_invalidation_sha256 = $10,
    updated_at = $11::timestamptz
where tenant_id = $1 and canonical_case_id = $2
  and case_revision = $12 and dependency_epoch = $13 and cache_epoch = $14
  and download_grant_epoch = $15 and current_dependency_sha256 = $16
returning case_revision::text`;

const HISTORY_INSERT_SQL = `
insert into public.engine_global_dependency_invalidations (
  invalidation_id, tenant_id, canonical_case_id, command_sha256,
  invalidation_sha256, prior_invalidation_sha256, mutation_kind,
  dependency_id, previous_dependency_sha256, next_dependency_sha256,
  case_revision, dependency_epoch, cache_epoch, download_grant_epoch,
  stale_stages, release_hold, actor_id, reason_code, worker_job_id, worker_id,
  worker_fencing_token, audit_event_sha256, outbox_id, outbox_payload_sha256,
  grants_revoked, jobs_cancelled, outbox_events_superseded,
  plan_payload, applied_payload, occurred_at
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
  array(select pg_catalog.jsonb_array_elements_text($15::jsonb)),
  $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
  $28::jsonb,$29::jsonb,$30::timestamptz
) returning invalidation_id`;

const IDEMPOTENCY_COMMIT_SQL = `
insert into public.engine_idempotency_records (
  tenant_id, canonical_case_id, scope, idempotency_key, command_sha256,
  result_sha256, result_payload, state, created_at, committed_at
) values (
  $1,$2,$3,$4,$5,$6,$7::jsonb,'committed',transaction_timestamp(),transaction_timestamp()
)
on conflict (tenant_id, scope, idempotency_key) do nothing
returning idempotency_key`;

const IDEMPOTENCY_VERIFY_SQL = `
select command_sha256, result_sha256, result_payload, state
from public.engine_idempotency_records
where tenant_id = $1 and canonical_case_id = $2
  and scope = $3 and idempotency_key = $4
for update`;

type LockedCase = Readonly<{
  current: GlobalDependencyCurrentState;
  lifecycle_state: string;
  updated_at: string;
  lifecycle_previous_sha256: string | null;
}>;

export type DurablePostgresGlobalInvalidationInput = Readonly<{
  session_context: DurableProductRouteSessionContextPort;
  actor: VerifiedActor;
  correlation_id: string;
}>;

/**
 * Operations-role adapter for the global invalidation service. Every command
 * re-enters one verified PostgreSQL transaction; there is no memory branch.
 */
export class DurablePostgresGlobalDependencyInvalidationPort
implements DurableGlobalDependencyInvalidationPort<PostgresTransactionContext> {
  readonly #sessionContext: DurableProductRouteSessionContextPort;
  readonly #actor: VerifiedActor;
  readonly #correlationId: string;

  constructor(input: DurablePostgresGlobalInvalidationInput) {
    if (input.session_context.proof_class !== "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT"
        || input.session_context.uses_service_role !== false
        || input.session_context.bypasses_rls !== false
        || input.actor.verified_server_side !== true
        || input.actor.tenant_id === null
        || !OPAQUE.test(input.actor.actor_id)
        || !OPAQUE.test(input.correlation_id)) {
      throw new Error("DURABLE_GLOBAL_INVALIDATION_SESSION_REQUIRED");
    }
    this.#sessionContext = input.session_context;
    this.#actor = input.actor;
    this.#correlationId = input.correlation_id;
  }

  transaction<TResult>(
    scope: Readonly<{ tenant_id: string; case_id: string }>,
    operation: (
      transaction: DurableGlobalDependencyInvalidationTransaction<PostgresTransactionContext>,
    ) => Promise<TResult>,
  ): Promise<TResult> {
    if (this.#actor.tenant_id !== scope.tenant_id
        || !this.#actor.assigned_case_ids.includes(scope.case_id)) {
      throw new Error("DURABLE_GLOBAL_INVALIDATION_SCOPE_FORBIDDEN");
    }
    return this.#sessionContext.transaction({
      actor: this.#actor,
      audience: "operations",
      case_id: scope.case_id,
      correlation_id: this.#correlationId,
    }, async (bundle) => {
      const transaction = new PostgresGlobalDependencyInvalidationTransaction(
        bundle.context,
        scope.tenant_id,
        scope.case_id,
        this.#actor.actor_id,
      );
      await transaction.acquireCaseLock();
      return operation(transaction);
    });
  }
}

export function createDurablePostgresGlobalDependencyInvalidationService(
  input: DurablePostgresGlobalInvalidationInput,
): GlobalDependencyInvalidationService<PostgresTransactionContext> {
  return new GlobalDependencyInvalidationService(
    new DurablePostgresGlobalDependencyInvalidationPort(input),
  );
}

class PostgresGlobalDependencyInvalidationTransaction
implements DurableGlobalDependencyInvalidationTransaction<PostgresTransactionContext> {
  readonly context: PostgresTransactionContext;
  readonly #tenantId: string;
  readonly #caseId: string;
  readonly #actorId: string;
  #locked: LockedCase | null = null;

  constructor(context: PostgresTransactionContext, tenantId: string, caseId: string, actorId: string) {
    this.context = context;
    this.#tenantId = tenantId;
    this.#caseId = caseId;
    this.#actorId = actorId;
  }

  async acquireCaseLock(): Promise<void> {
    await this.context.client.query(statement(
      "global_invalidation_case_lock",
      CASE_LOCK_SQL,
      [this.#tenantId, this.#caseId, this.#actorId],
    ));
  }

  async readIdempotency(idempotencyKey: string): Promise<DependencyIdempotencyRecord | null> {
    const result = await this.context.client.query(statement(
      "global_invalidation_idempotency_read",
      IDEMPOTENCY_READ_SQL,
      [this.#tenantId, this.#caseId, IDEMPOTENCY_SCOPE, idempotencyKey],
    ));
    if (result.row_count === 0) return null;
    if (result.row_count !== 1 || result.rows.length !== 1) malformed();
    return decodeIdempotency(result.rows[0]);
  }

  async lockCurrent(): Promise<GlobalDependencyCurrentState> {
    if (this.#locked) return this.#locked.current;
    const result = await this.context.client.query(statement(
      "global_invalidation_current_lock",
      CURRENT_LOCK_SQL,
      [this.#tenantId, this.#caseId],
    ));
    if (result.row_count !== 1 || result.rows.length !== 1) malformed();
    this.#locked = decodeLockedCase(result.rows[0]);
    return this.#locked.current;
  }

  async assertWorkerFence(fence: DependencyWorkerFence): Promise<void> {
    const result = await this.context.client.query(statement(
      "global_invalidation_fence_assert",
      WORKER_FENCE_SQL,
      [
        this.#tenantId, this.#caseId, fence.job_id, fence.worker_id,
        fence.fencing_token, fence.now_ms, fence.lease_expires_at_ms,
      ],
    ));
    if (result.row_count !== 1 || result.rows.length !== 1) staleFence();
    const row = rowObject(result.rows[0]);
    if (rowString(row, "job_id") !== fence.job_id
        || rowString(row, "lease_owner") !== fence.worker_id
        || rowSafeInteger(row, "fencing_token", 1) !== fence.fencing_token
        || rowSafeInteger(row, "lease_expires_at_ms", 1) !== fence.lease_expires_at_ms) {
      staleFence();
    }
  }

  async apply(plan: GlobalDependencyInvalidationPlan): Promise<AppliedGlobalDependencyInvalidation> {
    const locked = this.#locked;
    if (!locked) malformed();
    if (Date.parse(plan.occurred_at) < Date.parse(locked.updated_at)) malformed();
    const nextLifecycle = plan.release_hold ? "release_hold" : locked.lifecycle_state;
    const caseStateSha256 = canonicalSha256({
      tenant_id: plan.tenant_id,
      case_id: plan.case_id,
      revision: plan.next_case_revision,
      lifecycle_state: nextLifecycle,
      command_sha256: plan.command_sha256,
    });
    const lifecycleEventSha256 = canonicalSha256({
      previous_sha256: locked.lifecycle_previous_sha256,
      state_sha256: caseStateSha256,
      event_kind: "global_dependency_invalidated",
      occurred_at: plan.occurred_at,
    });
    const advanced = await this.context.client.query(statement(
      "global_invalidation_case_advance",
      CASE_ADVANCE_SQL,
      [
        plan.tenant_id, plan.case_id, plan.next_case_revision,
        locked.lifecycle_state, nextLifecycle, plan.command_sha256,
        lifecycleEventSha256, locked.lifecycle_previous_sha256, plan.occurred_at,
        locked.current.case_revision, caseStateSha256,
      ],
    ));
    oneAffected(advanced.row_count);

    const approvalResult = await this.context.client.query(statement(
      "global_invalidation_approvals_append",
      APPROVALS_INVALIDATE_SQL,
      [
        plan.tenant_id, plan.case_id, plan.invalidation_sha256,
        plan.invalidation_sha256, plan.reason_code, plan.invalidation_id,
        plan.mutation_kind, plan.occurred_at,
      ],
    ));
    const approvalsInvalidated = aggregateCount(approvalResult, "approvals_invalidated");

    const objectResult = await this.context.client.query(statement(
      "global_invalidation_report_objects_revoke",
      REPORT_OBJECTS_REVOKE_SQL,
      [plan.tenant_id, plan.case_id, plan.invalidation_sha256, plan.occurred_at],
    ));
    const grantsRevoked = aggregateCount(objectResult, "grants_revoked");
    aggregateCount(objectResult, "objects_revoked");

    const jobResult = await this.context.client.query(statement(
      "global_invalidation_jobs_cancel",
      JOBS_CANCEL_SQL,
      [
        plan.tenant_id, plan.case_id, plan.worker_fence.job_id, plan.occurred_at,
        plan.reason_code, plan.invalidation_sha256,
      ],
    ));
    const jobsCancelled = aggregateCount(jobResult, "jobs_cancelled");

    const outboxResult = await this.context.client.query(statement(
      "global_invalidation_outbox_supersede",
      OUTBOX_SUPERSEDE_SQL,
      [
        plan.tenant_id, plan.case_id, plan.invalidation_id,
        plan.occurred_at, plan.outbox.outbox_id,
      ],
    ));
    const outboxEventsSuperseded = safeRowCount(outboxResult.row_count);

    const currentResult = await this.context.client.query(statement(
      "global_invalidation_current_update",
      CURRENT_UPDATE_SQL,
      [
        plan.tenant_id, plan.case_id, plan.next_case_revision,
        plan.next_dependency_epoch, plan.next_cache_epoch,
        plan.next_download_grant_epoch, plan.next_dependency_sha256,
        JSON.stringify(plan.stale_stages), plan.release_hold,
        plan.invalidation_sha256, plan.occurred_at,
        locked.current.case_revision, locked.current.dependency_epoch,
        locked.current.cache_epoch, locked.current.download_grant_epoch,
        locked.current.current_dependency_sha256,
      ],
    ));
    oneAffected(currentResult.row_count);

    const durable = new PostgresJobsOutboxAuditRepository(
      this.context,
      plan.tenant_id,
      plan.case_id,
    );
    const audit = await durable.append({
      actor_id: plan.actor_id,
      action: "GLOBAL_DEPENDENCY_INVALIDATED",
      resource_id: plan.invalidation_id,
      resource_revision: plan.next_case_revision,
      resource_sha256: plan.invalidation_sha256,
      reason: plan.reason_code,
      occurred_at: plan.occurred_at,
    });
    await durable.enqueueOutbox({
      outbox_id: plan.outbox.outbox_id,
      tenant_id: plan.tenant_id,
      case_id: plan.case_id,
      logical_effect_id: plan.outbox.logical_effect_id,
      effect_kind: plan.outbox.effect_kind,
      payload: plan.outbox.payload,
      payload_sha256: plan.outbox.payload_sha256,
      created_at: plan.occurred_at,
    });

    const applied = deepFreeze({
      invalidation_sha256: plan.invalidation_sha256,
      case_revision: plan.next_case_revision,
      dependency_epoch: plan.next_dependency_epoch,
      cache_epoch: plan.next_cache_epoch,
      download_grant_epoch: plan.next_download_grant_epoch,
      stale_stages: plan.stale_stages,
      release_hold: plan.release_hold,
      historical_evidence_preserved: true as const,
      historical_versions_deleted: 0 as const,
      approval_invalidated: true as const,
      stale_execution_blocked: true as const,
      stale_approval_blocked: true as const,
      stale_download_blocked: true as const,
      grants_revoked: grantsRevoked,
      jobs_cancelled: jobsCancelled,
      outbox_events_superseded: outboxEventsSuperseded,
      cache_versioned: true as const,
      worker_fencing_token: plan.worker_fence.fencing_token,
      audit_event_sha256: audit.event_sha256,
      outbox_id: plan.outbox.outbox_id,
      outbox_payload_sha256: plan.outbox.payload_sha256,
    }) satisfies AppliedGlobalDependencyInvalidation;

    const history = await this.context.client.query(statement(
      "global_invalidation_history_append",
      HISTORY_INSERT_SQL,
      [
        plan.invalidation_id, plan.tenant_id, plan.case_id, plan.command_sha256,
        plan.invalidation_sha256, plan.prior_invalidation_sha256,
        plan.mutation_kind, plan.dependency_id, plan.previous_dependency_sha256,
        plan.next_dependency_sha256, plan.next_case_revision,
        plan.next_dependency_epoch, plan.next_cache_epoch,
        plan.next_download_grant_epoch, JSON.stringify(plan.stale_stages),
        plan.release_hold, plan.actor_id, plan.reason_code,
        plan.worker_fence.job_id, plan.worker_fence.worker_id,
        plan.worker_fence.fencing_token, audit.event_sha256,
        plan.outbox.outbox_id, plan.outbox.payload_sha256,
        grantsRevoked, jobsCancelled, outboxEventsSuperseded,
        JSON.stringify(plan), JSON.stringify(applied), plan.occurred_at,
      ],
    ));
    oneAffected(history.row_count);
    void approvalsInvalidated;
    return applied;
  }

  async commitIdempotency(
    idempotencyKey: string,
    commandSha256: string,
    receipt: GlobalDependencyInvalidationReceipt,
  ): Promise<void> {
    const inserted = await this.context.client.query(statement(
      "global_invalidation_idempotency_commit",
      IDEMPOTENCY_COMMIT_SQL,
      [
        this.#tenantId, this.#caseId, IDEMPOTENCY_SCOPE, idempotencyKey,
        commandSha256, receipt.receipt_sha256, JSON.stringify(receipt),
      ],
    ));
    if (inserted.row_count === 1) return;
    const verified = await this.context.client.query(statement(
      "global_invalidation_idempotency_verify",
      IDEMPOTENCY_VERIFY_SQL,
      [this.#tenantId, this.#caseId, IDEMPOTENCY_SCOPE, idempotencyKey],
    ));
    if (verified.row_count !== 1 || verified.rows.length !== 1) malformed();
    const prior = decodeIdempotency(verified.rows[0]);
    if (prior.command_sha256 !== commandSha256
        || prior.receipt.receipt_sha256 !== receipt.receipt_sha256) malformed();
  }
}

function decodeLockedCase(value: unknown): LockedCase {
  const row = rowObject(value);
  const staleStages = orderedStages(rowStringArray(row, "stale_stages"));
  const lifecycleState = rowString(row, "lifecycle_state");
  if (!LIFECYCLE_STATES.has(lifecycleState)) malformed();
  const updatedAt = rowString(row, "updated_at");
  if (Number.isNaN(Date.parse(updatedAt))) malformed();
  return deepFreeze({
    current: {
      case_revision: rowSafeInteger(row, "case_revision"),
      dependency_epoch: rowSafeInteger(row, "dependency_epoch"),
      cache_epoch: rowSafeInteger(row, "cache_epoch"),
      download_grant_epoch: rowSafeInteger(row, "download_grant_epoch"),
      current_dependency_sha256: rowSha256(row, "current_dependency_sha256"),
      stale_stages: staleStages,
      release_hold: rowBoolean(row, "release_hold"),
      dependencies_approved: rowBoolean(row, "dependencies_approved"),
      action_bindings: {
        execution: rowNullableSha256(row, "execution_binding_sha256"),
        approval: rowNullableSha256(row, "approval_binding_sha256"),
        download: rowNullableSha256(row, "download_binding_sha256"),
      },
      latest_invalidation_sha256: rowNullableSha256(row, "latest_invalidation_sha256"),
    },
    lifecycle_state: lifecycleState,
    updated_at: new Date(updatedAt).toISOString(),
    lifecycle_previous_sha256: rowNullableSha256(row, "lifecycle_previous_sha256"),
  });
}

function decodeIdempotency(value: unknown): DependencyIdempotencyRecord {
  const row = rowObject(value);
  if (rowString(row, "state") !== "committed") malformed();
  const commandSha256 = rowSha256(row, "command_sha256");
  const resultSha256 = rowSha256(row, "result_sha256");
  const payload = rowObject(rowJson(row, "result_payload"));
  if (payload.schema_version !== GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION
      || payload.command_sha256 !== commandSha256
      || payload.receipt_sha256 !== resultSha256) malformed();
  return deepFreeze({
    command_sha256: commandSha256,
    receipt: payload as unknown as GlobalDependencyInvalidationReceipt,
  });
}

function orderedStages(stages: readonly string[]): readonly GlobalDependencyStage[] {
  if (stages.some((stage) => !GLOBAL_DEPENDENCY_STAGES.includes(stage as GlobalDependencyStage))) {
    malformed();
  }
  const ordered = GLOBAL_DEPENDENCY_STAGES.filter((stage) => stages.includes(stage));
  if (ordered.length !== stages.length
      || ordered.some((stage, index) => stage !== stages[index])) malformed();
  return Object.freeze(ordered);
}

function aggregateCount(
  result: Readonly<{ row_count: number; rows: readonly Readonly<Record<string, unknown>>[] }>,
  key: string,
): number {
  if (result.row_count !== 1 || result.rows.length !== 1) malformed();
  return rowSafeInteger(rowObject(result.rows[0]), key);
}

function safeRowCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) malformed();
  return value;
}

function oneAffected(value: number): void {
  if (value !== 1) malformed();
}

function staleFence(): never {
  throw new CanonicalPostgresError("POSTGRES_TRANSACTION_FAILED", {
    domain_code: "STALE_FENCING_TOKEN",
  });
}

function malformed(): never {
  throw new CanonicalPostgresError("POSTGRES_ROW_MALFORMED");
}

export const DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF = Object.freeze({
  schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
  persistence: "postgresql" as const,
  memory_fallbacks: 0 as const,
  historical_delete_statements: 0 as const,
  worker_fence_required: true as const,
  durable_audit: true as const,
  durable_outbox: true as const,
  exact_hash_replay: true as const,
  outbox_supersession_is_not_publication: true as const,
  artifact_sha256_format: HASH.source,
});
