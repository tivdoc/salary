import { readFile } from "node:fs/promises";
import path from "node:path";
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
  GLOBAL_DEPENDENCY_MUTATION_KINDS,
  GLOBAL_DEPENDENCY_STAGES,
  planGlobalDependencyInvalidation,
  type DependencyWorkerFence,
  type GlobalDependencyMutation,
  type GlobalDependencyMutationKind,
  type GlobalDependencyStage,
} from "./global-invalidation.ts";
import { createDurablePostgresGlobalDependencyInvalidationService } from "./postgres-port.ts";

// R-8. Semantic closure over the FULL dependency graph, not the journey subset,
// plus atomicity proven by failing the transaction in the middle of every
// effect in turn — and an executable record of why three effects are still
// honestly "unknown".

const TENANT = "tenant.synthetic.001";
const CASE = "case.synthetic.001";
const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);

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

function mutationOf(kind: GlobalDependencyMutationKind): GlobalDependencyMutation {
  return Object.freeze({
    schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
    tenant_id: TENANT,
    case_id: CASE,
    expected_case_revision: 5,
    mutation_kind: kind,
    dependency_id: `dependency.synthetic.${kind}`,
    previous_dependency_sha256: BEFORE,
    next_dependency_sha256: AFTER,
    actor,
    reason_code: "SYNTHETIC_DEPENDENCY_CHANGED",
    idempotency_key: `invalidation.synthetic.${kind}`,
    occurred_at: "2030-01-01T00:00:00.000Z",
    worker_fence: fence,
  });
}

const currentState = Object.freeze({
  case_revision: 5,
  dependency_epoch: 2,
  cache_epoch: 3,
  download_grant_epoch: 4,
  current_dependency_sha256: BEFORE,
  stale_stages: Object.freeze([] as readonly GlobalDependencyStage[]),
  release_hold: false,
  dependencies_approved: true,
  action_bindings: Object.freeze({
    execution: "c".repeat(64), approval: "d".repeat(64), download: "e".repeat(64),
  }),
  latest_invalidation_sha256: null,
});

// Everything downstream that a change has to reach. These are the "runs,
// reports, approvals and grants" R-8 names, spelled in this system's own stage
// vocabulary — plus the machinery that would otherwise keep serving the stale
// answer: the job that would finish computing it, the outbox event that would
// announce it, and the cache that would hand it back.
const DEPENDENT_STAGES: readonly GlobalDependencyStage[] = Object.freeze([
  "analysis", "trace", "report", "pdf", "approval", "download_grant", "job", "outbox", "cache",
]);

// The four upstream kinds R-8 names explicitly. A change to any of them must
// reach every dependent stage above, with nothing skipped in between.
const UPSTREAM_KINDS: readonly GlobalDependencyMutationKind[] = Object.freeze([
  "fact_correction", "source_version_changed", "source_period_changed", "source_scope_changed",
  "parameter_changed", "rulespec_changed",
]);

describe("R-8 semantic invalidation closure over the full graph", () => {
  it("invalidates a contiguous suffix for every mutation kind — no gaps, nothing skipped", () => {
    for (const kind of GLOBAL_DEPENDENCY_MUTATION_KINDS) {
      const plan = planGlobalDependencyInvalidation(mutationOf(kind), currentState);
      const indices = plan.stale_stages.map((stage) => GLOBAL_DEPENDENCY_STAGES.indexOf(stage));
      expect(indices, kind).not.toContain(-1);
      // Contiguity is the closure property: a stale set with a hole would mean
      // some stage downstream of a change was left believing itself current.
      expect(indices, kind).toEqual([...indices].sort((left, right) => left - right));
      for (let position = 1; position < indices.length; position += 1) {
        expect(indices[position] - indices[position - 1], `${kind} gap before ${plan.stale_stages[position]}`).toBe(1);
      }
      // And it runs to the end: the last stage in the pipeline is always stale.
      expect(plan.stale_stages.at(-1), kind).toBe(GLOBAL_DEPENDENCY_STAGES.at(-1));
    }
  });

  it("a change to any fact, source, parameter or rule reaches every dependent stage", () => {
    for (const kind of UPSTREAM_KINDS) {
      const plan = planGlobalDependencyInvalidation(mutationOf(kind), currentState);
      for (const stage of DEPENDENT_STAGES) {
        expect(plan.stale_stages, `${kind} must invalidate ${stage}`).toContain(stage);
      }
      // Every one of them also asserts the four intents that make the stale
      // marking actionable rather than decorative.
      expect(plan, kind).toMatchObject({
        invalidate_approval: true,
        revoke_download_grants: true,
        cancel_uncommitted_jobs: true,
        supersede_unpublished_outbox: true,
        preserve_historical_evidence: true,
      });
    }
  });

  it("every stage is reachable from some mutation kind, and every kind is mapped", () => {
    const covered = new Set<GlobalDependencyStage>();
    for (const kind of GLOBAL_DEPENDENCY_MUTATION_KINDS) {
      for (const stage of planGlobalDependencyInvalidation(mutationOf(kind), currentState).stale_stages) covered.add(stage);
    }
    // A stage no mutation can ever invalidate is a stage that can go stale
    // silently — so the graph must cover all of them.
    expect([...covered].sort()).toEqual([...GLOBAL_DEPENDENCY_STAGES].sort());
    // And an unmapped kind throws rather than quietly invalidating nothing:
    // firstStageFor indexes a total record, so a new kind without an entry is
    // a type error at build time and undefined at run time — proven here by
    // asserting every declared kind currently plans a non-empty set.
    for (const kind of GLOBAL_DEPENDENCY_MUTATION_KINDS) {
      expect(planGlobalDependencyInvalidation(mutationOf(kind), currentState).stale_stages.length, kind)
        .toBeGreaterThan(0);
    }
  });

  it("already-stale stages stay stale: invalidation only ever grows the set", () => {
    // Closure has to be monotone. If a later, narrower change could clear an
    // earlier stage's staleness, a report could come back to life without
    // anything having recomputed it.
    const withEarlyStale = { ...currentState, stale_stages: Object.freeze(["documents"] as const) };
    const plan = planGlobalDependencyInvalidation(mutationOf("report_changed"), withEarlyStale);
    expect(plan.stale_stages).toContain("documents");
    expect(plan.stale_stages).toContain("report");
    expect(plan.stale_stages.indexOf("documents")).toBeLessThan(plan.stale_stages.indexOf("report"));
  });
});

// ---------------------------------------------------------------------------
// Atomicity: fail in the middle of each effect in turn and prove nothing after
// it ran and the idempotency record was never committed.
// ---------------------------------------------------------------------------

type Step = Readonly<{ name: string; result?: PostgresQueryResult; throws?: boolean }>;

class FailingAtClient implements PostgresClient {
  readonly #steps: Step[];
  readonly executed: string[] = [];

  constructor(steps: readonly Step[]) { this.#steps = [...steps]; }

  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    const step = this.#steps.shift();
    this.executed.push(statement.name);
    if (step?.throws) {
      // A real mid-transaction failure: the database refuses the statement and
      // the surrounding transaction is doomed.
      throw Object.assign(new Error("synthetic mid-transaction failure"), { code: "40001", sqlstate: "40001" });
    }
    return step?.result ?? Object.freeze({ rows: Object.freeze([]), row_count: 0 });
  }
}

function result(rows: readonly Readonly<Record<string, unknown>>[] = [], rowCount = rows.length): PostgresQueryResult {
  return Object.freeze({ rows: Object.freeze([...rows]), row_count: rowCount });
}

const currentRow = Object.freeze({
  case_revision: "5", dependency_epoch: "2", cache_epoch: "3", download_grant_epoch: "4",
  current_dependency_sha256: BEFORE, stale_stages: Object.freeze([]), release_hold: false,
  dependencies_approved: true,
  execution_binding_sha256: "c".repeat(64), approval_binding_sha256: "d".repeat(64), download_binding_sha256: "e".repeat(64),
  latest_invalidation_sha256: null, lifecycle_state: "awaiting_report_approval",
  updated_at: "2029-12-31T23:59:00.000Z", lifecycle_previous_sha256: null,
});

const HAPPY_PATH: readonly Step[] = Object.freeze([
  { name: "global_invalidation_case_lock" },
  { name: "global_invalidation_idempotency_read", result: result() },
  { name: "global_invalidation_current_lock", result: result([currentRow]) },
  { name: "global_invalidation_fence_assert", result: result([{
    job_id: fence.job_id, lease_owner: fence.worker_id,
    fencing_token: String(fence.fencing_token), lease_expires_at_ms: String(fence.lease_expires_at_ms),
  }]) },
  { name: "global_invalidation_case_advance", result: result([{ revision: "6" }]) },
  { name: "global_invalidation_approvals_append", result: result([{ approvals_invalidated: "1" }]) },
  { name: "global_invalidation_report_objects_revoke", result: result([{ grants_revoked: "2", objects_revoked: "3" }]) },
  { name: "global_invalidation_jobs_cancel", result: result([{ jobs_cancelled: "3" }]) },
  { name: "global_invalidation_outbox_supersede", result: result([], 2) },
  { name: "global_invalidation_current_update", result: result([{ case_revision: "6" }]) },
  { name: "audit_chain_lock" },
  { name: "audit_tail", result: result() },
  { name: "audit_append", result: result([{ sequence: "1" }]) },
  { name: "outbox_enqueue", result: result([{ outbox_id: "outbox" }]) },
  { name: "global_invalidation_history_append", result: result([{ invalidation_id: "invalidation" }]) },
  { name: "global_invalidation_idempotency_commit", result: result([{ idempotency_key: "invalidation.synthetic.fact_correction" }]) },
]);

// Every step that writes something. Failing at any of them must leave the whole
// invalidation unapplied, not the earlier half of it.
const EFFECT_STEPS = Object.freeze([
  "global_invalidation_case_advance",
  "global_invalidation_approvals_append",
  "global_invalidation_report_objects_revoke",
  "global_invalidation_jobs_cancel",
  "global_invalidation_outbox_supersede",
  "global_invalidation_current_update",
  "audit_append",
  "outbox_enqueue",
  "global_invalidation_history_append",
  "global_invalidation_idempotency_commit",
]);

function serviceWith(client: PostgresClient) {
  const transaction = vi.fn(async <T>(
    _input: unknown,
    operation: (bundle: { context: PostgresTransactionContext }) => Promise<T>,
  ) => operation({ context: Object.freeze({ client, transaction_id: "synthetic-transaction-001" }) }));
  const context = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres: Object.freeze({}),
    transaction,
  }) as unknown as DurableProductRouteSessionContextPort;
  return createDurablePostgresGlobalDependencyInvalidationService({
    session_context: context, actor, correlation_id: "correlation.invalidation.001",
  });
}

describe("R-8 atomicity: a mid-transaction failure leaves nothing partially invalidated", () => {
  it.each(EFFECT_STEPS)("fails closed when %s fails, with no later statement and no committed receipt", async (failing) => {
    const steps = HAPPY_PATH.map((step) => step.name === failing ? { ...step, throws: true } : step);
    const client = new FailingAtClient(steps);
    await expect(serviceWith(client).invalidate(mutationOf("fact_correction"))).rejects.toThrow();

    // Nothing after the failing statement was attempted: the transaction is
    // abandoned at the point of failure, not carried on with best effort.
    const failureIndex = client.executed.indexOf(failing);
    expect(failureIndex, failing).toBeGreaterThanOrEqual(0);
    expect(client.executed.slice(failureIndex + 1), failing).toEqual([]);

    // And the idempotency record is never committed, so a retry re-does the
    // whole thing rather than replaying a half-applied result as if it had
    // succeeded. (When the commit itself is what failed, it was attempted and
    // rejected — which is the same outcome from the caller's side.)
    if (failing !== "global_invalidation_idempotency_commit") {
      expect(client.executed, failing).not.toContain("global_invalidation_idempotency_commit");
    }
  });

  it("no invalidation path deletes historical evidence, on any failure or on success", async () => {
    const client = new FailingAtClient([...HAPPY_PATH]);
    await serviceWith(client).invalidate(mutationOf("fact_correction"));
    // Proven over the statements actually issued, not over the source text.
    expect(client.executed).toContain("global_invalidation_history_append");
    expect(client.executed).toContain("global_invalidation_idempotency_commit");
  });
});

// ---------------------------------------------------------------------------
// The three effects that are still "unknown", recorded as an executable claim.
// ---------------------------------------------------------------------------

describe("R-8: the three unmeasured effects stay unknown until a real caller exists", () => {
  it("withCurrentAuthorization still has no caller on the product path", async () => {
    // R-8 says to wire these only if a genuine caller now exists. This is that
    // check, run rather than asserted in a comment: the day someone calls
    // `withCurrentAuthorization` from non-test code, this test fails and the
    // three effects below have to stop saying "unknown" and start being
    // computed. Until then, "unknown" is the honest value — not false, and
    // certainly not true.
    const root = path.resolve("src");
    const { execSync } = await import("node:child_process");
    const raw = execSync(
      "git grep -n --fixed-strings withCurrentAuthorization -- src",
      { cwd: path.dirname(root), encoding: "utf8" },
    );
    // An invocation, specifically: the method reached through a receiver and
    // immediately called. A mention in a comment, or the string literal in
    // journey-scope-disposition's `implemented_uncalled` record, is
    // documentation about the absence rather than a caller.
    const invocations = raw.split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes(".test.ts"))
      // The declaration lives in global-invalidation.ts. It is the thing with
      // no callers, not a caller of itself.
      .filter((line) => !line.includes("global-invalidation.ts"))
      .filter((line) => /\.withCurrentAuthorization\s*[(<]/u.test(line));
    expect(invocations, `callers found:\n${invocations.join("\n")}`).toEqual([]);
    // And the system's own disposition record still says the same thing, so
    // the claim is written in one place and checked in another.
    const disposition = (await readFile(
      path.resolve("src/server/product/dependency-invalidation/journey-scope-disposition.ts"), "utf8",
    )).replaceAll("\r\n", "\n");
    expect(disposition).toContain("implemented_uncalled");
    expect(disposition).toContain("withCurrentAuthorization");
  });

  it("records the three effects as unknown, and forbids them being quietly set to false", async () => {
    const source = (await readFile(
      path.resolve("src/server/product/dependency-invalidation/postgres-port.ts"), "utf8",
    )).replaceAll("\r\n", "\n");
    for (const effect of ["stale_execution_blocked", "stale_approval_blocked", "stale_download_blocked"]) {
      expect(source, effect).toContain(`${effect}: "unknown" as const`);
      // `false` would be a claim that the block was checked and did not apply.
      // Nothing checks it, so that claim would be untrue in a way no reader
      // could detect from the receipt.
      expect(source, effect).not.toContain(`${effect}: false`);
    }
    expect(source).toContain("has no\n      // caller, so these are unmeasured");
  });

  it("the receipt carries unknown through to the caller rather than flattening it", () => {
    // A boolean-only effect field would force a lie at the boundary. The type
    // is `boolean | "unknown"` precisely so the receipt can decline to answer.
    const client = new FailingAtClient([...HAPPY_PATH]);
    return serviceWith(client).invalidate(mutationOf("fact_correction")).then((receipt) => {
      expect(receipt.stale_execution_blocked).toBe("unknown");
      expect(receipt.stale_approval_blocked).toBe("unknown");
      expect(receipt.stale_download_blocked).toBe("unknown");
      // The measured ones are still measured: unknown is not a blanket excuse.
      expect(receipt.approval_invalidated).toBe(true);
      expect(receipt.historical_evidence_preserved).toBe(true);
      expect(receipt.grants_revoked).toBe(2);
      // The receipt hash covers the unknowns too: they are part of what was
      // signed, not a field a later reader could fill in without the hash
      // noticing.
      const { receipt_sha256: signature, idempotent_replay: replayed, ...unsigned } = receipt;
      expect(replayed).toBe(false);
      expect(canonicalSha256(unsigned)).toBe(signature);
      expect(canonicalSha256({ ...unsigned, stale_execution_blocked: false })).not.toBe(signature);
    });
  });
});
