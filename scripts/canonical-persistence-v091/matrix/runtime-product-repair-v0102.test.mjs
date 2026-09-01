import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createRuntimeProductRepairV0102Fixture,
  RUNTIME_PRODUCT_REPAIR_V0102_INVOCATION,
} from "./runtime-product-repair-v0102.mts";

describe("V0.10.2 dynamic PostgreSQL runtime-product repair matrix", () => {
  it("derives a deterministic synthetic fixture with a stale revision and non-zero epochs", () => {
    const first = createRuntimeProductRepairV0102Fixture("repair001", 1_800_000_000_000);
    const second = createRuntimeProductRepairV0102Fixture("repair001", 1_800_000_000_000);

    expect(first).toEqual(second);
    expect(first.tenants.a).toBe("tenant:repair:a:repair001");
    expect(first.cases.a).toBe("case:repair:a:repair001");
    expect(first.internal_cases.a).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(first.lifecycle_advance).toMatchObject({
      expected_revision: 1,
      state_before: "awaiting_report_approval",
      state_after: "report_ready",
    });
    expect(first.mutation).toMatchObject({
      expected_case_revision: 2,
      mutation_kind: "fact_correction",
      worker_fence: { fencing_token: 3 },
    });
    expect(first.initial_epochs).toEqual({ dependency: 5, cache: 7, download_grant: 11 });
    expect(first.mutation.previous_dependency_sha256).toBe(first.hashes.dependency_before);
    expect(first.mutation.next_dependency_sha256).not.toBe(first.mutation.previous_dependency_sha256);
  });

  it("publishes a credential-free supplied-URL invocation contract", () => {
    expect(RUNTIME_PRODUCT_REPAIR_V0102_INVOCATION).toEqual({
      schema_version: "tivdoc-runtime-product-repair-v0.10.2-invocation-v1",
      function: "runRuntimeProductRepairV0102Matrix",
      required_inputs: [
        "admin_connection_url",
        "runtime_role_connection_urls.operations",
        "runtime_role_connection_urls.web",
        "build_identity_sha",
        "fixture_suffix",
      ],
      target: "loopback disposable tivdoc_v09_* PostgreSQL database after migration 202609010009",
      credentials_recorded: 0,
      synthetic_data_only: true,
      cleanup: "exact fixture scope in finally",
    });
  });

  it("executes the exact product SQL and production adapter through verified roles", async () => {
    const source = await readFile(new URL("./runtime-product-repair-v0102.mts", import.meta.url), "utf8");

    expect(source).toContain("durableBoundaryStatements.reportIdentity");
    expect(source).toContain("private.resolve_engine_case_id($1,$2)");
    expect(source).toContain("repair_v0102_intake_case_update");
    expect(source).toContain("repair_v0102_intake_lifecycle_insert");
    expect(source).toContain("createDurablePostgresGlobalDependencyInvalidationService");
    expect(source).toContain("private.runtime_context_install($1,$2,$3)");
    expect(source).toContain("session_replication_role = replica");
    expect(source).toContain("product_reachable_memory_fallbacks: 0");
    expect(source).not.toContain("service_role_connection_url");
    expect(source).not.toContain("TIVDOC_CUSTOMER_PROCESSING_ENABLED");
    expect(source).not.toContain("TIVDOC_CUSTOMER_SHADOW_ENABLED");
    expect(source).not.toContain("TIVDOC_PRODUCTION_DELIVERY_ENABLED");
  });

  it("is consumed by the full PostgreSQL receipt and independent evidence verifier", async () => {
    const run = await readFile(new URL("../run.mts", import.meta.url), "utf8");
    const verifier = await readFile(new URL("../evidence/verify.mts", import.meta.url), "utf8");

    expect(run).toContain("runRuntimeProductRepairV0102Matrix");
    expect(run).toContain('"runtime-product-repair-matrix-v0.10.2.json": runtimeProductRepair');
    expect(run).toContain("REAL_POSTGRESQL_RUNTIME_PRODUCT_REPAIR");
    expect(verifier).toContain('"runtime-product-repair-matrix-v0.10.2.json"');
    expect(verifier).toContain("verifyRuntimeProductRepair(runtimeProductRepair, environment)");
  });

  it("rejects non-isolated fixture identifiers before constructing connections", () => {
    expect(() => createRuntimeProductRepairV0102Fixture("customer-file", 1_800_000_000_000))
      .toThrow("RUNTIME_PRODUCT_REPAIR_FIXTURE_SUFFIX_INVALID");
    expect(() => createRuntimeProductRepairV0102Fixture("repair001", 1))
      .toThrow("RUNTIME_PRODUCT_REPAIR_CLOCK_INVALID");
  });
});
