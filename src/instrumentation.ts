export function register(): Promise<void> | void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Next replaces NEXT_RUNTIME per compiler target; require keeps the
    // Node-only composition out of the Edge instrumentation bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional compiler boundary
    const runtime = require("./server/product/integration/browser-runtime.ts") as typeof import("./server/product/integration/browser-runtime.ts");
    return runtime.initializeHermeticBrowserRuntime();
  }
}
