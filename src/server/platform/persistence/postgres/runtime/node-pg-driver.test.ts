import { describe, expect, it } from "vitest";

import { statement } from "../contracts.ts";
import {
  NodePostgresConnectionFactory,
  deriveNodePostgresTargetDescriptor,
  validateNodePostgresConnection,
  type NodePostgresPool,
  type NodePostgresPoolClient,
  type NodePostgresPoolFactory,
} from "./node-pg-driver.ts";

const CONNECTION_URL = "postgresql://tivdoc_dynamic:secret-value@127.0.0.1:55432/tivdoc_v09_dynamic_001";

class FakeClient implements NodePostgresPoolClient {
  readonly queries: Readonly<{ name: string; text: string; values: readonly unknown[] }>[] = [];
  rows: readonly Readonly<Record<string, unknown>>[] = [{ accepted: true }];
  queryError: unknown = null;
  releases = 0;

  async query(config: Readonly<{ name: string; text: string; values: readonly unknown[] }>) {
    (this.queries as { name: string; text: string; values: readonly unknown[] }[]).push(config);
    if (this.queryError) throw this.queryError;
    return { rows: this.rows, rowCount: null };
  }

  release(): void {
    this.releases += 1;
  }
}

class FakePool implements NodePostgresPool {
  readonly client = new FakeClient();
  connectionAttempts = 0;
  ends = 0;
  failConnection = false;

  async connect(): Promise<NodePostgresPoolClient> {
    this.connectionAttempts += 1;
    if (this.failConnection) throw new Error("password=must-not-escape");
    return this.client;
  }

  async end(): Promise<void> {
    this.ends += 1;
  }
}

function factory(pool: FakePool): NodePostgresConnectionFactory {
  const poolFactory: NodePostgresPoolFactory = () => pool;
  return NodePostgresConnectionFactory.fromConnectionUrl({ connection_url: CONNECTION_URL }, poolFactory);
}

describe("node-postgres canonical driver", () => {
  it("derives one safe loopback disposable target and rejects ambiguous targets", () => {
    expect(deriveNodePostgresTargetDescriptor(CONNECTION_URL)).toEqual({
      target_id: "tivdoc-v09-dynamic-001",
      host: "127.0.0.1",
      port: 55432,
      database: "tivdoc_v09_dynamic_001",
      disposable: true,
      validation: "LOOPBACK_DISPOSABLE_VALIDATED",
    });
    expect(() => deriveNodePostgresTargetDescriptor("postgresql://u:p@database.example/tivdoc_v09_dynamic_001"))
      .toThrow("POSTGRES_TARGET_NOT_LOOPBACK");
    expect(() => deriveNodePostgresTargetDescriptor("postgresql://u:p@127.0.0.1/production"))
      .toThrow("POSTGRES_TARGET_NOT_DISPOSABLE");
    expect(() => deriveNodePostgresTargetDescriptor("postgresql://u@127.0.0.1/tivdoc_v09_dynamic_001"))
      .toThrow("POSTGRES_TARGET_REQUIRED");
    expect(() => deriveNodePostgresTargetDescriptor(`${CONNECTION_URL}?sslmode=require`))
      .toThrow("POSTGRES_TARGET_REQUIRED");
  });

  it("revalidates a supplied config instead of trusting a forged target", () => {
    const validated = validateNodePostgresConnection({ connection_url: CONNECTION_URL });
    const forged = { ...validated, target: { ...validated.target, database: "tivdoc_v09_forged_000" } };
    expect(() => new NodePostgresConnectionFactory(forged, () => new FakePool()))
      .toThrow("POSTGRES_TARGET_NOT_DISPOSABLE");
  });

  it("maps named SQL and parameters exactly while exposing only aggregate safe metrics", async () => {
    const pool = new FakePool();
    const driver = factory(pool);
    const client = await driver.acquire();
    const query = statement("dynamic_probe", "select $1::text as accepted", ["opaque-value"]);

    await expect(client.query(query)).resolves.toEqual({ rows: [{ accepted: true }], row_count: 1 });
    expect(pool.client.queries).toEqual([{
      name: query.name,
      text: query.text,
      values: ["opaque-value"],
    }]);
    client.release();

    expect(driver.metrics()).toMatchObject({
      driver: "node-postgres",
      connection_attempts: 1,
      acquisitions: 1,
      queries: 1,
      releases: 1,
      active_clients: 0,
      closed: false,
    });
    const serialized = JSON.stringify(driver.metrics());
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("opaque-value");
    expect(serialized).not.toContain("select $1");
  });

  it("normalizes only typed node-postgres timestamps and preserves ordinary text", async () => {
    const pool = new FakePool();
    pool.client.rows = [{
      native_timestamp: new Date("2026-08-31T12:00:00.000Z"),
      text_timestamp: "2026-08-31 12:00:01+00",
      ordinary_text: "2026-08-31 synthetic",
    }];
    const driver = factory(pool);
    const client = await driver.acquire();

    await expect(client.query(statement("timestamp_normalization", "select 1", []))).resolves.toEqual({
      rows: [{
        native_timestamp: "2026-08-31T12:00:00.000Z",
        text_timestamp: "2026-08-31 12:00:01+00",
        ordinary_text: "2026-08-31 synthetic",
      }],
      row_count: 1,
    });
    client.release();
    await driver.close();
  });

  it("preserves a safe SQLSTATE without retaining raw driver details", async () => {
    const pool = new FakePool();
    pool.client.queryError = Object.assign(new Error("password=must-not-escape"), {
      code: "23505",
      detail: "secret-value",
    });
    const driver = factory(pool);
    const client = await driver.acquire();

    const failure = await client.query(statement("unique_conflict", "select 1", []))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "POSTGRES_STATEMENT_FAILED",
      sqlstate: "23505",
      domain_code: null,
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("secret-value");
    expect(String(failure)).not.toContain("password");
    client.release();
    await driver.close();
  });

  it("releases an acquired pool client exactly once and rejects use after release", async () => {
    const pool = new FakePool();
    const driver = factory(pool);
    const client = await driver.acquire();
    client.release();
    expect(() => client.release()).toThrow("POSTGRES_RELEASE_FAILED");
    await expect(client.query(statement("after_release", "select 1", [])))
      .rejects.toMatchObject({ code: "POSTGRES_STATEMENT_FAILED" });
    expect(pool.client.releases).toBe(1);
    expect(driver.metrics()).toMatchObject({ releases: 1, active_clients: 0 });
  });

  it("counts failed connection attempts without acquiring or leaking driver details", async () => {
    const pool = new FakePool();
    pool.failConnection = true;
    const driver = factory(pool);
    await expect(driver.acquire()).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_FAILED" });
    expect(String(await driver.acquire().catch((error: unknown) => error))).not.toContain("password");
    expect(driver.metrics()).toMatchObject({ connection_attempts: 2, acquisitions: 0, queries: 0 });
  });

  it("closes once, refuses close with leased clients, and fails closed after shutdown", async () => {
    const pool = new FakePool();
    const driver = factory(pool);
    const client = await driver.acquire();
    await expect(driver.close()).rejects.toMatchObject({ code: "POSTGRES_RELEASE_FAILED" });
    client.release();
    await driver.close();
    await driver.close();
    expect(pool.ends).toBe(1);
    await expect(driver.acquire()).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_FAILED" });
    expect(driver.metrics()).toMatchObject({ closed: true, active_clients: 0 });
  });
});
