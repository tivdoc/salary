import { describe, expect, it, vi } from "vitest";

import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type {
  PostgresClient,
  PostgresQueryResult,
  PostgresStatement,
  PostgresTransactionContext,
} from "../../platform/persistence/postgres/contracts.ts";
import type { DurableProductRouteSessionContextPort } from "../routes/durable-registration.ts";
import {
  GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
  type DependencyWorkerFence,
  type GlobalDependencyInvalidationReceipt,
  type GlobalDependencyMutation,
} from "./global-invalidation.ts";
import {
  createDurablePostgresGlobalDependencyInvalidationService,
  DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF,
} from "./postgres-port.ts";

const TENANT = "tenant.synthetic.001";
const CASE = "case.synthetic.001";
const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);
const EXECUTION = "c".repeat(64);
const APPROVAL = "d".repeat(64);
const DOWNLOAD = "e".repeat(64);

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

const mutation: GlobalDependencyMutation = Object.freeze({
  schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
  tenant_id: TENANT,
  case_id: CASE,
  expected_case_revision: 5,
  mutation_kind: "fact_correction",
  dependency_id: "dependency.synthetic.001",
  previous_dependency_sha256: BEFORE,
  next_dependency_sha256: AFTER,
  actor,
  reason_code: "SYNTHETIC_DEPENDENCY_CHANGED",
  idempotency_key: "invalidation.synthetic.0001",
  occurred_at: "2030-01-01T00:00:00.000Z",
  worker_fence: fence,
});

type Step = Readonly<{
  name: string;
  result?: PostgresQueryResult;
  inspect?: (statement: PostgresStatement) => void;
}>;

class ScriptedClient implements PostgresClient {
  readonly #steps: Step[];
  readonly statements: PostgresStatement[] = [];

  constructor(steps: readonly Step[]) {
    this.#steps = [...steps];
  }

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    const step = this.#steps.shift();
    expect(step?.name).toBe(statement.name);
    step?.inspect?.(statement);
    this.statements.push(statement);
    return step?.result ?? result();
  }

  assertComplete(): void {
    expect(this.#steps).toEqual([]);
  }
}

function result(
  rows: readonly Readonly<Record<string, unknown>>[] = [],
  rowCount = rows.length,
): PostgresQueryResult {
  return Object.freeze({ rows: Object.freeze([...rows]), row_count: rowCount });
}

function currentRow(input: Readonly<{
  stale?: readonly string[];
  approved?: boolean;
  revision?: number;
}> = {}) {
  const approved = input.approved ?? true;
  return Object.freeze({
    case_revision: String(input.revision ?? 5),
    dependency_epoch: "2",
    cache_epoch: "3",
    download_grant_epoch: "4",
    current_dependency_sha256: BEFORE,
    stale_stages: Object.freeze([...(input.stale ?? [])]),
    release_hold: false,
    dependencies_approved: approved,
    execution_binding_sha256: approved ? EXECUTION : null,
    approval_binding_sha256: approved ? APPROVAL : null,
    download_binding_sha256: approved ? DOWNLOAD : null,
    latest_invalidation_sha256: null,
    lifecycle_state: "awaiting_report_approval",
    updated_at: "2029-12-31T23:59:00.000Z",
    lifecycle_previous_sha256: null,
  });
}

function session(client: ScriptedClient) {
  const transaction = vi.fn(async <T>(
    _input: unknown,
    operation: (bundle: { context: PostgresTransactionContext }) => Promise<T>,
  ) => operation({
    context: Object.freeze({ client, transaction_id: "synthetic-transaction-001" }),
  }));
  const context = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres: Object.freeze({}),
    transaction,
  }) as unknown as DurableProductRouteSessionContextPort;
  return Object.freeze({ context, transaction });
}

function service(client: ScriptedClient) {
  const routeSession = session(client);
  return Object.freeze({
    service: createDurablePostgresGlobalDependencyInvalidationService({
      session_context: routeSession.context,
      actor,
      correlation_id: "correlation.invalidation.001",
    }),
    routeSession,
  });
}

function fullApplySteps(): readonly Step[] {
  return Object.freeze([
    { name: "global_invalidation_case_lock" },
    { name: "global_invalidation_idempotency_read", result: result() },
    {
      name: "global_invalidation_current_lock",
      result: result([currentRow()]),
      inspect: (statement) => {
        expect(statement.text).toContain("authoritative_case_revision");
        expect(statement.text).toContain("update public.engine_global_dependency_state");
        expect(statement.text).toContain("locked.authoritative_case_revision > locked.dependency_case_revision");
      },
    },
    { name: "global_invalidation_fence_assert", result: result([{
      job_id: fence.job_id,
      lease_owner: fence.worker_id,
      fencing_token: String(fence.fencing_token),
      lease_expires_at_ms: String(fence.lease_expires_at_ms),
    }]) },
    { name: "global_invalidation_case_advance", result: result([{ revision: "6" }]) },
    { name: "global_invalidation_approvals_append", result: result([{ approvals_invalidated: "1" }]) },
    { name: "global_invalidation_report_objects_revoke", result: result([{
      grants_revoked: "2", objects_revoked: "3",
    }]) },
    { name: "global_invalidation_jobs_cancel", result: result([{ jobs_cancelled: "3" }]) },
    { name: "global_invalidation_outbox_supersede", result: result([], 2) },
    { name: "global_invalidation_current_update", result: result([{ case_revision: "6" }]) },
    { name: "audit_chain_lock" },
    { name: "audit_tail", result: result() },
    { name: "audit_append", result: result([{ sequence: "1" }]) },
    { name: "outbox_enqueue", result: result([{ outbox_id: "outbox" }]) },
    { name: "global_invalidation_history_append", result: result([{ invalidation_id: "invalidation" }]) },
    {
      name: "global_invalidation_idempotency_commit",
      result: result([{ idempotency_key: mutation.idempotency_key }]),
      inspect: (statement) => {
        const receipt = JSON.parse(String(statement.values[6])) as GlobalDependencyInvalidationReceipt;
        expect(receipt).toMatchObject({
          case_revision: 6,
          grants_revoked: 2,
          jobs_cancelled: 3,
          outbox_events_superseded: 2,
          historical_versions_deleted: 0,
        });
      },
    },
  ]);
}

describe("durable PostgreSQL global dependency invalidation", () => {
  it("atomically versions currentness, invalidates approval/grants/jobs/outbox, audits, and replays after restart", async () => {
    const client = new ScriptedClient(fullApplySteps());
    const firstRuntime = service(client);
    const receipt = await firstRuntime.service.invalidate(mutation);

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
      outbox_events_superseded: 2,
      idempotent_replay: false,
    });
    expect(client.statements.some((entry) => /\bdelete\b/iu.test(entry.text))).toBe(false);
    expect(client.statements.find((entry) => entry.name === "global_invalidation_outbox_supersede")?.text)
      .toContain("state = 'superseded'");
    expect(firstRuntime.routeSession.transaction).toHaveBeenCalledTimes(1);
    client.assertComplete();

    const replayClient = new ScriptedClient([
      { name: "global_invalidation_case_lock" },
      { name: "global_invalidation_idempotency_read", result: result([{
        command_sha256: canonicalSha256(mutation),
        result_sha256: receipt.receipt_sha256,
        result_payload: receipt,
        state: "committed",
      }]) },
    ]);
    const replay = await service(replayClient).service.invalidate(mutation);
    expect(replay).toEqual({ ...receipt, idempotent_replay: true });
    replayClient.assertComplete();
  });

  it("fails closed at a stale worker fence before any approval, grant, job, audit, or outbox write", async () => {
    const client = new ScriptedClient([
      { name: "global_invalidation_case_lock" },
      { name: "global_invalidation_idempotency_read", result: result() },
      { name: "global_invalidation_current_lock", result: result([currentRow()]) },
      { name: "global_invalidation_fence_assert", result: result() },
    ]);
    await expect(service(client).service.invalidate(mutation)).rejects.toMatchObject({
      domain_code: "STALE_FENCING_TOKEN",
    });
    expect(client.statements.map((entry) => entry.name)).toEqual([
      "global_invalidation_case_lock",
      "global_invalidation_idempotency_read",
      "global_invalidation_current_lock",
      "global_invalidation_fence_assert",
    ]);
    client.assertComplete();
  });

  it("rechecks approved exact bindings and download epoch inside the verified transaction", async () => {
    const client = new ScriptedClient([
      { name: "global_invalidation_case_lock" },
      { name: "global_invalidation_current_lock", result: result([currentRow()]) },
    ]);
    const runtime = service(client);
    const operation = vi.fn(async (context: PostgresTransactionContext) => context.transaction_id);
    await expect(runtime.service.withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "download",
      expected_case_revision: 5,
      expected_dependency_sha256: BEFORE,
      expected_binding_sha256: DOWNLOAD,
      expected_download_grant_epoch: 4,
    }, operation)).resolves.toBe("synthetic-transaction-001");
    expect(operation).toHaveBeenCalledTimes(1);
    client.assertComplete();

    const staleClient = new ScriptedClient([
      { name: "global_invalidation_case_lock" },
      { name: "global_invalidation_current_lock", result: result([currentRow({
        stale: ["facts", "analysis", "approval", "download_grant", "cache"],
        approved: false,
      })]) },
    ]);
    const staleOperation = vi.fn(async () => "must-not-run");
    await expect(service(staleClient).service.withCurrentAuthorization({
      tenant_id: TENANT,
      case_id: CASE,
      action: "approval",
      expected_case_revision: 5,
      expected_dependency_sha256: BEFORE,
      expected_binding_sha256: APPROVAL,
    }, staleOperation)).rejects.toThrow("GLOBAL_DEPENDENCY_ACTION_NOT_CURRENT");
    expect(staleOperation).not.toHaveBeenCalled();
    staleClient.assertComplete();
  });

  it("publishes an explicit zero-memory production proof", () => {
    expect(DURABLE_GLOBAL_INVALIDATION_POSTGRES_PROOF).toMatchObject({
      persistence: "postgresql",
      memory_fallbacks: 0,
      historical_delete_statements: 0,
      worker_fence_required: true,
      durable_audit: true,
      durable_outbox: true,
      outbox_supersession_is_not_publication: true,
    });
  });
});
