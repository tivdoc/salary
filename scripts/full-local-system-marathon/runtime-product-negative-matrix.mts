import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { trustedGitText } from "../canonical-persistence-v091/foundation/trusted-git.mts";

const ROOT = path.resolve(process.cwd());
const OUTPUT = resolveOutput(process.argv.slice(2));
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

export const RUNTIME_PRODUCT_NEGATIVE_CASES = Object.freeze([
  "auth_signature_expiry_rotation_revocation_replay",
  "tenant_and_owner_concealment",
  "csrf_and_unsigned_identity_rejection",
  "stale_revision_and_changed_payload",
  "idempotent_replay_and_duplicate_effect_rejection",
  "dependency_invalidation_and_stale_grant_rejection",
  "body_upload_page_field_job_batch_report_limits",
  "cancellation_timeout_backpressure_and_concurrency",
  "worker_fencing_and_atomic_failure_visibility",
  "parser_import_resource_limits_fail_closed",
] as const);

const tests = Object.freeze([
  "src/server/product/auth/identity-session.test.ts",
  "src/server/product/auth/durable-session-boundary.test.ts",
  "src/server/product/routes/least-privilege-session-context.test.ts",
  "src/server/product/routes/portal-http.test.ts",
  "src/server/product/routes/runtime.test.ts",
  "src/server/platform/capabilities/system-capabilities.test.ts",
  "src/server/platform/capabilities/stable-entrypoint-runtime.test.ts",
  "src/server/platform/capabilities/stable-http-entrypoint.test.ts",
  "src/server/platform/security/security.test.ts",
  "src/server/platform/security/parser-sandbox.test.ts",
  "src/server/product/dependency-invalidation/global-invalidation.test.ts",
  "src/server/product/dependency-invalidation/postgres-port.test.ts",
  "src/server/product/worker-runtime/fresh-child-launcher.test.ts",
  "src/server/platform/storage/local-runtime/private-blob-provider.test.ts",
  "src/server/engine/multi-document-intake/application.test.ts",
  "src/engine/legal-operations/rulespec-lifecycle.test.ts",
  "src/engine/legal-quality/synthetic-property-suite.test.ts",
]);

const head = trustedGitText(ROOT, ["rev-parse", "HEAD"]);
const tree = trustedGitText(ROOT, ["rev-parse", "HEAD^{tree}"]);
const startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, [VITEST, "run", ...tests, "--maxWorkers=1"], {
  cwd: ROOT,
  env: safeEnvironment(),
  encoding: "utf8",
  windowsHide: true,
  timeout: 15 * 60_000,
  maxBuffer: 128 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? (result.error ? String(result.error) : "");
process.stdout.write(stdout);
process.stderr.write(stderr);

const currentHead = trustedGitText(ROOT, ["rev-parse", "HEAD"]);
const currentTree = trustedGitText(ROOT, ["rev-parse", "HEAD^{tree}"]);
const passed = result.status === 0 && result.signal === null && currentHead === head && currentTree === tree;
const receipt = Object.freeze({
  schema_version: "tivdoc-runtime-product-security-limits-negative-matrix-v0.10.2",
  status: passed ? "PASS" as const : "FAIL" as const,
  run_class: "FULL_LOCAL_SECURITY_LIMITS_NEGATIVE_MATRIX",
  verified_head: head,
  verified_tree: tree,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  test_files: tests,
  test_file_count: tests.length,
  negative_cases: RUNTIME_PRODUCT_NEGATIVE_CASES,
  negative_case_count: RUNTIME_PRODUCT_NEGATIVE_CASES.length,
  rendered_browser_negative_cases_are_proven_by: "browser_durable_product_e2e",
  child_exit_code: result.status ?? null,
  child_signal: result.signal,
  head_tree_stable: currentHead === head && currentTree === tree,
  no_partial_product_effects_required: true,
  truth_counters: Object.freeze({
    customer_data_reads: 0,
    deployments: 0,
    remote_migrations: 0,
    live_provider_calls: 0,
    openai_calls: 0,
  }),
});
await mkdir(OUTPUT, { recursive: true });
await writeFile(path.join(OUTPUT, "security-limits-negative-matrix.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (!passed) process.exitCode = result.status ?? 1;

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ",
    "USERPROFILE", "windir",
  ] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    CI: "1",
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

function resolveOutput(args: readonly string[]): string {
  const index = args.indexOf("--output-root");
  if (index < 0) return path.join(ROOT, "output", "runtime-product-closure-v0.10.2", "working");
  const value = args[index + 1];
  if (!value) throw new Error("V0102_NEGATIVE_MATRIX_OUTPUT_ROOT_REQUIRED");
  return path.resolve(ROOT, value);
}
