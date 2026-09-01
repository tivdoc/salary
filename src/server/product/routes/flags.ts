import "./server-boundary.ts";

export type StableProductRouteFlags = Readonly<{
  portalUi: boolean;
  portalApi: boolean;
  operationsUi: boolean;
  operationsApi: boolean;
}>;

export type StableProductRuntimeClass = "disabled" | "hermetic_test" | "durable_local";

export function readStableProductRouteFlags(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StableProductRouteFlags {
  const flags = Object.freeze({
    portalUi: enabled(environment.TIVDOC_PORTAL_UI_ENABLED),
    portalApi: enabled(environment.TIVDOC_PORTAL_API_ENABLED),
    operationsUi: enabled(environment.TIVDOC_OPERATIONS_UI_ENABLED),
    operationsApi: enabled(environment.TIVDOC_OPERATIONS_API_ENABLED),
  });
  classifyStableProductRuntime(environment, flags);
  return flags;
}

/**
 * Stable routes may be reachable only through an explicit local durable root or
 * the compiler-resistant, loopback-only browser fixture lane. A flag by itself
 * never enables a product route.
 */
export function classifyStableProductRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  flags: StableProductRouteFlags = Object.freeze({ portalUi: false, portalApi: false, operationsUi: false, operationsApi: false }),
): StableProductRuntimeClass {
  if (!Object.values(flags).some(Boolean)) return "disabled";
  if (environment.VERCEL_ENV === "production" || environment.VERCEL_ENV === "preview") {
    throw new Error("STABLE_PRODUCT_REMOTE_RUNTIME_FORBIDDEN");
  }
  const nodeEnvironment = Reflect.get(environment, "NODE_ENV");
  const localOnly = environment.TIVDOC_RUNTIME_TARGET === "local_only";
  const hermetic = nodeEnvironment === "test"
    && localOnly
    && enabled(environment.TIVDOC_HERMETIC_MODE)
    && enabled(environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED)
    && environment.TIVDOC_PRODUCT_E2E_LANE === "synthetic"
    && environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL === "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101"
    && environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN === "http://127.0.0.1:45123";
  if (hermetic) return "hermetic_test";
  const durable = localOnly
    && enabled(environment.TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED)
    && environment.TIVDOC_PRODUCT_PERSISTENCE_MODE === "isolated_postgres"
    && enabled(environment.TIVDOC_DURABLE_IDENTITY_ENABLED)
    && enabled(environment.TIVDOC_PRIVATE_STORAGE_ENABLED);
  if (durable) return "durable_local";
  throw new Error("STABLE_PRODUCT_CAPABILITY_PREREQUISITES_MISSING");
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
