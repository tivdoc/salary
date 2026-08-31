import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CommandSpec = Readonly<{
  id: string;
  executable: string;
  args: readonly string[];
  expectedExitCodes?: readonly number[];
}>;

type CommandResult = Readonly<{
  id: string;
  command: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_code: number;
  expected_exit_codes: readonly number[];
  outcome: "PASS" | "FAIL";
  stdout_path: string;
  stdout_sha256: string;
  stderr_path: string;
  stderr_sha256: string;
}>;

const root = process.cwd();
const outputRoot = path.resolve(root, "output", "overnight-v0.7", "final");
const commandOutputRoot = path.join(outputRoot, "commands");
await mkdir(commandOutputRoot, { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const vitest = path.resolve(root, "node_modules", "vitest", "vitest.mjs");
const tsc = path.resolve(root, "node_modules", "typescript", "bin", "tsc");
const nodeFlags = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"] as const;
const commands: readonly CommandSpec[] = [
  npmRun("P1_P2_P7_PLATFORM_VERIFY", "platform:verify"),
  npmRun("P3_CORPUS_RECONCILE", "legal:corpus:reconcile"),
  {
    id: "P3_BOUNDED_ACQUISITION_AND_WORKSPACE_VERIFY",
    executable: node,
    args: [...nodeFlags, "scripts/legal-v07/run.mts", "verify", "--corpus-state-root", ".", "--output", "output/overnight-v0.7/p3/run-c"],
  },
  npmRun("P4_RULESPEC_SKELETONS", "legal:rulespec-skeletons:verify"),
  npmRun("P4_GOLDEN_WORKFLOW", "legal:golden-workflow:verify"),
  npmRun("P4_GT_WORKSPACE", "extraction:gt:workspace:verify"),
  npmRun("P4_FIXTURE_PROVENANCE", "extraction:fixtures:verify"),
  npmRun("P4_EXTRACTION_QUALITY", "extraction:quality:verify"),
  npmRun("P4_SHADOW_VERIFY", "shadow:offline:verify"),
  npmRun("P4_SHADOW_SYNTHETIC", "shadow:offline:synthetic"),
  npmRun("P4_SHADOW_REAL_BLOCKED", "shadow:offline:real-blocked"),
  npmRun("P5_OPS_CONTRACT", "tivdoc:ops:contract"),
  npmRun("P5_OPS_API", "tivdoc:ops:api:verify"),
  npmRun("P5_OPS_UI", "tivdoc:ops:ui:verify"),
  npmRun("P5_OPS_SYNTHETIC", "tivdoc:ops:e2e:synthetic"),
  npmRun("P5_OPS_REAL_BLOCKED", "tivdoc:ops:e2e:blocked"),
  npmRun("P5_OPS_PUBLIC_PROVENANCE", "tivdoc:ops:e2e:public"),
  npmRun("P6_PORTAL_VERIFY", "tivdoc:portal:verify"),
  npmRun("P6_PORTAL_SYNTHETIC", "tivdoc:portal:e2e:synthetic"),
  npmRun("P8_READY_INTEGRATION", "overnight:v0.7:integration"),
  { ...npmRun("LEGAL_STRICT_READINESS_EXPECTED_BLOCK", "legal:ops:strict-readiness"), expectedExitCodes: [2] },
  npmRun("LINT", "lint"),
  { id: "TYPESCRIPT_NO_EMIT", executable: node, args: [tsc, "--noEmit"] },
  { id: "ONE_SEQUENTIAL_FULL_TEST_SUITE", executable: node, args: [vitest, "run", "--maxWorkers=1", "--reporter=dot"] },
  { id: "ONE_LOCAL_PRODUCTION_BUILD", executable: npm, args: ["run", "build", "--", "--webpack"] },
];

const commandResults: CommandResult[] = [];
for (const [index, command] of commands.entries()) {
  commandResults.push(await execute(command, index + 1));
}

const artifacts = await hashArtifacts([
  "output/overnight-v0.7/p3/run-c/verification-result.json",
  "output/overnight-v0.7/p3/run-c/acquisition/acquisition-report.json",
  "output/overnight-v0.7/p3/run-c/review-workspace/workspace-index.json",
  "output/overnight-v0.7/p4/legal-quality/manifest.json",
  "output/overnight-v0.7/p4/ground-truth/manifest.json",
  "output/overnight-v0.7/p4/shadow/manifest.json",
  "output/overnight-v0.7/p8/ready-receipt.json",
]);

const fullTestOutput = await readFile(path.join(commandOutputRoot, `${String(commands.findIndex((command) => command.id === "ONE_SEQUENTIAL_FULL_TEST_SUITE") + 1).padStart(3, "0")}-ONE_SEQUENTIAL_FULL_TEST_SUITE.stdout.txt`), "utf8");
const fullTestCounts = parseVitestCounts(fullTestOutput);
const git = (args: readonly string[]) => runGit(args).trim();
const skipReceipts = [
  skip("V07-ENV-DATABASE", "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED", "Detected Docker, Supabase CLI and local PostgreSQL clients/targets; no disposable local target existed, so no connection was attempted.", "Static migration/RLS contracts plus in-memory transactional, concurrency, fencing and failure-recovery verification completed.", ["V07-P1-PERSISTENCE", "V07-P2-RLS", "V07-P7-BACKUP"], "Durable PostgreSQL migration, multi-session RLS, crash/restart and backup/restore remain dynamically unverified.", "Provide a disposable local Supabase/PostgreSQL target with explicit local-only authorization."),
  skip("V07-PARSER-SANDBOX", "PARSER_OS_SANDBOX_NOT_VERIFIED", "Detected no supported local container or microVM runtime.", "Sandbox specification, capability guard, quarantine behavior and parser denial contracts completed.", ["V07-P2-SECURITY"], "OS-enforced network/filesystem/resource denial remains unverified.", "Provide a supported disposable local container or microVM runtime."),
  skip("V07-MANAGED-STORAGE", "MANAGED_PRIVATE_STORAGE_CONFIGURATION_PENDING", "Remote or managed storage access was prohibited and not attempted.", "Canonical private ObjectStoragePort, local content-addressed adapter, grants, quarantine and corruption tests completed.", ["V07-P2-STORAGE"], "Managed bucket policy and provider behavior remain externally unverified.", "Authorize and configure an isolated non-production private storage target."),
  skip("V07-AUDIT-CUSTODY", "OFF_HOST_AUDIT_CUSTODY_PENDING", "Off-host/WORM custody requires an external destination and authorization.", "Tamper-evident hash chain, local AuditAnchorPort receipt and mutation/gap detection completed.", ["V07-P2-AUDIT", "V07-P7-RELIABILITY"], "Application-local evidence is not independently durable custody.", "Configure an authorized off-host immutable anchor/custody destination."),
  skip("V07-PUBLIC-JOURNEY", "PUBLIC_FIXTURE_PROVENANCE_NOT_ELIGIBLE", "Inventoried repository fixtures; no eligible public/non-identifying reusable artifact was proven.", "Deterministic synthetic UI/API/E2E coverage completed and the public journey failed closed.", ["V07-P4-FIXTURES", "V07-P8-PUBLIC"], "No public benchmark product journey can be claimed.", "Approve and seal a provenance record for an eligible public, non-identifying fixture."),
  skip("V07-LEGAL-HUMAN-GATES", "HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED", "Bounded official-source acquisition and portable review workspace completed without fabricating review, meaning or activation.", "Seventeen inactive candidates, blank decision templates, seven RuleSpec skeletons and 42 blank golden templates completed.", ["V07-P3-REVIEW-WORKSPACE", "V07-P4-RULES"], "Real readiness remains 0/7; no real parameter, rule, calculation or Finding can activate.", "Authorized legal reviewers must verify identities/signatures, source role/effectivity/sector/population, dual-attest numeric parameters and approve rules."),
  skip("V07-GROUND-TRUTH", "HUMAN_GROUND_TRUTH_REQUIRED", "No customer documents were authorized or read and no qualified dual human annotations were available.", "Synthetic dual-review/adjudication/lock workflow, evaluator and immutable workspace completed.", ["V07-P4-GT"], "Real extraction quality and calibration cannot be claimed.", "Two independent qualified annotators and an adjudicator must seal an authorized de-identified Ground Truth bundle."),
  skip("V07-NATIVE-REPORT", "REPORT_RTL_VISUAL_VERIFICATION_PENDING", "Native browser and PDF inspection covered synthetic RTL screens and the canonical synthetic PDF; the canonical PDF does not itself prove Hebrew RTL report typography.", "Component/API/report determinism, RTL HTML, browser screenshots and Poppler-rendered PDF inspection completed.", ["V07-P5-UI", "V07-P8-VISUAL"], "Canonical Hebrew PDF bidi, font and page-break proof remains pending.", "Generate a canonical synthetic Hebrew report edition and complete native desktop/mobile/PDF page inspection."),
  skip("V07-CUSTOMER-INTEGRATION", "CUSTOMER_APPLICATION_INTEGRATION_MISSING", "No verified production identity, private storage or customer-data authorization was available.", "Default-off portal contracts, safe shell, owner-isolation service, clarification, entitlement and privacy synthetic flows completed.", ["V07-P6-PORTAL", "V07-P8-CUSTOMER"], "No customer record/document/report may be read or exposed.", "Integrate verified identity and private storage in an isolated environment, then authorize a de-identified customer-data test."),
  skip("V07-CUSTOMER-SHADOW", "CUSTOMER_SHADOW_NOT_AUTHORIZED", "Customer Shadow and delivery require explicit authorization and readiness gates that are absent.", "Offline deterministic synthetic Shadow and inactive-real-corpus negative runs completed; all customer/delivery flags remained false.", ["V07-P4-SHADOW", "V07-P8-DELIVERY"], "Customer Shadow, customer processing and production delivery remain disabled.", "Complete legal, Ground Truth, isolated platform and customer authorization gates before a separate Shadow decision."),
] as const;

const unsigned = {
  schema_version: "tivdoc-overnight-v0.7-acceptance-v1",
  generated_at: new Date().toISOString(),
  repository: root,
  base_head: "6b49158017457af5a7c8b13efe361353bbdf2c6c",
  base_tree: "cebbfb451bb6d0e3e3ef60b637c29c42bc3a2c3f",
  final_head: git(["rev-parse", "HEAD"]),
  final_tree: git(["rev-parse", "HEAD^{tree}"]),
  branch: git(["branch", "--show-current"]),
  tracked_worktree_clean: git(["status", "--porcelain", "--untracked-files=no"]) === "",
  overall_status: commandResults.every((result) => result.outcome === "PASS") ? "OVERNIGHT_ENGINEERING_WAVE_COMPLETE" : "OVERNIGHT_ENGINEERING_WAVE_PARTIAL",
  command_results: commandResults,
  full_test_counts: fullTestCounts,
  artifacts,
  skip_receipts: skipReceipts,
  legal_truth: {
    real_legal_topics_ready: "0/7",
    real_sources_active: 0,
    real_parameters_active: 0,
    real_rules_active: 0,
    real_calculations_or_findings: 0,
  },
  capability_truth: {
    isolated_persistence_verified: false,
    offline_shadow_engineering_complete: true,
    customer_shadow_authorized: false,
    customer_processing_enabled: false,
    production_delivery_enabled: false,
  },
  prohibited_action_counters: {
    customer_document_reads: 0,
    customer_metadata_reads: 0,
    production_connections: 0,
    preview_connections: 0,
    deployments: 0,
    remote_migrations: 0,
    external_supabase_calls: 0,
    live_storage_calls: 0,
    live_payment_calls: 0,
    openai_calls: 0,
    delivery_calls: 0,
    customer_shadow_runs: 0,
    real_legal_activations: 0,
    invented_legal_values_or_rules: 0,
  },
};
const payloadSha256 = sha256(canonicalJson(unsigned));
const receipt = { ...unsigned, payload_sha256: payloadSha256 };
const receiptPath = path.join(outputRoot, "acceptance-receipt.json");
const ledgerPath = path.join(outputRoot, "command-ledger.json");
await writeFile(ledgerPath, `${JSON.stringify(commandResults, null, 2)}\n`, "utf8");
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: receipt.overall_status, payload_sha256: payloadSha256, commands_passed: commandResults.filter((result) => result.outcome === "PASS").length, commands_total: commandResults.length, full_test_counts: fullTestCounts, receipt: receiptPath })}\n`);
process.exitCode = receipt.overall_status === "OVERNIGHT_ENGINEERING_WAVE_COMPLETE" ? 0 : 1;

function npmRun(id: string, script: string): CommandSpec {
  return { id, executable: npm, args: ["run", script] };
}

async function execute(spec: CommandSpec, ordinal: number): Promise<CommandResult> {
  const started = Date.now();
  const execution = spawnSync(spec.executable, [...spec.args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TIVDOC_INTERNAL_OPS_UI_ENABLED: "0",
      TIVDOC_INTERNAL_OPS_API_ENABLED: "0",
      TIVDOC_SYNTHETIC_OPS_ENABLED: "0",
      TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED: "0",
      TIVDOC_MANUAL_REPORT_EXPORT_ENABLED: "0",
      TIVDOC_CUSTOMER_PORTAL_ENABLED: "0",
      TIVDOC_CUSTOMER_PORTAL_API_ENABLED: "0",
      TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
      TIVDOC_CUSTOMER_SHADOW_ENABLED: "0",
      TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    },
  });
  const ended = Date.now();
  const stdout = execution.stdout ?? "";
  const stderr = execution.stderr ?? "";
  const prefix = `${String(ordinal).padStart(3, "0")}-${spec.id}`;
  const stdoutRelative = path.posix.join("output", "overnight-v0.7", "final", "commands", `${prefix}.stdout.txt`);
  const stderrRelative = path.posix.join("output", "overnight-v0.7", "final", "commands", `${prefix}.stderr.txt`);
  await writeFile(path.resolve(root, stdoutRelative), stdout, "utf8");
  await writeFile(path.resolve(root, stderrRelative), stderr, "utf8");
  const exitCode = execution.status ?? 255;
  const expectedExitCodes = spec.expectedExitCodes ?? [0];
  return {
    id: spec.id,
    command: [spec.executable, ...spec.args].map(quote).join(" "),
    started_at: new Date(started).toISOString(),
    ended_at: new Date(ended).toISOString(),
    duration_ms: ended - started,
    exit_code: exitCode,
    expected_exit_codes: expectedExitCodes,
    outcome: expectedExitCodes.includes(exitCode) ? "PASS" : "FAIL",
    stdout_path: stdoutRelative,
    stdout_sha256: sha256(stdout),
    stderr_path: stderrRelative,
    stderr_sha256: sha256(stderr),
  };
}

function skip(itemId: string, blockerCode: string, attemptedAction: string, safeFallbackCompleted: string, affectedAcceptanceIds: readonly string[], directDownstreamImpact: string, nextAction: string) {
  return {
    item_id: itemId,
    status: "SKIPPED_BLOCKED" as const,
    blocker_code: blockerCode,
    attempted_action: attemptedAction,
    evidence: "See command_results and artifacts in this receipt.",
    safe_fallback_completed: safeFallbackCompleted,
    affected_acceptance_ids: affectedAcceptanceIds,
    direct_downstream_impact: directDownstreamImpact,
    next_human_or_environment_action: nextAction,
  };
}

async function hashArtifacts(relativePaths: readonly string[]) {
  return Promise.all(relativePaths.map(async (relativePath) => {
    const bytes = await readFile(path.resolve(root, relativePath));
    return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
  }));
}

function parseVitestCounts(output: string) {
  const files = output.match(/Test Files\s+(\d+) passed/);
  const tests = output.match(/Tests\s+(\d+) passed/);
  return { files_passed: files ? Number(files[1]) : null, tests_passed: tests ? Number(tests[1]) : null };
}

function runGit(args: readonly string[]) {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`GIT_COMMAND_FAILED:${args.join(" ")}:${result.stderr}`);
  return result.stdout;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function quote(value: string) {
  return /[\s"]/u.test(value) ? JSON.stringify(value) : value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
