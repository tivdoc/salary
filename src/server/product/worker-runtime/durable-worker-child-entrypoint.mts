import { createDurableFreshWorkerChildRuntime } from "./durable-worker-runtime.ts";
import { serveFreshWorkerChildProcess } from "./fresh-child-launcher.ts";

const outcome = await serveFreshWorkerChildProcess(createDurableFreshWorkerChildRuntime, {
  input_timeout_ms: 5_000,
  shutdown_timeout_ms: 5_000,
});

if (outcome !== "COMPLETED") process.exitCode = 1;
