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
import { engineAssignments, productAssignments } from "./route-split.ts";

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

  it("serves the product half as main serves it, and blocks every engine dispatcher (L9-4 / D3)", () => {
    const runtime = createClosedProductionRuntime();
    const allowed = STABLE_PRODUCT_DISPATCHER_ROOTS.filter((entry) => runtime.evaluate(entry.entrypoint_id).outcome === "ALLOW").map((entry) => entry.entrypoint_id).sort();
    expect(allowed).toEqual(productAssignments().map((entry) => entry.entrypoint_id).sort());
    for (const entry of productAssignments()) {
      const decision = runtime.evaluate(entry.entrypoint_id);
      expect(decision, entry.entrypoint_id).toMatchObject({ outcome: "ALLOW", reason_codes: [], blocked_capabilities: [], external_reason_codes: ["SERVED_AS_MAIN"] });
      expect(runtime.servesAsMain(entry.entrypoint_id), entry.entrypoint_id).toBe(true);
    }
    for (const entry of engineAssignments()) {
      const decision = runtime.evaluate(entry.entrypoint_id);
      expect(decision.outcome, entry.entrypoint_id).toBe("BLOCK");
      expect(decision.reason_codes.length, entry.entrypoint_id).toBeGreaterThan(0);
      expect(runtime.servesAsMain(entry.entrypoint_id), entry.entrypoint_id).toBe(false);
    }
    // The registrar and the six branch routes: seven engine dispatchers, twenty product ones, nothing unassigned.
    expect(engineAssignments()).toHaveLength(7);
    expect(allowed).toHaveLength(20);
    // A capability is still enabled nowhere: the product half is served by declaration, not by an enabled capability.
    expect(runtime.projection.enabled_capabilities).toEqual([]);
  });

  it("a product dispatcher passes the HTTP guard without a body read or a limit, an engine one is refused with the product 404", async () => {
    installClosedProductionRuntime();
    const oversized = new Request("http://127.0.0.1/api/payments/reconcile", { method: "POST", headers: { "content-length": String(10 * 1024 * 1024) }, body: "x" });
    await expect(guardStableHttpEntrypoint("CEP-024", oversized)).resolves.toMatchObject({ outcome: "ALLOW", external_reason_codes: ["SERVED_AS_MAIN"] });
    expect(oversized.bodyUsed).toBe(false);
    await expect(guardStableHttpEntrypoint("CEP-020", new Request("http://127.0.0.1/api/operations/shadow/summary"))).rejects.toThrow("CAPABILITY_ENTRYPOINT_BLOCKED:CEP-020");
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
