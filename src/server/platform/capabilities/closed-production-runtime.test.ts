// L8-1 / D2. The closed projection: every capability blocked, nothing enabled,
// deterministic; a dispatcher that needs no capability is allowed, every
// other is BLOCK; a blocked API dispatcher answers the product 404 and a
// blocked page is not found; the general builder still refuses a production
// mode, so the closed projection is the only production projection there is.
import { afterEach, describe, expect, it } from "vitest";
import { createClosedProductionRuntime, installClosedProductionRuntime } from "./closed-production-runtime.ts";
import { guardStableHttpEntrypoint } from "./stable-http-entrypoint.ts";
import { STABLE_PRODUCT_DISPATCHER_ROOTS, isCapabilityBlockedError, resetStableEntrypointRuntimeForTests, resolveStableEntrypointRuntime } from "./stable-entrypoint-runtime.ts";
import { PRODUCTION_LEGAL_ENGINE_CLOSED, SYSTEM_CAPABILITY_SCHEMA_VERSION, buildClosedProductionCapabilityProjection, buildSystemCapabilityProjection, systemCapabilityNameSchema } from "./system-capabilities.ts";
import { refusedEntrypoint } from "../../product/routes/http-common.ts";

afterEach(() => resetStableEntrypointRuntimeForTests());

describe("the closed production projection", () => {
  it("blocks every capability, enables none, and hashes the same twice", () => {
    const first = buildClosedProductionCapabilityProjection();
    const second = buildClosedProductionCapabilityProjection();
    expect(first.projection_sha256).toBe(second.projection_sha256);
    expect(first.runtime_mode).toBe("production_closed");
    expect(first.execution_scope).toBe("remote_closed");
    expect(first.fixture_mode).toBe("none");
    expect(first.enabled_capabilities).toEqual([]);
    expect(first.blocked_capabilities).toEqual([...systemCapabilityNameSchema.options]);
    for (const name of systemCapabilityNameSchema.options) {
      const declaration = first.capabilities[name];
      expect(declaration.state, name).toBe("blocked");
      expect(declaration.provider_id, name).toBeNull();
      expect(declaration.blocker_codes, name).toEqual([name === "customer_processing" || name === "delivery" ? "CUSTOMER_PROCESSING_DISABLED" : PRODUCTION_LEGAL_ENGINE_CLOSED]);
    }
  });

  it("is the only production projection: the general builder still refuses a production mode", () => {
    expect(() => buildSystemCapabilityProjection({ schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION, runtime_mode: "production_closed", execution_scope: "remote_closed", fixture_mode: "none", declarations: {} })).toThrow("CAPABILITY_RUNTIME_MODE_UNSAFE");
  });

  it("allows only the dispatchers that need no capability, and blocks every legal, shadow, portal, operations and customer route", () => {
    const runtime = createClosedProductionRuntime();
    const allowed = STABLE_PRODUCT_DISPATCHER_ROOTS.filter((entry) => runtime.evaluate(entry.entrypoint_id).outcome === "ALLOW").map((entry) => entry.entrypoint_id);
    expect(allowed).toEqual(["CEP-001", "CEP-008", "CEP-009", "CEP-010", "CEP-011", "CEP-012", "CEP-019", "CEP-078"]);
    for (const id of ["CEP-006", "CEP-007", "CEP-020", "CEP-021", "CEP-025", "CEP-026", "CEP-013", "CEP-022", "CEP-024"]) {
      const decision = runtime.evaluate(id);
      expect(decision.outcome, id).toBe("BLOCK");
      expect(decision.reason_codes.length, id).toBeGreaterThan(0);
    }
  });

  it("installs once through the verified path, and a blocked API dispatcher answers the product 404", async () => {
    installClosedProductionRuntime();
    expect(resolveStableEntrypointRuntime().projection.runtime_mode).toBe("production_closed");
    expect(() => installClosedProductionRuntime()).toThrow("CAPABILITY_RUNTIME_ALREADY_INSTALLED");
    const request = new Request("http://127.0.0.1/api/operations/shadow/summary");
    let response: Response | null = null;
    try {
      await guardStableHttpEntrypoint("CEP-020", request);
    } catch (error) {
      expect(isCapabilityBlockedError(error)).toBe(true);
      response = refusedEntrypoint(error);
    }
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("");
    // The health dispatcher needs no capability and passes the same guard.
    await expect(guardStableHttpEntrypoint("CEP-019", new Request("http://127.0.0.1/api/health"))).resolves.toMatchObject({ outcome: "ALLOW" });
  });

  it("refusedEntrypoint rethrows anything that is not a capability block", () => {
    expect(() => refusedEntrypoint(new Error("CAPABILITY_BODY_LIMIT"))).toThrow("CAPABILITY_BODY_LIMIT");
    expect(() => refusedEntrypoint(new Error("CAPABILITY_RUNTIME_NOT_INSTALLED"))).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
  });
});
