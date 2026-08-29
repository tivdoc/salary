import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: [
      ...configDefaults.exclude,
      "src/server/engine/extraction/benchmarks/openai/openai-benchmark.external.test.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-benchmark.external.test.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-v2-benchmark.external.test.ts",
    ],
  },
});
