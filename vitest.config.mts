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
    // L10-5 (Lane B): a run that finds no test file must fail, not pass.
    passWithNoTests: false,
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: [
      ...configDefaults.exclude,
      "src/server/engine/extraction/benchmarks/openai/openai-benchmark.external.test.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-benchmark.external.test.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-v2-benchmark.external.test.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-v21-benchmark.external.test.ts",
    ],
  },
});
