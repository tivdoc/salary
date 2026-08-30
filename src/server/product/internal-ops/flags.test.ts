import { describe, expect, it } from "vitest";
import { EnvironmentFeatureFlagPort, INTERNAL_OPS_FLAGS, readInternalOpsFlags, UnsafeInternalOpsFlagError } from "./flags.ts";

describe("V0.7 internal ops server-only flags", () => {
  it("defaults every internal ops capability to false", () => {
    const flags = readInternalOpsFlags({}, "test");
    expect(Object.keys(flags)).toEqual(INTERNAL_OPS_FLAGS);
    expect(Object.values(flags).every((value) => value === false)).toBe(true);
    expect(new EnvironmentFeatureFlagPort({}, "test").isEnabled("TIVDOC_INTERNAL_OPS_API_ENABLED")).toBe(false);
  });

  it("hard-fails synthetic and public fixtures in production", () => {
    expect(() => readInternalOpsFlags({ TIVDOC_SYNTHETIC_OPS_ENABLED: "true" }, "production")).toThrow(UnsafeInternalOpsFlagError);
    expect(() => readInternalOpsFlags({ TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED: "1" }, "production")).toThrow("OPS_PRODUCTION_FIXTURE_FORBIDDEN");
  });

  it("does not treat permissive-looking values as enabled", () => {
    expect(readInternalOpsFlags({ TIVDOC_INTERNAL_OPS_UI_ENABLED: "yes", TIVDOC_INTERNAL_OPS_API_ENABLED: "TRUE" }, "test")).toMatchObject({
      TIVDOC_INTERNAL_OPS_UI_ENABLED: false,
      TIVDOC_INTERNAL_OPS_API_ENABLED: false,
    });
  });
});
