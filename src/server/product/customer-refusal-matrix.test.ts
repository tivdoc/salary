// L8-6 / D6. Customer Shadow stays shut, and this is the matrix of what
// keeps it shut: every route, flag, capability, schema, service gate, script
// lane and storage constraint that would have to change for customer payslip
// data to enter the legal engine — each one exercised here, today, and each
// one refusing. A row that stops refusing fails the suite; a row that is
// removed fails the pinned count. The matrix is the inventory of the change
// that authorizing customer data would be, so that change cannot happen by
// drift.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { durableShadowRunEnvelopeSchema } from "../engine/shadow/durable-contracts.ts";
import { DurableOfflineShadowScheduler } from "../engine/shadow/durable-scheduler.ts";
import { buildDurableSyntheticShadowEnvelope } from "../engine/shadow/durable-synthetic-fixtures.ts";
import { readOfflineShadowFlags } from "../engine/shadow/flags.ts";
import { OfflineShadowControlPlane } from "../engine/shadow/control-plane.ts";
import { buildSyntheticShadowDefinition, SyntheticMechanicsShadowEvaluator } from "../engine/shadow/synthetic-fixtures.ts";
import { installClosedProductionRuntime } from "../platform/capabilities/closed-production-runtime.ts";
import { routeAssignmentOf } from "../platform/capabilities/route-split.ts";
import { resetStableEntrypointRuntimeForTests, resolveStableEntrypointRuntime } from "../platform/capabilities/stable-entrypoint-runtime.ts";
import { buildSystemCapabilityProjection, SYSTEM_CAPABILITY_SCHEMA_VERSION } from "../platform/capabilities/system-capabilities.ts";
import { LocalRuntimePrivateBlobProvider } from "../platform/storage/local-runtime/private-blob-provider.ts";
import { INTERNAL_OPS_SCHEMA_VERSION } from "./internal-ops/contracts.ts";
import { disabledInternalOpsFlags, readInternalOpsFlags } from "./internal-ops/flags.ts";
import { InternalOpsError, InternalOpsService } from "./internal-ops/service.ts";
import { createSyntheticOpsFixture } from "./internal-ops/synthetic-test-fixture.ts";
import { refusedEntrypoint } from "./routes/http-common.ts";
import { classifyStableProductRuntime, readStableProductRouteFlags } from "./routes/flags.ts";
import { DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL, durableLocalProductRuntimeEnabled } from "./runtime/durable-local-config.ts";
import { WAVE3_TOPICS } from "../../engine/wave3/contracts.ts";
import { hermeticBrowserRuntimeBootstrapEnabled } from "../../instrumentation.ts";

/** A durable local environment that passes every other startup check, so the customer-flag guard is what refuses. */
function durableEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1", TIVDOC_DURABLE_PRODUCT_RUNTIME_SENTINEL: DURABLE_LOCAL_PRODUCT_RUNTIME_SENTINEL,
    TIVDOC_RUNTIME_TARGET: "local_only", TIVDOC_PRODUCT_PERSISTENCE_MODE: "isolated_postgres", TIVDOC_DURABLE_IDENTITY_ENABLED: "1", TIVDOC_PRIVATE_STORAGE_ENABLED: "1",
    TIVDOC_PORTAL_UI_ENABLED: "1", TIVDOC_PORTAL_API_ENABLED: "1", TIVDOC_OPERATIONS_UI_ENABLED: "1", TIVDOC_OPERATIONS_API_ENABLED: "1",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0", TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0", TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0", TIVDOC_OPENAI_LIVE_TESTS: "0",
    NODE_ENV: "development", ...overrides,
  };
}

type Row = Readonly<{
  id: string;
  kind: "route" | "flag" | "capability" | "schema" | "service" | "script" | "storage" | "fixture";
  surface: string;
  /** What would have to change for customer data to enter through this surface. */
  would_have_to_change: string;
  /** The refusal observed today: a code, a status, or a count. */
  refuses: () => string | Promise<string>;
  expected: string;
}>;

function thrown(work: () => unknown): string {
  try { work(); return "NO_THROW"; } catch (error) { return (error as Error).message; }
}
async function thrownAsync(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return "NO_THROW"; } catch (error) { return (error as Error).message; }
}
function git(args: string[]): string {
  return spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
}

/** The customer funnel and payments dispatchers, by inventory id and method. */
const CUSTOMER_ROUTES: ReadonlyArray<readonly [string, string, string]> = [
  ["CEP-002", "GET", "/check"], ["CEP-003", "GET", "/check/upload"], ["CEP-004", "GET", "/check/payment"], ["CEP-005", "GET", "/check/received"],
  ["CEP-013", "POST", "/api/cases"], ["CEP-014", "GET", "/api/cases/resume"], ["CEP-015", "GET", "/api/cases/status"],
  ["CEP-016", "POST", "/api/documents/sign"], ["CEP-017", "POST", "/api/documents/complete"], ["CEP-018", "POST", "/api/funnel/session"],
  ["CEP-022", "POST", "/api/payments/start"], ["CEP-023", "GET", "/api/payments/return"], ["CEP-024", "POST", "/api/payments/reconcile"],
];
const LEGAL_ROUTES: ReadonlyArray<readonly [string, string]> = [["CEP-006", "/operations"], ["CEP-007", "/portal"], ["CEP-020", "/api/operations/*"], ["CEP-021", "/api/operations/session"], ["CEP-025", "/api/portal/*"], ["CEP-026", "/api/portal/session"]];

/** The closed runtime's decision on a dispatcher: its outcome, whether the named blocker is among its reasons, and the product response's status. */
function closedRuntimeDecision(entrypointId: string, blocker: string): string {
  resetStableEntrypointRuntimeForTests();
  installClosedProductionRuntime();
  const runtime = resolveStableEntrypointRuntime();
  const decision = runtime.evaluate(entrypointId);
  const response = refusedEntrypoint(new Error(`CAPABILITY_ENTRYPOINT_BLOCKED:${entrypointId}:${decision.reason_codes.join(",")}`));
  return `${decision.outcome}:${decision.reason_codes.includes(blocker) ? blocker : decision.reason_codes.join(",")}:${response.status}`;
}

const MATRIX: readonly Row[] = [
  // --- Routes: under the closed production runtime every customer dispatcher is BLOCK with the product's 404; without any runtime, fail-closed.
  // L9-4 / D3: these thirteen are the product half — what main serves — and
  // under the closed runtime they are served as main serves them. Customer
  // payslip data enters the PRODUCT's own store through them today, as it
  // does on tivdoc.com; it reaches no legal computation. What refuses here is
  // the boundary: the route's module imports nothing from the engine, and no
  // capability is enabled for it to reach one.
  ...CUSTOMER_ROUTES.map(([id, method, route]): Row => ({
    id: `route.${id}`, kind: "route", surface: `${method} ${route} (product half, served as main)`,
    would_have_to_change: "The route's module would have to import the engine (it imports nothing from it) and a capability would have to be enabled for it (the closed projection enables none); the split would have to be edited to move it.",
    refuses: () => {
      resetStableEntrypointRuntimeForTests();
      const runtime = installClosedProductionRuntime();
      const decision = runtime.evaluate(id);
      const file = routeAssignmentOf(id)?.route_file ?? "";
      const enginePattern = /from\s+"(?:@\/server\/engine|@\/engine|@\/server\/product\/(?:operations|portal|internal-ops|legal|durable-governance)|\.\.\/.*(?:legal|shadow|operations|portal|ground-truth))/u;
      const engineImport = enginePattern.test(readFileSync(file, "utf8"));
      return `${decision.outcome}:${decision.external_reason_codes.join(",")}:${runtime.projection.enabled_capabilities.length}:${engineImport ? "engine-import" : "no-engine-import"}`;
    },
    expected: "ALLOW:SERVED_AS_MAIN:0:no-engine-import",
  })),
  ...LEGAL_ROUTES.map(([id, route]): Row => ({
    id: `route.${id}`, kind: "route", surface: route,
    would_have_to_change: "The legal engine's own dispatchers are closed in production; customer data reaching them needs an installed runtime that enables portal or operations.",
    refuses: () => closedRuntimeDecision(id, "PRODUCTION_LEGAL_ENGINE_CLOSED"),
    expected: "BLOCK:PRODUCTION_LEGAL_ENGINE_CLOSED:404",
  })),
  {
    id: "route.no_runtime", kind: "route", surface: "any guarded dispatcher, no runtime installed",
    would_have_to_change: "Nothing: with no runtime installed every guarded dispatcher fails closed (V0.10.10).",
    refuses: () => { resetStableEntrypointRuntimeForTests(); return thrown(() => resolveStableEntrypointRuntime()); },
    expected: "CAPABILITY_RUNTIME_NOT_INSTALLED",
  },
  // --- Flags: the three that name customer data, off by default, refused under Vercel when on.
  {
    id: "flag.TIVDOC_CUSTOMER_PROCESSING_ENABLED", kind: "flag", surface: "TIVDOC_CUSTOMER_PROCESSING_ENABLED",
    would_have_to_change: "The flag would have to be set on in the deployment's environment, and the internal-ops service and the runtime would have to honour it.",
    refuses: () => String(readInternalOpsFlags({}, "production").TIVDOC_CUSTOMER_PROCESSING_ENABLED),
    expected: "false",
  },
  {
    id: "flag.TIVDOC_CUSTOMER_SHADOW_ENABLED", kind: "flag", surface: "TIVDOC_CUSTOMER_SHADOW_ENABLED / TIVDOC_CUSTOMER_SHADOW_AUTHORIZED",
    would_have_to_change: "The customer shadow flag would have to be set on; the durable local runtime refuses to start unless it is \"0\".",
    refuses: () => `${String(readInternalOpsFlags({}, "production").TIVDOC_CUSTOMER_SHADOW_ENABLED)}|${thrown(() => durableLocalProductRuntimeEnabled(durableEnvironment({ TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "1" }), "nodejs"))}`,
    expected: "false|DURABLE_LOCAL_PRODUCT_FLAGS_INVALID",
  },
  {
    id: "flag.TIVDOC_PRODUCTION_DELIVERY_ENABLED", kind: "flag", surface: "TIVDOC_PRODUCTION_DELIVERY_ENABLED",
    would_have_to_change: "Delivery to a customer would have to be switched on; it is off by default and the local runtime refuses it on.",
    refuses: () => `${String(readInternalOpsFlags({}, "production").TIVDOC_PRODUCTION_DELIVERY_ENABLED)}|${thrown(() => durableLocalProductRuntimeEnabled(durableEnvironment({ TIVDOC_PRODUCTION_DELIVERY_ENABLED: "1" }), "nodejs"))}`,
    expected: "false|DURABLE_LOCAL_PRODUCT_FLAGS_INVALID",
  },
  {
    id: "flag.customer_processing_local_runtime", kind: "flag", surface: "TIVDOC_CUSTOMER_PROCESSING_ENABLED=1 on the durable local runtime",
    would_have_to_change: "The durable local runtime's startup guard, which refuses any customer flag that is not \"0\".",
    refuses: () => `${thrown(() => durableLocalProductRuntimeEnabled(durableEnvironment({ TIVDOC_CUSTOMER_PROCESSING_ENABLED: "1" }), "nodejs"))}|${String(durableLocalProductRuntimeEnabled(durableEnvironment({}), "nodejs"))}`,
    expected: "DURABLE_LOCAL_PRODUCT_FLAGS_INVALID|true",
  },
  {
    id: "flag.durable_runtime_under_vercel", kind: "flag", surface: "TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED under Vercel",
    would_have_to_change: "The only runtime that can enable customer processing refuses to start on a deployment.",
    refuses: () => thrown(() => durableLocalProductRuntimeEnabled({ TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "1", VERCEL_ENV: "production" }, "nodejs")),
    expected: "DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN",
  },
  {
    id: "flag.hermetic_runtime_under_vercel", kind: "flag", surface: "TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED under Vercel",
    would_have_to_change: "The hermetic browser runtime refuses a deployment environment before reading any other flag.",
    refuses: () => thrown(() => hermeticBrowserRuntimeBootstrapEnabled({ TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "1", NODE_ENV: "production", VERCEL_ENV: "production" }, "nodejs")),
    expected: "BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN",
  },
  {
    id: "flag.hermetic_runtime_customer_flag", kind: "flag", surface: "hermetic runtime with TIVDOC_CUSTOMER_PROCESSING_ENABLED=1",
    would_have_to_change: "The hermetic runtime refuses to boot unless every customer flag is \"0\".",
    refuses: () => thrown(() => hermeticBrowserRuntimeBootstrapEnabled({
      TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED: "1", NODE_ENV: "test", TIVDOC_PRODUCT_BROWSER_RUNTIME_SENTINEL: "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101", TIVDOC_HERMETIC_MODE: "1", TIVDOC_RUNTIME_TARGET: "local_only", TIVDOC_PRODUCT_E2E_LANE: "synthetic",
      TIVDOC_PORTAL_UI_ENABLED: "1", TIVDOC_PORTAL_API_ENABLED: "1", TIVDOC_OPERATIONS_UI_ENABLED: "1", TIVDOC_OPERATIONS_API_ENABLED: "1",
      TIVDOC_CUSTOMER_PROCESSING_ENABLED: "1", TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0", TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0", TIVDOC_OPENAI_LIVE_TESTS: "0",
    }, "nodejs")),
    expected: "BROWSER_RUNTIME_BOOTSTRAP_FLAGS_INVALID",
  },
  {
    id: "flag.product_routes_under_vercel", kind: "flag", surface: "portal and operations route flags under Vercel",
    would_have_to_change: "The route flags refuse a deployment when on, and classify as disabled when off.",
    refuses: () => `${classifyStableProductRuntime({ VERCEL_ENV: "production" }, readStableProductRouteFlags({ VERCEL_ENV: "production", NODE_ENV: "production" }))}|${thrown(() => classifyStableProductRuntime({ VERCEL_ENV: "production" }, { portalUi: true, portalApi: true, operationsUi: true, operationsApi: true }))}`,
    expected: "disabled|STABLE_PRODUCT_REMOTE_RUNTIME_FORBIDDEN",
  },
  {
    id: "flag.offline_shadow_under_production", kind: "flag", surface: "TIVDOC_OFFLINE_SHADOW_ENABLED / SYNTHETIC / PUBLIC under production",
    would_have_to_change: "Any shadow flag on under production throws; all three are off by default.",
    refuses: () => `${thrown(() => readOfflineShadowFlags({ TIVDOC_OFFLINE_SHADOW_ENABLED: "1" }, "production"))}|${String(readOfflineShadowFlags({}, "production").enabled)}`,
    expected: "SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION|false",
  },
  // --- Capabilities: the projection cannot enable customer processing or delivery anywhere but a local test/development runtime, and the closed projection enables nothing.
  {
    id: "capability.production_mode_refused", kind: "capability", surface: "buildSystemCapabilityProjection(runtime_mode: production)",
    would_have_to_change: "The projection builder would have to accept a production runtime mode; it accepts test and development only.",
    refuses: () => thrown(() => buildSystemCapabilityProjection({ schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION, runtime_mode: "production", execution_scope: "local_only", fixture_mode: "none", declarations: {} })),
    expected: "CAPABILITY_RUNTIME_MODE_UNSAFE",
  },
  {
    id: "capability.remote_scope_refused", kind: "capability", surface: "buildSystemCapabilityProjection(execution_scope: remote)",
    would_have_to_change: "The projection builder would have to accept a remote execution scope; it accepts local_only.",
    refuses: () => thrown(() => buildSystemCapabilityProjection({ schema_version: SYSTEM_CAPABILITY_SCHEMA_VERSION, runtime_mode: "development", execution_scope: "remote", fixture_mode: "none", declarations: {} })),
    expected: "CAPABILITY_EXECUTION_SCOPE_UNSAFE",
  },
  {
    id: "capability.closed_projection_enables_nothing", kind: "capability", surface: "the closed production projection",
    would_have_to_change: "The projection every deployment installs would have to enable a capability; it enables none and blocks all eighteen.",
    refuses: () => { resetStableEntrypointRuntimeForTests(); const runtime = installClosedProductionRuntime(); return `${runtime.projection.enabled_capabilities.length}/${runtime.projection.blocked_capabilities.length}`; },
    expected: "0/18",
  },
  // --- Schemas: the shadow envelope cannot carry customer material, by literal.
  {
    id: "schema.envelope.customer_input_allowed", kind: "schema", surface: "durableShadowRunEnvelopeSchema.customer_input_allowed",
    would_have_to_change: "The envelope schema's literal false would have to become a boolean.",
    refuses: () => String(durableShadowRunEnvelopeSchema.safeParse({ ...buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.matrix.001" }), customer_input_allowed: true }).success),
    expected: "false",
  },
  {
    id: "schema.envelope.dataset_customer_material", kind: "schema", surface: "durableShadowRunEnvelopeSchema.dataset_pin.customer_material",
    would_have_to_change: "The dataset pin's literal false would have to become a boolean, and its classification would have to admit something other than deterministic_synthetic.",
    refuses: () => { const envelope = buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.matrix.002" }); return String(durableShadowRunEnvelopeSchema.safeParse({ ...envelope, dataset_pin: { ...envelope.dataset_pin, customer_material: true } }).success); },
    expected: "false",
  },
  {
    id: "schema.envelope.ground_truth_customer_material", kind: "schema", surface: "durableShadowRunEnvelopeSchema.ground_truth_pin",
    would_have_to_change: "The ground-truth pin would have to admit customer material or a human ground-truth count above zero.",
    refuses: () => { const envelope = buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.matrix.003" }); return `${String(durableShadowRunEnvelopeSchema.safeParse({ ...envelope, ground_truth_pin: { ...envelope.ground_truth_pin, customer_material: true } }).success)}|${String(durableShadowRunEnvelopeSchema.safeParse({ ...envelope, ground_truth_pin: { ...envelope.ground_truth_pin, human_ground_truth_count: 1 } }).success)}`; },
    expected: "false|false",
  },
  {
    id: "schema.envelope.real_counts", kind: "schema", surface: "source_state_pin / parameter_state_pin / rule_state_pin real counts",
    would_have_to_change: "The pins' literal zero counts of real sources, parameters and rules would have to become numbers.",
    refuses: () => { const envelope = buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.matrix.004" }); return [
      durableShadowRunEnvelopeSchema.safeParse({ ...envelope, source_state_pin: { ...envelope.source_state_pin, active_real_source_count: 1 } }).success,
      durableShadowRunEnvelopeSchema.safeParse({ ...envelope, parameter_state_pin: { ...envelope.parameter_state_pin, active_real_parameter_count: 1 } }).success,
      durableShadowRunEnvelopeSchema.safeParse({ ...envelope, rule_state_pin: { ...envelope.rule_state_pin, active_real_rule_count: 1 } }).success,
    ].map(String).join("|"); },
    expected: "false|false|false",
  },
  // --- Services: the scheduler, the control plane and the internal-ops service refuse by code, before the schema's message.
  {
    id: "service.scheduler.customer_input", kind: "service", surface: "DurableOfflineShadowScheduler.schedule with customer_input_allowed",
    would_have_to_change: "The scheduler's explicit refusal, ahead of the schema, would have to go.",
    refuses: async () => {
      const { LocalFileDurableShadowStateStore } = await import("../engine/shadow/durable-store.ts");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const root = await mkdtemp(path.join(tmpdir(), "tivdoc-refusal-matrix-"));
      const store = new LocalFileDurableShadowStateStore({ root, root_kind: "generated_offline_synthetic_state" });
      const scheduler = new DurableOfflineShadowScheduler({ store, flags: { enabled: true, synthetic_enabled: true, public_enabled: false }, limits: { max_jobs: 4, max_queued: 4, max_concurrent_leases: 1, max_attempts: 2, max_dataset_bytes: 8_192, max_lease_ms: 60_000 } });
      return thrownAsync(() => scheduler.schedule({ ...buildDurableSyntheticShadowEnvelope({ run_id: "shadow.run.matrix.005" }), customer_input_allowed: true } as never, { idempotency_key: "idem.matrix.005", correlation_id: "corr.matrix.005" }));
    },
    expected: "SHADOW_CUSTOMER_INPUT_FORBIDDEN",
  },
  {
    id: "service.control_plane.customer_material", kind: "service", surface: "OfflineShadowControlPlane.registerDefinition with a customer bundle",
    would_have_to_change: "The control plane's refusal of any bundle marked customer material would have to go.",
    refuses: () => {
      const plane = new OfflineShadowControlPlane({ flags: { enabled: true, synthetic_enabled: true, public_enabled: false }, evaluator: new SyntheticMechanicsShadowEvaluator(), now: () => "2040-01-01T00:00:00.000Z" });
      const definition = buildSyntheticShadowDefinition("synthetic_test");
      // The definition schema refuses first, by literal, on the bundle's customer_material; the control plane's own refusal (SHADOW_CUSTOMER_MATERIAL_FORBIDDEN) stands behind it.
      const message = thrown(() => plane.registerDefinition({ ...definition, bundles: definition.bundles.map((bundle) => ({ ...bundle, customer_material: true })) }));
      try { return `schema:${(JSON.parse(message) as Array<{ path: unknown[] }>)[0].path.join(".")}`; } catch { return message; }
    },
    expected: "schema:bundles.0.customer_material",
  },
  {
    id: "service.internal_ops.real_analysis", kind: "service", surface: "InternalOpsService analysis_request mode=real",
    would_have_to_change: "The internal-ops service's guard on real-mode analysis while TIVDOC_CUSTOMER_PROCESSING_ENABLED is off.",
    refuses: async () => {
      const fixture = createSyntheticOpsFixture("test");
      fixture.setRole("legal_reviewer");
      const service = new InternalOpsService({ ports: fixture.ports, flags: { ...disabledInternalOpsFlags(), TIVDOC_INTERNAL_OPS_API_ENABLED: true }, now: () => "2030-02-01T10:00:00.000Z" });
      const request = {
        schema_version: INTERNAL_OPS_SCHEMA_VERSION, command_id: "cmd-matrix-real-0001", idempotency_key: "idem-matrix-real-0001", expected_revision: 4,
        reason: "refusal matrix: a real-mode analysis request while customer processing is off",
        payload: { action: "analysis_request", case_id: fixture.caseId, analysis_run_id: null, mode: "real", requested_topics: [...WAVE3_TOPICS], input_snapshot_sha256: "a".repeat(64) },
      };
      try {
        await service.mutate(fixture.actor("legal_reviewer"), request, "matrix:correlation:0001");
        return "NO_THROW";
      } catch (error) {
        return error instanceof InternalOpsError ? error.code : (error as Error).message;
      }
    },
    expected: "OPS_LEGAL_READINESS_BLOCKED",
  },
  // --- Scripts and fixtures: the lanes that touch customer material are outside the default test run, untracked, and refuse production.
  {
    id: "script.real_benchmarks_excluded", kind: "script", surface: "vitest.config.mts excludes the real-payslip benchmarks",
    would_have_to_change: "The default test run would have to include the external benchmark suites that read real and customer payslips.",
    refuses: () => String(["openai-real-benchmark.external.test.ts", "openai-real-v2-benchmark.external.test.ts", "openai-real-v21-benchmark.external.test.ts", "openai-benchmark.external.test.ts"].every((name) => readFileSync("vitest.config.mts", "utf8").includes(name))),
    expected: "true",
  },
  {
    id: "script.customer_eval_tools_refuse_production", kind: "script", surface: "scripts/customer-eval-tools.mjs",
    would_have_to_change: "The customer evaluation tooling would have to run under a production environment; it refuses one before doing anything.",
    refuses: () => { const result = spawnSync(process.execPath, ["scripts/customer-eval-tools.mjs"], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: "production" }, encoding: "utf8", timeout: 60_000 }); return `${result.status}:${(result.stderr ?? "").includes("PRODUCTION_ENVIRONMENT_REFUSED")}`; },
    expected: "2:true",
  },
  {
    id: "fixture.customer_payslips_untracked", kind: "fixture", surface: "eval/customer-payslips, eval/real-payslips",
    would_have_to_change: "The customer and real payslip trees would have to be tracked to reach a build or a deployment; both are ignored and untracked.",
    refuses: () => `${git(["ls-files", "eval/customer-payslips", "eval/real-payslips"]).length}|${String(readFileSync(".gitignore", "utf8").includes("/eval/customer-payslips/") && readFileSync(".gitignore", "utf8").includes("/eval/real-payslips/"))}`,
    expected: "0|true",
  },
  // --- Storage: local private storage cannot be public or claim platform management.
  {
    id: "storage.local_private_not_public", kind: "storage", surface: "LocalRuntimePrivateBlobProvider(publicly_addressable: true)",
    would_have_to_change: "The provider would have to accept a publicly addressable or platform-managed configuration.",
    refuses: () => `${thrown(() => new LocalRuntimePrivateBlobProvider({ root: path.resolve("output", "tivdoc-private-matrix"), runtime_class: "ignored_local_private_filesystem", publicly_addressable: true as never, managed_platform_verified: false }))}|${thrown(() => new LocalRuntimePrivateBlobProvider({ root: path.resolve("output", "tivdoc-private-matrix"), runtime_class: "ignored_local_private_filesystem", publicly_addressable: false, managed_platform_verified: true as never }))}`,
    expected: "LOCAL_PRIVATE_STORAGE_CONFIGURATION_INVALID|LOCAL_PRIVATE_STORAGE_CONFIGURATION_INVALID",
  },
];

describe("the customer-data refusal matrix (D6)", () => {
  afterEach(() => resetStableEntrypointRuntimeForTests());

  it("is the pinned inventory: every surface that would have to change, by kind", () => {
    expect(MATRIX).toHaveLength(43);
    const byKind: Record<string, number> = {};
    for (const row of MATRIX) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    expect(byKind).toEqual({ route: 20, flag: 9, capability: 3, schema: 4, service: 3, script: 2, fixture: 1, storage: 1 });
    expect(new Set(MATRIX.map((row) => row.id)).size).toBe(MATRIX.length);
    for (const row of MATRIX) expect(row.would_have_to_change.length, row.id).toBeGreaterThan(40);
  });

  for (const row of MATRIX) {
    it(`${row.id} refuses today — ${row.surface}`, async () => {
      expect(await row.refuses(), row.would_have_to_change).toBe(row.expected);
    });
  }
});
