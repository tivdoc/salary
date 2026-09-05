// L8-1 / D2. The production closure proof: a production build cannot reach the
// legal engine or the offline shadow — proven by execution, recorded as a
// receipt carrying the build's own hash.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/production-closure/prove.mts
//
// This repository is the live site (tivdoc.com) as well as the legal engine.
// The scattered gates — flags that throw under production, a runtime bootstrap
// that refuses Vercel, an operations panel that 404s without a capability —
// each protect one door. This proof walks every door of one build:
//
//   1. `next build` under VERCEL_ENV=production, NODE_ENV=production and NO
//      Tivdoc flag at all — the environment the live site runs in — and the
//      build's hash is what the receipt is bound to.
//   2. The built server, started under that same environment: the operations
//      routes (legal review, shadow, ground truth, anything) and the portal
//      routes answer one and the same 404 — status, body, headers — and the
//      pages 404 too, while `/` and the health route still answer.
//   3. The gates, executed in this process: the shadow flags throw with any
//      flag on under production; the product route flags read from an empty
//      environment are all off and classify as `disabled`; the internal-ops
//      flags — customer processing, customer shadow, production delivery —
//      default to off; the durable and hermetic runtimes refuse Vercel.
//   4. The build's own module graph: no server bundle carries a marker of the
//      Pool P import path, the selection registrar, the shadow runner or the
//      sensitivity runners, nor the reference-tenant literal; no traced file
//      lies under scripts/.
//   5. Every script entry point, spawned under the production environment,
//      exits 2 with PRODUCTION_ENVIRONMENT_REFUSED before doing anything.
//
// Nothing here touches a database, a provider or the network beyond the
// loopback server it starts and stops. Any failed assertion makes the receipt
// FAIL and the process exit 1; the receipt still records what was seen.
import "../production-refusal.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readOfflineShadowFlags } from "../../src/server/engine/shadow/flags.ts";
import { classifyStableProductRuntime, readStableProductRouteFlags } from "../../src/server/product/routes/flags.ts";
import { readInternalOpsFlags } from "../../src/server/product/internal-ops/flags.ts";
import { durableLocalProductRuntimeEnabled } from "../../src/server/product/runtime/durable-local-config.ts";
import { hermeticBrowserRuntimeBootstrapEnabled } from "../../src/instrumentation.ts";
import { PRODUCT_HTTP_HEADERS } from "../../src/server/product/routes/http-common.ts";
import { guardPosition, listScriptEntryPoints, PRODUCTION_REFUSAL_CODE } from "./entry-points.mjs";

const ROOT = process.cwd();
const RECEIPT_ROOT = path.join(ROOT, "output", "next", "closure");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

type VercelEnvironment = "production" | "preview";
type Check = Readonly<{ environment: VercelEnvironment; name: string; passed: boolean; detail: string }>;
const checks: Check[] = [];
// L9-2 / D2. The proof is a matrix over the two environments a deployment can
// have. `register()` installs the closed projection for VERCEL_ENV=preview as
// well as production, but long run 8 built and probed only production —
// and preview is exactly the environment a branch push creates. Every check
// below runs once per environment, tagged, and the receipt records both.
const ENVIRONMENTS: readonly VercelEnvironment[] = ["production", "preview"];
let currentEnvironment: VercelEnvironment = "production";
const record = (name: string, passed: boolean, detail: unknown) => {
  checks.push(Object.freeze({ environment: currentEnvironment, name, passed, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }));
  process.stdout.write(`${passed ? "PASS" : "FAIL"} [${currentEnvironment}] ${name} — ${checks.at(-1)!.detail.slice(0, 200)}\n`);
};

/** The deployment environment: the system's own variables and nothing of Tivdoc's; NODE_ENV=production and the VERCEL_ENV under proof. */
function productionEnvironment(port?: number, vercelEnv: VercelEnvironment = currentEnvironment): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "WINDIR", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramData", "COMSPEC"]) {
    if (process.env[key]) kept[key] = process.env[key];
  }
  return { ...kept, NODE_ENV: "production", VERCEL_ENV: vercelEnv, ...(port ? { PORT: String(port) } : {}) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("CLOSURE_PORT_UNAVAILABLE"))));
    });
  });
}

/** A content hash of the build's server output: every file's hash, in path order. */
function buildHash(): { build_id: string; server_tree_sha256: string; server_files: number } {
  const buildId = readFileSync(path.join(ROOT, ".next", "BUILD_ID"), "utf8").trim();
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else files.push(full); } };
  walk(path.join(ROOT, ".next", "server"));
  files.sort();
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${path.relative(ROOT, file).split(path.sep).join("/")}\0${sha256(readFileSync(file))}\n`);
  return { build_id: buildId, server_tree_sha256: digest.digest("hex"), server_files: files.length };
}

async function probe(port: number, route: string, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) if (!["date", "connection", "keep-alive", "vary", "x-nextjs-cache", "etag", "x-powered-by"].includes(key)) headers[key] = value;
    return { status: response.status, body: await response.text(), headers };
  } catch (error) {
    return { status: 0, body: String((error as Error).message), headers: {} };
  }
}

type EnvironmentResult = Readonly<{ vercel_env: VercelEnvironment; build: ReturnType<typeof buildHash> | null; entry_points_spawned: number }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const startedAt = new Date().toISOString();
  const results: EnvironmentResult[] = [];
  for (const environment of ENVIRONMENTS) {
    currentEnvironment = environment;
    results.push(await runEnvironment(environment));
  }
  finish(startedAt, results);
}

async function runEnvironment(environment: VercelEnvironment): Promise<EnvironmentResult> {
  // --- 1. The build, under the deployment environment.
  const buildEnvironment = productionEnvironment();
  const build = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { cwd: ROOT, env: buildEnvironment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(path.join(RECEIPT_ROOT, `build.${environment}.log`), `${build.stdout ?? ""}\n${build.stderr ?? ""}`, "utf8");
  record("build_under_production_environment", build.status === 0, { exit: build.status, vercel_env: environment, tivdoc_flags_in_env: Object.keys(buildEnvironment).filter((key) => key.startsWith("TIVDOC_")).length });
  if (build.status !== 0) return { vercel_env: environment, build: null, entry_points_spawned: 0 };
  const hash = buildHash();
  record("build_hash_recorded", /^[a-f0-9]{64}$/u.test(hash.server_tree_sha256), hash);

  // --- 4. The build's module graph, before the server is even started.
  const markers = ["tivdoc_pool_p_import", "importPoolPBatch(", "tivdoc_l76_draft_shadow", "tivdoc_e37_sensitivity", "tivdoc_l710_sensitivity", "L76_ENV_MISSING", "E37_ENV_MISSING", "POOL_P_ENV_MISSING", "governance_legal_instrument_selection_register", "legal.reference.il"];
  const bundleHits: Record<string, string[]> = {};
  const scriptModules: string[] = [];
  const traced = new Set<string>();
  const walkServer = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walkServer(full); continue; }
      if (name.endsWith(".nft.json")) {
        const trace = JSON.parse(readFileSync(full, "utf8")) as { files?: string[] };
        for (const file of trace.files ?? []) {
          // Only a file inside THIS repository counts, and never the build or its dependencies.
          const resolved = path.resolve(path.dirname(full), file);
          if (!resolved.startsWith(ROOT + path.sep)) continue;
          const relative = path.relative(ROOT, resolved).split(path.sep).join("/");
          if (relative.startsWith("node_modules/") || relative.startsWith(".next/")) continue;
          traced.add(relative);
        }
        continue;
      }
      if (!name.endsWith(".js")) continue;
      const text = readFileSync(full, "utf8");
      for (const marker of markers) if (text.includes(marker)) (bundleHits[marker] ??= []).push(path.relative(ROOT, full).split(path.sep).join("/"));
      // Turbopack names every module it bundles by its project path; a script bundled into the server would appear here.
      if (text.includes("[project]/scripts/")) scriptModules.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  };
  walkServer(path.join(ROOT, ".next", "server"));
  record("module_graph_carries_no_script_or_reference_tenant_marker", Object.keys(bundleHits).length === 0 && scriptModules.length === 0, { markers_searched: markers.length, hits: bundleHits, chunks_bundling_a_script_module: scriptModules });

  // --- 4b. The deployment file trace. Beside the module graph, the build's
  // tracer copies every EXISTING file that a string in the graph names — an
  // evidence contract naming a receipt under output/, the entry-point
  // inventory naming a script. Before this run it copied the whole working
  // directory (a font read and an evidence root were spelled beside
  // `process.cwd()`); now it names what the data names. Two things are
  // asserted about it. A file deploys only if git tracks it, so nothing
  // tracked may be customer material or a local evidence tree; and every
  // script the trace names is a data reference — no chunk bundles it — that
  // refuses a production environment if it is an entry point at all.
  const trackedList = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tracked = new Set((trackedList.stdout ?? "").split("\0").filter((entry) => entry !== ""));
  const tracedList = [...traced].sort();
  const localOnly = tracedList.filter((file) => !tracked.has(file));
  const customerPattern = /(^|\/)(eval\/customer-payslips|eval\/real-payslips|customer-payslips|tmp)\//u;
  const customerNamed = tracedList.filter((file) => customerPattern.test(file));
  const customerTracked = customerNamed.filter((file) => tracked.has(file));
  record("deployment_trace_carries_no_customer_material_that_could_deploy", trackedList.status === 0 && customerTracked.length === 0, {
    traced_in_repository: tracedList.length, git_tracked: tracedList.length - localOnly.length, local_only_cannot_deploy: localOnly.length,
    customer_paths_named_by_local_evidence: customerNamed.length, customer_paths_tracked: customerTracked,
  });
  const scriptsTraced = tracedList.filter((file) => file.startsWith("scripts/"));
  const entryPoints = new Set(listScriptEntryPoints(ROOT));
  const scriptsUnguarded = scriptsTraced.filter((file) => entryPoints.has(file) && !guardPosition(ROOT, file).first_is_guard);
  record("scripts_in_the_deployment_trace_are_data_references_that_refuse_production", scriptModules.length === 0 && scriptsUnguarded.length === 0, {
    scripts_named: scriptsTraced, bundled_as_modules: scriptModules, entry_points_among_them: scriptsTraced.filter((file) => entryPoints.has(file)), unguarded: scriptsUnguarded,
  });

  // --- 2. The built server under the same environment: one 404 shape.
  const port = await freePort();
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: ROOT, env: productionEnvironment(port), stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  server.stdout?.on("data", (chunk) => log.push(String(chunk)));
  server.stderr?.on("data", (chunk) => log.push(String(chunk)));
  try {
    let up = false;
    for (let attempt = 0; attempt < 120 && !up; attempt += 1) {
      const health = await probe(port, "/api/health");
      if (health.status > 0) up = true; else await delay(1_000);
    }
    record("server_started_under_production_environment", up, { port, vercel_env: environment });
    if (!up) return { vercel_env: environment, build: hash, entry_points_spawned: 0 };

    // Every legal, shadow, portal and operations dispatcher, each with a method it declares.
    const closed = [
      ["/api/operations/legal-review/queue", "GET"], ["/api/operations/legal-review/topics", "GET"], ["/api/operations/shadow/summary", "GET"],
      ["/api/operations/ground-truth/queue", "GET"], ["/api/operations/anything-at-all", "GET"], ["/api/operations/legal-review/actions", "POST"],
      ["/api/operations/session", "POST"], ["/api/operations/session", "DELETE"],
      ["/api/portal/session", "POST"], ["/api/portal/session", "DELETE"], ["/api/portal/cases", "GET"], ["/api/portal/anything-at-all", "POST"],
    ] as const;
    const responses = await Promise.all(closed.map(async ([route, method]) => ({ route, method, ...(await probe(port, route, method)) })));
    const shapes = new Set(responses.map((response) => JSON.stringify({ status: response.status, body: response.body, headers: response.headers })));
    record("closed_api_routes_answer_one_404_shape", responses.every((response) => response.status === 404 && response.body === "") && shapes.size === 1,
      { routes: responses.map((response) => `${response.method} ${response.route}=${response.status}:${response.body.length}b`), distinct_shapes: shapes.size, headers: responses[0]?.headers ?? {} });
    // The product's own refusal headers are what the handler sets; next.config's global
    // headers are layered on top by the framework. What matters is that the set is one
    // and the same on every closed route, which the shape check above already proves;
    // the merged headers are recorded, not asserted, so a framework change shows up here.
    const productHeadersSeen = Object.keys(PRODUCT_HTTP_HEADERS).filter((key) => responses[0]?.headers[key] !== undefined);
    record("closed_api_routes_carry_refusal_headers", productHeadersSeen.length === Object.keys(PRODUCT_HTTP_HEADERS).length, { present: productHeadersSeen, merged: responses[0]?.headers ?? {} });
    // Paths outside the app's routes answer the framework's own 404, recorded for completeness.
    const unrouted = await Promise.all(["/api/portal-v07/cases", "/api/internal-ops-v07/cases"].map(async (route) => ({ route, ...(await probe(port, route)) })));
    record("paths_outside_the_app_answer_the_framework_404", unrouted.every((response) => response.status === 404), unrouted.map((response) => `${response.route}=${response.status}:${response.body.length}b`));

    const pages = await Promise.all(["/operations", "/portal", "/internal-ops-v07"].map(async (route) => ({ route, ...(await probe(port, route)) })));
    record("legal_pages_answer_404", pages.every((page) => page.status === 404), pages.map((page) => `${page.route}=${page.status}`));
    const open = await Promise.all(["/", "/privacy", "/terms", "/robots.txt", "/sitemap.xml", "/api/health"].map(async (route) => ({ route, ...(await probe(port, route)) })));
    record("the_public_pages_and_health_still_answer", open.every((page) => page.status === 200), open.map((page) => `${page.route}=${page.status}`));
    // The customer funnel and the payments routes are CUSTOMER_PROCESSING_DISABLED on this
    // branch by the inventory's own classification: closed, with the same 404, never 500.
    // tivdoc.com serves main; this branch is not deployable as the live business until
    // customer processing is authorised, and this check records that rather than hiding it.
    const business = await Promise.all(([
      ["/check", "GET"], ["/check/upload", "GET"], ["/api/cases", "POST"], ["/api/cases/resume", "GET"], ["/api/cases/status", "GET"],
      ["/api/documents/sign", "POST"], ["/api/documents/complete", "POST"], ["/api/funnel/session", "POST"],
      ["/api/payments/start", "POST"], ["/api/payments/return", "GET"], ["/api/payments/reconcile", "POST"],
    ] as const).map(async ([route, method]) => ({ route, method, ...(await probe(port, route, method)) })));
    record("customer_processing_and_payments_are_closed_on_this_branch", business.every((row) => row.status === 404),
      { routes: business.map((row) => `${row.method} ${row.route}=${row.status}`), deployable_as_live_site: false, reason: "CUSTOMER_PROCESSING_DISABLED; tivdoc.com serves main" });
  } finally {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) server.kill("SIGKILL");
    writeFileSync(path.join(RECEIPT_ROOT, `server.${environment}.log`), log.join("").slice(-20_000), "utf8");
  }

  // --- 3. The gates, executed here.
  const throws = (fn: () => unknown): string | null => { try { fn(); return null; } catch (error) { return (error as Error).message; } };
  record("shadow_flags_throw_under_production_with_any_flag_on", [
    throws(() => readOfflineShadowFlags({ TIVDOC_OFFLINE_SHADOW_ENABLED: "1" }, "production")),
    throws(() => readOfflineShadowFlags({ TIVDOC_SYNTHETIC_SHADOW_ENABLED: "true" }, "production")),
    throws(() => readOfflineShadowFlags({ TIVDOC_PUBLIC_SHADOW_ENABLED: "1" }, "production")),
  ].every((message) => message === "SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION"), "three flags, three throws");
  const shadowDefault = readOfflineShadowFlags({}, "production");
  record("shadow_flags_default_off", !shadowDefault.enabled && !shadowDefault.synthetic_enabled && !shadowDefault.public_enabled, shadowDefault);
  const routeFlags = readStableProductRouteFlags({ VERCEL_ENV: environment, NODE_ENV: "production" });
  record("product_route_flags_default_off_and_classify_disabled", !Object.values(routeFlags).some(Boolean) && classifyStableProductRuntime({ VERCEL_ENV: environment }, routeFlags) === "disabled", routeFlags);
  record("product_route_flags_refuse_vercel_when_on", throws(() => classifyStableProductRuntime({ VERCEL_ENV: environment }, { portalUi: true, portalApi: true, operationsUi: true, operationsApi: true })) === "STABLE_PRODUCT_REMOTE_RUNTIME_FORBIDDEN", "");
  const opsFlags = readInternalOpsFlags({}, "production");
  record("customer_processing_customer_shadow_and_delivery_default_off", !opsFlags.TIVDOC_CUSTOMER_PROCESSING_ENABLED && !opsFlags.TIVDOC_CUSTOMER_SHADOW_ENABLED && !opsFlags.TIVDOC_PRODUCTION_DELIVERY_ENABLED && !Object.values(opsFlags).some(Boolean), opsFlags);
  record("synthetic_ops_flags_throw_under_production", throws(() => readInternalOpsFlags({ TIVDOC_SYNTHETIC_OPS_ENABLED: "1" }, "production")) !== null, "");
  record("durable_runtime_refuses_vercel", throws(() => durableLocalProductRuntimeEnabled({ TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1", VERCEL_ENV: environment }, "nodejs")) === "DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN"
    && durableLocalProductRuntimeEnabled({ VERCEL_ENV: environment }, "nodejs") === false, "");
  record("hermetic_runtime_refuses_vercel", throws(() => hermeticBrowserRuntimeBootstrapEnabled({ TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "1", NODE_ENV: "test", VERCEL_ENV: environment }, "nodejs")) === "BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN"
    && hermeticBrowserRuntimeBootstrapEnabled({ VERCEL_ENV: environment }, "nodejs") === false, "");

  // --- 5. Every script entry point refuses, by execution.
  const entries = listScriptEntryPoints(ROOT);
  const unguarded = entries.filter((entry) => !guardPosition(ROOT, entry).first_is_guard);
  record("every_entry_point_carries_the_guard_first", unguarded.length === 0, { entry_points: entries.length, unguarded });
  const python = spawnSync("python", ["--version"], { cwd: tmpdir(), encoding: "utf8" });
  const pythonAvailable = python.status === 0;
  const refusals: Array<{ entry: string; exit: number | null; refused: boolean }> = [];
  for (const entry of entries) {
    const isPython = entry.endsWith(".py");
    if (isPython && !pythonAvailable) { refusals.push({ entry, exit: null, refused: false }); continue; }
    const result = isPython
      ? spawnSync("python", [path.join(ROOT, entry)], { cwd: tmpdir(), env: productionEnvironment(), encoding: "utf8", timeout: 60_000 })
      : spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", entry], { cwd: ROOT, env: productionEnvironment(), encoding: "utf8", timeout: 60_000 });
    refusals.push({ entry, exit: result.status, refused: result.status === 2 && String(result.stderr).includes(PRODUCTION_REFUSAL_CODE) });
  }
  const notRefused = refusals.filter((row) => !row.refused);
  record("every_entry_point_refuses_by_execution", notRefused.length === 0, { spawned: refusals.length, python_available: pythonAvailable, not_refused: notRefused.slice(0, 20) });

  return { vercel_env: environment, build: hash, entry_points_spawned: refusals.length };
}

function finish(startedAt: string, results: readonly EnvironmentResult[]): void {
  const failed = checks.filter((check) => !check.passed);
  const content = {
    schema_version: "tivdoc-production-closure-receipt-v2",
    unit: "L8-1 / D2; L9-2 / D2 (two environments)",
    status: failed.length === 0 && results.length === ENVIRONMENTS.length ? "PASS" : "FAIL",
    environments: results.map((result) => ({
      NODE_ENV: "production", VERCEL_ENV: result.vercel_env, tivdoc_flags: "none",
      build: result.build,
      checks_total: checks.filter((check) => check.environment === result.vercel_env).length,
      checks_failed: checks.filter((check) => check.environment === result.vercel_env && !check.passed).map((check) => check.name),
      entry_points_spawned: result.entry_points_spawned,
    })),
    // The identical posture in both environments: the same check names pass in both, and the two builds are distinct builds.
    identical_posture: ENVIRONMENTS.every((environment) => checks.filter((check) => check.environment === environment && check.passed).map((check) => check.name).join(",")
      === checks.filter((check) => check.environment === "production" && check.passed).map((check) => check.name).join(",")),
    checks,
    checks_total: checks.length,
    checks_failed: failed.map((check) => `${check.environment}:${check.name}`),
    entry_points_spawned: results.reduce((sum, result) => sum + result.entry_points_spawned, 0),
    counters: { live_provider_calls: 0, openai_calls: 0, database_connections: 0, deployments: 0 },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  const receipt = { ...content, receipt_sha256: sha256(JSON.stringify(content)) };
  writeFileSync(path.join(RECEIPT_ROOT, "production-closure-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`PRODUCTION_CLOSURE ${JSON.stringify({ status: receipt.status, environments: results.map((result) => `${result.vercel_env}:${result.build?.server_tree_sha256?.slice(0, 16) ?? null}`), checks: checks.length, failed: failed.map((check) => `${check.environment}:${check.name}`), identical_posture: content.identical_posture, receipt_sha256: receipt.receipt_sha256 })}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
