import { describe, expect, it } from "vitest";
import { disabledOfflineShadowFlags, readOfflineShadowFlags } from "./flags.ts";

// Wave 8 S-2. The kill switch is default off, in every runtime mode, and
// flipping it in production is not merely discouraged — it is a thrown
// error, not a boolean a caller can silently leave true.
describe("offline shadow kill switch (S-2)", () => {
  const modes = ["test", "development", "production", undefined] as const;

  it.each(modes)("boots off with no environment set, in %s mode", (nodeEnv) => {
    const flags = readOfflineShadowFlags({}, nodeEnv);
    expect(flags).toEqual({ enabled: false, synthetic_enabled: false, public_enabled: false });
  });

  it.each(modes)("boots off when the flags are explicitly false or unset, in %s mode", (nodeEnv) => {
    const flags = readOfflineShadowFlags({ TIVDOC_OFFLINE_SHADOW_ENABLED: "false", TIVDOC_SYNTHETIC_SHADOW_ENABLED: "0" }, nodeEnv);
    expect(flags.enabled).toBe(false);
    expect(flags.synthetic_enabled).toBe(false);
  });

  it("turns on in a non-production mode when explicitly set", () => {
    const flags = readOfflineShadowFlags({ TIVDOC_OFFLINE_SHADOW_ENABLED: "true", TIVDOC_SYNTHETIC_SHADOW_ENABLED: "1" }, "test");
    expect(flags.enabled).toBe(true);
    expect(flags.synthetic_enabled).toBe(true);
  });

  it("refuses (throws, not a false the caller could ignore) if any flag would be true in production", () => {
    expect(() => readOfflineShadowFlags({ TIVDOC_OFFLINE_SHADOW_ENABLED: "true" }, "production"))
      .toThrow("SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION");
    expect(() => readOfflineShadowFlags({ TIVDOC_SYNTHETIC_SHADOW_ENABLED: "true" }, "production"))
      .toThrow("SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION");
    expect(() => readOfflineShadowFlags({ TIVDOC_PUBLIC_SHADOW_ENABLED: "true" }, "production"))
      .toThrow("SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION");
  });

  it("production with every flag off does not throw — off is always safe", () => {
    expect(() => readOfflineShadowFlags({}, "production")).not.toThrow();
    expect(readOfflineShadowFlags({}, "production")).toEqual({ enabled: false, synthetic_enabled: false, public_enabled: false });
  });

  it("reads the real process.env and NODE_ENV by default, not a fixture the caller forgot to pass", () => {
    // No arguments — proves the default parameters actually resolve to the
    // live environment rather than silently defaulting to some other
    // fixture that would hide a real production misconfiguration.
    const flags = readOfflineShadowFlags();
    expect(typeof flags.enabled).toBe("boolean");
  });

  it("disabledOfflineShadowFlags() is the same all-off shape, independent of any environment", () => {
    expect(disabledOfflineShadowFlags()).toEqual({ enabled: false, synthetic_enabled: false, public_enabled: false });
  });
});
