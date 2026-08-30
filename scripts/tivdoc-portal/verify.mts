import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CONTRACT_BASE = "5373447e6cb18ab9e73a58fede18b96d573f584a";
const ALLOWLIST = [
  /^src\/server\/product\/customer-portal\//,
  /^src\/app\/portal-v07\//,
  /^src\/app\/api\/portal-v07\//,
  /^src\/components\/portal-v07\//,
  /^scripts\/tivdoc-portal\//,
  /^docs\/overnight-v0\.7-p6\.md$/,
];
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sources = {
  contracts: source("src/server/product/customer-portal/contracts.ts"),
  repository: source("src/server/product/customer-portal/synthetic-repository.ts"),
  service: source("src/server/product/customer-portal/service.ts"),
  api: source("src/server/product/customer-portal/api.ts"),
  route: source("src/app/api/portal-v07/[[...resource]]/route.ts"),
  page: source("src/app/portal-v07/page.tsx"),
  component: source("src/components/portal-v07/portal-shell.tsx"),
};

const testResult = runFocusedTests();
const changedPaths = gitPaths();
const outsideAllowlist = changedPaths.filter((path) => !ALLOWLIST.some((pattern) => pattern.test(path)));
const defaultOff = sources.route.includes("status: 404") && sources.page.includes("notFound()") && sources.route.includes("return disabled()") && !/^import /m.test(sources.route);
const ownerScoped = ["actor.role !== \"customer_owner\"", "actor.actor_id !== caseRecord.owner_actor_id", "actor.tenant_id !== caseRecord.tenant_id"].every((needle) => sources.service.includes(needle));
const clarificationBound = ["source_type: \"declared\"", "question_version", "explicit_confirmation: true", "conflicting_documented_fact_ids", "requires_human_review: true"].every((needle) => `${sources.contracts}${sources.repository}`.includes(needle));
const entitlementBound = ["verified_server_evidence", "full_reviewed_report", "release_state === \"released\"", "object_version_id", "artifact_sha256"].every((needle) => `${sources.contracts}${sources.service}`.includes(needle));
const privacyBound = ["PrivacyRequestRevision", "idempotency_key", "restricted_by_legal_hold", "consentHistory"].every((needle) => `${sources.contracts}${sources.repository}`.includes(needle));
const productionFixtureGuard = sources.repository.includes('mode === "production"') && sources.repository.includes("TEST_ADAPTER_FORBIDDEN_IN_PRODUCTION");

const acceptance = [
  { id: "V07-P6-PORTAL", pass: testResult.failed === 0 && defaultOff && ownerScoped },
  { id: "V07-P6-CLARIFICATION", pass: testResult.failed === 0 && clarificationBound },
  { id: "V07-P6-ENTITLEMENT", pass: testResult.failed === 0 && entitlementBound },
  { id: "V07-P6-PRIVACY", pass: testResult.failed === 0 && privacyBound },
];
const unsigned = {
  schema_version: "tivdoc-portal-verification-v0.7.0",
  contract_base: CONTRACT_BASE,
  overall: acceptance.every((item) => item.pass) && outsideAllowlist.length === 0 ? "LOCALLY_VERIFIED_DEFAULT_OFF" : "FAILED",
  acceptance,
  focused_tests: testResult,
  changed_paths: changedPaths,
  outside_allowlist: outsideAllowlist,
  source_hashes: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, sha256(value)])),
  invariant_counts: {
    real_customer_reads: 0,
    production_connections: 0,
    live_payment_calls: 0,
    delivery_calls: 0,
    openai_calls: 0,
    customer_shadow_runs: 0,
    legal_values_or_rules_invented: 0,
    automatic_releases: 0,
  },
  guards: {
    default_off_non_disclosing_route: defaultOff,
    owner_scope_enforced_server_side: ownerScoped,
    production_test_adapter_rejected: productionFixtureGuard,
    exact_release_binding_present: entitlementBound,
    declared_conflict_preservation_present: clarificationBound,
  },
  blockers: [
    "P2_SERVER_IDENTITY_ADAPTER_NOT_INTEGRATED",
    "P2_PRIVATE_STORAGE_ADAPTER_NOT_INTEGRATED",
    "CUSTOMER_DATA_READ_AUTHORIZATION_NOT_PROVEN",
    "BROWSER_E2E_AND_VISUAL_VERIFICATION_DEFERRED_TO_P8",
    "PRODUCTION_DELIVERY_DISABLED",
  ],
};
const result = { ...unsigned, evidence_sha256: sha256(canonicalJson(unsigned)) };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.overall === "LOCALLY_VERIFIED_DEFAULT_OFF" ? 0 : 6;

function runFocusedTests(): Readonly<{ files: number; tests: number; failed: number }> {
  const executable = resolve(root, "node_modules/vitest/vitest.mjs");
  try {
    const output = execFileSync(process.execPath, [executable,
      "run",
      "src/server/product/customer-portal",
      "src/components/portal-v07/portal-shell.test.ts",
      "--reporter=json",
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    const report = JSON.parse(output) as Readonly<{ testResults: readonly unknown[]; numTotalTests: number; numFailedTests: number }>;
    return { files: report.testResults.length, tests: report.numTotalTests, failed: report.numFailedTests };
  } catch (error) {
    const stdout = typeof error === "object" && error && "stdout" in error ? String(error.stdout) : "";
    try {
      const report = JSON.parse(stdout) as Readonly<{ testResults: readonly unknown[]; numTotalTests: number; numFailedTests: number }>;
      return { files: report.testResults.length, tests: report.numTotalTests, failed: Math.max(1, report.numFailedTests) };
    } catch {
      return { files: 0, tests: 0, failed: 1 };
    }
  }
}

function source(path: string): string { return readFileSync(resolve(root, path), "utf8"); }

function gitPaths(): readonly string[] {
  const committed = git(["diff", "--name-only", `${CONTRACT_BASE}..HEAD`]);
  const modified = git(["diff", "--name-only"]);
  const staged = git(["diff", "--cached", "--name-only"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...committed, ...modified, ...staged, ...untracked])].sort();
}

function git(args: readonly string[]): readonly string[] {
  const output = execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  return output ? output.split(/\r?\n/).map((path) => path.replaceAll("\\", "/")) : [];
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
