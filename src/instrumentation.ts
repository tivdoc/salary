export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeHermeticBrowserRuntime } = await import(
      "./server/product/integration/browser-runtime"
    );
    await initializeHermeticBrowserRuntime();
  }
}
