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

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!hermeticBrowserRuntimeBootstrapEnabled()) return;
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
