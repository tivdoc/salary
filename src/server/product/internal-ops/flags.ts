import "./server-boundary.ts";

import type { ServerFeatureFlagPort, V07FeatureFlag, VerifiedActor } from "../../../engine/wave4/contracts.ts";

export const INTERNAL_OPS_FLAGS = [
  "TIVDOC_INTERNAL_OPS_UI_ENABLED",
  "TIVDOC_INTERNAL_OPS_API_ENABLED",
  "TIVDOC_SYNTHETIC_OPS_ENABLED",
  "TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED",
  "TIVDOC_MANUAL_REPORT_EXPORT_ENABLED",
  "TIVDOC_CUSTOMER_PROCESSING_ENABLED",
  "TIVDOC_CUSTOMER_SHADOW_ENABLED",
  "TIVDOC_PRODUCTION_DELIVERY_ENABLED",
] as const satisfies readonly V07FeatureFlag[];

export type InternalOpsFlag = (typeof INTERNAL_OPS_FLAGS)[number];
export type InternalOpsFlagSnapshot = Readonly<Record<InternalOpsFlag, boolean>>;

export class UnsafeInternalOpsFlagError extends Error {
  readonly code = "OPS_PRODUCTION_FIXTURE_FORBIDDEN" as const;

  constructor() {
    super("OPS_PRODUCTION_FIXTURE_FORBIDDEN");
    this.name = "UnsafeInternalOpsFlagError";
  }
}

function enabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function readInternalOpsFlags(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): InternalOpsFlagSnapshot {
  const snapshot = Object.freeze(Object.fromEntries(INTERNAL_OPS_FLAGS.map((flag) => [flag, enabled(environment[flag])])) as Record<InternalOpsFlag, boolean>);
  if (nodeEnv === "production" && (snapshot.TIVDOC_SYNTHETIC_OPS_ENABLED || snapshot.TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED)) {
    throw new UnsafeInternalOpsFlagError();
  }
  return snapshot;
}

export class EnvironmentFeatureFlagPort implements ServerFeatureFlagPort {
  readonly #flags: InternalOpsFlagSnapshot;

  constructor(environment?: Readonly<Record<string, string | undefined>>, nodeEnv?: string) {
    this.#flags = readInternalOpsFlags(environment, nodeEnv);
  }

  isEnabled(flag: V07FeatureFlag): boolean {
    return flag in this.#flags ? this.#flags[flag as InternalOpsFlag] : false;
  }

  projectForActor(flags: readonly V07FeatureFlag[], _actor: VerifiedActor): Readonly<Record<V07FeatureFlag, boolean>> {
    void _actor;
    return Object.freeze(Object.fromEntries(flags.map((flag) => [flag, this.isEnabled(flag)])) as Record<V07FeatureFlag, boolean>);
  }

  internalSnapshot(): InternalOpsFlagSnapshot {
    return this.#flags;
  }
}

export function disabledInternalOpsFlags(): InternalOpsFlagSnapshot {
  return Object.freeze(Object.fromEntries(INTERNAL_OPS_FLAGS.map((flag) => [flag, false])) as Record<InternalOpsFlag, boolean>);
}
