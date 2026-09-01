import { describe, expect, it } from "vitest";

import { classifyStableProductRuntime, readStableProductRouteFlags } from "./flags.ts";

const ENABLED = Object.freeze({
  TIVDOC_PORTAL_UI_ENABLED: "true",
  TIVDOC_PORTAL_API_ENABLED: "true",
  TIVDOC_OPERATIONS_UI_ENABLED: "true",
  TIVDOC_OPERATIONS_API_ENABLED: "true",
});

describe("stable product capability gate", () => {
  it("keeps all routes disabled without flags", () => {
    expect(readStableProductRouteFlags({})).toEqual({
      portalUi: false,
      portalApi: false,
      operationsUi: false,
      operationsApi: false,
    });
  });

  it("allows only the explicit compiler-resistant hermetic test lane", () => {
    const environment = {
      ...ENABLED,
      NODE_ENV: "test",
      TIVDOC_RUNTIME_TARGET: "local_only",
      TIVDOC_HERMETIC_MODE: "true",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "true",
      TIVDOC_PRODUCT_E2E_LANE: "synthetic",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL: "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN: "http://127.0.0.1:45123",
    };
    const flags = readStableProductRouteFlags(environment);
    expect(classifyStableProductRuntime(environment, flags)).toBe("hermetic_test");
  });

  it("allows an explicit local durable identity, PostgreSQL and private-storage root", () => {
    const environment = {
      ...ENABLED,
      NODE_ENV: "development",
      TIVDOC_RUNTIME_TARGET: "local_only",
      TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "true",
      TIVDOC_PRODUCT_PERSISTENCE_MODE: "isolated_postgres",
      TIVDOC_DURABLE_IDENTITY_ENABLED: "true",
      TIVDOC_PRIVATE_STORAGE_ENABLED: "true",
    };
    expect(classifyStableProductRuntime(environment, readStableProductRouteFlags(environment))).toBe("durable_local");
  });

  it("rejects flags without prerequisites and every preview/production target", () => {
    expect(() => readStableProductRouteFlags({ ...ENABLED, NODE_ENV: "development" }))
      .toThrow("STABLE_PRODUCT_CAPABILITY_PREREQUISITES_MISSING");
    expect(() => readStableProductRouteFlags({ ...ENABLED, VERCEL_ENV: "preview" }))
      .toThrow("STABLE_PRODUCT_REMOTE_RUNTIME_FORBIDDEN");
    expect(() => readStableProductRouteFlags({ ...ENABLED, VERCEL_ENV: "production" }))
      .toThrow("STABLE_PRODUCT_REMOTE_RUNTIME_FORBIDDEN");
  });
});
