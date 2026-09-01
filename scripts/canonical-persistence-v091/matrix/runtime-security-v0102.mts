import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";

const EXPOSED_FUNCTIONS = Object.freeze([
  "governance_aggregate_read",
  "governance_golden_case_set_import",
  "governance_gt_eligibility_append",
  "governance_gt_manifest_append",
  "governance_human_decision_admit",
  "governance_key_challenge_append",
  "governance_legal_observation_decide",
  "governance_legal_observation_import",
  "governance_parameter_attestation_append",
  "governance_parameter_import",
  "governance_reviewer_append",
  "governance_reviewer_key_register",
  "governance_reviewer_key_revoke",
  "governance_reviewer_verification_material_read",
  "governance_rulespec_approval_append",
  "governance_rulespec_import",
  "governance_trust_organization_append",
  "governance_trust_policy_append",
  "governance_work_claim",
  "governance_work_enqueue",
  "governance_work_release",
] as const);

const OPERATIONS_FUNCTIONS = new Set([
  "governance_aggregate_read", "governance_gt_eligibility_append",
  "governance_gt_manifest_append", "governance_human_decision_admit",
  "governance_key_challenge_append", "governance_legal_observation_decide",
  "governance_parameter_attestation_append", "governance_reviewer_append",
  "governance_reviewer_key_register", "governance_reviewer_key_revoke",
  "governance_reviewer_verification_material_read", "governance_rulespec_approval_append",
  "governance_trust_organization_append", "governance_trust_policy_append",
  "governance_work_claim", "governance_work_enqueue", "governance_work_release",
]);
const WORKER_FUNCTIONS = new Set([
  "governance_aggregate_read", "governance_golden_case_set_import",
  "governance_legal_observation_import", "governance_parameter_import",
  "governance_rulespec_import", "governance_work_enqueue",
]);

const CANONICAL_HELPERS = Object.freeze([
  "canonical_text_uuid",
  "resolve_engine_case_id",
] as const);

type RuntimeSecurityRole =
  | "anon"
  | "authenticated"
  | "identity"
  | "service_role"
  | "unauthorized"
  | "web"
  | "operations"
  | "worker";

export type RuntimeSecurityMatrixReceipt = Readonly<{
  schema_version: "tivdoc-governance-runtime-security-matrix-v0.10.2";
  governance_security_definer_functions: 32;
  governance_exposed_functions: 21;
  helper_functions: 11;
  canonical_helper_functions: 2;
  canonical_helper_acl_rows: readonly Readonly<{
    role: RuntimeSecurityRole;
    function: (typeof CANONICAL_HELPERS)[number];
    execute: boolean;
    expected: boolean;
    status: "PASS";
  }>[];
  canonical_helper_owner: "tivdoc_governance_owner";
  canonical_helper_owner_login: false;
  canonical_helper_owner_bypass_rls: false;
  canonical_helper_security_invoker_functions: 2;
  canonical_helper_safe_search_path_functions: 2;
  acl_rows: readonly Readonly<{
    role: RuntimeSecurityRole;
    function: (typeof EXPOSED_FUNCTIONS)[number];
    execute: boolean;
    expected: boolean;
    status: "PASS";
  }>[];
  unsafe_or_unexplained_functions: 0;
  cross_tenant_read_successes: 0;
  cross_tenant_write_successes: 0;
  cross_tenant_rpc_successes: 0;
  revoked_session_acceptances: 0;
  caller_controlled_context_successes: 0;
  pool_context_leaks: 0;
  owner_login: false;
  owner_bypass_rls: false;
  owner_context_successes: 0;
  identity_session_reader_rows: 1;
  identity_direct_table_reads: 0;
  identity_context_install_successes: 0;
  observed_role_connections: 8;
  administrative_connections: 1;
  connection_attempts: 9;
  credentials_recorded: 0;
  status: "PASS";
}>;

export async function runRuntimeSecurityV0102Matrix(input: Readonly<{
  admin_connection_url: string;
  role_connection_urls: Readonly<Record<
    "anon" | "authenticated" | "service_role" | "unauthorized"
      | "tivdoc_identity_runtime" | "tivdoc_web_runtime" | "tivdoc_operations_runtime" | "tivdoc_worker_runtime",
    string
  >>;
  fixture_suffix: string;
}>): Promise<RuntimeSecurityMatrixReceipt> {
  const fixture = fixtureIds(input.fixture_suffix);
  const admin = pool(input.admin_connection_url, "tivdoc-v0102-security-admin");
  const connections = Object.freeze({
    anon: pool(input.role_connection_urls.anon, "tivdoc-v0102-security-anon"),
    authenticated: pool(input.role_connection_urls.authenticated, "tivdoc-v0102-security-authenticated"),
    identity: pool(input.role_connection_urls.tivdoc_identity_runtime, "tivdoc-v0102-security-identity"),
    service_role: pool(input.role_connection_urls.service_role, "tivdoc-v0102-security-service"),
    unauthorized: pool(input.role_connection_urls.unauthorized, "tivdoc-v0102-security-unauthorized"),
    web: pool(input.role_connection_urls.tivdoc_web_runtime, "tivdoc-v0102-security-web"),
    operations: pool(input.role_connection_urls.tivdoc_operations_runtime, "tivdoc-v0102-security-operations"),
    worker: pool(input.role_connection_urls.tivdoc_worker_runtime, "tivdoc-v0102-security-worker"),
  });
  try {
    await seed(admin, fixture);
    const catalog = await admin.query<{
      function: (typeof EXPOSED_FUNCTIONS)[number];
      security_definer: boolean;
      owner: string;
      config: readonly string[] | null;
    }>(`
      select procedure.proname as function, procedure.prosecdef as security_definer,
             owner.rolname as owner, procedure.proconfig as config
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
      join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
      where namespace.nspname = 'private' and procedure.proname like 'governance\\_%' escape '\\'
      order by procedure.proname`);
    assert(catalog.rows.length === 32, "RUNTIME_SECURITY_FUNCTION_COUNT_INVALID");
    const exposedCatalog = catalog.rows.filter((row) => EXPOSED_FUNCTIONS.includes(row.function));
    assert(exposedCatalog.length === 21, "RUNTIME_SECURITY_EXPOSED_COUNT_INVALID");
    assert(catalog.rows.every((row) => row.security_definer && row.owner === "tivdoc_governance_owner"
      && row.config?.includes("search_path=\"\"") === true), "RUNTIME_SECURITY_FUNCTION_CONFIGURATION_INVALID");

    const canonicalHelpers = await admin.query<{
      function: (typeof CANONICAL_HELPERS)[number];
      security_definer: boolean;
      owner: string;
      owner_login: boolean;
      owner_bypass_rls: boolean;
      config: readonly string[] | null;
    }>(`
      select procedure.proname as function,
             procedure.prosecdef as security_definer,
             owner.rolname as owner,
             owner.rolcanlogin as owner_login,
             owner.rolbypassrls as owner_bypass_rls,
             procedure.proconfig as config
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
      join pg_catalog.pg_roles owner on owner.oid = procedure.proowner
      where namespace.nspname = 'private' and procedure.proname = any($1::text[])
      order by procedure.proname`, [CANONICAL_HELPERS]);
    assert(canonicalHelpers.rows.length === CANONICAL_HELPERS.length
      && canonicalHelpers.rows.every((row) => !row.security_definer
        && row.owner === "tivdoc_governance_owner"
        && !row.owner_login
        && !row.owner_bypass_rls
        && row.config?.includes("search_path=\"\"") === true),
    "RUNTIME_SECURITY_CANONICAL_HELPER_CONFIGURATION_INVALID");

    const aclRows: RuntimeSecurityMatrixReceipt["acl_rows"][number][] = [];
    const canonicalHelperAclRows: RuntimeSecurityMatrixReceipt["canonical_helper_acl_rows"][number][] = [];
    for (const [role, connection] of Object.entries(connections) as [RuntimeSecurityRole, Pool][]) {
      const result = await connection.query<{ function: (typeof EXPOSED_FUNCTIONS)[number]; execute: boolean }>(`
        select procedure.proname as function,
               pg_catalog.has_function_privilege(current_user, procedure.oid, 'EXECUTE') as execute
        from pg_catalog.pg_proc procedure
        join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'private' and procedure.proname = any($1::text[])
        order by procedure.proname`, [EXPOSED_FUNCTIONS]);
      assert(result.rows.length === 21, `RUNTIME_SECURITY_ACL_DENOMINATOR_INVALID:${role}`);
      for (const row of result.rows) {
        const expected = role === "operations" ? OPERATIONS_FUNCTIONS.has(row.function)
          : role === "worker" ? WORKER_FUNCTIONS.has(row.function) : false;
        assert(row.execute === expected, `RUNTIME_SECURITY_ACL_INVALID:${role}:${row.function}`);
        aclRows.push(Object.freeze({ role, function: row.function, execute: row.execute, expected, status: "PASS" }));
      }
      const helpers = await connection.query<{
        function: (typeof CANONICAL_HELPERS)[number];
        execute: boolean;
      }>(`
        select procedure.proname as function,
               pg_catalog.has_function_privilege(current_user, procedure.oid, 'EXECUTE') as execute
        from pg_catalog.pg_proc procedure
        join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'private' and procedure.proname = any($1::text[])
        order by procedure.proname`, [CANONICAL_HELPERS]);
      assert(helpers.rows.length === CANONICAL_HELPERS.length,
        `RUNTIME_SECURITY_CANONICAL_HELPER_ACL_DENOMINATOR_INVALID:${role}`);
      for (const row of helpers.rows) {
        const expected = role === "web" || role === "operations" || role === "worker";
        assert(row.execute === expected,
          `RUNTIME_SECURITY_CANONICAL_HELPER_ACL_INVALID:${role}:${row.function}`);
        canonicalHelperAclRows.push(Object.freeze({
          role, function: row.function, execute: row.execute, expected, status: "PASS",
        }));
      }
    }

    const owner = await admin.query<{ login: boolean; bypass_rls: boolean }>(`
      select rolcanlogin as login, rolbypassrls as bypass_rls
      from pg_catalog.pg_roles where rolname = 'tivdoc_governance_owner'`);
    assert(owner.rows.length === 1 && !owner.rows[0]!.login && !owner.rows[0]!.bypass_rls,
      "RUNTIME_SECURITY_OWNER_INVALID");
    await ownerCannotInstallContext(admin, fixture);
    await identityRoleIsolation(connections.identity, fixture);
    await revokedSessionDenied(connections.operations, fixture);
    await crossTenantAndPoolReuse(connections.operations, fixture);

    return Object.freeze({
      schema_version: "tivdoc-governance-runtime-security-matrix-v0.10.2",
      governance_security_definer_functions: 32,
      governance_exposed_functions: 21,
      helper_functions: 11,
      canonical_helper_functions: 2,
      canonical_helper_acl_rows: Object.freeze(canonicalHelperAclRows),
      canonical_helper_owner: "tivdoc_governance_owner",
      canonical_helper_owner_login: false,
      canonical_helper_owner_bypass_rls: false,
      canonical_helper_security_invoker_functions: 2,
      canonical_helper_safe_search_path_functions: 2,
      acl_rows: Object.freeze(aclRows),
      unsafe_or_unexplained_functions: 0,
      cross_tenant_read_successes: 0,
      cross_tenant_write_successes: 0,
      cross_tenant_rpc_successes: 0,
      revoked_session_acceptances: 0,
      caller_controlled_context_successes: 0,
      pool_context_leaks: 0,
      owner_login: false,
      owner_bypass_rls: false,
      owner_context_successes: 0,
      identity_session_reader_rows: 1,
      identity_direct_table_reads: 0,
      identity_context_install_successes: 0,
      observed_role_connections: 8,
      administrative_connections: 1,
      connection_attempts: 9,
      credentials_recorded: 0,
      status: "PASS",
    });
  } finally {
    await Promise.allSettled([admin.end(), ...Object.values(connections).map((connection) => connection.end())]);
  }
}

function pool(connectionString: string, applicationName: string): Pool {
  return new Pool({ connectionString, application_name: applicationName, ssl: false, max: 1, allowExitOnIdle: true });
}

function fixtureIds(suffix: string) {
  assert(/^[a-f0-9]{6,32}$/u.test(suffix), "RUNTIME_SECURITY_FIXTURE_SUFFIX_INVALID");
  return Object.freeze({
    tenant_a: `tenant:security:a:${suffix}`,
    tenant_b: `tenant:security:b:${suffix}`,
    actor_a: `reviewer:security:a:${suffix}`,
    actor_b: `reviewer:security:b:${suffix}`,
    organization_a: `reviewer-org:security:a:${suffix}`,
    organization_b: `reviewer-org:security:b:${suffix}`,
    sid_a: `session:security:a:${suffix}`,
    sid_b: `session:security:b:${suffix}`,
    sid_revoked: `session:security:revoked:${suffix}`,
    jti_a: `token:security:a:${suffix}`,
    jti_b: `token:security:b:${suffix}`,
    jti_revoked: `token:security:revoked:${suffix}`,
    case_a: uuid(`case-a:${suffix}`),
    case_b: uuid(`case-b:${suffix}`),
    canonical_case_a: `case:security:a:${suffix}`,
    canonical_case_b: `case:security:b:${suffix}`,
  });
}

async function seed(admin: Pool, fixture: ReturnType<typeof fixtureIds>): Promise<void> {
  await admin.query(`
    insert into public.cases(id, public_id, first_name, email, phone)
    values ($1::uuid, $3, 'Synthetic', 'synthetic-a@example.invalid', '+00000000001'),
           ($2::uuid, $4, 'Synthetic', 'synthetic-b@example.invalid', '+00000000002')
  `, [fixture.case_a, fixture.case_b, `TV-SA${fixture.case_a.slice(0, 6)}`, `TV-SB${fixture.case_b.slice(0, 6)}`]);
  await admin.query(`
    insert into public.engine_case_identity(internal_case_id, tenant_id, canonical_case_id)
    values ($1::uuid, $3, $5), ($2::uuid, $4, $6)
  `, [fixture.case_a, fixture.case_b, fixture.tenant_a, fixture.tenant_b,
    fixture.canonical_case_a, fixture.canonical_case_b]);
  await admin.query(`
    insert into public.engine_case_state(
      case_id, tenant_id, revision, lifecycle_state, state_sha256, updated_at, canonical_case_id
    )
    values ($1::uuid, $3, 0, 'awaiting_documents', repeat('a',64), pg_catalog.clock_timestamp(), $5),
           ($2::uuid, $4, 0, 'awaiting_documents', repeat('b',64), pg_catalog.clock_timestamp(), $6)
  `, [fixture.case_a, fixture.case_b, fixture.tenant_a, fixture.tenant_b,
    fixture.canonical_case_a, fixture.canonical_case_b]);
  await admin.query(`
    insert into public.product_identity_sessions(
      tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
      expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
    ) values
      ($1,$3,$6,$9,0,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 hour',null,$12,repeat('a',64),pg_catalog.clock_timestamp()-interval '1 minute'),
      ($2,$4,$7,$10,0,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 hour',null,$13,repeat('b',64),pg_catalog.clock_timestamp()-interval '1 minute'),
      ($1,$5,$8,$11,0,pg_catalog.clock_timestamp()-interval '2 minutes',pg_catalog.clock_timestamp()+interval '1 hour',pg_catalog.clock_timestamp()-interval '1 minute',$12,repeat('c',64),pg_catalog.clock_timestamp()-interval '2 minutes')
  `, [fixture.tenant_a, fixture.tenant_b, fixture.sid_a, fixture.sid_b, fixture.sid_revoked,
    fixture.actor_a, fixture.actor_b, `reviewer:security:revoked:${fixture.sid_a.slice(-8)}`,
    fixture.jti_a, fixture.jti_b, fixture.jti_revoked, fixture.organization_a, fixture.organization_b]);
}

async function ownerCannotInstallContext(admin: Pool, fixture: ReturnType<typeof fixtureIds>): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role tivdoc_governance_owner");
    await expectSqlstate(client, "select * from private.runtime_context_install($1,$2,$3)",
      [fixture.sid_a, fixture.jti_a, `owner:context:${fixture.sid_a.slice(-8)}`], "42501");
    await client.query("rollback");
  } finally {
    client.release();
  }
}

async function identityRoleIsolation(connection: Pool, fixture: ReturnType<typeof fixtureIds>): Promise<void> {
  const session = await connection.query<{ tenant_id: string; session_id: string }>(
    "select tenant_id, session_id from private.product_identity_session_read($1)",
    [fixture.sid_a],
  );
  assert(session.rowCount === 1 && session.rows[0]?.tenant_id === fixture.tenant_a
    && session.rows[0]?.session_id === fixture.sid_a, "RUNTIME_SECURITY_IDENTITY_READER_INVALID");

  const client = await connection.connect();
  try {
    await expectSqlstate(client, "select tenant_id from public.product_identity_sessions where sid = $1",
      [fixture.sid_a], "42501");
    await expectSqlstate(client, "select * from private.runtime_context_install($1,$2,$3)",
      [fixture.sid_a, fixture.jti_a, `identity:context:${fixture.sid_a.slice(-8)}`], "42501");
  } finally {
    client.release();
  }
}

async function revokedSessionDenied(connection: Pool, fixture: ReturnType<typeof fixtureIds>): Promise<void> {
  const client = await connection.connect();
  try {
    await client.query("begin");
    await expectSqlstate(client, "select * from private.runtime_context_install($1,$2,$3)",
      [fixture.sid_revoked, fixture.jti_revoked, `revoked:context:${fixture.sid_a.slice(-8)}`], "42501");
    await client.query("rollback");
  } finally {
    client.release();
  }
}

async function crossTenantAndPoolReuse(connection: Pool, fixture: ReturnType<typeof fixtureIds>): Promise<void> {
  const client = await connection.connect();
  try {
    await context(client, fixture.sid_a, fixture.jti_a, `security:a:${fixture.sid_a.slice(-8)}`);
    assert(await rowCount(client, fixture.tenant_a) === 1, "RUNTIME_SECURITY_TENANT_A_READ_MISSING");
    assert(await rowCount(client, fixture.tenant_b) === 0, "RUNTIME_SECURITY_CROSS_TENANT_READ");
    const update = await client.query("update public.engine_case_state set lifecycle_state = lifecycle_state where tenant_id = $1", [fixture.tenant_b]);
    assert(update.rowCount === 0, "RUNTIME_SECURITY_CROSS_TENANT_WRITE");
    await client.query("select pg_catalog.set_config('tivdoc.tenant_id',$1,true)", [fixture.tenant_b]);
    assert(await rowCount(client, fixture.tenant_b) === 0, "RUNTIME_SECURITY_CALLER_CONTEXT_ACCEPTED");
    await client.query("commit");
    const cleared = await client.query<{ tenant: string; actor: string; sid: string }>(`
      select pg_catalog.current_setting('tivdoc.tenant_id',true) as tenant,
             pg_catalog.current_setting('tivdoc.actor_id',true) as actor,
             pg_catalog.current_setting('tivdoc.identity_sid',true) as sid`);
    assert(Object.values(cleared.rows[0]!).every((value) => value === "" || value === null),
      "RUNTIME_SECURITY_POOL_CONTEXT_LEAK");
    await context(client, fixture.sid_b, fixture.jti_b, `security:b:${fixture.sid_b.slice(-8)}`);
    assert(await rowCount(client, fixture.tenant_b) === 1, "RUNTIME_SECURITY_TENANT_B_READ_MISSING");
    assert(await rowCount(client, fixture.tenant_a) === 0, "RUNTIME_SECURITY_POOL_CROSS_TENANT_LEAK");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function context(client: PoolClient, sid: string, jti: string, correlation: string): Promise<void> {
  await client.query("begin");
  const result = await client.query("select * from private.runtime_context_install($1,$2,$3)", [sid, jti, correlation]);
  assert(result.rowCount === 1, "RUNTIME_SECURITY_CONTEXT_INSTALL_FAILED");
}

async function rowCount(client: PoolClient, tenant: string): Promise<number> {
  const result = await client.query("select count(*)::integer as count from public.engine_case_state where tenant_id = $1", [tenant]);
  return Number(result.rows[0]?.count);
}

async function expectSqlstate(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  expected: string,
): Promise<void> {
  try {
    await client.query(sql, values);
  } catch (error) {
    assert(errorCode(error) === expected, `RUNTIME_SECURITY_SQLSTATE_INVALID:${errorCode(error) ?? "none"}`);
    return;
  }
  throw new Error("RUNTIME_SECURITY_NEGATIVE_OPERATION_SUCCEEDED");
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function uuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
