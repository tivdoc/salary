import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../canonical.ts";
import type { AtomicCommand, TransactionReceipt } from "../../contracts.ts";
import { PostgresIdempotencyRepository } from "./idempotency.ts";
import { StrictRecordingPostgresDriver } from "./recording-driver.ts";
import { CanonicalPostgresTransactionManager } from "./transaction-manager.ts";

const commandBody = Object.freeze({ action: "synthetic_atomic_write" });
const command: AtomicCommand = Object.freeze({
  tenant_id: "tenant:synthetic:001",
  case_id: "case:synthetic:001",
  actor_id: "actor:synthetic:worker",
  scope: "synthetic.write",
  idempotency_key: "synthetic:001",
  expected_case_revision: 0,
  command_sha256: canonicalSha256(commandBody),
  command: commandBody,
  occurred_at: "2026-08-31T00:00:00.000Z",
  writes: [],
  invalidates: [],
  outbox: [],
});

const receipt: TransactionReceipt = Object.freeze({
  tenant_id: command.tenant_id,
  case_id: command.case_id,
  case_revision: 1,
  command_sha256: command.command_sha256,
  audit_event_sha256: "a".repeat(64),
  outbox_ids: Object.freeze(["outbox:synthetic:001"]),
  idempotent_replay: false,
});

describe("PostgreSQL idempotency adapter", () => {
  it("reserves, runs and commits one receipt in the caller transaction", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "idempotency_reserve", result: { rows: [], row_count: 1 } },
      { statement_name: "idempotency_lock", result: { rows: [{ command_sha256: command.command_sha256, state: "reserved" }], row_count: 1 } },
      { statement_name: "idempotency_commit", result: { rows: [{ tenant_id: command.tenant_id }], row_count: 1 } },
      { statement_name: "transaction_commit" },
    ]);
    const manager = new CanonicalPostgresTransactionManager(driver);
    const repository = new PostgresIdempotencyRepository();
    let effects = 0;
    await expect(manager.transaction((context) => repository.execute(context, command, async () => {
      effects += 1;
      return receipt;
    }))).resolves.toEqual(receipt);
    expect(effects).toBe(1);
    expect(driver.inventory().statements.slice(1, 4).map((entry) => entry.parameter_count)).toEqual([6, 3, 7]);
  });

  it("returns a persisted receipt without re-running an identical command", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "idempotency_reserve" },
      { statement_name: "idempotency_lock", result: { rows: [{
        command_sha256: command.command_sha256,
        state: "committed",
        result_payload: receipt,
      }], row_count: 1 } },
      { statement_name: "transaction_commit" },
    ]);
    const repository = new PostgresIdempotencyRepository();
    const manager = new CanonicalPostgresTransactionManager(driver);
    let effects = 0;
    const replay = await manager.transaction((context) => repository.execute(context, command, async () => {
      effects += 1;
      return receipt;
    }));
    expect(effects).toBe(0);
    expect(replay).toMatchObject({ idempotent_replay: true, case_revision: 1 });
  });

  it("rejects a changed payload hash and rolls back before persistence", async () => {
    const driver = new StrictRecordingPostgresDriver([]);
    const repository = new PostgresIdempotencyRepository();
    const context = { client: await driver.acquire(), transaction_id: "test" };
    await expect(repository.execute(context, { ...command, command: { action: "changed" } }, async () => receipt))
      .rejects.toMatchObject({ code: "PAYLOAD_HASH_MISMATCH" });
    expect(driver.inventory().statements).toHaveLength(0);
  });
});
