import "./server-boundary.ts";

import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";

export const GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION =
  "tivdoc-global-dependency-invalidation-v0.10.2" as const;

export const GLOBAL_DEPENDENCY_STAGES = Object.freeze([
  "documents",
  "facts",
  "confirmations",
  "legal_source",
  "parameters",
  "rulespec",
  "rule_input",
  "analysis",
  "trace",
  "report",
  "pdf",
  "approval",
  "download_grant",
  "job",
  "outbox",
  "cache",
] as const);

export const GLOBAL_DEPENDENCY_MUTATION_KINDS = Object.freeze([
  "document_changed",
  "fact_correction",
  "clarification_answered",
  "source_version_changed",
  "source_period_changed",
  "source_scope_changed",
  "parameter_changed",
  "rulespec_changed",
  "reviewer_key_revoked",
  "report_changed",
  "chargeback",
  "privacy_request",
] as const);

export type GlobalDependencyStage = (typeof GLOBAL_DEPENDENCY_STAGES)[number];
export type GlobalDependencyMutationKind = (typeof GLOBAL_DEPENDENCY_MUTATION_KINDS)[number];
export type DependencyAuthorizationAction = "execution" | "approval" | "download";

export type DependencyWorkerFence = Readonly<{
  job_id: string;
  worker_id: string;
  fencing_token: number;
  now_ms: number;
  lease_expires_at_ms: number;
}>;

export type GlobalDependencyMutation = Readonly<{
  schema_version: typeof GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION;
  tenant_id: string;
  case_id: string;
  expected_case_revision: number;
  mutation_kind: GlobalDependencyMutationKind;
  dependency_id: string;
  previous_dependency_sha256: string;
  next_dependency_sha256: string;
  actor: VerifiedActor;
  reason_code: string;
  idempotency_key: string;
  occurred_at: string;
  worker_fence: DependencyWorkerFence;
}>;

export type GlobalDependencyCurrentState = Readonly<{
  case_revision: number;
  dependency_epoch: number;
  cache_epoch: number;
  download_grant_epoch: number;
  current_dependency_sha256: string;
  stale_stages: readonly GlobalDependencyStage[];
  release_hold: boolean;
  dependencies_approved: boolean;
  action_bindings: Readonly<Record<DependencyAuthorizationAction, string | null>>;
  latest_invalidation_sha256: string | null;
}>;

export type GlobalDependencyInvalidationPlan = Readonly<{
  schema_version: typeof GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION;
  invalidation_id: string;
  command_sha256: string;
  tenant_id: string;
  case_id: string;
  mutation_kind: GlobalDependencyMutationKind;
  dependency_id: string;
  previous_dependency_sha256: string;
  next_dependency_sha256: string;
  prior_invalidation_sha256: string | null;
  next_case_revision: number;
  next_dependency_epoch: number;
  next_cache_epoch: number;
  next_download_grant_epoch: number;
  stale_stages: readonly GlobalDependencyStage[];
  release_hold: boolean;
  preserve_historical_evidence: true;
  invalidate_approval: true;
  revoke_download_grants: true;
  block_stale_execution: true;
  block_stale_approval: true;
  block_stale_download: true;
  cancel_uncommitted_jobs: true;
  supersede_unpublished_outbox: true;
  actor_id: string;
  reason_code: string;
  occurred_at: string;
  worker_fence: DependencyWorkerFence;
  invalidation_sha256: string;
  outbox: Readonly<{
    outbox_id: string;
    logical_effect_id: string;
    effect_kind: "global_dependency_invalidated";
    payload: Readonly<{
      schema_version: typeof GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION;
      invalidation_id: string;
      tenant_id: string;
      case_id: string;
      mutation_kind: GlobalDependencyMutationKind;
      case_revision: number;
      dependency_epoch: number;
      cache_epoch: number;
      download_grant_epoch: number;
      invalidation_sha256: string;
    }>;
    payload_sha256: string;
  }>;
}>;

export type AppliedGlobalDependencyInvalidation = Readonly<{
  invalidation_sha256: string;
  case_revision: number;
  dependency_epoch: number;
  cache_epoch: number;
  download_grant_epoch: number;
  stale_stages: readonly GlobalDependencyStage[];
  release_hold: boolean;
  historical_evidence_preserved: true;
  historical_versions_deleted: 0;
  approval_invalidated: true;
  stale_execution_blocked: true;
  stale_approval_blocked: true;
  stale_download_blocked: true;
  grants_revoked: number;
  jobs_cancelled: number;
  outbox_events_superseded: number;
  cache_versioned: true;
  worker_fencing_token: number;
  audit_event_sha256: string;
  outbox_id: string;
  outbox_payload_sha256: string;
}>;

export type GlobalDependencyInvalidationReceipt = Readonly<{
  schema_version: typeof GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION;
  invalidation_id: string;
  command_sha256: string;
  invalidation_sha256: string;
  case_revision: number;
  dependency_epoch: number;
  cache_epoch: number;
  download_grant_epoch: number;
  stale_stages: readonly GlobalDependencyStage[];
  release_hold: boolean;
  historical_evidence_preserved: true;
  historical_versions_deleted: 0;
  approval_invalidated: true;
  stale_execution_blocked: true;
  stale_approval_blocked: true;
  stale_download_blocked: true;
  grants_revoked: number;
  jobs_cancelled: number;
  outbox_events_superseded: number;
  cache_versioned: true;
  audit_event_sha256: string;
  outbox_id: string;
  outbox_payload_sha256: string;
  receipt_sha256: string;
  idempotent_replay: boolean;
}>;

export type DependencyIdempotencyRecord = Readonly<{
  command_sha256: string;
  receipt: GlobalDependencyInvalidationReceipt;
}>;

/**
 * Every callback is executed inside one durable transaction. Implementations
 * must roll back all writes when the callback rejects and must lock both the
 * case currentness row and idempotency key until commit.
 */
export interface DurableGlobalDependencyInvalidationTransaction<TContext> {
  readonly context: TContext;
  readIdempotency(idempotencyKey: string): Promise<DependencyIdempotencyRecord | null>;
  lockCurrent(): Promise<GlobalDependencyCurrentState>;
  assertWorkerFence(fence: DependencyWorkerFence): Promise<void>;
  apply(plan: GlobalDependencyInvalidationPlan): Promise<AppliedGlobalDependencyInvalidation>;
  commitIdempotency(
    idempotencyKey: string,
    commandSha256: string,
    receipt: GlobalDependencyInvalidationReceipt,
  ): Promise<void>;
}

export interface DurableGlobalDependencyInvalidationPort<TContext> {
  transaction<TResult>(
    scope: Readonly<{ tenant_id: string; case_id: string }>,
    operation: (
      transaction: DurableGlobalDependencyInvalidationTransaction<TContext>,
    ) => Promise<TResult>,
  ): Promise<TResult>;
}

export type DependencyAuthorizationRequest = Readonly<{
  tenant_id: string;
  case_id: string;
  action: DependencyAuthorizationAction;
  expected_case_revision: number;
  expected_dependency_sha256: string;
  expected_binding_sha256: string;
  expected_download_grant_epoch?: number;
  execution_mode?: "synthetic_test" | "real";
}>;

export class GlobalDependencyInvalidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GlobalDependencyInvalidationError";
    this.code = code;
  }
}

export class GlobalDependencyInvalidationService<TContext = unknown> {
  readonly #port: DurableGlobalDependencyInvalidationPort<TContext>;

  constructor(port: DurableGlobalDependencyInvalidationPort<TContext>) {
    this.#port = port;
  }

  async invalidate(input: GlobalDependencyMutation): Promise<GlobalDependencyInvalidationReceipt> {
    assertMutation(input);
    const commandSha256 = canonicalSha256(input);
    return this.#port.transaction({ tenant_id: input.tenant_id, case_id: input.case_id }, async (transaction) => {
      const replay = await transaction.readIdempotency(input.idempotency_key);
      if (replay) {
        if (replay.command_sha256 !== commandSha256) fail("GLOBAL_INVALIDATION_IDEMPOTENCY_CONFLICT");
        assertReceipt(replay.receipt, commandSha256);
        return deepFreeze({ ...replay.receipt, idempotent_replay: true });
      }

      const current = await transaction.lockCurrent();
      assertCurrentState(current);
      if (current.case_revision !== input.expected_case_revision) fail("GLOBAL_INVALIDATION_REVISION_CONFLICT");
      if (current.current_dependency_sha256 !== input.previous_dependency_sha256) {
        fail("GLOBAL_INVALIDATION_DEPENDENCY_CONFLICT");
      }
      await transaction.assertWorkerFence(input.worker_fence);
      const plan = planGlobalDependencyInvalidation(input, current, commandSha256);
      const applied = await transaction.apply(plan);
      assertApplied(plan, applied);
      const receipt = receiptFor(plan, applied);
      await transaction.commitIdempotency(input.idempotency_key, commandSha256, receipt);
      return receipt;
    });
  }

  /**
   * Rechecks currentness and performs the protected action in that same
   * transaction. A download caller must supply the grant epoch; an old signed
   * grant alone is never sufficient.
   */
  async withCurrentAuthorization<TResult>(
    input: DependencyAuthorizationRequest,
    operation: (context: TContext, current: GlobalDependencyCurrentState) => Promise<TResult>,
  ): Promise<TResult> {
    assertAuthorization(input);
    if (input.action === "execution" && input.execution_mode === "real") {
      fail("GLOBAL_DEPENDENCY_REAL_EXECUTION_FORBIDDEN");
    }
    return this.#port.transaction({ tenant_id: input.tenant_id, case_id: input.case_id }, async (transaction) => {
      const current = await transaction.lockCurrent();
      assertCurrentState(current);
      const binding = current.action_bindings[input.action];
      if (current.case_revision !== input.expected_case_revision
          || current.current_dependency_sha256 !== input.expected_dependency_sha256
          || current.dependencies_approved !== true
          || current.release_hold
          || current.stale_stages.length !== 0
          || binding === null
          || binding !== input.expected_binding_sha256) {
        fail("GLOBAL_DEPENDENCY_ACTION_NOT_CURRENT");
      }
      if (input.action === "download") {
        if (input.expected_download_grant_epoch !== current.download_grant_epoch) {
          fail("GLOBAL_DEPENDENCY_ACTION_NOT_CURRENT");
        }
      } else if (input.expected_download_grant_epoch !== undefined) {
        fail("GLOBAL_INVALIDATION_INPUT_INVALID");
      }
      return operation(transaction.context, current);
    });
  }
}

export function planGlobalDependencyInvalidation(
  input: GlobalDependencyMutation,
  current: GlobalDependencyCurrentState,
  commandSha256 = canonicalSha256(input),
): GlobalDependencyInvalidationPlan {
  assertMutation(input);
  assertCurrentState(current);
  assertHash(commandSha256);
  if (current.case_revision !== input.expected_case_revision
      || current.current_dependency_sha256 !== input.previous_dependency_sha256) {
    fail("GLOBAL_INVALIDATION_REVISION_CONFLICT");
  }
  const firstStage = firstStageFor(input.mutation_kind);
  const downstream = GLOBAL_DEPENDENCY_STAGES.slice(GLOBAL_DEPENDENCY_STAGES.indexOf(firstStage));
  const staleStages = orderedStages([...current.stale_stages, ...downstream]);
  const invalidationId = `invalidation:${commandSha256.slice(0, 48)}`;
  const core = deepFreeze({
    schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
    invalidation_id: invalidationId,
    command_sha256: commandSha256,
    tenant_id: input.tenant_id,
    case_id: input.case_id,
    mutation_kind: input.mutation_kind,
    dependency_id: input.dependency_id,
    previous_dependency_sha256: input.previous_dependency_sha256,
    next_dependency_sha256: input.next_dependency_sha256,
    prior_invalidation_sha256: current.latest_invalidation_sha256,
    next_case_revision: current.case_revision + 1,
    next_dependency_epoch: current.dependency_epoch + 1,
    next_cache_epoch: current.cache_epoch + 1,
    next_download_grant_epoch: current.download_grant_epoch + 1,
    stale_stages: staleStages,
    release_hold: current.release_hold || input.mutation_kind === "chargeback" || input.mutation_kind === "privacy_request",
    preserve_historical_evidence: true as const,
    invalidate_approval: true as const,
    revoke_download_grants: true as const,
    block_stale_execution: true as const,
    block_stale_approval: true as const,
    block_stale_download: true as const,
    cancel_uncommitted_jobs: true as const,
    supersede_unpublished_outbox: true as const,
    actor_id: input.actor.actor_id,
    reason_code: input.reason_code,
    occurred_at: input.occurred_at,
    worker_fence: input.worker_fence,
  });
  const invalidationSha256 = canonicalSha256(core);
  const payload = deepFreeze({
    schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
    invalidation_id: invalidationId,
    tenant_id: input.tenant_id,
    case_id: input.case_id,
    mutation_kind: input.mutation_kind,
    case_revision: core.next_case_revision,
    dependency_epoch: core.next_dependency_epoch,
    cache_epoch: core.next_cache_epoch,
    download_grant_epoch: core.next_download_grant_epoch,
    invalidation_sha256: invalidationSha256,
  });
  const outbox = deepFreeze({
    outbox_id: `outbox:${commandSha256.slice(0, 48)}`,
    logical_effect_id: `effect:${commandSha256.slice(0, 48)}`,
    effect_kind: "global_dependency_invalidated" as const,
    payload,
    payload_sha256: canonicalSha256(payload),
  });
  return deepFreeze({ ...core, invalidation_sha256: invalidationSha256, outbox });
}

function receiptFor(
  plan: GlobalDependencyInvalidationPlan,
  applied: AppliedGlobalDependencyInvalidation,
): GlobalDependencyInvalidationReceipt {
  const unsigned = deepFreeze({
    schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
    invalidation_id: plan.invalidation_id,
    command_sha256: plan.command_sha256,
    invalidation_sha256: plan.invalidation_sha256,
    case_revision: applied.case_revision,
    dependency_epoch: applied.dependency_epoch,
    cache_epoch: applied.cache_epoch,
    download_grant_epoch: applied.download_grant_epoch,
    stale_stages: orderedStages(applied.stale_stages),
    release_hold: applied.release_hold,
    historical_evidence_preserved: true as const,
    historical_versions_deleted: 0 as const,
    approval_invalidated: true as const,
    stale_execution_blocked: true as const,
    stale_approval_blocked: true as const,
    stale_download_blocked: true as const,
    grants_revoked: applied.grants_revoked,
    jobs_cancelled: applied.jobs_cancelled,
    outbox_events_superseded: applied.outbox_events_superseded,
    cache_versioned: true as const,
    audit_event_sha256: applied.audit_event_sha256,
    outbox_id: applied.outbox_id,
    outbox_payload_sha256: applied.outbox_payload_sha256,
  });
  return deepFreeze({
    ...unsigned,
    receipt_sha256: canonicalSha256(unsigned),
    idempotent_replay: false,
  });
}

function assertApplied(
  plan: GlobalDependencyInvalidationPlan,
  applied: AppliedGlobalDependencyInvalidation,
): void {
  if (applied.invalidation_sha256 !== plan.invalidation_sha256
      || applied.case_revision !== plan.next_case_revision
      || applied.dependency_epoch !== plan.next_dependency_epoch
      || applied.cache_epoch !== plan.next_cache_epoch
      || applied.download_grant_epoch !== plan.next_download_grant_epoch
      || !sameStages(applied.stale_stages, plan.stale_stages)
      || applied.release_hold !== plan.release_hold
      || applied.historical_evidence_preserved !== true
      || applied.historical_versions_deleted !== 0
      || applied.approval_invalidated !== true
      || applied.stale_execution_blocked !== true
      || applied.stale_approval_blocked !== true
      || applied.stale_download_blocked !== true
      || applied.cache_versioned !== true
      || applied.worker_fencing_token !== plan.worker_fence.fencing_token
      || applied.outbox_id !== plan.outbox.outbox_id
      || applied.outbox_payload_sha256 !== plan.outbox.payload_sha256
      || !safeCount(applied.grants_revoked)
      || !safeCount(applied.jobs_cancelled)
      || !safeCount(applied.outbox_events_superseded)) {
    fail("GLOBAL_INVALIDATION_APPLY_INCOMPLETE");
  }
  assertHash(applied.audit_event_sha256);
  assertHash(applied.outbox_payload_sha256);
}

function assertReceipt(receipt: GlobalDependencyInvalidationReceipt, commandSha256: string): void {
  assertHash(receipt.receipt_sha256);
  assertHash(receipt.invalidation_sha256);
  assertHash(receipt.audit_event_sha256);
  assertHash(receipt.outbox_payload_sha256);
  if (receipt.schema_version !== GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION
      || receipt.command_sha256 !== commandSha256
      || receipt.historical_evidence_preserved !== true
      || receipt.historical_versions_deleted !== 0
      || receipt.approval_invalidated !== true
      || receipt.stale_execution_blocked !== true
      || receipt.stale_approval_blocked !== true
      || receipt.stale_download_blocked !== true
      || receipt.cache_versioned !== true
      || !safeCount(receipt.grants_revoked)
      || !safeCount(receipt.jobs_cancelled)
      || !safeCount(receipt.outbox_events_superseded)) {
    fail("GLOBAL_INVALIDATION_RECEIPT_INVALID");
  }
  const { receipt_sha256: ignoredReceiptSha256, idempotent_replay: ignoredReplay, ...unsigned } = receipt;
  void ignoredReceiptSha256;
  void ignoredReplay;
  if (canonicalSha256(unsigned) !== receipt.receipt_sha256) fail("GLOBAL_INVALIDATION_RECEIPT_INVALID");
}

function assertMutation(input: GlobalDependencyMutation): void {
  if (input.schema_version !== GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION
      || !GLOBAL_DEPENDENCY_MUTATION_KINDS.includes(input.mutation_kind)
      || !opaque(input.tenant_id)
      || !opaque(input.case_id)
      || !opaque(input.dependency_id)
      || !idempotencyKey(input.idempotency_key)
      || !/^[A-Z][A-Z0-9_]{2,79}$/u.test(input.reason_code)
      || !safeCount(input.expected_case_revision)
      || !timestamp(input.occurred_at)
      || input.previous_dependency_sha256 === input.next_dependency_sha256) {
    fail("GLOBAL_INVALIDATION_INPUT_INVALID");
  }
  assertHash(input.previous_dependency_sha256);
  assertHash(input.next_dependency_sha256);
  if (input.actor.verified_server_side !== true
      || input.actor.tenant_id !== input.tenant_id
      || !input.actor.assigned_case_ids.includes(input.case_id)
      || !opaque(input.actor.actor_id)) {
    fail("GLOBAL_INVALIDATION_ACTOR_FORBIDDEN");
  }
  assertFence(input.worker_fence);
}

function assertAuthorization(input: DependencyAuthorizationRequest): void {
  if (!opaque(input.tenant_id) || !opaque(input.case_id)
      || !safeCount(input.expected_case_revision)
      || !(["execution", "approval", "download"] as const).includes(input.action)) {
    fail("GLOBAL_INVALIDATION_INPUT_INVALID");
  }
  assertHash(input.expected_dependency_sha256);
  assertHash(input.expected_binding_sha256);
  if (input.action === "execution") {
    if (input.execution_mode !== "synthetic_test" && input.execution_mode !== "real") {
      fail("GLOBAL_INVALIDATION_INPUT_INVALID");
    }
  } else if (input.execution_mode !== undefined) {
    fail("GLOBAL_INVALIDATION_INPUT_INVALID");
  }
  if (input.expected_download_grant_epoch !== undefined && !safeCount(input.expected_download_grant_epoch)) {
    fail("GLOBAL_INVALIDATION_INPUT_INVALID");
  }
}

function assertCurrentState(current: GlobalDependencyCurrentState): void {
  if (!safeCount(current.case_revision)
      || !safeCount(current.dependency_epoch)
      || !safeCount(current.cache_epoch)
      || !safeCount(current.download_grant_epoch)
      || typeof current.release_hold !== "boolean"
      || typeof current.dependencies_approved !== "boolean") {
    fail("GLOBAL_INVALIDATION_CURRENT_STATE_INVALID");
  }
  assertHash(current.current_dependency_sha256);
  if (current.latest_invalidation_sha256 !== null) assertHash(current.latest_invalidation_sha256);
  if (!sameStages(current.stale_stages, orderedStages(current.stale_stages))) {
    fail("GLOBAL_INVALIDATION_CURRENT_STATE_INVALID");
  }
  const bindingKeys = Object.keys(current.action_bindings).sort();
  if (bindingKeys.join(",") !== "approval,download,execution") fail("GLOBAL_INVALIDATION_CURRENT_STATE_INVALID");
  for (const binding of Object.values(current.action_bindings)) if (binding !== null) assertHash(binding);
}

function assertFence(fence: DependencyWorkerFence): void {
  if (!opaque(fence.job_id) || !opaque(fence.worker_id)
      || !Number.isSafeInteger(fence.fencing_token) || fence.fencing_token < 1
      || !Number.isSafeInteger(fence.now_ms) || fence.now_ms < 1
      || !Number.isSafeInteger(fence.lease_expires_at_ms)
      || fence.lease_expires_at_ms <= fence.now_ms) {
    fail("GLOBAL_INVALIDATION_FENCE_INVALID");
  }
}

function firstStageFor(kind: GlobalDependencyMutationKind): GlobalDependencyStage {
  const stages: Readonly<Record<GlobalDependencyMutationKind, GlobalDependencyStage>> = Object.freeze({
    document_changed: "documents",
    fact_correction: "facts",
    clarification_answered: "confirmations",
    source_version_changed: "legal_source",
    source_period_changed: "legal_source",
    source_scope_changed: "legal_source",
    parameter_changed: "parameters",
    rulespec_changed: "rulespec",
    reviewer_key_revoked: "approval",
    report_changed: "report",
    chargeback: "approval",
    privacy_request: "documents",
  });
  return stages[kind];
}

function orderedStages(values: readonly GlobalDependencyStage[]): readonly GlobalDependencyStage[] {
  const unique = new Set(values);
  if ([...unique].some((value) => !GLOBAL_DEPENDENCY_STAGES.includes(value))) {
    fail("GLOBAL_INVALIDATION_CURRENT_STATE_INVALID");
  }
  return Object.freeze(GLOBAL_DEPENDENCY_STAGES.filter((stage) => unique.has(stage)));
}

function sameStages(left: readonly GlobalDependencyStage[], right: readonly GlobalDependencyStage[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function opaque(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u.test(value);
}

function idempotencyKey(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/u.test(value);
}

function timestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail("GLOBAL_INVALIDATION_HASH_INVALID");
}

function fail(code: string): never {
  throw new GlobalDependencyInvalidationError(code);
}
