import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const mode = process.argv[2] ?? "all";

const testFiles = {
  api: ["src/server/product/internal-ops/flags.test.ts", "src/server/product/internal-ops/internal-ops.acceptance.test.ts"],
  ui: ["src/components/internal-ops-v07/internal-ops-console.test.ts"],
  e2e: ["src/server/product/internal-ops/internal-ops.acceptance.test.ts"],
} as const;

function runTests(files: readonly string[], pattern?: string): void {
  const args = [vitest, "run", ...files, "--reporter=dot", "--maxWorkers=1"];
  if (pattern) args.push("-t", pattern);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function contract(): void {
  const roots = [
    "src/server/product/internal-ops",
    "src/app/internal-ops-v07",
    "src/app/api/internal-ops-v07",
    "src/components/internal-ops-v07",
  ];
  const files = roots.flatMap((root) => walk(path.join(repoRoot, root))).filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));
  const content = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const forbiddenEndpointTokens = ["mark" + "Paid", "force" + "Ready", "override" + "Amount", "ignore" + "Conflict", "activate" + "Rule"];
  const failures = forbiddenEndpointTokens.filter((token) => content.includes(token));
  const requiredFlags = [
    "TIVDOC_INTERNAL_OPS_UI_ENABLED", "TIVDOC_INTERNAL_OPS_API_ENABLED", "TIVDOC_SYNTHETIC_OPS_ENABLED",
    "TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED", "TIVDOC_MANUAL_REPORT_EXPORT_ENABLED", "TIVDOC_CUSTOMER_PROCESSING_ENABLED",
    "TIVDOC_CUSTOMER_SHADOW_ENABLED", "TIVDOC_PRODUCTION_DELIVERY_ENABLED",
  ];
  const missingFlags = requiredFlags.filter((flag) => !content.includes(flag));
  if (failures.length || missingFlags.length || !content.includes("evaluateLegalReadiness")) {
    console.error(JSON.stringify({ status: "FAIL", failures, missing_flags: missingFlags }));
    process.exit(1);
  }
  console.log(JSON.stringify({ schema_version: "tivdoc-ops-command-receipt-v0.7.0", command: "ops:contract", status: "PASS", scanned_files: files.length, forbidden_endpoint_count: 0, required_flag_count: requiredFlags.length }));
}

function publicFixture(): void {
  const enabled = process.env.TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED === "true" || process.env.TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED === "1";
  if (process.env.NODE_ENV === "production" && enabled) {
    console.error(JSON.stringify({ command: "ops:public", status: "FAIL", code: "OPS_PRODUCTION_FIXTURE_FORBIDDEN" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ schema_version: "tivdoc-ops-command-receipt-v0.7.0", command: "ops:public", status: enabled ? "NON_PRODUCTION_FIXTURE_FLAG_ENABLED" : "SKIPPED_FEATURE_FLAG_DISABLED", production_reachable: false }));
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const entry = path.join(directory, name);
    return statSync(entry).isDirectory() ? walk(entry) : [entry];
  });
}

switch (mode) {
  case "contract": contract(); break;
  case "api": runTests(testFiles.api, "V07-P5-OPS-API|server-only flags"); break;
  case "ui": runTests(testFiles.ui); break;
  case "e2e": runTests(testFiles.e2e, "V07-P5-OPS-E2E"); break;
  case "synthetic": runTests(testFiles.e2e, "seven-topic synthetic readiness journey"); break;
  case "real-blocked": runTests(testFiles.e2e, "real-data-shaped journey"); break;
  case "public": publicFixture(); break;
  case "all": contract(); runTests([...testFiles.api, ...testFiles.ui]); publicFixture(); break;
  default:
    console.error("usage: run.mts contract|api|ui|e2e|synthetic|real-blocked|public|all");
    process.exit(2);
}
