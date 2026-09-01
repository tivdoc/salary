import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import {
  EXPECTED_CANONICAL_RLS_TABLES,
  EXPECTED_TENANT_POLICY_TABLES,
} from "../foundation/inventory.mts";

const EXPECTED_RLS_TABLE_NAMES = Object.freeze(
  EXPECTED_CANONICAL_RLS_TABLES.map((table) => table.slice("public.".length)),
);
const EXPECTED_POLICY_TABLE_NAMES = Object.freeze(
  EXPECTED_TENANT_POLICY_TABLES.map((table) => table.slice("public.".length)),
);

const EXPECTED_SECURITY_DEFINERS = Object.freeze(new Map<string, boolean>([
  ["private.append_controlled_import_audit", false],
  ["private.claim_controlled_import_recovery", true],
  ["private.claim_engine_platform_jobs", true],
  ["private.claim_engine_platform_outbox", true],
  ["private.controlled_import_forbid_mutation", false],
  ["private.controlled_import_publish", true],
  ["private.controlled_import_reject", true],
  ["private.controlled_import_reserve", true],
  ["private.controlled_import_stage_exact_bytes", true],
  ["private.enforce_analysis_job_history", false],
  ["private.enforce_case_confirmation_history", false],
  ["private.enforce_case_conversation_history", false],
  ["private.enforce_document_extraction_history", false],
  ["private.enforce_engine_analysis_run_history", false],
  ["private.enforce_engine_case_scope", false],
  ["private.finish_engine_platform_job", true],
  ["private.heartbeat_engine_platform_job", true],
  ["private.open_controlled_import_published_bytes", true],
  ["private.product_case_owner_bind", true],
  ["private.product_forbid_delete", false],
  ["private.product_forbid_privacy_mutation", false],
  ["private.product_identity_session_read", true],
  ["private.product_identity_session_register", true],
  ["private.product_owner_lookup", true],
  ["private.product_owner_revoke", true],
  ["private.product_privacy_append", true],
  ["private.product_private_report_object_bind", true],
  ["private.product_report_object_approve", true],
  ["private.product_report_object_approved_read", true],
  ["private.product_report_object_revoke", true],
  ["private.product_session_revoke", true],
  ["private.product_session_rotate", true],
  ["private.reject_engine_append_only_mutation", false],
  ["private.resolve_engine_case_id", true],
  ["public.claim_salary_ga4_purchase", true],
  ["public.claim_salary_meta_purchase", true],
  ["public.claim_salary_payment_completed", true],
  ["public.complete_salary_ga4_purchase", true],
  ["public.complete_salary_meta_purchase", true],
  ["public.release_salary_ga4_purchase", true],
  ["public.release_salary_meta_purchase", true],
  ["public.verify_salary_payment", true],
]));

export type RlsRoleResult = Readonly<{
  role: "anon" | "authenticated" | "service_role" | "tenant_policy_probe";
  tables_checked: number;
  reads_allowed: number;
  reads_denied: number;
  writes_allowed: number;
  writes_denied: number;
  unexpected_results: number;
  status: "PASS" | "FAIL";
}>;

export type TenantPolicyTableResult = Readonly<{
  table: string;
  seeded_own_tenant_rows: number;
  seeded_cross_tenant_control_rows: number;
  own_tenant_rows_visible: number;
  cross_tenant_rows_visible: number;
  cross_tenant_write_rejected: boolean;
  status: "PASS" | "FAIL";
}>;

export type TenantPolicyDenominators = Readonly<{
  expected_tables: number;
  tested_tables: number;
  tables_with_seeded_own_tenant_rows: number;
  tables_with_seeded_cross_tenant_control_rows: number;
  tables_with_expected_own_tenant_visibility: number;
  tables_with_zero_cross_tenant_visibility: number;
  tables_with_cross_tenant_write_rejection: number;
}>;

export type RlsMatrixReceipt = Readonly<{
  schema_version: "tivdoc-real-postgresql-rls-matrix-v0.9.1";
  proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF";
  sensitive_tables: readonly string[];
  roles: readonly RlsRoleResult[];
  rls_enabled: number;
  rls_forced: number;
  security_definer_functions: number;
  unsafe_security_definer_functions: number;
  security_definer_acl_mismatches: number;
  tenant_policy_tables: number;
  tenant_policy_denominators: TenantPolicyDenominators;
  tenant_policy_table_results: readonly TenantPolicyTableResult[];
  seeded_own_tenant_rows: number;
  seeded_cross_tenant_control_rows: number;
  own_tenant_rows_visible: number;
  cross_tenant_rows_visible: number;
  cross_tenant_write_rejections: number;
  cross_tenant_write_rejected: boolean;
  distinct_tenant_controls: true;
  synthetic_control_rows_inserted: 12;
  synthetic_findings_inserted: 2;
  synthetic_findings_removed: 2;
  persistent_job_history_controls: 2;
  real_findings_generated: false;
  legal_sources_activated: 0;
  customer_data_used: false;
  connection_attempts: number;
  credentials_recorded: 0;
  status: "PASS" | "FAIL";
}>;

type RoleUrls = Readonly<{
  anon: string;
  authenticated: string;
  service_role: string;
  tenant_policy_probe: string;
}>;

type TableColumn = Readonly<{ table_name: string; first_column: string }>;
type SecurityDefiner = Readonly<{
  schema_name: string;
  function_name: string;
  safe_search_path: boolean;
  anon_execute: boolean;
  authenticated_execute: boolean;
  service_execute: boolean;
}>;
type TenantSeedControl = Readonly<{
  table_name: string;
  seeded_own_tenant_rows: number;
  seeded_cross_tenant_control_rows: number;
}>;
type CaseConfirmationWriteProbe = Readonly<{
  case_id: string;
  analysis_run_id: string;
  canonical_case_id: string;
  canonical_analysis_run_id: string;
}>;

type SyntheticRlsControls = Readonly<{
  finding_ids: readonly string[];
  synthetic_control_rows_inserted: 12;
  synthetic_findings_inserted: 2;
  persistent_job_history_controls: 2;
}>;

/**
 * Performs permission checks through four independent authenticated sessions.
 * It records only role/table counters; SQL errors and connection strings are
 * deliberately kept out of the receipt.
 */
export async function runRealPostgresRlsMatrix(input: Readonly<{
  admin_connection_url: string;
  role_connection_urls: RoleUrls;
  tenant_a: string;
  tenant_b: string;
}>): Promise<RlsMatrixReceipt> {
  if (!input.tenant_a || !input.tenant_b || input.tenant_a === input.tenant_b) {
    throw new Error("RLS_DISTINCT_TENANT_CONTROLS_REQUIRED");
  }
  const admin = pool(input.admin_connection_url, "tivdoc-v091-rls-admin");
  let pendingSyntheticFindingIds: readonly string[] = Object.freeze([]);
  try {
    const inventory = await admin.query<TableColumn>(`
      select c.relname as table_name,
             (select a.attname from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
              order by a.attnum limit 1) as first_column
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      order by c.relname`);
    const tables = inventory.rows.map(({ table_name }) => table_name);
    if (!sameStrings(tables, EXPECTED_RLS_TABLE_NAMES)) {
      throw new Error("RLS_TABLE_INVENTORY_INVALID");
    }

    const rels = await admin.query<{ enabled: string; forced: string }>(`
      select count(*) filter (where c.relrowsecurity)::text as enabled,
             count(*) filter (where c.relforcerowsecurity)::text as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[])`, [tables]);
    const rlsEnabled = Number(rels.rows[0]?.enabled ?? -1);
    const rlsForced = Number(rels.rows[0]?.forced ?? -1);

    const definers = await admin.query<SecurityDefiner>(`
      select n.nspname as schema_name,
             p.proname as function_name,
             coalesce(p.proconfig, array[]::text[]) @> array['search_path=""']::text[] as safe_search_path,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
      order by n.nspname, p.proname, p.oid`);
    const definerNames = definers.rows.map((row) => `${row.schema_name}.${row.function_name}`);
    if (!sameStrings(definerNames, [...EXPECTED_SECURITY_DEFINERS.keys()])) {
      throw new Error("RLS_SECURITY_DEFINER_INVENTORY_INVALID");
    }
    const securityDefinerFunctions = definers.rows.length;
    const unsafeSecurityDefinerFunctions = definers.rows.filter((row) => !row.safe_search_path).length;
    const securityDefinerAclMismatches = definers.rows.filter((row) => {
      const serviceExpected = EXPECTED_SECURITY_DEFINERS.get(`${row.schema_name}.${row.function_name}`);
      return row.anon_execute || row.authenticated_execute || row.service_execute !== serviceExpected;
    }).length;
    const policies = await admin.query<{ tablename: string; roles: string[]; command: string }>(`
      select tablename, roles::text[] as roles, cmd as command from pg_policies
      where schemaname = 'public'
      order by tablename`);
    if (!sameStrings(policies.rows.map(({ tablename }) => tablename), EXPECTED_POLICY_TABLE_NAMES)
      || policies.rows.some((policy) => policy.roles.length !== 1 || policy.roles[0] !== "service_role"
        || policy.command !== "ALL")) {
      throw new Error("RLS_TENANT_POLICY_INVENTORY_INVALID");
    }
    const policyNames = new Set(policies.rows.map(({ tablename }) => tablename));
    const policyTables = inventory.rows.filter(({ table_name: tableName }) => policyNames.has(tableName));
    if (policyTables.length !== EXPECTED_POLICY_TABLE_NAMES.length) {
      throw new Error("RLS_TENANT_POLICY_DENOMINATOR_INVALID");
    }
    const syntheticControls = await seedSyntheticRlsControls(admin, input.tenant_a, input.tenant_b);
    pendingSyntheticFindingIds = syntheticControls.finding_ids;
    const seedControls = await readTenantSeedControls(
      admin,
      policyTables,
      input.tenant_a,
      input.tenant_b,
    );
    const caseConfirmationWriteProbe = await readCaseConfirmationWriteProbe(admin, input.tenant_b);

    const roles: RlsRoleResult[] = [];
    roles.push(await deniedRole("anon", input.role_connection_urls.anon, inventory.rows));
    roles.push(await deniedRole("authenticated", input.role_connection_urls.authenticated, inventory.rows));
    roles.push(await serviceRole(input.role_connection_urls.service_role, inventory.rows));
    const probe = await policyProbe({
      connection_url: input.role_connection_urls.tenant_policy_probe,
      tables: policyTables,
      seed_controls: seedControls,
      case_confirmation_write_probe: caseConfirmationWriteProbe,
      tenant_a: input.tenant_a,
      tenant_b: input.tenant_b,
    });
    roles.push(probe.result);
    const syntheticFindingsRemoved = await cleanupSyntheticFindings(admin, pendingSyntheticFindingIds);
    pendingSyntheticFindingIds = Object.freeze([]);

    const status = rlsEnabled === tables.length
      && rlsForced === 0
      && unsafeSecurityDefinerFunctions === 0
      && securityDefinerFunctions === EXPECTED_SECURITY_DEFINERS.size
      && securityDefinerAclMismatches === 0
      && roles.every((entry) => entry.status === "PASS")
      && probe.tenant_policy_denominators.expected_tables === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_denominators.tested_tables === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_denominators.tables_with_seeded_own_tenant_rows === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_denominators.tables_with_seeded_cross_tenant_control_rows === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_denominators.tables_with_expected_own_tenant_visibility === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_denominators.tables_with_zero_cross_tenant_visibility === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_denominators.tables_with_cross_tenant_write_rejection === EXPECTED_POLICY_TABLE_NAMES.length
      && probe.tenant_policy_table_results.every((entry) => entry.status === "PASS")
      && probe.cross_tenant_rows_visible === 0
      && probe.cross_tenant_write_rejected
      ? "PASS" : "FAIL";
    return Object.freeze({
      schema_version: "tivdoc-real-postgresql-rls-matrix-v0.9.1",
      proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
      sensitive_tables: Object.freeze(tables),
      roles: Object.freeze(roles),
      rls_enabled: rlsEnabled,
      rls_forced: rlsForced,
      security_definer_functions: securityDefinerFunctions,
      unsafe_security_definer_functions: unsafeSecurityDefinerFunctions,
      security_definer_acl_mismatches: securityDefinerAclMismatches,
      tenant_policy_tables: policyTables.length,
      tenant_policy_denominators: probe.tenant_policy_denominators,
      tenant_policy_table_results: probe.tenant_policy_table_results,
      seeded_own_tenant_rows: probe.seeded_own_tenant_rows,
      seeded_cross_tenant_control_rows: probe.seeded_cross_tenant_control_rows,
      own_tenant_rows_visible: probe.own_tenant_rows_visible,
      cross_tenant_rows_visible: probe.cross_tenant_rows_visible,
      cross_tenant_write_rejections: probe.cross_tenant_write_rejections,
      cross_tenant_write_rejected: probe.cross_tenant_write_rejected,
      distinct_tenant_controls: true,
      synthetic_control_rows_inserted: syntheticControls.synthetic_control_rows_inserted,
      synthetic_findings_inserted: syntheticControls.synthetic_findings_inserted,
      synthetic_findings_removed: syntheticFindingsRemoved,
      persistent_job_history_controls: syntheticControls.persistent_job_history_controls,
      real_findings_generated: false,
      legal_sources_activated: 0,
      customer_data_used: false,
      connection_attempts: 5,
      credentials_recorded: 0,
      status,
    });
  } finally {
    if (pendingSyntheticFindingIds.length > 0) {
      await cleanupSyntheticFindings(admin, pendingSyntheticFindingIds);
    }
    await admin.end();
  }
}

async function seedSyntheticRlsControls(
  admin: Pool,
  tenantA: string,
  tenantB: string,
): Promise<SyntheticRlsControls> {
  const client = await admin.connect();
  const findingIds: string[] = [];
  let jobHistoryControls = 0;
  let productBoundaryControls = 0;
  try {
    await client.query("begin");
    for (const tenantId of [tenantA, tenantB]) {
      const findingId = randomUUID();
      const factReference = randomUUID();
      const uniqueSuffix = randomUUID();
      const finding = await client.query<{ id: string }>(`
        with target_run as (
          select id, canonical_case_id, canonical_analysis_run_id
          from public.analysis_runs
          where tenant_id = $1
          order by created_at, id
          limit 1
        )
        insert into public.analysis_findings (
          id, analysis_run_id, category, status, confidence, confidence_tier,
          rule_id, rule_version, calculation_payload, fact_references,
          evidence_references, requires_confirmation, idempotency_key,
          tenant_id, canonical_case_id, canonical_analysis_run_id, canonical_finding_id
        )
        select $2::uuid, id, 'synthetic_rls_isolation_control', 'blocked', 0, 'low',
               'not-applicable-rls-control', '0', null, array[$3::uuid],
               jsonb_build_array(jsonb_build_object('kind', 'synthetic_rls_control', 'customer_data', false)),
               true, $4, $1, canonical_case_id, canonical_analysis_run_id, $5
        from target_run
        returning id::text`, [
        tenantId,
        findingId,
        factReference,
        `rls-control-${uniqueSuffix}`,
        `rls-control-${uniqueSuffix}`,
      ]);
      if (finding.rowCount !== 1 || finding.rows[0]?.id !== findingId) {
        throw new Error("RLS_SYNTHETIC_FINDING_CONTROL_FAILED");
      }
      findingIds.push(findingId);

      const eventSha256 = createHash("sha256")
        .update(`tivdoc-v091-rls-job-history\u0000${tenantId}\u0000${randomUUID()}`)
        .digest("hex");
      const history = await client.query<{ sequence: string }>(`
        with target_job as (
          select job_id, state, revision, fencing_token, canonical_case_id
          from public.engine_durable_jobs
          where tenant_id = $1
          order by created_at, job_id
          limit 1
        )
        insert into public.engine_job_history (
          job_id, from_state, to_state, revision, fencing_token, reason_code,
          previous_sha256, event_sha256, occurred_at, tenant_id, canonical_case_id
        )
        select job_id, state, state, revision, fencing_token,
               'synthetic_rls_baseline_control', null, $2, now(), $1, canonical_case_id
        from target_job
        returning sequence::text`, [tenantId, eventSha256]);
      if (history.rowCount !== 1 || !history.rows[0]?.sequence) {
        throw new Error("RLS_SYNTHETIC_JOB_HISTORY_CONTROL_FAILED");
      }
      jobHistoryControls += 1;

      const subject = `rls-subject-${uniqueSuffix}`;
      const session = await client.query(`
        insert into public.product_identity_sessions (
          tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
          expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
        ) values ($1, $2, $3, $4, 0, now(), now() + interval '1 hour', null, null, $5, now())`, [
        tenantId,
        `rls-session-${uniqueSuffix}`,
        subject,
        `rls-token-${uniqueSuffix}`,
        createHash("sha256").update(`rls-session:${tenantId}:${uniqueSuffix}`).digest("hex"),
      ]);
      const owner = await client.query(`
        with target_case as (
          select canonical_case_id from public.engine_case_state
          where tenant_id = $1 order by updated_at, case_id limit 1
        )
        insert into public.product_case_owners (
          tenant_id, canonical_case_id, subject, revision, status,
          binding_sha256, created_at, revoked_at
        )
        select $1, canonical_case_id, $2, 1, 'active', $3, now(), null
        from target_case`, [
        tenantId,
        subject,
        createHash("sha256").update(`rls-owner:${tenantId}:${uniqueSuffix}`).digest("hex"),
      ]);
      const privacy = await client.query(`
        with target_case as (
          select canonical_case_id from public.engine_case_state
          where tenant_id = $1 order by updated_at, case_id limit 1
        )
        insert into public.product_privacy_request_versions (
          request_id, revision, tenant_id, canonical_case_id, request_kind, state,
          idempotency_key, command_sha256, legal_hold_conflict,
          grant_revocation_receipt_sha256, created_at
        )
        select $2, 1, $1, canonical_case_id, 'access', 'requested', $3, $4, false, null, now()
        from target_case`, [
        tenantId,
        `rls-request-${uniqueSuffix}`,
        `rls-privacy-${uniqueSuffix}`,
        createHash("sha256").update(`rls-privacy:${tenantId}:${uniqueSuffix}`).digest("hex"),
      ]);
      const reportObject = await client.query(`
        with target_report as (
          select tenant_id, canonical_case_id, report_id, revision, report_sha256, pdf_sha256
          from public.engine_report_versions
          where tenant_id = $1 order by created_at, report_id, revision limit 1
        )
        insert into public.product_private_report_objects (
          tenant_id, canonical_case_id, report_id, report_revision, report_sha256,
          object_version_id, provider_locator, byte_length, artifact_sha256,
          state, grant_epoch, revocation_receipt_sha256, revoked_at, created_at
        )
        select tenant_id, canonical_case_id, report_id, revision, report_sha256,
               $2, $3, 128, pdf_sha256, 'staged', 0, null, null, now()
        from target_report`, [
        tenantId,
        `rls-object-${uniqueSuffix}`,
        `synthetic/rls/${uniqueSuffix}`,
      ]);
      const insertedProductRows = [session, owner, privacy, reportObject]
        .reduce((sum, result) => sum + (result.rowCount ?? 0), 0);
      if (insertedProductRows !== 4) throw new Error("RLS_SYNTHETIC_PRODUCT_CONTROL_FAILED");
      productBoundaryControls += insertedProductRows;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (findingIds.length !== 2 || jobHistoryControls !== 2 || productBoundaryControls !== 8) {
    throw new Error("RLS_SYNTHETIC_CONTROL_DENOMINATOR_INVALID");
  }
  return Object.freeze({
    finding_ids: Object.freeze(findingIds),
    synthetic_control_rows_inserted: 12,
    synthetic_findings_inserted: 2,
    persistent_job_history_controls: 2,
  });
}

async function cleanupSyntheticFindings(admin: Pool, findingIds: readonly string[]): Promise<2> {
  if (findingIds.length !== 2) throw new Error("RLS_SYNTHETIC_FINDING_CLEANUP_DENOMINATOR_INVALID");
  const result = await admin.query<{ id: string }>(`
    delete from public.analysis_findings
    where id = any($1::uuid[])
    returning id::text`, [[...findingIds]]);
  if (result.rowCount !== 2) throw new Error("RLS_SYNTHETIC_FINDING_CLEANUP_FAILED");
  return 2;
}

async function deniedRole(
  role: "anon" | "authenticated",
  connectionUrl: string,
  tables: readonly TableColumn[],
): Promise<RlsRoleResult> {
  const target = pool(connectionUrl, `tivdoc-v091-rls-${role}`);
  let readsDenied = 0;
  let writesDenied = 0;
  let unexpected = 0;
  try {
    const client = await target.connect();
    try {
      await assertCurrentRole(client, role);
      for (const { table_name: tableName, first_column: firstColumn } of tables) {
        const table = identifier(tableName);
        const column = identifier(firstColumn);
        if (await denied(client, `select 1 from public.${table} limit 0`)) readsDenied += 1;
        else unexpected += 1;
        for (const sql of [
          `insert into public.${table} default values`,
          `update public.${table} set ${column} = ${column} where false`,
          `delete from public.${table} where false`,
        ]) {
          if (await denied(client, sql)) writesDenied += 1;
          else unexpected += 1;
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await target.end();
  }
  return Object.freeze({
    role,
    tables_checked: tables.length,
    reads_allowed: 0,
    reads_denied: readsDenied,
    writes_allowed: 0,
    writes_denied: writesDenied,
    unexpected_results: unexpected,
    status: unexpected === 0 && readsDenied === tables.length && writesDenied === tables.length * 3 ? "PASS" : "FAIL",
  });
}

async function serviceRole(connectionUrl: string, tables: readonly TableColumn[]): Promise<RlsRoleResult> {
  const target = pool(connectionUrl, "tivdoc-v091-rls-service");
  let readsAllowed = 0;
  let readsDenied = 0;
  let writesAllowed = 0;
  let writesDenied = 0;
  let unexpected = 0;
  try {
    const client = await target.connect();
    try {
      await assertCurrentRole(client, "service_role");
      await client.query("select set_config('tivdoc.tenant_id', $1, false)", ["rls-service-probe"]);
      for (const { table_name: tableName, first_column: firstColumn } of tables) {
        const table = identifier(tableName);
        const column = identifier(firstColumn);
        const privileges = await client.query<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(`
          select has_table_privilege(current_user, $1, 'SELECT') as can_select,
                 has_table_privilege(current_user, $1, 'INSERT') as can_insert,
                 has_table_privilege(current_user, $1, 'UPDATE') as can_update,
                 has_table_privilege(current_user, $1, 'DELETE') as can_delete`, [`public.${tableName}`]);
        const acl = privileges.rows[0];
        const expectedSelect = tableName !== "controlled_import_publication_markers";
        const expectedInsert = !["controlled_import_publication_markers", "product_privacy_request_versions"].includes(tableName);
        const selectAllowed = await succeeds(client, `select 1 from public.${table} limit 0`);
        if (acl?.can_select !== expectedSelect || selectAllowed !== expectedSelect) unexpected += 1;
        else if (selectAllowed) readsAllowed += 1;
        else readsDenied += 1;
        if (acl?.can_insert !== expectedInsert) unexpected += 1;
        else if (acl.can_insert) writesAllowed += 1;
        else writesDenied += 1;
        for (const [sql, expected] of [
          [`update public.${table} set ${column} = ${column} where false`, acl?.can_update === true],
          [`delete from public.${table} where false`, acl?.can_delete === true],
        ] as const) {
          const allowed = await succeeds(client, sql);
          if (allowed !== expected) unexpected += 1;
          else if (allowed) writesAllowed += 1;
          else writesDenied += 1;
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await target.end();
  }
  return Object.freeze({
    role: "service_role",
    tables_checked: tables.length,
    reads_allowed: readsAllowed,
    reads_denied: readsDenied,
    writes_allowed: writesAllowed,
    writes_denied: writesDenied,
    unexpected_results: unexpected,
    status: unexpected === 0 && readsAllowed + readsDenied === tables.length
      && writesAllowed + writesDenied === tables.length * 3 ? "PASS" : "FAIL",
  });
}

async function policyProbe(input: Readonly<{
  connection_url: string;
  tables: readonly TableColumn[];
  seed_controls: readonly TenantSeedControl[];
  case_confirmation_write_probe: CaseConfirmationWriteProbe;
  tenant_a: string;
  tenant_b: string;
}>): Promise<Readonly<{
  result: RlsRoleResult;
  tenant_policy_denominators: TenantPolicyDenominators;
  tenant_policy_table_results: readonly TenantPolicyTableResult[];
  seeded_own_tenant_rows: number;
  seeded_cross_tenant_control_rows: number;
  own_tenant_rows_visible: number;
  cross_tenant_rows_visible: number;
  cross_tenant_write_rejections: number;
  cross_tenant_write_rejected: boolean;
}>> {
  const target = pool(input.connection_url, "tivdoc-v091-rls-policy-probe");
  let readsAllowed = 0;
  let unexpected = 0;
  let ownTenantVisible = 0;
  let crossTenantVisible = 0;
  let crossTenantWriteRejections = 0;
  const tableResults: TenantPolicyTableResult[] = [];
  const controlsByTable = new Map(input.seed_controls.map((control) => [control.table_name, control]));
  try {
    const client = await target.connect();
    try {
      await assertCurrentRole(client, "tivdoc_policy_probe");
      await client.query("select set_config('tivdoc.tenant_id', $1, false)", [input.tenant_a]);
      for (const { table_name: tableName } of input.tables) {
        const table = identifier(tableName);
        const control = controlsByTable.get(tableName);
        if (!control) throw new Error("RLS_TENANT_SEED_CONTROL_MISSING");
        const result = await client.query<{ own_count: string; cross_count: string }>(
          `select count(*) filter (where tenant_id = $1)::text as own_count,
                  count(*) filter (where tenant_id is distinct from $1)::text as cross_count
           from public.${table}`,
          [input.tenant_a],
        );
        const ownCount = exactCount(result.rows[0]?.own_count);
        const crossCount = exactCount(result.rows[0]?.cross_count);
        const writeProbe = tableName === "case_confirmations"
          ? caseConfirmationWriteStatement(input.case_confirmation_write_probe, input.tenant_b)
          : Object.freeze({
            sql: `insert into public.${table} (tenant_id) values ($1)`,
            values: Object.freeze([input.tenant_b]),
          });
        const crossTenantWriteRejected = await denied(client, writeProbe.sql, writeProbe.values);
        const status = control.seeded_own_tenant_rows > 0
          && control.seeded_cross_tenant_control_rows > 0
          && ownCount === control.seeded_own_tenant_rows
          && crossCount === 0
          ? "PASS" : "FAIL";
        tableResults.push(Object.freeze({
          table: `public.${tableName}`,
          seeded_own_tenant_rows: control.seeded_own_tenant_rows,
          seeded_cross_tenant_control_rows: control.seeded_cross_tenant_control_rows,
          own_tenant_rows_visible: ownCount,
          cross_tenant_rows_visible: crossCount,
          cross_tenant_write_rejected: crossTenantWriteRejected,
          status: status === "PASS" && crossTenantWriteRejected ? "PASS" : "FAIL",
        }));
        ownTenantVisible += ownCount;
        crossTenantVisible += crossCount;
        readsAllowed += 1;
        if (crossTenantWriteRejected) crossTenantWriteRejections += 1;
        if (status !== "PASS" || !crossTenantWriteRejected) unexpected += 1;
      }
    } catch {
      unexpected += 1;
    } finally {
      client.release();
    }
  } finally {
    await target.end();
  }
  const tenantPolicyDenominators: TenantPolicyDenominators = Object.freeze({
    expected_tables: EXPECTED_POLICY_TABLE_NAMES.length,
    tested_tables: tableResults.length,
    tables_with_seeded_own_tenant_rows: tableResults.filter((entry) => entry.seeded_own_tenant_rows > 0).length,
    tables_with_seeded_cross_tenant_control_rows: tableResults
      .filter((entry) => entry.seeded_cross_tenant_control_rows > 0).length,
    tables_with_expected_own_tenant_visibility: tableResults
      .filter((entry) => entry.own_tenant_rows_visible === entry.seeded_own_tenant_rows
        && entry.seeded_own_tenant_rows > 0).length,
    tables_with_zero_cross_tenant_visibility: tableResults
      .filter((entry) => entry.seeded_cross_tenant_control_rows > 0 && entry.cross_tenant_rows_visible === 0).length,
    tables_with_cross_tenant_write_rejection: tableResults
      .filter((entry) => entry.cross_tenant_write_rejected).length,
  });
  const result: RlsRoleResult = Object.freeze({
    role: "tenant_policy_probe",
    tables_checked: input.tables.length,
    reads_allowed: readsAllowed,
    reads_denied: 0,
    writes_allowed: 0,
    writes_denied: crossTenantWriteRejections,
    unexpected_results: unexpected,
    status: unexpected === 0 && readsAllowed === input.tables.length
      && tenantPolicyDenominators.tested_tables === tenantPolicyDenominators.expected_tables
      && tenantPolicyDenominators.tables_with_seeded_own_tenant_rows === tenantPolicyDenominators.expected_tables
      && tenantPolicyDenominators.tables_with_seeded_cross_tenant_control_rows === tenantPolicyDenominators.expected_tables
      && tenantPolicyDenominators.tables_with_expected_own_tenant_visibility === tenantPolicyDenominators.expected_tables
      && tenantPolicyDenominators.tables_with_zero_cross_tenant_visibility === tenantPolicyDenominators.expected_tables
      && tenantPolicyDenominators.tables_with_cross_tenant_write_rejection === tenantPolicyDenominators.expected_tables
      && crossTenantVisible === 0 && crossTenantWriteRejections === tenantPolicyDenominators.expected_tables ? "PASS" : "FAIL",
  });
  return Object.freeze({
    result,
    tenant_policy_denominators: tenantPolicyDenominators,
    tenant_policy_table_results: Object.freeze(tableResults),
    seeded_own_tenant_rows: tableResults.reduce((total, entry) => total + entry.seeded_own_tenant_rows, 0),
    seeded_cross_tenant_control_rows: tableResults
      .reduce((total, entry) => total + entry.seeded_cross_tenant_control_rows, 0),
    own_tenant_rows_visible: ownTenantVisible,
    cross_tenant_rows_visible: crossTenantVisible,
    cross_tenant_write_rejections: crossTenantWriteRejections,
    cross_tenant_write_rejected: crossTenantWriteRejections === EXPECTED_POLICY_TABLE_NAMES.length,
  });
}

async function readCaseConfirmationWriteProbe(
  admin: Pool,
  tenantId: string,
): Promise<CaseConfirmationWriteProbe> {
  const result = await admin.query<CaseConfirmationWriteProbe>(`
    select case_id::text as case_id,
           id::text as analysis_run_id,
           canonical_case_id,
           canonical_analysis_run_id
    from public.analysis_runs
    where tenant_id = $1
      and canonical_case_id is not null
      and canonical_analysis_run_id is not null
    order by created_at, id
    limit 1`, [tenantId]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row?.case_id || !row.analysis_run_id
    || !row.canonical_case_id || !row.canonical_analysis_run_id) {
    throw new Error("RLS_CASE_CONFIRMATION_WRITE_PROBE_UNAVAILABLE");
  }
  return Object.freeze({ ...row });
}

function caseConfirmationWriteStatement(
  control: CaseConfirmationWriteProbe,
  crossTenantId: string,
): Readonly<{ sql: string; values: readonly string[] }> {
  const unique = randomUUID();
  return Object.freeze({
    sql: `insert into public.case_confirmations (
            id, case_id, source_analysis_run_id, target_fact_path, question_id,
            question_version, status, idempotency_key, tenant_id,
            canonical_confirmation_id, canonical_case_id, canonical_analysis_run_id
          ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, 1, 'pending', $6, $7, $8, $9, $10)`,
    values: Object.freeze([
      randomUUID(),
      control.case_id,
      control.analysis_run_id,
      "synthetic.rls.cross_tenant_write",
      "synthetic-rls-cross-tenant-write",
      `synthetic-rls-${unique}`,
      crossTenantId,
      `synthetic-rls-confirmation-${unique}`,
      control.canonical_case_id,
      control.canonical_analysis_run_id,
    ]),
  });
}

async function readTenantSeedControls(
  admin: Pool,
  tables: readonly TableColumn[],
  tenantA: string,
  tenantB: string,
): Promise<readonly TenantSeedControl[]> {
  const controls: TenantSeedControl[] = [];
  for (const { table_name: tableName } of tables) {
    const result = await admin.query<{ own_count: string; cross_count: string }>(
      `select count(*) filter (where tenant_id = $1)::text as own_count,
              count(*) filter (where tenant_id = $2)::text as cross_count
       from public.${identifier(tableName)}`,
      [tenantA, tenantB],
    );
    controls.push(Object.freeze({
      table_name: tableName,
      seeded_own_tenant_rows: exactCount(result.rows[0]?.own_count),
      seeded_cross_tenant_control_rows: exactCount(result.rows[0]?.cross_count),
    }));
  }
  return Object.freeze(controls);
}

function pool(connectionString: string, applicationName: string): Pool {
  return new Pool({ connectionString, application_name: applicationName, ssl: false, max: 2, allowExitOnIdle: true });
}

async function assertCurrentRole(client: PoolClient, expected: string): Promise<void> {
  const result = await client.query<{ current_user: string }>("select current_user");
  if (result.rows[0]?.current_user !== expected) throw new Error("RLS_ROLE_SESSION_MISMATCH");
}

async function denied(client: PoolClient, sql: string, values: readonly string[] = []): Promise<boolean> {
  try {
    await client.query("begin");
    await client.query(sql, values);
    await client.query("rollback");
    return false;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return isPostgresError(error) && error.code === "42501";
  }
}

async function succeeds(client: PoolClient, sql: string): Promise<boolean> {
  try {
    await client.query(sql);
    return true;
  } catch {
    return false;
  }
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("RLS_IDENTIFIER_UNSAFE");
  return `"${value}"`;
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactCount(value: string | undefined): number {
  const parsed = Number(value ?? -1);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("RLS_ROW_COUNT_INVALID");
  return parsed;
}

function isPostgresError(value: unknown): value is Readonly<{ code: string }> {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}
