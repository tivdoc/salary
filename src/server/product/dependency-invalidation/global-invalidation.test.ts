import { describe, expect, it, vi } from "vitest";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import {
  GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
  GLOBAL_DEPENDENCY_STAGES,
  GlobalDependencyInvalidationService,
  planGlobalDependencyInvalidation,
  type AppliedGlobalDependencyInvalidation,
  type DependencyIdempotencyRecord,
  type DependencyWorkerFence,
  type DurableGlobalDependencyInvalidationPort,
  type DurableGlobalDependencyInvalidationTransaction,
  type GlobalDependencyCurrentState,
  type GlobalDependencyInvalidationPlan,
  type GlobalDependencyInvalidationReceipt,
  type GlobalDependencyMutation,
  type GlobalDependencyMutationKind,
  type GlobalDependencyStage,
} from "./global-invalidation.ts";

const TENANT = "tenant.synthetic.001";
const CASE = "case.synthetic.001";
const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);
const EXECUTION_BINDING = "c".repeat(64);
const APPROVAL_BINDING = "d".repeat(64);
const DOWNLOAD_BINDING = "e".repeat(64);

const actor: VerifiedActor = Object.freeze({
  actor_id: "actor.synthetic.001",
  role: "scoped_background_worker",
  tenant_id: TENANT,
  assigned_case_ids: Object.freeze([CASE]),
  verified_server_side: true,
  break_glass_reason: null,
  break_glass_expires_at: null,
});

const fence: DependencyWorkerFence = Object.freeze({
  job_id: "job.invalidation.001",
  worker_id: "worker.invalidation.001",
  fencing_token: 7,
  now_ms: 1_000,
  lease_expires_at_ms: 5_000,
});

function mutation(
  kind: GlobalDependencyMutationKind = "fact_correction",
  overrides: Partial<GlobalDependencyMutation> = {},
): GlobalDependencyMutation {
  return Object.freeze({
    schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
    tenant_id: TENANT,
    case_id: CASE,
    expected_case_revision: 5,
    mutation_kind: kind,
    dependency_id: `dependency.${kind}.001`,
    previous_dependency_sha256: BEFORE,
    next_dependency_sha256: AFTER,
    actor,
    reason_code: "SYNTHETIC_DEPENDENCY_CHANGED",
    idempotency_key: `invalidation.${kind}.0001`,
    occurred_at: "2030-01-01T00:00:00.000Z",
    worker_fence: fence,
    ...overrides,
  });
}

function currentState(): GlobalDependencyCurrentState {
  return Object.freeze({
    case_revision: 5,
    dependency_epoch: 2,
    cache_epoch: 3,
    download_grant_epoch: 4,
    current_dependency_sha256: BEFORE,
    stale_stages: Object.freeze([]),
    release_hold: false,
    dependencies_approved: true,
    action_bindings: Object.freeze({
      execution: EXECUTION_BINDING,
      approval: APPROVAL_BINDING,
      download: DOWNLOAD_BINDING,
    }),
    latest_invalidation_sha256: null,
  });
}

type MutableState = {
  current: GlobalDependencyCurrentState;
  idempotency: Map<string, DependencyIdempotencyRecord>;
  history: GlobalDependencyInvalidationPlan[];
  audit: string[];
  outbox: string[];
  historical_versions: string[];
  active_grants: number;
  active_jobs: number;
  unpublished_outbox: number;
};

type TestContext = Readonly<{ transaction_id: number }>;

class MemoryDurableInvalidationPort implements DurableGlobalDependencyInvalidationPort<TestContext> {
  #state: MutableState;
  #tail: Promise<void> = Promise.resolve();
  #transactionId = 0;
  readonly order: string[] = [];
  readonly malformedApply: boolean;

  constructor(input: Readonly<{ malformedApply?: boolean; dependenciesApproved?: boolean }> = {}) {
    this.malformedApply = input.malformedApply ?? false;
    this.#state = {
      current: Object.freeze({ ...currentState(), dependencies_approved: input.dependenciesApproved ?? true }),
      idempotency: new Map(),
      history: [],
      audit: [],
      outbox: [],
      historical_versions: ["analysis.v1", "trace.v1", "report.v1", "approval.v1"],
      active_grants: 2,
      active_jobs: 3,
      unpublished_outbox: 1,
    };
  }

  transaction<TResult>(
    scope: Readonly<{ tenant_id: string; case_id: string }>,
    operation: (transaction: DurableGlobalDependencyInvalidationTransaction<TestContext>) => Promise<TResult>,
  ): Promise<TResult> {
    const run = this.#tail.then(async () => {
      if (scope.tenant_id !== TENANT || scope.case_id !== CASE) throw new Error("scope_mismatch");
      const working = cloneState(this.#state);
      const context = Object.freeze({ transaction_id: ++this.#transactionId });
      const transaction: DurableGlobalDependencyInvalidationTransaction<TestContext> = Object.freeze({
        context,
        readIdempotency: async (key: string) => working.idempotency.get(key) ?? null,
        lockCurrent: async () => {
          this.order.push("lock");
          return cloneCurrent(working.current);
        },
        assertWorkerFence: async (candidate: DependencyWorkerFence) => {
          this.order.push("fence");
          if (candidate.job_id !== fence.job_id
              || candidate.worker_id !== fence.worker_id
              || candidate.fencing_token !== fence.fencing_token
              || candidate.lease_expires_at_ms <= candidate.now_ms) {
            throw new Error("STALE_FENCING_TOKEN");
          }
        },
        apply: async (plan: GlobalDependencyInvalidationPlan) => {
          this.order.push("apply");
          const grants = working.active_grants;
          const jobs = working.active_jobs;
          const superseded = working.unpublished_outbox;
          const auditSha256 = canonicalSha256({
            action: "GLOBAL_DEPENDENCY_INVALIDATED",
            invalidation_sha256: plan.invalidation_sha256,
            case_revision: plan.next_case_revision,
          });
          working.history.push(plan);
          working.audit.push(auditSha256);
          working.outbox.push(plan.outbox.outbox_id);
          working.active_grants = 0;
          working.active_jobs = 0;
          working.unpublished_outbox = 0;
          working.current = Object.freeze({
            case_revision: plan.next_case_revision,
            dependency_epoch: plan.next_dependency_epoch,
            cache_epoch: plan.next_cache_epoch,
            download_grant_epoch: plan.next_download_grant_epoch,
            current_dependency_sha256: plan.next_dependency_sha256,
            stale_stages: Object.freeze([...plan.stale_stages]),
            release_hold: plan.release_hold,
            dependencies_approved: false,
            action_bindings: Object.freeze({ execution: null, approval: null, download: null }),
            latest_invalidation_sha256: plan.invalidation_sha256,
          });
          const applied: AppliedGlobalDependencyInvalidation = Object.freeze({
            invalidation_sha256: plan.invalidation_sha256,
            case_revision: plan.next_case_revision,
            dependency_epoch: plan.next_dependency_epoch,
            cache_epoch: plan.next_cache_epoch,
            download_grant_epoch: plan.next_download_grant_epoch,
            stale_stages: plan.stale_stages,
            release_hold: plan.release_hold,
            historical_evidence_preserved: true,
            historical_versions_deleted: 0,
            approval_invalidated: true,
            stale_execution_blocked: true,
            stale_approval_blocked: true,
            stale_download_blocked: true,
            grants_revoked: grants,
            jobs_cancelled: jobs,
            outbox_events_superseded: superseded,
            cache_versioned: true,
            worker_fencing_token: plan.worker_fence.fencing_token,
            audit_event_sha256: auditSha256,
            outbox_id: plan.outbox.outbox_id,
            outbox_payload_sha256: plan.outbox.payload_sha256,
          });
          return this.malformedApply
            ? Object.freeze({ ...applied, historical_versions_deleted: 1 }) as unknown as AppliedGlobalDependencyInvalidation
            : applied;
        },
        commitIdempotency: async (
          key: string,
          commandSha256: string,
          receipt: GlobalDependencyInvalidationReceipt,
        ) => {
          this.order.push("idempotency");
          working.idempotency.set(key, Object.freeze({ command_sha256: commandSha256, receipt }));
        },
      });
      const result = await operation(transaction);
      this.#state = working;
      return result;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  snapshot() {
    return cloneState(this.#state);
  }

  markRebuilt(input: Readonly<{
    dependency_sha256: string;
    execution_binding: string;
    approval_binding: string;
    download_binding: string;
  }>): void {
    this.#state.current = Object.freeze({
      ...this.#state.current,
      current_dependency_sha256: input.dependency_sha256,
      stale_stages: Object.freeze([]),
      release_hold: false,
      dependencies_approved: true,
      action_bindings: Object.freeze({
        execution: input.execution_binding,
        approval: input.approval_binding,
        download: input.download_binding,
      }),
    });
  }
}

function cloneCurrent(current: GlobalDependencyCurrentState): GlobalDependencyCurrentState {
  return Object.freeze({
    ...current,
    stale_stages: Object.freeze([...current.stale_stages]),
    action_bindings: Object.freeze({ ...current.action_bindings }),
  });
}

function cloneState(state: MutableState): MutableState {
  return {
    current: cloneCurrent(state.current),
    idempotency: new Map(state.idempotency),
    history: [...state.history],
    audit: [...state.audit],
    outbox: [...state.outbox],
    historical_versions: [...state.historical_versions],
    active_grants: state.active_grants,
    active_jobs: state.active_jobs,
    unpublished_outbox: state.unpublished_outbox,
  };
}

describe("global dependency invalidation", () => {
  it.each([
    ["document_changed", "documents", false],
    ["fact_correction", "facts", false],
    ["clarification_answered", "confirmations", false],
    ["source_version_changed", "legal_source", false],
    ["source_period_changed", "legal_source", false],
    ["source_scope_changed", "legal_source", false],
    ["parameter_changed", "parameters", false],
    ["rulespec_changed", "rulespec", false],
    ["reviewer_key_revoked", "approval", false],
    ["report_changed", "report", false],
    ["chargeback", "approval", true],
    ["privacy_request", "documents", true],
  ] as const)("closes %s from %s through cache", (kind, firstStage, releaseHold) => {
    const plan = planGlobalDependencyInvalidation(mutation(kind), currentState());
    const expected = GLOBAL_DEPENDENCY_STAGES.slice(GLOBAL_DEPENDENCY_STAGES.indexOf(firstStage));
    expect(plan.stale_stages).toEqual(expected);
    expect(plan.release_hold).toBe(releaseHold);
    expect(plan).toMatchObject({
      preserve_historical_evidence: true,
      invalidate_approval: true,
      revoke_download_grants: true,
      block_stale_execution: true,
      block_stale_approval: true,
      block_stale_download: true,
      cancel_uncommitted_jobs: true,
      supersede_unpublished_outbox: true,
      next_case_revision: 6,
      next_dependency_epoch: 3,
      next_cache_epoch: 4,
      next_download_grant_epoch: 5,
    });
    expect(plan.outbox.payload_sha256).toBe(canonicalSha256(plan.outbox.payload));
  });

  it("commits stale state, grant/job/outbox/cache effects and audit after the worker fence", async () => {
    const port = new MemoryDurableInvalidationPort();
    const service = new GlobalDependencyInvalidationService(port);
    const receipt = await service.invalidate(mutation());

    expect(port.order).toEqual(["lock", "fence", "apply", "idempotency"]);
    expect(receipt).toMatchObject({
      case_revision: 6,
      dependency_epoch: 3,
      cache_epoch: 4,
      download_grant_epoch: 5,
      historical_evidence_preserved: true,
      historical_versions_deleted: 0,
      approval_invalidated: true,
      stale_execution_blocked: true,
      stale_approval_blocked: true,
      stale_download_blocked: true,
      grants_revoked: 2,
      jobs_cancelled: 3,
      outbox_events_superseded: 1,
      cache_versioned: true,
      idempotent_replay: false,
    });
    const state = port.snapshot();
    expect(state.historical_versions).toEqual(["analysis.v1", "trace.v1", "report.v1", "approval.v1"]);
    expect(state.history).toHaveLength(1);
    expect(state.audit).toEqual([receipt.audit_event_sha256]);
    expect(state.outbox).toEqual([receipt.outbox_id]);
    expect(state.current.stale_stages).toContain("download_grant");
  });

  it("replays after service restart and rejects same-key command drift without another effect", async () => {
    const port = new MemoryDurableInvalidationPort();
    const first = await new GlobalDependencyInvalidationService(port).invalidate(mutation());
    const replay = await new GlobalDependencyInvalidationService(port).invalidate(mutation());
    expect(replay).toEqual({ ...first, idempotent_replay: true });
    expect(port.snapshot().history).toHaveLength(1);

    await expect(new GlobalDependencyInvalidationService(port).invalidate(mutation("fact_correction", {
      next_dependency_sha256: "f".repeat(64),
    }))).rejects.toThrow("GLOBAL_INVALIDATION_IDEMPOTENCY_CONFLICT");
    expect(port.snapshot().history).toHaveLength(1);
  });

  it("serializes concurrent mutations, rejects stale fencing and rolls back incomplete effects", async () => {
    const concurrentPort = new MemoryDurableInvalidationPort();
    const service = new GlobalDependencyInvalidationService(concurrentPort);
    const results = await Promise.allSettled([
      service.invalidate(mutation()),
      service.invalidate(mutation("source_version_changed", {
        next_dependency_sha256: "f".repeat(64),
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(concurrentPort.snapshot().history).toHaveLength(1);

    const staleFencePort = new MemoryDurableInvalidationPort();
    await expect(new GlobalDependencyInvalidationService(staleFencePort).invalidate(mutation("fact_correction", {
      worker_fence: Object.freeze({ ...fence, fencing_token: 6 }),
    }))).rejects.toThrow("STALE_FENCING_TOKEN");
    expect(staleFencePort.snapshot().history).toHaveLength(0);

    const malformedPort = new MemoryDurableInvalidationPort({ malformedApply: true });
    await expect(new GlobalDependencyInvalidationService(malformedPort).invalidate(mutation()))
      .rejects.toThrow("GLOBAL_INVALIDATION_APPLY_INCOMPLETE");
    expect(malformedPort.snapshot()).toMatchObject({
      current: { case_revision: 5, cache_epoch: 3, download_grant_epoch: 4 },
      history: [],
      audit: [],
      outbox: [],
    });
  });

  it("rechecks action currentness inside the transaction and never trusts an old grant alone", async () => {
    const port = new MemoryDurableInvalidationPort();
    const service = new GlobalDependencyInvalidationService(port);
    const operation = vi.fn(async (context: TestContext) => context.transaction_id);
    await expect(service.withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "execution",
      execution_mode: "synthetic_test",
      expected_case_revision: 5,
      expected_dependency_sha256: BEFORE,
      expected_binding_sha256: EXECUTION_BINDING,
    }, operation)).resolves.toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);

    await expect(service.withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "download",
      expected_case_revision: 5,
      expected_dependency_sha256: BEFORE,
      expected_binding_sha256: DOWNLOAD_BINDING,
    }, operation)).rejects.toThrow("GLOBAL_DEPENDENCY_ACTION_NOT_CURRENT");

    await service.invalidate(mutation());
    port.markRebuilt({
      dependency_sha256: AFTER,
      execution_binding: "1".repeat(64),
      approval_binding: "2".repeat(64),
      download_binding: "3".repeat(64),
    });
    await expect(service.withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "download",
      expected_case_revision: 6,
      expected_dependency_sha256: AFTER,
      expected_binding_sha256: "3".repeat(64),
      expected_download_grant_epoch: 4,
    }, operation)).rejects.toThrow("GLOBAL_DEPENDENCY_ACTION_NOT_CURRENT");

    await expect(service.withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "download",
      expected_case_revision: 6,
      expected_dependency_sha256: AFTER,
      expected_binding_sha256: "3".repeat(64),
      expected_download_grant_epoch: 5,
    }, operation)).resolves.toBeGreaterThan(1);
  });

  it("fails closed before real execution when dependencies are not approved", async () => {
    const port = new MemoryDurableInvalidationPort({ dependenciesApproved: false });
    const operation = vi.fn(async () => "must-not-run");
    await expect(new GlobalDependencyInvalidationService(port).withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "execution",
      execution_mode: "synthetic_test",
      expected_case_revision: 5,
      expected_dependency_sha256: BEFORE,
      expected_binding_sha256: EXECUTION_BINDING,
    }, operation)).rejects.toThrow("GLOBAL_DEPENDENCY_ACTION_NOT_CURRENT");
    expect(operation).not.toHaveBeenCalled();

    const readyPort = new MemoryDurableInvalidationPort();
    await expect(new GlobalDependencyInvalidationService(readyPort).withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "execution",
      execution_mode: "real",
      expected_case_revision: 5,
      expected_dependency_sha256: BEFORE,
      expected_binding_sha256: EXECUTION_BINDING,
    }, operation)).rejects.toThrow("GLOBAL_DEPENDENCY_REAL_EXECUTION_FORBIDDEN");
    expect(operation).not.toHaveBeenCalled();
  });
});
