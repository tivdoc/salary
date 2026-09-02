import { afterEach, describe, expect, it } from "vitest";

import { register } from "./instrumentation.ts";
import {
  assertStableEntrypointCapability,
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
