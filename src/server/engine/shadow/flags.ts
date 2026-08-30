export type OfflineShadowFlags = Readonly<{ enabled: boolean; synthetic_enabled: boolean; public_enabled: boolean }>;

export function readOfflineShadowFlags(environment: Readonly<Record<string, string | undefined>> = process.env, nodeEnv: string | undefined = process.env.NODE_ENV): OfflineShadowFlags {
  const enabled = (key: string) => environment[key] === "true" || environment[key] === "1";
  const flags = Object.freeze({ enabled: enabled("TIVDOC_OFFLINE_SHADOW_ENABLED"), synthetic_enabled: enabled("TIVDOC_SYNTHETIC_SHADOW_ENABLED"), public_enabled: enabled("TIVDOC_PUBLIC_SHADOW_ENABLED") });
  if (nodeEnv === "production" && (flags.enabled || flags.synthetic_enabled || flags.public_enabled)) throw new Error("SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION");
  return flags;
}

export function disabledOfflineShadowFlags(): OfflineShadowFlags {
  return Object.freeze({ enabled: false, synthetic_enabled: false, public_enabled: false });
}
