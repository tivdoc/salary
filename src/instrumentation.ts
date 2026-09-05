type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const HERMETIC_BROWSER_SENTINEL = "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101";

export function hermeticBrowserRuntimeBootstrapEnabled(
  environment: RuntimeEnvironment = process.env,
  nextRuntime: string | undefined = process.env.NEXT_RUNTIME,
): boolean {
  if (nextRuntime !== "nodejs" || !enabled(environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED)) return false;

  const nodeEnvironment = runtimeEnvironmentValue(environment, "NODE_ENV");
  const vercelEnvironment = runtimeEnvironmentValue(environment, "VERCEL_ENV");
  if (nodeEnvironment !== "test" || vercelEnvironment === "production" || vercelEnvironment === "preview") {
    throw new Error("BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN");
  }
  if (environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL !== HERMETIC_BROWSER_SENTINEL
      || !enabled(environment.TIVDOC_HERMETIC_MODE)
      || environment.TIVDOC_RUNTIME_TARGET !== "local_only"
      || environment.TIVDOC_PRODUCT_E2E_LANE !== "synthetic") {
    throw new Error("BROWSER_RUNTIME_BOOTSTRAP_SENTINEL_INVALID");
  }
  if (!enabled(environment.TIVDOC_PORTAL_UI_ENABLED)
      || !enabled(environment.TIVDOC_PORTAL_API_ENABLED)
      || !enabled(environment.TIVDOC_OPERATIONS_UI_ENABLED)
      || !enabled(environment.TIVDOC_OPERATIONS_API_ENABLED)
      || environment.TIVDOC_CUSTOMER_PROCESSING_ENABLED !== "0"
      || environment.TIVDOC_CUSTOMER_SHADOW_AUTHORIZED !== "0"
      || environment.TIVDOC_PRODUCTION_DELIVERY_ENABLED !== "0"
      || environment.TIVDOC_OPENAI_LIVE_TESTS !== "0") {
    throw new Error("BROWSER_RUNTIME_BOOTSTRAP_FLAGS_INVALID");
  }

  const origin = strictLoopbackOrigin(environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_ORIGIN);
  if (origin !== "http://127.0.0.1:45123") throw new Error("BROWSER_RUNTIME_BOOTSTRAP_ORIGIN_FORBIDDEN");
  return true;
}

/**
 * L8-1 / D2. A production or preview deployment — VERCEL_ENV says so, or
 * NODE_ENV=production with no Tivdoc runtime mode requested — is closed by
 * construction: it installs the projection in which every capability is
 * blocked, so the public pages answer, every legal, shadow, portal and
 * operations dispatcher answers the product's one 404, and nothing can be
 * turned on by a request. Any other environment without a runtime mode keeps
 * the V0.10.10 posture: nothing installed, every dispatcher fails closed.
 */
export function closedProductionEnvironment(environment: RuntimeEnvironment = process.env): boolean {
  // Case-insensitive (Lane B, long run 8): a mis-cased "Production" closes too.
  const vercelEnvironment = runtimeEnvironmentValue(environment, "VERCEL_ENV")?.trim().toLowerCase();
  const nodeEnvironment = runtimeEnvironmentValue(environment, "NODE_ENV")?.trim().toLowerCase();
  return vercelEnvironment === "production" || vercelEnvironment === "preview" || nodeEnvironment === "production";
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const durableRequested = enabled(process.env.TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED);
    const hermeticRequested = enabled(process.env.TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED);
    if (durableRequested && hermeticRequested) {
      throw new Error("PRODUCT_RUNTIME_BOOTSTRAP_MODE_CONFLICT");
    }
    const hermeticEnabled = hermeticRequested && hermeticBrowserRuntimeBootstrapEnabled();
    if (!durableRequested && !hermeticRequested && closedProductionEnvironment()) {
      const { installClosedProductionRuntime } = await import("./server/platform/capabilities/closed-production-runtime");
      installClosedProductionRuntime();
      return;
    }
    if (durableRequested) {
      const { initializeDurableLocalProductRuntime } = await import(
        "./server/product/runtime/durable-local-runtime"
      );
      await initializeDurableLocalProductRuntime();
      return;
    }
    if (!hermeticEnabled) return;
    const { initializeHermeticBrowserRuntime } = await import(
      "./server/product/integration/browser-runtime"
    );
    await initializeHermeticBrowserRuntime();
  }
}

function runtimeEnvironmentValue(environment: RuntimeEnvironment, key: string): string | undefined {
  const value = Reflect.get(environment, key);
  return typeof value === "string" ? value : undefined;
}

function strictLoopbackOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "45123"
      || url.username !== "" || url.password !== "" || url.pathname !== "/"
      || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
