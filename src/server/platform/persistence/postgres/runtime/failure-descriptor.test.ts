import { beforeEach, describe, expect, it } from "vitest";

import { statement, type PostgresStatement, type PostgresQueryResult } from "../contracts.ts";
import {
  CanonicalPostgresError,
  clearPostgresFailureLog,
  mapPostgresFailure,
  readPostgresFailureLog,
  POSTGRES_FAILURE_STAGES,
} from "./errors.ts";
import { CanonicalPostgresTransactionManager, type ManagedPostgresClient } from "./transaction-manager.ts";

// V0.10.13 W1. Three runs were spent on failures that concealed their own
// cause. The low-cardinality code that crosses the boundary is correct and
// unchanged; what was missing was an internal channel saying which stage threw
// and what the thrown thing was. `stage` alone turns "fails before any
// statement" from an inference into a fact.

class ScriptedClient implements ManagedPostgresClient {
  readonly seen: string[] = [];

  constructor(private readonly failOn: string, private readonly error: unknown) {}

  async query(input: PostgresStatement): Promise<PostgresQueryResult> {
    this.seen.push(input.text);
    if (input.text === this.failOn) throw this.error;
    return Object.freeze({ rows: Object.freeze([]), row_count: 0 });
  }

  release(): void {}
}

function factoryFor(client: ManagedPostgresClient) {
  return Object.freeze({ acquire: async () => client, close: async () => undefined });
}

const socketError = Object.assign(new Error("connection terminated"), { code: "ECONNRESET", errno: -4077 });
const serverError = Object.assign(new Error("permission denied"), {
  code: "42501", severity: "ERROR", routine: "aclcheck_error",
});

describe("V0.10.13 persistence failure descriptor", () => {
  beforeEach(() => { clearPostgresFailureLog(); });

  it("names the stage for a failure at begin, in the operation, and at commit", async () => {
    const stages: string[] = [];
    for (const [failOn, run] of [
      ["begin", async (manager: CanonicalPostgresTransactionManager) => manager.transaction(async () => 1)],
      ["commit", async (manager: CanonicalPostgresTransactionManager) => manager.transaction(async () => 1)],
    ] as const) {
      clearPostgresFailureLog();
      const manager = new CanonicalPostgresTransactionManager(factoryFor(new ScriptedClient(failOn, serverError)));
      await expect(run(manager)).rejects.toThrow("POSTGRES_TRANSACTION_FAILED");
      stages.push(readPostgresFailureLog().at(-1)?.stage ?? "missing");
    }
    clearPostgresFailureLog();
    const manager = new CanonicalPostgresTransactionManager(factoryFor(new ScriptedClient("never", serverError)));
    await expect(manager.transaction(async () => { throw new Error("inside"); }))
      .rejects.toThrow("POSTGRES_TRANSACTION_FAILED");
    stages.push(readPostgresFailureLog().at(-1)?.stage ?? "missing");
    expect(stages).toEqual(["begin", "commit", "operation"]);
  });

  it("distinguishes an acquisition failure from a transaction failure", async () => {
    const manager = new CanonicalPostgresTransactionManager(Object.freeze({
      acquire: async () => { throw socketError; },
      close: async () => undefined,
    }));
    await expect(manager.transaction(async () => 1)).rejects.toThrow("POSTGRES_CONNECTION_FAILED");
    const descriptor = readPostgresFailureLog().at(-1);
    expect(descriptor?.stage).toBe("acquire");
    expect(descriptor?.code).toBe("POSTGRES_CONNECTION_FAILED");
  });

  it("records the constructor, a safe error code, errno, severity and routine", () => {
    mapPostgresFailure(serverError, "POSTGRES_STATEMENT_FAILED", "operation");
    const server = readPostgresFailureLog().at(-1);
    expect(server).toMatchObject({
      stage: "operation",
      constructor_name: "Error",
      error_code: "42501",
      sqlstate: "42501",
      severity: "ERROR",
      routine: "aclcheck_error",
    });

    mapPostgresFailure(socketError, "POSTGRES_TRANSACTION_FAILED", "operation");
    const socket = readPostgresFailureLog().at(-1);
    expect(socket).toMatchObject({ error_code: "ECONNRESET", errno: -4077, sqlstate: null });
  });

  it("records nothing that could carry a message, a parameter or an identifier", () => {
    const leaky = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432 for user hunter2"), {
      code: "a code with spaces and a very long tail that should never be recorded verbatim at all",
      severity: "not-a-token!",
      routine: "also invalid ",
    });
    mapPostgresFailure(leaky, "POSTGRES_TRANSACTION_FAILED", "operation");
    const descriptor = readPostgresFailureLog().at(-1);
    expect(descriptor?.error_code).toBeNull();
    expect(descriptor?.severity).toBeNull();
    expect(descriptor?.routine).toBeNull();
    expect(Object.keys(descriptor ?? {}).sort()).toEqual([
      "at", "code", "constructor_name", "errno", "error_code", "routine", "severity", "sqlstate", "stage",
    ]);
    expect(JSON.stringify(descriptor)).not.toContain("hunter2");
    expect(JSON.stringify(descriptor)).not.toContain("10.0.0.1");
  });

  it("passes a canonical error through unchanged while still describing it", () => {
    const canonical = new CanonicalPostgresError("POSTGRES_TARGET_NOT_LOOPBACK");
    expect(mapPostgresFailure(canonical, "POSTGRES_TRANSACTION_FAILED", "operation")).toBe(canonical);
    expect(readPostgresFailureLog().at(-1)).toMatchObject({
      code: "POSTGRES_TARGET_NOT_LOOPBACK", stage: "operation", constructor_name: "CanonicalPostgresError",
    });
  });

  it("declares every stage it can record", () => {
    expect([...POSTGRES_FAILURE_STAGES]).toEqual([
      "acquire", "begin", "operation", "commit", "rollback", "release", "unspecified",
    ]);
    for (const entry of readPostgresFailureLog()) {
      expect(POSTGRES_FAILURE_STAGES as readonly string[]).toContain(entry.stage);
    }
  });

  it("leaves the thrown error's own shape untouched", async () => {
    const manager = new CanonicalPostgresTransactionManager(factoryFor(new ScriptedClient("begin", serverError)));
    const thrown = await manager.transaction(async () => 1).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(CanonicalPostgresError);
    expect((thrown as CanonicalPostgresError).code).toBe("POSTGRES_TRANSACTION_FAILED");
    expect((thrown as CanonicalPostgresError).sqlstate).toBe("42501");
    expect(statement("probe", "select 1", []).text).toBe("select 1");
  });
});
