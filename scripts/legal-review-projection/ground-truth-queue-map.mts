// Wave 5 (G-1, G-2, G-10, G-11). The durable annotation queue, filled with
// identity and nothing else, and the process-local stores it replaces, named.
//
// G-10 maps the 42 blank Golden Case templates (7 topics × 6 scenarios, built
// by the engine, never hand-written) onto the durable work queue as empty
// items: template identity, version, topic, scenario and the template's own
// content digest. No answers, no expected values, no bindings — the template
// is blank and the queue entry says so.
//
// G-11 maps the 5 customer-derived payslip composites onto the same queue as
// visual-eligibility work, pending the owner's visual review, which is human
// and stays open. The only input is the review manifest's metadata: neutral
// document ids and composite digests. The composite images are never opened,
// read or hashed here; the digests come from the manifest as written.
//
// G-2 reads the queue's own properties from the catalog and asserts them —
// RLS enabled and forced, one owner-bound verified-tenant policy, no table
// grant outside the owner, execute grants on the queue definers exactly as
// designed and never to anon, authenticated, service_role or public — and the
// enqueues above are the execution proof: every receipt is read back from the
// database, and a second run replays every item from the idempotency ledger.
//
// G-1 enumerates every process-local store still on the ground-truth path,
// with file:line anchors located at run time, and counts the product
// constructors each has: none, which is the disposition.
//
// Zero ground-truth content is produced. HUMAN_GROUND_TRUTH_LOCKED stays 0.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildBlankGoldenCaseTemplates } from "../../src/engine/legal-quality/golden-case-templates.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresTransactionContext } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { GovernanceMutationReceipt } from "../../src/server/platform/persistence/postgres/governance/contracts.ts";
import { PostgresGovernanceWorkRepository } from "../../src/server/platform/persistence/postgres/governance/repositories.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const TENANT = "tenant.synthetic.001";
// The enqueue definer attributes every work item to this actor, and the actor
// guard admits only the verified session subject, so the fixture session's
// subject is this name.
const QUEUE_ACTOR = "governance.queue";
const SESSION = Object.freeze({ sid: "session.gt.queue.wave5", jti: "token.gt.queue.wave5" });
// Deterministic so a re-run is the same command and replays from the ledger.
const TEMPLATE_ENQUEUED_AT = "2026-09-03T00:00:00.000Z";
const MANIFEST_PATH = path.join("eval", "customer-payslips", "review-v3", "review-manifest.json");

// The lanes as the product declares them; copied by value so this script does
// not import the product's route contracts and their dependency tree.
const LANES = Object.freeze({
  golden_case_outputs: Object.freeze({
    workflow_kind: "rulespec_approval" as const, work_kind: "golden_case_outputs" as const,
    required_role: "human_golden_case_reviewer",
  }),
  ground_truth_visual_eligibility: Object.freeze({
    workflow_kind: "ground_truth" as const, work_kind: "ground_truth_visual_eligibility" as const,
    required_role: "human_ground_truth_eligibility_reviewer",
  }),
});

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Outcome = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Outcome[] = [];
function record(name: string, pass: boolean, observed: string): void {
  results.push(Object.freeze({ case: name, outcome: pass ? "pass" : "fail", observed }));
}

/** Runs one governance transaction as the operations role under the queue session. */
async function transaction<T>(
  factory: NodePostgresConnectionFactory,
  operation: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  const client = await factory.acquire();
  try {
    await client.query(statement("gt_queue_begin", "begin", []));
    await client.query(statement("gt_queue_context",
      "select * from private.runtime_context_install($1,$2,$3)", [SESSION.sid, SESSION.jti, `gt-queue-map:${Date.now()}`]));
    const value = await operation({ client, transaction_id: `gt-queue-map:${Date.now()}` });
    await client.query(statement("gt_queue_commit", "commit", []));
    return value;
  } catch (error) {
    await client.query(statement("gt_queue_rollback", "rollback", [])).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// --- G-1: process-local stores on the ground-truth path -----------------------

type StoreAnchor = Readonly<{
  symbol: string; file: string; line: number | null; kind: string;
  product_constructors: readonly string[]; disposition: string; note: string;
}>;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts)$/u.test(entry) && !/\.test\.(ts|tsx|mts)$/u.test(entry)) out.push(full);
  }
  return out;
}

function lineOf(file: string, pattern: RegExp): number | null {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? null : index + 1;
}

function constructorsOf(symbol: string, files: readonly string[], declaredIn: string): string[] {
  const hits: string[] = [];
  const pattern = new RegExp(`new ${symbol}\\(`, "u");
  for (const file of files) {
    if (path.resolve(file) === path.resolve(declaredIn)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => { if (pattern.test(line)) hits.push(`${file.replaceAll("\\", "/")}:${index + 1}`); });
  }
  return hits;
}

function enumerateProcessLocalStores(): readonly StoreAnchor[] {
  const files = [...walk("src"), ...walk("scripts")];
  const anchors: StoreAnchor[] = [];
  const declare = (symbol: string, file: string, kind: string, note: string) => {
    const line = lineOf(file, new RegExp(`^export class ${symbol}\\b`, "u"));
    const constructors = constructorsOf(symbol, files, file);
    const productConstructors = constructors.filter((hit) => hit.startsWith("src/"));
    anchors.push(Object.freeze({
      symbol, file, line, kind,
      product_constructors: Object.freeze(productConstructors),
      disposition: productConstructors.length === 0 ? "implemented_uncalled" : "process_local_in_product_code",
      note: constructors.length === 0 ? note : `${note} Constructed at: ${constructors.join(", ")}.`,
    }));
  };
  declare("TrustedGroundTruthWorkflow", "src/engine/extraction-ground-truth/trusted-workflow.ts", "in-memory workflow state machine",
    "The V0.10.1 process-local ground-truth workflow; its durable replacement is PostgresGroundTruthRepository over governance_gt_manifest_versions, proven by ground-truth-matrix.mts.");
  declare("InMemoryReviewerTrustStore", "src/server/platform/trust/reviewer-trust-store.ts", "in-memory reviewer trust store",
    "Process-local trust organisation, policy, reviewer and key state; durable replacement is PostgresReviewerTrustRepository. The only constructor is the CLI scripts/human-trust/verify.mts (CEP-047), not product code.");
  declare("AppendOnlyLegalOperationsStore", "src/engine/legal-operations/state-machine.ts", "in-memory append-only legal operations store",
    "Held by LegalOperationsService, which itself has no product constructor.");
  declare("ExternalEvidenceHandoffLedger", "src/engine/legal-operations/evidence-handoff.ts", "in-memory evidence handoff ledger",
    "Durable replacement is out of scope for the ground-truth path; recorded because it sits on the same process-local list (CEP-093).");
  // LegalOperationsService keeps its own process-local maps for golden cases
  // and trusted decisions; they are fields, not classes, so they are anchored
  // by field rather than by declaration.
  const service = "src/server/engine/legal-operations/service.ts";
  const fields = existsSync(service)
    ? readFileSync(service, "utf8").split(/\r?\n/u)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s+readonly #\w+ = new (Map|Set)</u.test(line))
      .map(({ line, index }) => `${service}:${index + 1} ${line.trim().replace(/ = .*$/u, "")}`)
    : [];
  const serviceConstructors = constructorsOf("LegalOperationsService", files, service).filter((hit) => hit.startsWith("src/"));
  anchors.push(Object.freeze({
    symbol: "LegalOperationsService process-local maps", file: service, line: lineOf(service, /readonly #goldenCases/u),
    kind: "in-memory golden-case and trusted-decision maps",
    product_constructors: Object.freeze(serviceConstructors),
    disposition: serviceConstructors.length === 0 ? "implemented_uncalled" : "process_local_in_product_code",
    note: `Fields: ${fields.join("; ")}. Durable replacements: governance_golden_case_set_import and governance_human_decision_admit.`,
  }));
  return Object.freeze(anchors);
}

// --- G-2: the queue's properties, from the catalog ----------------------------

type Catalog = Readonly<{
  rls: boolean; forced: boolean; owner: string;
  policies: readonly Readonly<{ policyname: string; roles: string; qual: string; with_check: string | null }>[];
  table_grants: readonly Readonly<{ grantee: string; privilege_type: string }>[];
  triggers: readonly string[];
  execute: Readonly<Record<string, readonly string[]>>;
}>;

async function readCatalog(adminUrl: string): Promise<Catalog> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const one = (await client.query(
      `select c.relrowsecurity rls, c.relforcerowsecurity forced, r.rolname owner
         from pg_class c join pg_roles r on r.oid = c.relowner join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = 'governance_work_items'`)).rows[0] as { rls: boolean; forced: boolean; owner: string };
    const policies = (await client.query(
      `select policyname, roles::text as roles, qual, with_check from pg_policies
        where schemaname = 'private' and tablename = 'governance_work_items' order by policyname`)).rows as Catalog["policies"];
    const grants = (await client.query(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'private' and table_name = 'governance_work_items' order by grantee, privilege_type`)).rows as Catalog["table_grants"];
    const triggers = (await client.query(
      `select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = 'governance_work_items' and not t.tgisinternal`)).rows.map((row) => String(row.tgname));
    const execute: Record<string, readonly string[]> = {};
    for (const fn of ["governance_work_enqueue", "governance_work_claim", "governance_work_release", "governance_complete_claim", "governance_claim_assert"]) {
      execute[fn] = (await client.query(
        `select grantee from information_schema.routine_privileges
          where specific_schema = 'private' and routine_name = $1 and privilege_type = 'EXECUTE' order by grantee`, [fn]))
        .rows.map((row) => String(row.grantee));
    }
    return Object.freeze({ ...one, policies, table_grants: grants, triggers: Object.freeze(triggers), execute: Object.freeze(execute) });
  } finally {
    await client.end().catch(() => undefined);
  }
}

// --- main ---------------------------------------------------------------------

type Enqueued = Readonly<{ work_item_id: string; revision: number; state: string; idempotent_replay: boolean }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF");
  if (!adminUrl || !operationsUrl || !projectRef) throw new Error("GT_QUEUE_MAP_ENV_MISSING");
  const { default: pg } = await import("pg");

  // G-1 first: it needs no database.
  const stores = enumerateProcessLocalStores();
  record("G1_process_local_stores_enumerated",
    stores.length === 5 && stores.every((store) => store.line !== null),
    stores.map((store) => `${store.symbol}@${store.file}:${store.line ?? "?"} ${store.disposition}`).join(" | "));
  // A store is reachable from product code only if a product constructor of it
  // exists outside another store that is itself unreachable: the append-only
  // legal-operations store is constructed once, by LegalOperationsService,
  // which has no product constructor of its own.
  const unreachableHosts = new Set(stores.filter((store) => store.product_constructors.length === 0).map((store) => store.file));
  const reachable = stores.map((store) => ({
    symbol: store.symbol,
    from_product: store.product_constructors.filter((hit) => !unreachableHosts.has(hit.replace(/:[0-9]+$/u, ""))),
  }));
  record("G1_no_store_reachable_from_product_code",
    reachable.every((entry) => entry.from_product.length === 0),
    reachable.map((entry) => `${entry.symbol}: ${entry.from_product.length === 0 ? "unreachable" : entry.from_product.join(",")}`).join(" | "));

  // G-2, the catalog half.
  const catalog = await readCatalog(adminUrl);
  const owner = "tivdoc_governance_owner";
  const forbidden = new Set(["PUBLIC", "anon", "authenticated", "service_role"]);
  record("G2_rls_enabled_and_forced", catalog.rls && catalog.forced && catalog.owner === owner,
    `rls=${catalog.rls} forced=${catalog.forced} owner=${catalog.owner}`);
  record("G2_single_owner_bound_verified_tenant_policy",
    catalog.policies.length === 1 && catalog.policies[0]!.roles === `{${owner}}`
      && /runtime_verified_tenant\(\)/u.test(catalog.policies[0]!.qual)
      && /runtime_verified_tenant\(\)/u.test(catalog.policies[0]!.with_check ?? ""),
    catalog.policies.map((policy) => `${policy.policyname} ${policy.roles} using ${policy.qual}`).join(" | "));
  record("G2_no_table_grant_outside_owner",
    catalog.table_grants.every((grant) => grant.grantee === owner),
    [...new Set(catalog.table_grants.map((grant) => grant.grantee))].join(","));
  const expectedExecute: Readonly<Record<string, readonly string[]>> = Object.freeze({
    governance_work_enqueue: [owner, "tivdoc_operations_runtime", "tivdoc_worker_runtime"],
    governance_work_claim: [owner, "tivdoc_operations_runtime"],
    governance_work_release: [owner, "tivdoc_operations_runtime"],
    governance_complete_claim: [owner],
    governance_claim_assert: [owner],
  });
  record("G2_definer_execute_grants_as_designed",
    Object.entries(expectedExecute).every(([fn, grantees]) =>
      JSON.stringify([...catalog.execute[fn] ?? []].sort()) === JSON.stringify([...grantees].sort())),
    Object.entries(catalog.execute).map(([fn, grantees]) => `${fn}: ${grantees.join(",")}`).join(" | "));
  record("G2_no_execute_grant_to_anon_authenticated_service_role_public",
    Object.values(catalog.execute).every((grantees) => grantees.every((grantee) => !forbidden.has(grantee))),
    "checked enqueue, claim, release, complete_claim, claim_assert");
  record("G2_queue_mutable_by_contract_no_immutability_trigger", catalog.triggers.length === 0,
    `triggers=${catalog.triggers.length}; work items move pending -> claimed -> completed | released by definer only`);

  // Fixture session for the queue actor in the stable synthetic tenant.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    const now = Math.floor(Date.now() / 1_000);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = excluded.valid_after,
         expires_at = excluded.expires_at, reviewer_org_id = excluded.reviewer_org_id`,
      [TENANT, SESSION.sid, QUEUE_ACTOR, SESSION.jti, now - 5, now + 3_600, "review_org_00001",
        sha256(`${TENANT}|${SESSION.sid}|${QUEUE_ACTOR}|${SESSION.jti}`)],
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_ground_truth_queue_map",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: projectRef },
  });

  let failure: string | null = null;
  const templatesEnqueued: Enqueued[] = [];
  const compositesEnqueued: Enqueued[] = [];
  let compositesDisposition = "enqueued";
  try {
    const toEnqueued = (id: string, receipt: GovernanceMutationReceipt): Enqueued => Object.freeze({
      work_item_id: id, revision: receipt.revision, state: receipt.state, idempotent_replay: receipt.idempotent_replay,
    });

    // --- G-10: the 42 blank templates, identity only.
    const templates = buildBlankGoldenCaseTemplates();
    record("G10_engine_builds_42_blank_templates", templates.length === 42
      && templates.every((template) => template.state === "blank_human_legal_review_template" && template.legal_ground_truth === false),
      `${templates.length} templates, ${new Set(templates.map((t) => t.topic)).size} topics × ${new Set(templates.map((t) => t.scenario)).size} scenarios`);
    for (const template of templates) {
      const itemId = `gt.golden.${template.template_id}`;
      const receipt = await transaction(factory, (context) => new PostgresGovernanceWorkRepository(context, TENANT).enqueue({
        work_item_id: itemId, workflow_kind: LANES.golden_case_outputs.workflow_kind,
        aggregate_id: template.template_id, aggregate_version: "1",
        work_kind: LANES.golden_case_outputs.work_kind, required_role: LANES.golden_case_outputs.required_role,
        document_sha256: null, object_version_id: null, input_sha256: template.content_sha256,
        payload: {
          template_id: template.template_id, template_version: template.template_version,
          topic: template.topic, scenario: template.scenario, state: template.state,
          content_sha256: template.content_sha256, dependencies_sha256: template.dependencies_sha256,
          content: "none: blank template identity only",
        },
        idempotency_key: `enqueue.${itemId}`, created_at: TEMPLATE_ENQUEUED_AT,
      }));
      templatesEnqueued.push(toEnqueued(itemId, receipt));
    }
    record("G10_42_templates_on_durable_queue",
      templatesEnqueued.length === 42 && templatesEnqueued.every((entry) => entry.revision === 1 && entry.state === "pending"),
      `${templatesEnqueued.length} receipts, revision 1 pending; replayed ${templatesEnqueued.filter((e) => e.idempotent_replay).length}`);

    // --- G-11: the 5 composites, from the manifest's metadata only.
    if (!existsSync(MANIFEST_PATH)) {
      compositesDisposition = "blocked_dependency: review manifest absent on this host";
      record("G11_5_composites_on_durable_queue", false, compositesDisposition);
    } else {
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Readonly<{
        schema_version: string; pipeline_version: string; status: string; created_timestamp: string;
        documents: readonly Readonly<{ neutral_document_id: string; composite_sha256: string; composite_sheet_position: number; section_count: number; status: string }>[];
      }>;
      const manifestSha256 = sha256(readFileSync(MANIFEST_PATH, "utf8"));
      for (const document of manifest.documents) {
        const itemId = `gt.visual.${document.neutral_document_id}`;
        const identity = {
          neutral_document_id: document.neutral_document_id, composite_sha256: document.composite_sha256,
          composite_sheet_position: document.composite_sheet_position, section_count: document.section_count,
          status: document.status, pipeline_version: manifest.pipeline_version, manifest_sha256: manifestSha256,
        };
        const receipt = await transaction(factory, (context) => new PostgresGovernanceWorkRepository(context, TENANT).enqueue({
          work_item_id: itemId, workflow_kind: LANES.ground_truth_visual_eligibility.workflow_kind,
          aggregate_id: document.neutral_document_id, aggregate_version: "1",
          work_kind: LANES.ground_truth_visual_eligibility.work_kind,
          required_role: LANES.ground_truth_visual_eligibility.required_role,
          document_sha256: document.composite_sha256,
          object_version_id: `${manifest.pipeline_version}:${document.neutral_document_id}`,
          input_sha256: sha256(JSON.stringify(identity)),
          payload: { ...identity, content: "none: pending the owner's visual review" },
          idempotency_key: `enqueue.${itemId}`, created_at: manifest.created_timestamp,
        }));
        compositesEnqueued.push(toEnqueued(itemId, receipt));
      }
      record("G11_5_composites_on_durable_queue",
        compositesEnqueued.length === 5 && compositesEnqueued.every((entry) => entry.revision === 1 && entry.state === "pending"),
        `${compositesEnqueued.length} receipts, revision 1 pending; replayed ${compositesEnqueued.filter((e) => e.idempotent_replay).length}; images never opened`);
    }
  } catch (error) {
    failure = `${(error as { code?: string }).code ?? (error as Error).name}: ${String((error as Error).message).slice(0, 240)}`;
    record("map_completed", false, failure);
  } finally {
    await factory.close().catch(() => undefined);
  }

  const failed = results.filter((entry) => entry.outcome === "fail");
  writeFileSync(path.join(RECEIPT_ROOT, "ground-truth-queue-map.json"), `${JSON.stringify({
    schema_version: "tivdoc-ground-truth-queue-map-wave5", tenant: TENANT, queue_actor: QUEUE_ACTOR,
    observed_at: new Date().toISOString(),
    human_ground_truth_locked: 0, content_created: "none: template identity and composite digests only",
    g1_process_local_stores: stores,
    g2_catalog: catalog,
    g10_templates: templatesEnqueued,
    g11_composites: { disposition: compositesDisposition, items: compositesEnqueued, owner_visual_review: "human, open" },
    cases: results.length, passed: results.length - failed.length, failed: failed.length, failure, results,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`cases=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
    + `${failed.length > 0 ? ` failing=${failed.map((f) => f.case).join(",")}` : ""}\n`);
  for (const entry of results) process.stdout.write(`  ${entry.outcome} ${entry.case} :: ${entry.observed.slice(0, 220)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
