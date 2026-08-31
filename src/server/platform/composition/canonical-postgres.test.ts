import { describe, expect, it } from "vitest";

import { StrictRecordingPostgresDriver } from "../persistence/postgres/runtime/recording-driver.ts";
import {
  CANONICAL_POSTGRES_SCHEMA_VERSION,
  requireIsolatedCanonicalPostgres,
  startCanonicalPostgresComposition,
} from "./canonical-postgres.ts";

const target = Object.freeze({
  target_id: "tivdoc-v09-synthetic-target",
  host: "127.0.0.1" as const,
  database: "tivdoc_v09_synthetic_001",
  disposable: true as const,
  validation: "LOOPBACK_DISPOSABLE_VALIDATED" as const,
});

describe("single canonical PostgreSQL composition root", () => {
  it("rejects memory mode without both a hermetic boundary and explicit sentinel", async () => {
    await expect(startCanonicalPostgresComposition({ mode: "memory_test_only", execution_boundary: "non_test" }, {}))
      .rejects.toMatchObject({ code: "MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION" });
    await expect(startCanonicalPostgresComposition({ mode: "memory_test_only", execution_boundary: "test" }, {}))
      .rejects.toMatchObject({ code: "MEMORY_TEST_ONLY_SENTINEL_REQUIRED" });
  });

  it("permits a test-owned memory bundle only behind the explicit hermetic sentinel", async () => {
    const composition = await startCanonicalPostgresComposition({
      mode: "memory_test_only",
      execution_boundary: "hermetic_synthetic",
      test_sentinel: "TIVDOC_HERMETIC_TEST_ONLY",
    }, { memory_test_only_factory: () => Object.freeze({ fixture: "synthetic-only" }) });
    expect(composition).toEqual({
      mode: "memory_test_only", durable: false, test_only: true,
      bundle: { fixture: "synthetic-only" },
    });
  });

  it("keeps disabled mode fail-closed without acquiring a connection", async () => {
    const composition = await startCanonicalPostgresComposition({ mode: "disabled", execution_boundary: "non_test" }, {});
    expect(composition).toEqual({ mode: "disabled", durable: false, reason: "PERSISTENCE_DISABLED" });
    expect(() => requireIsolatedCanonicalPostgres(composition)).toThrowError("PERSISTENCE_DISABLED");
  });

  it("checks schema at startup and binds W1/W2/runtime adapters to one transaction context", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "runtime_context_set" },
      { statement_name: "schema_compatibility_read", result: { rows: [{ schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION }], row_count: 1 } },
      { statement_name: "transaction_commit" },
      { statement_name: "transaction_begin" },
      { statement_name: "runtime_context_set" },
      { statement_name: "transaction_commit" },
    ]);
    const composition = await startCanonicalPostgresComposition({
      mode: "isolated_postgres",
      execution_boundary: "non_test",
      target,
      build_identity_sha: "a".repeat(40),
    }, {
      connection_factory: driver,
      intake_factory: (context, tenantId) => ({ context, tenantId, source: "W1" as const }),
      analysis_factory: (context, tenantId) => ({ context, tenantId, source: "W2" as const }),
    });
    const operational = requireIsolatedCanonicalPostgres(composition);
    await expect(operational.transaction("tenant:synthetic:001", "case:synthetic:001", async (bundle) => {
      expect(bundle.intake.context).toBe(bundle.context);
      expect(bundle.analysis.context).toBe(bundle.context);
      expect(bundle.intake.tenantId).toBe("tenant:synthetic:001");
      expect(bundle.runtime.idempotency).toBeDefined();
      expect(bundle.runtime.jobs_outbox_audit).toBeDefined();
      return bundle.context.transaction_id;
    })).resolves.toBe("postgres-transaction-00000002");
    expect(driver.inventory()).toMatchObject({ acquisitions: 2, releases: 2, remaining_steps: 0 });
  });

  it("fails startup closed on an incompatible schema and does not expose adapters", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "runtime_context_set" },
      { statement_name: "schema_compatibility_read", result: { rows: [{ schema_version: "wrong" }], row_count: 1 } },
      { statement_name: "transaction_rollback" },
    ]);
    await expect(startCanonicalPostgresComposition({
      mode: "isolated_postgres", execution_boundary: "non_test", target,
      build_identity_sha: "b".repeat(40),
    }, {
      connection_factory: driver,
      intake_factory: () => ({}),
      analysis_factory: () => ({}),
    })).rejects.toMatchObject({ code: "POSTGRES_SCHEMA_INCOMPATIBLE" });
    expect(driver.inventory().statements.at(-1)?.name).toBe("transaction_rollback");
  });

  it("rejects any non-loopback or ambiguously named target before connection acquisition", async () => {
    await expect(startCanonicalPostgresComposition({
      mode: "isolated_postgres", execution_boundary: "non_test",
      target: { ...target, host: "db.example.invalid" as "127.0.0.1" },
      build_identity_sha: "c".repeat(40),
    }, {})).rejects.toMatchObject({ code: "POSTGRES_TARGET_NOT_LOOPBACK" });
  });

  it("does not fall back to memory when connection acquisition fails", async () => {
    await expect(startCanonicalPostgresComposition({
      mode: "isolated_postgres", execution_boundary: "non_test", target,
      build_identity_sha: "d".repeat(40),
    }, {
      connection_factory: { acquire: () => Promise.reject(new Error("driver detail must not escape")) },
      intake_factory: () => ({}),
      analysis_factory: () => ({}),
      memory_test_only_factory: () => ({ forbidden_fallback: true }),
    })).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_FAILED", message: "POSTGRES_CONNECTION_FAILED" });
  });
});
