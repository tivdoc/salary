import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../canonical.ts";
import { PostgresJobsOutboxAuditRepository } from "./jobs-outbox-audit.ts";
import { StrictRecordingPostgresDriver } from "./recording-driver.ts";
import { CanonicalPostgresTransactionManager } from "./transaction-manager.ts";

const tenantId = "tenant:synthetic:001";
const caseId = "case:synthetic:001";
const payload = Object.freeze({ synthetic_job: 1 });
const payloadSha = canonicalSha256(payload);

function jobRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    job_id: "job:synthetic:001",
    tenant_id: tenantId,
    case_id: caseId,
    job_kind: "analysis_stage",
    idempotency_key: "analysis:001",
    payload,
    payload_sha256: payloadSha,
    pinned_version_sha256s: ["b".repeat(64)],
    state: "queued",
    revision: 1,
    attempt_count: 0,
    max_attempts: 3,
    available_at: 0,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    cancellation_requested: false,
    terminal_effect_sha256: null,
    replayed_from_job_id: null,
    ...overrides,
  };
}

describe("PostgreSQL jobs, fencing, outbox and audit adapter", () => {
  it("uses parameterized enqueue SQL and returns the idempotently selected row", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "job_enqueue", result: { rows: [], row_count: 1 } },
      { statement_name: "job_select_idempotent", result: { rows: [jobRow()], row_count: 1 } },
    ]);
    const context = { client: await driver.acquire(), transaction_id: "synthetic" };
    const repository = new PostgresJobsOutboxAuditRepository(context, tenantId, caseId);
    await expect(repository.enqueue({
      job_id: "job:synthetic:001",
      tenant_id: tenantId,
      case_id: caseId,
      job_kind: "analysis_stage",
      idempotency_key: "analysis:001",
      payload,
      payload_sha256: payloadSha,
      pinned_version_sha256s: ["b".repeat(64)],
      max_attempts: 3,
      available_at_ms: 0,
    })).resolves.toMatchObject({ state: "queued", fencing_token: 0 });
    expect(driver.inventory().statements.map((entry) => [entry.name, entry.parameter_count])).toEqual([
      ["job_enqueue", 12], ["job_select_idempotent", 3],
    ]);
    expect(driver.inventory().statements.every((entry) => !entry.text.includes("synthetic:001"))).toBe(true);
  });

  it("rejects a stale worker when the fenced transition updates no row", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "job_start", result: { rows: [], row_count: 0 } },
    ]);
    const context = { client: await driver.acquire(), transaction_id: "synthetic" };
    const repository = new PostgresJobsOutboxAuditRepository(context, tenantId, caseId);
    await expect(repository.start("job:synthetic:001", "worker:stale", 1, 100))
      .rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
  });

  it("rolls back a published state when logical-effect insertion fails", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "outbox_publish", result: { rows: [{ logical_effect_id: "effect:001" }], row_count: 1 } },
      { statement_name: "logical_effect_insert", fail_with: "POSTGRES_STATEMENT_FAILED" },
      { statement_name: "transaction_rollback" },
    ]);
    const manager = new CanonicalPostgresTransactionManager(driver);
    await expect(manager.transaction(async (context) => {
      const repository = new PostgresJobsOutboxAuditRepository(context, tenantId, caseId);
      return repository.publishOutbox({
        outbox_id: "outbox:001",
        worker_id: "worker:001",
        fencing_token: 4,
        now_ms: 100,
        logical_effect_sha256: "c".repeat(64),
      });
    })).rejects.toMatchObject({ code: "POSTGRES_STATEMENT_FAILED" });
    expect(driver.inventory().statements.map((entry) => entry.name)).toEqual([
      "transaction_begin", "outbox_publish", "logical_effect_insert", "transaction_rollback",
    ]);
  });

  it("rejects malformed persisted hashes before returning a job", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "job_enqueue" },
      { statement_name: "job_select_idempotent", result: { rows: [jobRow({ payload_sha256: "corrupt" })], row_count: 1 } },
    ]);
    const context = { client: await driver.acquire(), transaction_id: "synthetic" };
    const repository = new PostgresJobsOutboxAuditRepository(context, tenantId, caseId);
    await expect(repository.enqueue({
      job_id: "job:synthetic:001", tenant_id: tenantId, case_id: caseId,
      job_kind: "analysis_stage", idempotency_key: "analysis:001",
      payload, payload_sha256: payloadSha, pinned_version_sha256s: ["b".repeat(64)],
      max_attempts: 3, available_at_ms: 0,
    })).rejects.toMatchObject({ code: "POSTGRES_ROW_MALFORMED" });
  });

  it("appends an audit event only after locking the tenant/case chain", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "audit_chain_lock" },
      { statement_name: "audit_tail" },
      { statement_name: "audit_append", result: { rows: [{ sequence: "1" }], row_count: 1 } },
    ]);
    const context = { client: await driver.acquire(), transaction_id: "synthetic" };
    const repository = new PostgresJobsOutboxAuditRepository(context, tenantId, caseId);
    await expect(repository.append({
      actor_id: "actor:synthetic:worker",
      action: "SYNTHETIC_COMMAND_APPLIED",
      resource_id: caseId,
      resource_revision: 1,
      resource_sha256: "d".repeat(64),
      reason: "SYNTHETIC_TEST_COMMAND",
      occurred_at: "2026-08-31T00:00:00.000Z",
    })).resolves.toMatchObject({ sequence: 1, previous_sha256: null });
    expect(driver.inventory().statements.map((entry) => entry.name)).toEqual([
      "audit_chain_lock", "audit_tail", "audit_append",
    ]);
  });
});
