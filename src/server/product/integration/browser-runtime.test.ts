import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSyntheticCaseFixture } from "../../../engine/case-analysis/synthetic-fixtures.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import { resetRuntimeHermeticSessionManagerForTests } from "../auth/hermetic-session.ts";
import { resetProductSessionBoundaryForTests } from "../auth/runtime.ts";
import { INTERNAL_OPS_SCHEMA_VERSION } from "../internal-ops/contracts.ts";
import {
  resetCanonicalProductRouteServicesForTests,
  resolveCanonicalApplicationPersistence,
  resolveCanonicalApplicationProofClass,
  resolveCanonicalOperationsService,
} from "../routes/runtime.ts";
import { initializeHermeticBrowserRuntime } from "./browser-runtime.ts";
import { verifiedSyntheticActor } from "./ready-harness.ts";

describe("V0.8 hermetic browser startup composition", () => {
  afterEach(() => {
    resetCanonicalProductRouteServicesForTests();
    resetProductSessionBoundaryForTests();
    resetRuntimeHermeticSessionManagerForTests();
    vi.unstubAllEnvs();
  });

  it("seeds before readiness and installs the canonical route services only in hermetic test mode", async () => {
    const caseId = buildSyntheticCaseFixture({ fixture_id: "p8-0" }).command.case_id;
    const actor = verifiedSyntheticActor({ actor_id: "owner-a-01", role: "customer_owner", tenant_id: "tenant01", assigned_case_ids: [caseId] });
    vi.stubEnv("TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED", "true");
    vi.stubEnv("TIVDOC_HERMETIC_MODE", "true");
    vi.stubEnv("TIVDOC_PRODUCT_E2E_LANE", "synthetic");
    vi.stubEnv("TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL", "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101");
    vi.stubEnv("TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN", "http://127.0.0.1:45123");
    vi.stubEnv("TIVDOC_RUNTIME_TARGET", "local_only");
    vi.stubEnv("TIVDOC_PRODUCT_SESSION_SECRET", "browser-runtime-test-secret-000000000000000000000001");
    vi.stubEnv("TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON", JSON.stringify({ "browser-owner-ticket-0001": { audience: "portal", actor } }));
    vi.stubEnv("TIVDOC_PORTAL_UI_ENABLED", "true");
    vi.stubEnv("TIVDOC_PORTAL_API_ENABLED", "true");
    vi.stubEnv("TIVDOC_OPERATIONS_UI_ENABLED", "true");
    vi.stubEnv("TIVDOC_OPERATIONS_API_ENABLED", "true");
    await expect(initializeHermeticBrowserRuntime()).resolves.toBeUndefined();
    expect(resolveCanonicalApplicationPersistence()).toMatchObject({ mode: "isolated_postgres", durable: true });
    expect(resolveCanonicalApplicationProofClass()).toBe("STATIC_OR_RECORDING_DRIVER_PROOF");
    const legal = verifiedSyntheticActor({ actor_id: "legal-reviewer-01", role: "legal_reviewer", tenant_id: "tenant01", assigned_case_ids: [caseId] });
    const operations = resolveCanonicalOperationsService()!;
    const facts = await operations.read(legal, "facts", caseId);
    expect("snapshot_sha256" in facts && facts.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(operations.mutate(legal, {
      schema_version: INTERNAL_OPS_SCHEMA_VERSION,
      command_id: "browser-runtime-analysis-command-0001",
      idempotency_key: "browser-runtime-analysis-idempotency-0001",
      expected_revision: 5,
      reason: "hermetic startup integration test",
      payload: {
        action: "analysis_request",
        case_id: caseId,
        analysis_run_id: null,
        mode: "synthetic_test",
        requested_topics: WAVE3_TOPICS,
        input_snapshot_sha256: "snapshot_sha256" in facts ? facts.snapshot_sha256 : null,
      },
    }, "browser-runtime-correlation-0001")).resolves.toMatchObject({ revision: 7, state: "awaiting_report_approval" });
  });
});
