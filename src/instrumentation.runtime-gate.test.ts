import { afterEach, describe, expect, it } from "vitest";

import { register } from "./instrumentation.ts";
import {
  assertStableEntrypointCapability,
  resetStableEntrypointRuntimeForTests,
  resolveStableEntrypointRuntime,
} from "./server/platform/capabilities/stable-entrypoint-runtime.ts";

// V0.10.10 W3. Serving `/`, `/portal` or `/operations` from a plain `next dev`
// or `next start` returns HTTP 500 with CAPABILITY_RUNTIME_NOT_INSTALLED. That
// is the intended fail-closed posture, not a bundling fault: `register()`
// installs a capability runtime only when a runtime mode is explicitly
// requested, and returns silently otherwise.
//
// These cases pin that contract from both ends, so a future change that either
// removes the fail-closed default or lets a route serve without an installed
// runtime fails here rather than in production.

const KEYS = [
  "NEXT_RUNTIME",
  "TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED",
  "TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED",
  "VERCEL_ENV",
] as const;

const original = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withEnvironment(values: Readonly<Partial<Record<(typeof KEYS)[number], string>>>): void {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("V0.10.10 product runtime installation gate", () => {
  it("installs nothing when no runtime mode is requested and stays fail-closed", async () => {
    withEnvironment({ NEXT_RUNTIME: "nodejs" });
    await expect(register()).resolves.toBeUndefined();
    expect(() => resolveStableEntrypointRuntime()).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
    expect(() => assertStableEntrypointCapability("CEP-078")).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
  });

  // L8-1 / D2. A production or preview environment with no runtime mode is
  // closed by construction: the closed projection is installed, every legal,
  // shadow, portal, operations and customer dispatcher is BLOCK, and the
  // dispatchers that need no capability still answer.
  it("installs the closed runtime under a production or preview environment", async () => {
    for (const vercelEnv of ["production", "preview"]) {
      resetStableEntrypointRuntimeForTests();
      withEnvironment({ NEXT_RUNTIME: "nodejs", VERCEL_ENV: vercelEnv });
      await expect(register()).resolves.toBeUndefined();
      const runtime = resolveStableEntrypointRuntime();
      expect(runtime.projection.runtime_mode).toBe("production_closed");
      expect(runtime.projection.enabled_capabilities).toEqual([]);
      expect(runtime.evaluate("CEP-020").outcome).toBe("BLOCK");
      expect(runtime.evaluate("CEP-007").outcome).toBe("BLOCK");
      expect(runtime.evaluate("CEP-013").outcome).toBe("BLOCK");
      expect(runtime.evaluate("CEP-001").outcome).toBe("ALLOW");
      expect(runtime.evaluate("CEP-019").outcome).toBe("ALLOW");
    }
    resetStableEntrypointRuntimeForTests();
  });

  it("a requested runtime mode under Vercel is refused, never silently downgraded to the closed one", async () => {
    withEnvironment({ NEXT_RUNTIME: "nodejs", VERCEL_ENV: "production", TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1" });
    await expect(register()).rejects.toThrow("DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN");
    expect(() => resolveStableEntrypointRuntime()).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
  });

  it("installs nothing outside the node runtime", async () => {
    withEnvironment({ NEXT_RUNTIME: "edge", TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1" });
    await expect(register()).resolves.toBeUndefined();
    expect(() => resolveStableEntrypointRuntime()).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
  });

  it("refuses to bootstrap two runtime modes at once", async () => {
    withEnvironment({
      NEXT_RUNTIME: "nodejs",
      TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1",
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "1",
    });
    await expect(register()).rejects.toThrow("PRODUCT_RUNTIME_BOOTSTRAP_MODE_CONFLICT");
    expect(() => resolveStableEntrypointRuntime()).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
  });

  it("refuses a hermetic bootstrap that is not fully sentinel-gated", async () => {
    withEnvironment({ NEXT_RUNTIME: "nodejs", TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "1" });
    await expect(register()).rejects.toThrow(/BROWSER_RUNTIME_BOOTSTRAP_/u);
    expect(() => resolveStableEntrypointRuntime()).toThrow("CAPABILITY_RUNTIME_NOT_INSTALLED");
  });
});
