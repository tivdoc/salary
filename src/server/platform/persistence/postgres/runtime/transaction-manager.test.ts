import { describe, expect, it } from "vitest";

import { statement } from "../contracts.ts";
import { StrictRecordingPostgresDriver } from "./recording-driver.ts";
import { CanonicalPostgresTransactionManager } from "./transaction-manager.ts";

describe("canonical PostgreSQL transaction manager", () => {
  it("uses one acquired client and commits an operation exactly once", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "synthetic_write", result: { rows: [{ accepted: true }], row_count: 1 } },
      { statement_name: "transaction_commit" },
    ]);
    const manager = new CanonicalPostgresTransactionManager(driver);
    await expect(manager.transaction(async (context) => {
      const result = await context.client.query(statement("synthetic_write", "insert into synthetic(value) values ($1) returning true as accepted", ["opaque-value"]));
      return result.rows[0].accepted;
    })).resolves.toBe(true);
    expect(driver.inventory()).toMatchObject({ acquisitions: 1, releases: 1, remaining_steps: 0 });
    expect(driver.inventory().statements.map((entry) => entry.name)).toEqual([
      "transaction_begin", "synthetic_write", "transaction_commit",
    ]);
    expect(driver.inventory().statements[1]).toMatchObject({ parameter_count: 1, transaction_control: false });
  });

  it("rolls back a later-effect failure and never attempts commit", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "domain_write" },
      { statement_name: "audit_write", fail_with: "POSTGRES_STATEMENT_FAILED" },
      { statement_name: "transaction_rollback" },
    ]);
    const manager = new CanonicalPostgresTransactionManager(driver);
    await expect(manager.transaction(async (context) => {
      await context.client.query(statement("domain_write", "insert into domain_record(value) values ($1)", ["opaque"]));
      await context.client.query(statement("audit_write", "insert into audit_record(value) values ($1)", ["hash"]));
    })).rejects.toMatchObject({ code: "POSTGRES_STATEMENT_FAILED" });
    expect(driver.inventory().statements.map((entry) => entry.name)).toEqual([
      "transaction_begin", "domain_write", "audit_write", "transaction_rollback",
    ]);
  });

  it("rejects nested transactions rather than opening a second connection", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "transaction_rollback" },
    ]);
    const manager = new CanonicalPostgresTransactionManager(driver);
    await expect(manager.transaction(() => manager.transaction(async () => undefined)))
      .rejects.toMatchObject({ code: "POSTGRES_TRANSACTION_NESTING_FORBIDDEN" });
    expect(driver.inventory()).toMatchObject({ acquisitions: 1, releases: 1, remaining_steps: 0 });
  });
});
