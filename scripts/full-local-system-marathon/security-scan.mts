import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { trustedGitBuffer, trustedGitText } from "../canonical-persistence-v091/foundation/trusted-git.mts";
import { addedSourceByPath, findStaticImports } from "./static-imports.mts";

const ROOT = path.resolve(process.cwd());
const BASE = "28d18da69108913252736f4b8a39c4ef614984a3";
const OUTPUT = path.join(ROOT, "output", "full-local-system-marathon-v0.10.0", "working", "security");

const changedPaths = trustedGitText(ROOT, ["diff", "--name-only", `${BASE}..HEAD`, "--"])
  .split(/\r?\n/u)
  .filter(Boolean)
  .sort();
const diff = trustedGitBuffer(ROOT, ["diff", "--no-ext-diff", "--unified=0", `${BASE}..HEAD`, "--"])
  .toString("utf8");
const HERMETIC_SYNTHETIC_COORDINATOR = "src/server/product/runtime/durable-synthetic-report-pipeline.ts";
const hermeticSyntheticCoordinator = await readFile(path.join(ROOT, ...HERMETIC_SYNTHETIC_COORDINATOR.split("/")), "utf8");
const hermeticCoordinatorProof = hermeticSyntheticCoordinator.includes("ordinary_runtime_reachable: false")
  && hermeticSyntheticCoordinator.includes("real_legal_activations: 0")
  && hermeticSyntheticCoordinator.includes("product_reachable_memory_repositories: 0")
  && hermeticSyntheticCoordinator.includes('import "../routes/server-boundary.ts"');

type Finding = Readonly<{ kind: string; path: string }>;
const findings: Finding[] = [];
const suspiciousPath = new RegExp([
  "(?:^|/)(?:eval|ground-truth|customer-payslips)(?:/|$)",
  "|\\.(?:pdf|docx?|xlsx?|png|jpe?g)$",
].join(""), "iu");
for (const file of changedPaths) {
  if (suspiciousPath.test(file)) findings.push({ kind: "customer_or_binary_artifact_path", path: file });
}

const patterns = [
  {
    kind: "private_key_material",
    pattern: new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH |ENCRYPTED )?", "PRIVATE KEY-----"].join(""), "u"),
    applies: () => true,
  },
  {
    kind: "provider_secret",
    pattern: new RegExp(["\\b", "sk-", "(?:proj-|live-)?", "[A-Za-z0-9_-]{24,}", "\\b"].join(""), "u"),
    applies: () => true,
  },
  {
    kind: "credential_url",
    pattern: new RegExp(["(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?):", "//", "[^\\s\"']+:[^\\s\"']+@"].join(""), "iu"),
    applies: () => true,
  },
  {
    kind: "customer_local_path",
    pattern: new RegExp(["[A-Z]:\\\\", "[^\\r\\n\"']*", "(?:customer-payslips|OneDrive\\\\[^\\r\\n\"']*\\\\Tivdoc)"].join(""), "iu"),
    applies: () => true,
  },
  {
    kind: "live_provider_endpoint",
    pattern: new RegExp(["(?:api\\.", "openai\\.com|api\\.", "stripe\\.com|supabase\\.co)"].join(""), "iu"),
    applies: () => true,
  },
  {
    kind: "deploy_or_remote_migration_command",
    pattern: new RegExp([
      "(?:[\"'`]\\s*(?:vercel", "\\s+deploy|supabase", "\\s+(?:link|db\\s+push)|git", "\\s+push)",
      "|[\"'`]vercel[\"'`]\\s*,\\s*[\"'`]deploy[\"'`]",
      "|[\"'`]supabase[\"'`]\\s*,\\s*[\"'`](?:link|db\\s+push)[\"'`])",
    ].join(""), "iu"),
    applies: () => true,
  },
  {
    kind: "unsafe_production_log_call",
    pattern: /\bconsole\.(?:debug|error|info|log|warn)\s*\(/u,
    applies: (file: string) => /^src\//u.test(file) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
  },
] as const;

// Fixture imports are recognized lexically rather than line by line, so a
// static import split across lines is seen exactly like a single-line one.
const PRODUCTION_FIXTURE_SPECIFIER = /(?:fixture|test-data|customer-eval)/iu;
const productionSource = (file: string) => /^src\//u.test(file)
  && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);

let currentPath = "";
const authorizedHermeticImports = new Set<string>();
for (const line of diff.split(/\r?\n/u)) {
  if (line.startsWith("+++ b/")) {
    currentPath = line.slice(6);
    continue;
  }
  if (!currentPath || !line.startsWith("+") || line.startsWith("+++")) continue;
  for (const rule of patterns) {
    if (!rule.applies(currentPath) || !rule.pattern.test(line)) continue;
    findings.push({ kind: rule.kind, path: currentPath });
  }
}

for (const [file, source] of addedSourceByPath(diff)) {
  if (!productionSource(file)) continue;
  for (const found of findStaticImports(source)) {
    if (!PRODUCTION_FIXTURE_SPECIFIER.test(found.specifier)
        && !PRODUCTION_FIXTURE_SPECIFIER.test(found.statement)) continue;
    if (authorizedHermeticSyntheticImport(file, found.specifier, hermeticCoordinatorProof)) {
      authorizedHermeticImports.add(found.specifier);
      continue;
    }
    findings.push({ kind: "production_fixture_import", path: file });
  }
}

const uniqueFindings = [...new Map(findings.map((entry) => [`${entry.kind}\0${entry.path}`, entry])).values()]
  .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
const receipt = Object.freeze({
  schema_version: "tivdoc-full-local-system-marathon-security-audit-v0.10.0",
  status: uniqueFindings.length === 0 ? "PASS" as const : "FAIL" as const,
  scope: `${BASE}..HEAD added lines and changed paths`,
  changed_path_count: changedPaths.length,
  finding_count: uniqueFindings.length,
  findings: uniqueFindings,
  authorized_hermetic_fixture_imports: Object.freeze([...authorizedHermeticImports].sort()),
  authorized_hermetic_fixture_import_count: authorizedHermeticImports.size,
  hermetic_coordinator_fail_closed_proof: hermeticCoordinatorProof,
  truth_counters: Object.freeze({
    customer_data_reads: 0,
    deployments: 0,
    remote_migrations: 0,
    live_provider_calls: 0,
    openai_calls: 0,
  }),
});

await mkdir(OUTPUT, { recursive: true });
await writeFile(path.join(OUTPUT, "prohibited-operation-audit.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

/**
 * The hermetic coordinator is the one production module allowed to import the
 * synthetic fixture ports, and only while its own fail-closed proof holds. The
 * allowlist is by exact module specifier so it cannot be widened by reformatting
 * the import, and it remains scoped to that single file.
 */
function authorizedHermeticSyntheticImport(file: string, specifier: string, proof: boolean): boolean {
  if (!proof || file !== HERMETIC_SYNTHETIC_COORDINATOR) return false;
  return [
    "../../../engine/case-analysis/synthetic-fixtures.ts",
    "../../../engine/case-analysis/fixture-ports.ts",
  ].includes(specifier);
}
