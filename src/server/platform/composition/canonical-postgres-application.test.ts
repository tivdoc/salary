import { describe, expect, it } from "vitest";

import { PERSISTENCE_CAPABILITIES } from "../persistence/wiring-map.ts";
import { StrictRecordingPostgresDriver } from "../persistence/postgres/runtime/recording-driver.ts";
import { CANONICAL_POSTGRES_SCHEMA_VERSION } from "./canonical-postgres.ts";
import {
  CANONICAL_POSTGRES_CAPABILITY_BINDINGS,
  CANONICAL_POSTGRES_ENTRYPOINT_BINDINGS,
  startCanonicalApplicationPostgres,
} from "./canonical-postgres-application.ts";

describe("canonical V0.9 application PostgreSQL binding", () => {
  it("binds the exact frozen 14 capabilities once through one application root", () => {
    expect(CANONICAL_POSTGRES_CAPABILITY_BINDINGS.map((entry) => entry.capability)).toEqual(PERSISTENCE_CAPABILITIES);
    expect(new Set(CANONICAL_POSTGRES_CAPABILITY_BINDINGS.map((entry) => entry.binding)).size).toBe(14);
    expect(CANONICAL_POSTGRES_ENTRYPOINT_BINDINGS.map((entry) => entry.entrypoint)).toEqual([
      "stable_portal", "stable_operations", "case_analysis", "background_workers",
    ]);
  });

  it("constructs all W1, W2 and runtime adapters on the same recording transaction context", async () => {
    const driver = new StrictRecordingPostgresDriver([
      { statement_name: "transaction_begin" },
      { statement_name: "runtime_context_set" },
      { statement_name: "schema_compatibility_read", result: { rows: [{ schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION }], row_count: 1 } },
      { statement_name: "transaction_commit" },
      { statement_name: "transaction_begin" },
      { statement_name: "runtime_context_set" },
      { statement_name: "transaction_commit" },
    ]);
    const composition = await startCanonicalApplicationPostgres({
      mode: "isolated_postgres",
      execution_boundary: "test",
      target: { target_id: "v09-recording", host: "127.0.0.1", database: "tivdoc_v09_recording_001", disposable: true, validation: "LOOPBACK_DISPOSABLE_VALIDATED" },
      build_identity_sha: "a".repeat(40),
    }, { connection_factory: driver });
    expect(composition.mode).toBe("isolated_postgres");
    if (composition.mode !== "isolated_postgres") throw new Error("TEST_COMPOSITION_MODE_INVALID");
    await composition.transaction("tenant-synthetic", "case-synthetic", async (bundle) => {
      expect(bundle.intake.context).toBe(bundle.context);
      expect(bundle.analysis.caseAnalysis).toBeDefined();
      expect(bundle.runtime.idempotency).toBeDefined();
      expect(bundle.runtime.jobs_outbox_audit).toBeDefined();
    });
    expect(driver.inventory()).toMatchObject({ acquisitions: 2, releases: 2, remaining_steps: 0, proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF" });
  });
});
