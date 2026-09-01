import "../routes/server-boundary.ts";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import type { DurableLocalProductRuntimeConfig } from "../runtime/durable-local-config.ts";
import {
  FreshWorkerChildProcessLauncher,
  type FreshWorkerChildEnvironmentKey,
} from "./fresh-child-launcher.ts";

const ENTRYPOINT = fileURLToPath(new URL("./durable-worker-child-entrypoint.mts", import.meta.url));

export function createDurableFreshWorkerLauncher(
  config: DurableLocalProductRuntimeConfig,
  systemEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): FreshWorkerChildProcessLauncher {
  const environment: Partial<Record<FreshWorkerChildEnvironmentKey, string>> = {
    NODE_ENV: "development",
    TIVDOC_WORKER_RUNTIME_SENTINEL: "TIVDOC_FRESH_WORKER_V0102",
    TIVDOC_WORKER_ACTOR_ID: config.worker_identity.actor_id,
    TIVDOC_WORKER_TENANT_ID: config.worker_identity.tenant_id,
    TIVDOC_WORKER_SESSION_ID: config.worker_identity.session_id,
    TIVDOC_WORKER_TOKEN_ID: config.worker_identity.token_id,
    TIVDOC_WORKER_ROTATION_COUNTER: String(config.worker_identity.rotation_counter),
    TIVDOC_WORKER_BUILD_IDENTITY_SHA: config.build_identity_sha,
    TIVDOC_WORKER_POSTGRES_URL: config.connection_urls.worker,
    TIVDOC_WORKER_PRIVATE_STORAGE_ROOT: config.private_storage_root,
  };
  for (const key of ["SYSTEMROOT", "TEMP", "TMP", "WINDIR"] as const) {
    if (systemEnvironment[key]) environment[key] = systemEnvironment[key];
  }
  return new FreshWorkerChildProcessLauncher({
    entrypoint_path: ENTRYPOINT,
    working_directory: dirname(ENTRYPOINT),
    timeout_ms: 30_000,
    termination_grace_ms: 2_000,
    child_environment: environment,
  });
}
