import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-benchmark.external.test.ts",
      "src/server/engine/extraction/benchmarks/openai/real-public/openai-real-v2-benchmark.external.test.ts",
    ],
  },
});
