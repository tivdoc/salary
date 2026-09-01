import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSupabaseBlockerReceipt, EXPECTED_SUPABASE_PLATFORM_MATRIX, SUPABASE_EXPECTED_MATRIX_SCHEMA } from "./contracts.mts";
import { detectLocalSupabaseEnvironment } from "./environment.mts";

export function repoRootFromModule(metaUrl: string): string {
  return resolve(fileURLToPath(new URL("../../../", metaUrl)));
}

export function runSupabaseHarnessOperation(operation: "detect" | "bootstrap" | "verify" | "teardown", metaUrl: string): void {
  const detection = detectLocalSupabaseEnvironment({ repoRoot: repoRootFromModule(metaUrl) });
  if (detection.status === "BLOCKED_ENVIRONMENT") {
    process.stdout.write(`${JSON.stringify(buildSupabaseBlockerReceipt(operation, detection), null, 2)}\n`);
    process.exitCode = operation === "detect" ? 0 : 2;
    return;
  }

  const receipt = Object.freeze({
    schema: "tivdoc-isolated-supabase-operation-ready-v0.10.0",
    capability_id: "MC-03",
    operation,
    status: "READY_FOR_EXPLICIT_LOCAL_RUN",
    execution_performed: false,
    exact_reason: "Tooling and cached assets were detected, but mutation requires the dedicated owned-root executor and explicit local-only sentinel.",
    required_sentinel: "TIVDOC_ISOLATED_SUPABASE_EXECUTION=LOCAL_SYNTHETIC_ONLY",
    expected_matrix: Object.freeze({ schema: SUPABASE_EXPECTED_MATRIX_SCHEMA, checks: EXPECTED_SUPABASE_PLATFORM_MATRIX }),
    live_provider_calls: 0,
    remote_migrations: 0,
    deployments: 0,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = operation === "detect" ? 0 : 2;
}
