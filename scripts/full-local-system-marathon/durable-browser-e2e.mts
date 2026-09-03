import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pool, type PoolClient } from "pg";

import {
  applyCleanMigrationChain,
  applyCompatibilityBootstrap,
  assertOwnedClusterStopped,
  createOwnedDatabase,
  createOwnedLocalTarget,
  discoverMigrationChain,
  initializeOwnedCluster,
  inspectAuthenticodeInstalledPostgresRuntime,
  resolveDynamicPostgresPaths,
  selectRandomHighLoopbackPort,
  startOwnedCluster,
  stopOwnedCluster,
  type ApprovedPostgresTarget,
  type DynamicPostgresPaths,
  type PinnedPostgresBinaries,
} from "../canonical-persistence-v091/foundation/index.mts";
import {
  configureDynamicRoleSessions,
  configureRuntimeRoleSessions,
  generateDynamicRoleSecrets,
  generateRuntimeRoleSecrets,
  roleConnectionUrls,
  runtimeRoleConnectionUrls,
  targetConnectionUrl,
} from "../canonical-persistence-v091/orchestration/roles.mts";
import { marathonBrowserToolEnvironment } from "./browser-e2e-runtime.mts";
import {
  DURABLE_BROWSER_RECEIPT_SCHEMA,
  durableBrowserCsrfToken,
  durableBrowserFixtureIds,
  durableBrowserHmacKey,
  durableBrowserJwtClaims,
  durableBrowserRuntimeEnvironment,
  durableBrowserStorageState,
  generateDurableBrowserKeyMaterial,
  sha256,
  signDurableBrowserJwt,
  type DurableBrowserFixtureIds,
  type DurableBrowserIdentityFixture,
} from "./durable-browser-e2e-runtime.mts";

const ROOT = path.resolve(process.cwd());
const OUTPUT_ROOT = path.resolve(ROOT, "output", "playwright", "v0102-durable");
const CLI = path.resolve(ROOT, "node_modules", "@playwright", "cli", "playwright-cli.js");
const HTTPS_SERVER = path.resolve(
  ROOT,
  "scripts",
  "full-local-system-marathon",
  "durable-browser-https-server.mts",
);
const OPENSSL = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
const REQUIRED_TIMELINE_ACTIONS = Object.freeze([
  "RUNTIME_PRODUCT_BOUNDARY_UI",
  "RUNTIME_PRODUCT_BOUNDARY_HTTP",
  "RUNTIME_PRODUCT_BOUNDARY_IDENTITY_SESSION",
  "RUNTIME_PRODUCT_BOUNDARY_CANONICAL_ROOT",
  "RUNTIME_PRODUCT_BOUNDARY_POSTGRES_TRANSACTION",
  "RUNTIME_PRODUCT_JOB_OUTBOX_ENQUEUED",
  "RUNTIME_PRODUCT_FRESH_WORKER_STORED",
  "RUNTIME_PRODUCT_EXACT_REPORT_GRANTED",
  "RUNTIME_PRODUCT_AUTHENTICATED_DOWNLOAD",
] as const);

type CommandReceipt = Readonly<{
  command_id: string;
  exit_code: 0;
  stdout_sha256: string;
  stderr_sha256: string;
}>;

type BrowserFlowReceipt = Readonly<{
  command_receipts: readonly CommandReceipt[];
  downloaded_file: string;
  snapshots: readonly string[];
  cross_owner_denied: true;
  csrf_denied: true;
}>;

const runId = randomBytes(6).toString("hex");
const runOutput = path.resolve(OUTPUT_ROOT, "runs", runId);
const privateStorageRoot = path.resolve(runOutput, `tivdoc-private-runtime-${runId}`);
const downloadPath = path.resolve(runOutput, "tivdoc-approved-report.pdf");
const sessionName = `tivdoc-v0102-${runId}`;
const fixture = durableBrowserFixtureIds(runId);
const serverOutputHash = createHash("sha256");
let serverOutputBytes = 0;
let serverOutputLineBuffer = "";
let safeServerRuntimeFailure: string | null = null;
let target: ApprovedPostgresTarget | null = null;
let paths: DynamicPostgresPaths | null = null;
let binaries: PinnedPostgresBinaries | null = null;
let admin: Pool | null = null;
let server: ChildProcessWithoutNullStreams | null = null;
let temporaryRoot: string | null = null;
let browserOpened = false;
let clusterStarted = false;
let primaryError: unknown = null;
let cleanupReceipt: Readonly<Record<string, unknown>> | null = null;

await mkdir(runOutput, { recursive: true });
assertIgnoredOutput();

try {
  const build = await inspectProductionBuild();
  const postgresPort = await selectRandomHighLoopbackPort();
  target = createOwnedLocalTarget({ port: postgresPort, suffix: `durable_${runId}` });
  paths = resolveDynamicPostgresPaths(ROOT, target);
  const prepared = await inspectAuthenticodeInstalledPostgresRuntime(paths);
  binaries = prepared.binaries;
  await initializeOwnedCluster({ target, paths, binaries });
  await startOwnedCluster({ target, paths, binaries });
  clusterStarted = true;
  await createOwnedDatabase({ target, paths, binaries });
  const chain = await discoverMigrationChain(paths);
  const bootstrap = await applyCompatibilityBootstrap({ target, paths, binaries });
  const adminUrl = targetConnectionUrl(target);
  const dynamicSecrets = generateDynamicRoleSecrets();
  const dynamicRoles = await configureDynamicRoleSessions({
    admin_connection_url: adminUrl,
    secrets: dynamicSecrets,
  });
  const migrations = await applyCleanMigrationChain({ target, paths, binaries, chain });
  const runtimeSecrets = generateRuntimeRoleSecrets();
  const runtimeRoles = await configureRuntimeRoleSessions({
    admin_connection_url: adminUrl,
    secrets: runtimeSecrets,
  });
  const runtimeUrls = runtimeRoleConnectionUrls({
    target,
    database: target.descriptor.database,
    secrets: runtimeSecrets,
  });
  const dynamicUrls = roleConnectionUrls({
    target,
    database: target.descriptor.database,
    secrets: dynamicSecrets,
  });
  admin = new Pool({
    connectionString: adminUrl,
    application_name: "tivdoc-v0102-durable-browser-e2e-admin",
    ssl: false,
    max: 2,
    allowExitOnIdle: true,
  });
  await admin.query("alter role tivdoc_operations_runtime set log_statement = 'all'");

  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + 1_800;
  const seed = await seedSyntheticFixture(admin, fixture, issuedAt, expiresAt + 600);
  const privacyBefore = await privacyRequestCount(admin, fixture);
  assert(privacyBefore === 0, "DURABLE_BROWSER_PRIVACY_PRECONDITION_INVALID");

  temporaryRoot = await mkdtemp(path.join(tmpdir(), "tivdoc-v0102-browser-"));
  assertOwnedTemporaryRoot(temporaryRoot);
  const certificate = await createEphemeralCertificate(temporaryRoot);
  const httpsPort = await selectRandomHighLoopbackPort();
  const origin = `https://127.0.0.1:${httpsPort}`;
  const issuer = "https://identity.synthetic.invalid";
  const keyMaterial = generateDurableBrowserKeyMaterial(runId);
  const runtimeEnvironment = durableBrowserRuntimeEnvironment({
    system_environment: process.env,
    build_identity_sha: build.git_head,
    allowed_origin: origin,
    issuer,
    key_id: keyMaterial.key_id,
    public_key_spki_pem: keyMaterial.public_key_spki_pem,
    key_not_before_epoch: issuedAt - 60,
    key_expires_at_epoch: expiresAt + 600,
    identity_postgres_url: runtimeUrls.tivdoc_identity_runtime,
    web_postgres_url: runtimeUrls.tivdoc_web_runtime,
    operations_postgres_url: runtimeUrls.tivdoc_operations_runtime,
    worker_postgres_url: runtimeUrls.tivdoc_worker_runtime,
    private_storage_root: privateStorageRoot,
    download_grant_hmac_key_base64url: durableBrowserHmacKey(),
    worker: fixture.worker,
    tenant_id: fixture.tenant_id,
  });
  const playwrightConfig = path.resolve(temporaryRoot, "playwright-cli.json");
  await writeFile(playwrightConfig, `${JSON.stringify({
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: { channel: "msedge", headless: true },
      contextOptions: {
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        locale: "he-IL",
        viewport: { width: 1_440, height: 900 },
      },
    },
    outputDir: runOutput,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  server = spawn(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    HTTPS_SERVER,
  ], {
    cwd: ROOT,
    env: {
      ...runtimeEnvironment,
      TIVDOC_DURABLE_BROWSER_HTTPS_PORT: String(httpsPort),
      TIVDOC_DURABLE_BROWSER_CERTIFICATE_PATH: certificate.certificate_path,
      TIVDOC_DURABLE_BROWSER_PRIVATE_KEY_PATH: certificate.private_key_path,
    },
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      serverOutputHash.update(bytes);
      serverOutputBytes += bytes.byteLength;
      if (stream === server?.stdout) {
        serverOutputLineBuffer += bytes.toString("utf8");
        let newline = serverOutputLineBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = serverOutputLineBuffer.slice(0, newline);
          serverOutputLineBuffer = serverOutputLineBuffer.slice(newline + 1);
          const match = /^TIVDOC_SAFE_RUNTIME_FAILURE:([A-Z][A-Z0-9_]{2,120})$/u.exec(line);
          if (match?.[1]) safeServerRuntimeFailure = match[1];
          newline = serverOutputLineBuffer.indexOf("\n");
        }
      }
    });
  }
  await waitForHttpsServer(origin, server);

  const identities = Object.freeze({
    legal: sessionState(
      fixture.legal_reviewer,
      fixture,
      issuer,
      issuedAt,
      expiresAt,
      keyMaterial.key_id,
      keyMaterial.private_key,
    ),
    approver: sessionState(
      fixture.report_approver,
      fixture,
      issuer,
      issuedAt,
      expiresAt,
      keyMaterial.key_id,
      keyMaterial.private_key,
    ),
    owner: sessionState(
      fixture.owner,
      fixture,
      issuer,
      issuedAt,
      expiresAt,
      keyMaterial.key_id,
      keyMaterial.private_key,
    ),
    cross_owner: sessionState(
      fixture.cross_owner,
      fixture,
      issuer,
      issuedAt,
      expiresAt,
      keyMaterial.key_id,
      keyMaterial.private_key,
    ),
  });
  const browser = await runRenderedBrowserFlow({
    origin,
    playwright_config: playwrightConfig,
    temporary_root: temporaryRoot,
    fixture,
    expires_at_epoch: expiresAt,
    identities,
  });
  browserOpened = true;

  const evidence = await collectDurableEvidence(admin, fixture, downloadPath, privacyBefore);
  const artifactReceipts = await collectArtifactReceipts(runOutput, browser.snapshots, browser.downloaded_file);

  cleanupReceipt = await cleanupRuntime();
  const receipt = Object.freeze({
    schema_version: DURABLE_BROWSER_RECEIPT_SCHEMA,
    status: "PASS",
    proof_class: "REAL_RENDERED_BROWSER_TO_ISOLATED_POSTGRESQL_DURABLE_PRODUCT_PATH",
    run_id_sha256: sha256(runId),
    execution_scope: "local_only",
    browser: Object.freeze({
      engine: "msedge",
      playwright_cli: true,
      rendered_ui: true,
      ignore_https_errors_for_ephemeral_certificate_only: true,
      origin,
      direct_service_shortcuts: false,
      command_count: browser.command_receipts.length,
      commands: browser.command_receipts,
      cross_owner_denied: browser.cross_owner_denied,
      csrf_denied: browser.csrf_denied,
    }),
    identity: Object.freeze({
      proof: "RS256_COOKIE_ONLY_WITH_AUTHORITATIVE_POSTGRESQL_SESSION_RECHECK",
      secure_host_cookie: true,
      legal_reviewer_and_report_approver_distinct: fixture.legal_reviewer.actor_id !== fixture.report_approver.actor_id,
      reviewer_organizations_distinct:
        fixture.legal_reviewer.reviewer_organization_id !== fixture.report_approver.reviewer_organization_id,
      customer_owner_distinct: fixture.owner.actor_id !== fixture.report_approver.actor_id,
      synthetic_session_count: 5,
      identity_values_emitted: 0,
      credentials_emitted: 0,
    }),
    postgres: Object.freeze({
      target: target.descriptor,
      owned_isolated_loopback: true,
      postgres_version: binaries.postgres_version,
      compatibility_bootstrap_applied: bootstrap.applied_count,
      migration_count: migrations.applied_count,
      migration_names_sha256: sha256(chain.migrations.map((item) => item.name).join("\n")),
      dynamic_roles: dynamicRoles,
      runtime_roles: runtimeRoles,
      service_role_product_requests: 0,
      role_urls_emitted: 0,
      dynamic_role_url_count: Object.keys(dynamicUrls).length,
    }),
    runtime: Object.freeze({
      durable_runtime_sentinel: true,
      production_next_build: build,
      https: Object.freeze({
        ephemeral_self_signed_certificate: true,
        raw_tls_host_pinned: true,
        strict_next_request_origin_adapter: true,
        certificate_sha256: certificate.certificate_sha256,
        certificate_private_key_emitted: 0,
      }),
      server_output_sha256: serverOutputHash.digest("hex"),
      server_output_bytes: serverOutputBytes,
      private_storage_root_emitted: 0,
      customer_processing_enabled: false,
      customer_shadow_enabled: false,
      production_delivery_enabled: false,
      openai_live_tests: false,
      real_legal_activations: 0,
      customer_documents_used: 0,
      remote_connections: 0,
    }),
    synthetic_seed: seed,
    durable_evidence: evidence,
    artifacts: artifactReceipts,
    cleanup: cleanupReceipt,
  });
  assertReceiptContainsNoSecrets(receipt);
  await writeFile(path.resolve(runOutput, "durable-browser-e2e-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(path.resolve(OUTPUT_ROOT, "durable-browser-e2e-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  const diagnostic = admin === null
    ? null
    : await durableFailureDiagnostic(admin, fixture).catch(() => null);
  const primaryCode = safeErrorCode(error);
  const serverCode = safeServerRuntimeFailure === null ? "" : `:SERVER_${safeServerRuntimeFailure}`;
  primaryError = new Error(`${diagnostic === null ? primaryCode : `${primaryCode}:${diagnostic}`}${serverCode}`);
} finally {
  if (!cleanupReceipt) {
    try {
      cleanupReceipt = await cleanupRuntime();
    } catch (cleanupError) {
      if (!primaryError) primaryError = cleanupError;
    }
  }
}

if (primaryError) throw primaryError;

async function seedSyntheticFixture(
  connection: Pool,
  ids: DurableBrowserFixtureIds,
  issuedAtEpoch: number,
  sessionExpiresEpoch: number,
) {
  const client = await connection.connect();
  const factPayload = Object.freeze({
    canonical_path: "synthetic.monthly.gross_minor_units",
    status: "confirmed",
    provenance_count: 1,
    conflict_count: 0,
  });
  const factSha256 = sha256(JSON.stringify(factPayload));
  const stateSha256 = sha256(JSON.stringify({
    tenant_id: ids.tenant_id,
    case_id: ids.case_id,
    revision: 1,
    state: "ready_for_legal_evaluation",
  }));
  const commandSha256 = sha256(`synthetic-seed-command:${runId}`);
  const eventSha256 = sha256(`synthetic-seed-event:${stateSha256}`);
  const ownerBindingSha256 = sha256(`synthetic-owner-binding:${ids.owner.actor_id}:${ids.case_id}`);
  try {
    await client.query("begin");
    await client.query(`
      insert into public.engine_case_identity(internal_case_id, tenant_id, canonical_case_id)
      values ($1::uuid, $2, $3)`, [ids.internal_case_id, ids.tenant_id, ids.case_id]);
    await client.query(`
      insert into public.engine_case_state(
        case_id, tenant_id, canonical_case_id, revision, lifecycle_state, state_sha256, updated_at
      ) values (
        $1::uuid, $2, $3, 1, 'ready_for_legal_evaluation', $4, to_timestamp($5)
      )`, [ids.internal_case_id, ids.tenant_id, ids.case_id, stateSha256, issuedAtEpoch - 5]);
    await client.query(`
      insert into public.engine_case_lifecycle_revisions(
        case_id, tenant_id, revision, state_before, state_after, event_kind,
        command_sha256, event_sha256, previous_sha256, occurred_at
      ) values (
        $1::uuid, $2, 1, null, 'ready_for_legal_evaluation', 'synthetic.fixture.ready',
        $3, $4, null, to_timestamp($5)
      )`, [ids.internal_case_id, ids.tenant_id, commandSha256, eventSha256, issuedAtEpoch - 5]);
    await client.query(`
      insert into public.engine_canonical_fact_versions(
        fact_id, revision, tenant_id, case_id, analysis_run_id, payload,
        payload_sha256, created_at, canonical_case_id, canonical_analysis_run_id
      ) values (
        $1, 1, $2, $3::uuid, null, $4::jsonb, $5, to_timestamp($6), $7, null
      )`, [ids.fact_id, ids.tenant_id, ids.internal_case_id, JSON.stringify(factPayload),
      factSha256, issuedAtEpoch - 4, ids.case_id]);
    for (const identity of [ids.legal_reviewer, ids.report_approver, ids.owner, ids.cross_owner, ids.worker]) {
      await insertIdentitySession(
        client,
        ids.tenant_id,
        identity,
        issuedAtEpoch,
        sessionExpiresEpoch,
      );
    }
    await client.query(`
      insert into public.product_case_owners(
        tenant_id, canonical_case_id, subject, revision, status,
        binding_sha256, created_at, revoked_at
      ) values ($1, $2, $3, 1, 'active', $4, to_timestamp($5), null)`, [
      ids.tenant_id,
      ids.case_id,
      ids.owner.actor_id,
      ownerBindingSha256,
      issuedAtEpoch - 4,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return Object.freeze({
    schema_version: "tivdoc-durable-browser-synthetic-seed-v0.10.2",
    status: "PASS",
    tenant_sha256: sha256(ids.tenant_id),
    case_sha256: sha256(ids.case_id),
    fact_payload_sha256: factSha256,
    initial_state_sha256: stateSha256,
    owner_binding_sha256: ownerBindingSha256,
    initial_case_revision: 1,
    initial_state: "ready_for_legal_evaluation",
    synthetic_only: true,
    customer_documents: 0,
    active_legal_sources: 0,
    active_legal_parameters: 0,
    active_israeli_rules: 0,
  });
}

async function insertIdentitySession(
  client: PoolClient,
  tenantId: string,
  identity: DurableBrowserIdentityFixture,
  issuedAtEpoch: number,
  expiresAtEpoch: number,
): Promise<void> {
  const sessionSha256 = sha256(JSON.stringify({
    tenant_id: tenantId,
    sid: identity.session_id,
    subject: identity.actor_id,
    jti: identity.token_id,
    reviewer_organization_id: identity.reviewer_organization_id,
  }));
  await client.query(`
    insert into public.product_identity_sessions(
      tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
      expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
    ) values (
      $1, $2, $3, $4, 1, to_timestamp($5), to_timestamp($6), null, $7, $8, to_timestamp($5)
    )`, [tenantId, identity.session_id, identity.actor_id, identity.token_id,
    issuedAtEpoch - 5, expiresAtEpoch, identity.reviewer_organization_id, sessionSha256]);
}

function sessionState(
  identity: DurableBrowserIdentityFixture,
  ids: DurableBrowserFixtureIds,
  issuer: string,
  issuedAtEpoch: number,
  expiresAtEpoch: number,
  keyId: string,
  privateKey: Parameters<typeof signDurableBrowserJwt>[2],
) {
  const csrfToken = durableBrowserCsrfToken();
  const claims = durableBrowserJwtClaims({
    fixture: identity,
    tenant_id: ids.tenant_id,
    case_id: ids.case_id,
    issuer,
    issued_at_epoch: issuedAtEpoch,
    expires_at_epoch: expiresAtEpoch,
  });
  return Object.freeze({
    csrf_token: csrfToken,
    state: durableBrowserStorageState({
      compact_jwt: signDurableBrowserJwt(claims, keyId, privateKey),
      csrf_token: csrfToken,
      expires_at_epoch: expiresAtEpoch,
    }),
  });
}

async function runRenderedBrowserFlow(input: Readonly<{
  origin: string;
  playwright_config: string;
  temporary_root: string;
  fixture: DurableBrowserFixtureIds;
  expires_at_epoch: number;
  identities: Readonly<Record<"legal" | "approver" | "owner" | "cross_owner", Readonly<{
    csrf_token: string;
    state: ReturnType<typeof durableBrowserStorageState>;
  }>>>;
}>): Promise<BrowserFlowReceipt> {
  const commands: CommandReceipt[] = [];
  const snapshots: string[] = [];
  commands.push(runCli("open_https", [
    "open",
    input.origin,
    "--browser",
    "msedge",
    "--config",
    input.playwright_config,
  ]));
  browserOpened = true;
  commands.push(runCli("resize_desktop", ["resize", "1440", "900"]));

  await loadIdentity("legal", input.identities.legal.state, input.temporary_root, commands);
  commands.push(runCli("goto_operations_legal", ["goto", `${input.origin}/operations`]));
  snapshots.push(await captureSnapshot("operations-legal-before-analysis", commands));
  commands.push(runCode("legal_analysis_rendered_action", `async (page) => {
    const preflight = await page.evaluate(async () => {
      const response = await fetch('/api/operations/capabilities', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      return {
        status: response.status,
        productBoundary: response.headers.get('x-content-type-options') === 'nosniff'
          && response.headers.get('x-robots-tag') === 'noindex, nofollow, noarchive',
      };
    });
    const cookieNames = (await page.context().cookies(${JSON.stringify(input.origin)}))
      .map((cookie) => cookie.name)
      .sort();
    const cookieShape = cookieNames.join(',') === '__Host-tivdoc_identity,tivdoc_csrf'
      ? 'COOKIE_SHAPE_EXACT'
      : 'COOKIE_SHAPE_INVALID';
    if (preflight.status !== 200) {
      throw new Error('OPERATIONS_PREFLIGHT_' + preflight.status + '_'
        + (preflight.productBoundary ? 'PRODUCT_BOUNDARY' : 'BARE_ROUTE') + '_' + cookieShape);
    }
    await page.getByTestId('load-operations').click();
    const queueButton = page.locator('aside[aria-label="תור עבודה"] button').filter({ hasText: ${JSON.stringify(input.fixture.case_id)} });
    await queueButton.waitFor({ state: 'visible', timeout: 20000 });
    await queueButton.click();
    const action = page.getByTestId('run-analysis');
    await action.waitFor({ state: 'visible', timeout: 20000 });
    if (await action.isDisabled()) throw new Error('ANALYSIS_ACTION_DISABLED');
    const responsePromise = page.waitForResponse((response) => response.url().includes('/analysis/request') && response.request().method() === 'POST', { timeout: 60000 });
    await action.click();
    const response = await responsePromise;
    if (response.status() !== 200) throw new Error('ANALYSIS_HTTP_' + response.status());
    await page.getByRole('status').filter({ hasText: 'התיק נטען מהשירות הקנוני.' }).waitFor({ state: 'visible', timeout: 20000 });
    return { status: response.status(), title: await page.title() };
  }`, 90_000));
  snapshots.push(await captureSnapshot("operations-legal-after-analysis", commands));

  await loadIdentity("approver", input.identities.approver.state, input.temporary_root, commands);
  commands.push(runCli("goto_operations_approver", ["goto", `${input.origin}/operations`]));
  snapshots.push(await captureSnapshot("operations-approver-before-approval", commands));
  commands.push(runCode("distinct_approver_rendered_action", `async (page) => {
    await page.getByTestId('load-operations').click();
    const queueButton = page.locator('aside[aria-label="תור עבודה"] button').filter({ hasText: ${JSON.stringify(input.fixture.case_id)} });
    await queueButton.waitFor({ state: 'visible', timeout: 20000 });
    await queueButton.click();
    const action = page.getByTestId('approve-report');
    await action.waitFor({ state: 'visible', timeout: 20000 });
    if (await action.isDisabled()) throw new Error('APPROVAL_ACTION_DISABLED');
    const responsePromise = page.waitForResponse((response) => response.url().includes('/report/approve') && response.request().method() === 'POST', { timeout: 60000 });
    await action.click();
    const response = await responsePromise;
    if (response.status() !== 200) throw new Error('APPROVAL_HTTP_' + response.status());
    await page.getByRole('status').filter({ hasText: 'התיק נטען מהשירות הקנוני.' }).waitFor({ state: 'visible', timeout: 20000 });
    return { status: response.status(), title: await page.title() };
  }`, 90_000));
  snapshots.push(await captureSnapshot("operations-approver-after-approval", commands));

  await loadIdentity("owner", input.identities.owner.state, input.temporary_root, commands);
  commands.push(runCli("goto_portal_owner", ["goto", `${input.origin}/portal`]));
  commands.push(runCode("owner_portal_report_visible", `async (page) => {
    const button = page.getByTestId('download-report');
    await button.waitFor({ state: 'visible', timeout: 30000 });
    if (await button.isDisabled()) throw new Error('DOWNLOAD_ACTION_DISABLED');
    return { title: await page.title() };
  }`));
  snapshots.push(await captureSnapshot("portal-owner-approved-report", commands));
  commands.push(runCode("owner_exact_download", `async (page) => {
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.getByTestId('download-report').click();
    const download = await downloadPromise;
    await download.saveAs(${JSON.stringify(downloadPath)});
    await page.getByRole('status').filter({ hasText: 'הדוח המאושר הורד.' }).waitFor({ state: 'visible', timeout: 20000 });
    return { suggestedFilename: download.suggestedFilename() };
  }`, 60_000));

  await loadIdentity("cross-owner", input.identities.cross_owner.state, input.temporary_root, commands);
  commands.push(runCode("cross_owner_rendered_denial", `async (page) => {
    const denial = page.waitForResponse((response) => response.url().includes('/api/portal/cases/') && response.request().method() === 'GET', { timeout: 30000 });
    const documentResponse = await page.goto(${JSON.stringify(`${input.origin}/portal`)}, { waitUntil: 'domcontentloaded' });
    if (!documentResponse || documentResponse.status() !== 200) throw new Error('CROSS_OWNER_DOCUMENT_NOT_RENDERED');
    const response = await denial;
    if (response.status() !== 404) throw new Error('CROSS_OWNER_HTTP_' + response.status());
    await page.getByRole('alert').filter({ hasText: 'לא ניתן להציג את התיק' }).waitFor({ state: 'visible', timeout: 20000 });
    return { documentStatus: documentResponse.status(), apiStatus: response.status() };
  }`));
  snapshots.push(await captureSnapshot("portal-cross-owner-denied", commands));

  await loadIdentity("owner-csrf", input.identities.owner.state, input.temporary_root, commands);
  commands.push(runCli("goto_portal_owner_csrf", ["goto", `${input.origin}/portal`]));
  commands.push(runCode("owner_portal_ready_for_csrf_test", `async (page) => {
    await page.getByTestId('privacy-request').waitFor({ state: 'visible', timeout: 30000 });
    return true;
  }`));
  const wrongCsrf = durableBrowserCsrfToken();
  assert(wrongCsrf !== input.identities.owner.csrf_token, "DURABLE_BROWSER_CSRF_FIXTURE_COLLISION");
  commands.push(runCli("replace_csrf_cookie_after_render", [
    "cookie-set",
    "tivdoc_csrf",
    wrongCsrf,
    "--domain",
    "127.0.0.1",
    "--path",
    "/",
    "--expires",
    String(input.expires_at_epoch),
    "--secure",
    "--sameSite",
    "Strict",
  ]));
  commands.push(runCode("csrf_rendered_denial", `async (page) => {
    const responsePromise = page.waitForResponse((response) => response.url().includes('/privacy') && response.request().method() === 'POST', { timeout: 30000 });
    await page.getByTestId('privacy-request').click();
    const response = await responsePromise;
    if (response.status() !== 404) throw new Error('CSRF_HTTP_' + response.status());
    await page.getByRole('status').filter({ hasText: 'לא ניתן לבצע את הפעולה.' }).waitFor({ state: 'visible', timeout: 20000 });
    return { status: response.status() };
  }`));
  snapshots.push(await captureSnapshot("portal-csrf-denied", commands));
  commands.push(runCli("browser_console_errors", ["console", "error"]));
  return Object.freeze({
    command_receipts: Object.freeze(commands),
    downloaded_file: downloadPath,
    snapshots: Object.freeze(snapshots),
    cross_owner_denied: true,
    csrf_denied: true,
  });
}

async function loadIdentity(
  name: string,
  state: ReturnType<typeof durableBrowserStorageState>,
  temporaryRootPath: string,
  commands: CommandReceipt[],
): Promise<void> {
  const statePath = path.resolve(temporaryRootPath, `identity-${name}.json`);
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    commands.push(runCli(`identity_${name}`, ["state-load", statePath]));
  } finally {
    await unlink(statePath).catch(() => undefined);
  }
}

async function captureSnapshot(name: string, commands: CommandReceipt[]): Promise<string> {
  const markdown = path.resolve(runOutput, `${name}.md`);
  const screenshot = path.resolve(runOutput, `${name}.png`);
  commands.push(runCli(`snapshot_${name}`, ["snapshot", "--filename", markdown]));
  commands.push(runCli(`screenshot_${name}`, ["screenshot", "--filename", screenshot, "--full-page"]));
  return markdown;
}

function runCode(commandId: string, code: string, timeout = 60_000): CommandReceipt {
  return runCli(commandId, ["run-code", code], timeout);
}

function runCli(commandId: string, args: readonly string[], timeout = 60_000): CommandReceipt {
  const result = spawnSync(process.execPath, [CLI, `-s=${sessionName}`, ...args], {
    cwd: ROOT,
    env: marathonBrowserToolEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    const safeOutput = `${result.stdout}\n${result.stderr}`;
    const diagnostic = /(OPERATIONS_PREFLIGHT_[A-Z0-9_]{2,180})/u.exec(safeOutput)?.[1]
      ?? /Error:\s+([A-Z][A-Z0-9_:.-]{2,180})/u.exec(safeOutput)?.[1]
      ?? "NO_SAFE_DIAGNOSTIC";
    throw new Error(`DURABLE_BROWSER_CLI_FAILED:${commandId}:${diagnostic}`);
  }
  return Object.freeze({
    command_id: commandId,
    exit_code: 0,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
  });
}

async function collectDurableEvidence(
  connection: Pool,
  ids: DurableBrowserFixtureIds,
  downloadedPath: string,
  privacyBefore: number,
) {
  const jobResult = await connection.query(`
    select job_id, state, revision::text, attempt_count, lease_owner, terminal_effect_sha256,
           payload, payload_sha256
    from public.engine_durable_jobs
    where tenant_id = $1 and canonical_case_id = $2
    order by created_at desc limit 1`, [ids.tenant_id, ids.case_id]);
  assert(jobResult.rowCount === 1, "DURABLE_BROWSER_JOB_MISSING");
  const job = record(jobResult.rows[0]);
  const envelope = record(job.payload);
  const timeline = record(envelope.timeline);
  const pipeline = record(envelope.pipeline);
  assert(job.state === "succeeded", "DURABLE_BROWSER_JOB_NOT_SUCCEEDED");
  assert(Number(job.attempt_count) === 1, "DURABLE_BROWSER_JOB_ATTEMPT_INVALID");
  assert(job.lease_owner === ids.worker.actor_id, "DURABLE_BROWSER_WORKER_IDENTITY_INVALID");
  assert(envelope.analysis_mode === "synthetic_seven_topic_only"
    && envelope.legal_rules_activated === 0, "DURABLE_BROWSER_SYNTHETIC_MODE_INVALID");
  assert(timeline.tenant_id === ids.tenant_id && timeline.case_id === ids.case_id,
    "DURABLE_BROWSER_TIMELINE_SCOPE_INVALID");
  assert(timeline.actor_id === ids.legal_reviewer.actor_id,
    "DURABLE_BROWSER_LEGAL_REVIEWER_BINDING_INVALID");
  assert(job.terminal_effect_sha256 === pipeline.logical_effect_sha256,
    "DURABLE_BROWSER_TERMINAL_EFFECT_INVALID");

  const history = await connection.query(`
    select to_state, reason_code, revision::text, fencing_token::text, event_sha256
    from public.engine_job_history where job_id = $1 order by sequence`, [job.job_id]);
  assert(history.rows.some((row) => row.to_state === "succeeded"),
    "DURABLE_BROWSER_JOB_HISTORY_INCOMPLETE");
  const outbox = await exactlyOneQuery(connection, `
    select state, logical_effect_id, payload_sha256, published_at::text
    from public.engine_outbox_events where outbox_id = $1`, [pipeline.outbox_id],
  "DURABLE_BROWSER_OUTBOX_MISSING");
  assert(outbox.state === "published" && outbox.logical_effect_id === pipeline.logical_effect_id
    && outbox.payload_sha256 === job.payload_sha256 && typeof outbox.published_at === "string",
  "DURABLE_BROWSER_OUTBOX_NOT_PUBLISHED");
  const effect = await exactlyOneQuery(connection, `
    select logical_effect_sha256, outbox_id, committed_at::text
    from public.engine_logical_effect_receipts
    where tenant_id = $1 and logical_effect_id = $2`, [ids.tenant_id, pipeline.logical_effect_id],
  "DURABLE_BROWSER_LOGICAL_EFFECT_MISSING");
  assert(effect.logical_effect_sha256 === pipeline.logical_effect_sha256
    && effect.outbox_id === pipeline.outbox_id, "DURABLE_BROWSER_LOGICAL_EFFECT_INVALID");

  const report = await exactlyOneQuery(connection, `
    select report_id, revision::text, report_sha256, pdf_sha256, analysis_result_sha256,
           octet_length(convert_to(artifacts_payload::text, 'UTF8'))::text as payload_bytes
    from public.engine_report_versions
    where tenant_id = $1 and canonical_case_id = $2
    order by revision desc limit 1`, [ids.tenant_id, ids.case_id],
  "DURABLE_BROWSER_REPORT_MISSING");
  const approval = await exactlyOneQuery(connection, `
    select release_state, decision_sha256, decision_payload ->> 'reviewer_id' as reviewer_id,
           decision_payload ->> 'reviewer_role' as reviewer_role, report_sha256
    from public.engine_review_task_versions
    where tenant_id = $1 and canonical_case_id = $2 and task_kind = 'report_approval'
    order by revision desc limit 1`, [ids.tenant_id, ids.case_id],
  "DURABLE_BROWSER_APPROVAL_MISSING");
  assert(approval.release_state === "approved"
    && approval.reviewer_id === ids.report_approver.actor_id
    && approval.reviewer_role === "report_approver"
    && approval.reviewer_id !== ids.legal_reviewer.actor_id
    && approval.report_sha256 === report.report_sha256,
  "DURABLE_BROWSER_DISTINCT_APPROVAL_INVALID");

  const object = await exactlyOneQuery(connection, `
    select state, grant_epoch::text, object_version_id, provider_locator,
           byte_length::text, artifact_sha256, report_sha256
    from public.product_private_report_objects
    where tenant_id = $1 and canonical_case_id = $2
    order by report_revision desc limit 1`, [ids.tenant_id, ids.case_id],
  "DURABLE_BROWSER_PRIVATE_OBJECT_MISSING");
  assert(object.state === "approved" && Number(object.grant_epoch) === 1
    && object.artifact_sha256 === report.pdf_sha256
    && object.report_sha256 === report.report_sha256
    && typeof object.provider_locator === "string"
    && object.provider_locator.startsWith("objects/")
    && !object.provider_locator.includes("..")
    && !object.provider_locator.includes("://"),
  "DURABLE_BROWSER_PRIVATE_OBJECT_INVALID");

  // `engine_platform_audit_events` forces row level security, so the owner
  // connection sees nothing on it without a declared tenant, and this read
  // would return zero rows and fail as a missing timeline action rather than
  // as a permission problem. The declaration is transaction-local, so it has to
  // share one checked-out client with the read — a pooled query can land on a
  // different backend and lose it. The other reads in this function are still
  // pooled; they touch tables that are not forced yet, and each will need the
  // same treatment when it is.
  const auditClient = await connection.connect();
  let auditResult;
  try {
    await auditClient.query("begin");
    await auditClient.query("select set_config('tivdoc.tenant_id', $1, true)", [ids.tenant_id]);
    auditResult = await auditClient.query(`
      select actor_id, action, resource_revision::text, resource_sha256,
             reason_code, event_sha256, case_sequence::text
      from public.engine_platform_audit_events
      where tenant_id = $1 and canonical_case_id = $2
      order by case_sequence`, [ids.tenant_id, ids.case_id]);
    await auditClient.query("commit");
  } catch (error) {
    await auditClient.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    auditClient.release();
  }
  const actions = new Set(auditResult.rows.map((row) => String(row.action)));
  for (const action of REQUIRED_TIMELINE_ACTIONS) {
    assert(actions.has(action), `DURABLE_BROWSER_TIMELINE_ACTION_MISSING:${action}`);
  }
  const workerAudit = auditResult.rows.find((row) => row.action === "RUNTIME_PRODUCT_FRESH_WORKER_STORED");
  assert(workerAudit?.actor_id === ids.worker.actor_id
    && typeof workerAudit.reason_code === "string"
    && /^TIVDOC_TIMELINE:[a-f0-9]{64}$/u.test(workerAudit.reason_code),
  "DURABLE_BROWSER_FRESH_WORKER_AUDIT_INVALID");
  const workerProcessSha256 = String(workerAudit.reason_code).slice("TIVDOC_TIMELINE:".length);
  assert(workerProcessSha256 !== timeline.session_binding_sha256,
    "DURABLE_BROWSER_FRESH_WORKER_PROCESS_NOT_DISTINCT");
  const downloadAudit = auditResult.rows.find((row) => row.action === "RUNTIME_PRODUCT_AUTHENTICATED_DOWNLOAD");
  assert(downloadAudit?.actor_id === ids.owner.actor_id,
    "DURABLE_BROWSER_DOWNLOAD_OWNER_AUDIT_INVALID");

  const downloaded = await readFile(downloadedPath);
  assert(downloaded.byteLength === Number(object.byte_length)
    && sha256(downloaded) === object.artifact_sha256
    && sha256(downloaded) === report.pdf_sha256,
  "DURABLE_BROWSER_EXACT_DOWNLOAD_INVALID");
  const privacyAfter = await privacyRequestCount(connection, ids);
  assert(privacyAfter === privacyBefore, "DURABLE_BROWSER_CSRF_DENIAL_PERSISTED_WRITE");

  const state = await exactlyOneQuery(connection, `
    select revision::text, lifecycle_state, state_sha256
    from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2`,
  [ids.tenant_id, ids.case_id], "DURABLE_BROWSER_CASE_STATE_MISSING");
  assert(Number(state.revision) === Number(report.revision)
    && (state.lifecycle_state === "awaiting_report_approval" || state.lifecycle_state === "report_ready"),
  "DURABLE_BROWSER_CASE_REPORT_REVISION_INVALID");

  return Object.freeze({
    schema_version: "tivdoc-durable-browser-postgresql-evidence-v0.10.2",
    status: "PASS",
    job: Object.freeze({
      state: job.state,
      revision: Number(job.revision),
      attempt_count: Number(job.attempt_count),
      job_id_sha256: sha256(String(job.job_id)),
      payload_sha256: job.payload_sha256,
      history_events: history.rowCount,
      succeeded_history: true,
    }),
    worker: Object.freeze({
      fresh_process_protocol_verified: true,
      distinct_process_binding_verified: true,
      worker_process_sha256: workerProcessSha256,
      worker_actor_sha256: sha256(ids.worker.actor_id),
      server_process_binding_sha256: timeline.session_binding_sha256,
    }),
    outbox: Object.freeze({
      state: outbox.state,
      payload_sha256: outbox.payload_sha256,
      logical_effect_sha256: effect.logical_effect_sha256,
      published: true,
    }),
    report: Object.freeze({
      report_id_sha256: sha256(String(report.report_id)),
      revision: Number(report.revision),
      report_sha256: report.report_sha256,
      pdf_sha256: report.pdf_sha256,
      analysis_result_sha256: report.analysis_result_sha256,
      stored_artifacts_payload_bytes: Number(report.payload_bytes),
      approval_state: approval.release_state,
      distinct_approver: true,
    }),
    private_object: Object.freeze({
      state: object.state,
      grant_epoch: Number(object.grant_epoch),
      object_version_id_sha256: sha256(String(object.object_version_id)),
      provider_locator_sha256: sha256(String(object.provider_locator)),
      artifact_sha256: object.artifact_sha256,
      byte_length: Number(object.byte_length),
      publicly_addressable: false,
    }),
    timeline: Object.freeze({
      required_action_count: REQUIRED_TIMELINE_ACTIONS.length,
      action_count: actions.size,
      audit_event_count: auditResult.rowCount,
      required_actions_complete: true,
      chain_event_sha256s: Object.freeze(auditResult.rows.map((row) => row.event_sha256)),
    }),
    download: Object.freeze({
      exact_hash_match: true,
      byte_length: downloaded.byteLength,
      sha256: sha256(downloaded),
      owner_authenticated: true,
    }),
    denials: Object.freeze({
      cross_owner_http_404: true,
      csrf_http_404: true,
      csrf_persistent_writes: privacyAfter - privacyBefore,
    }),
    legal_rules_activated: 0,
    remote_provider_calls: 0,
  });
}

async function privacyRequestCount(connection: Pool, ids: DurableBrowserFixtureIds): Promise<number> {
  const result = await connection.query<{ count: number }>(`
    select count(*)::integer as count
    from public.product_privacy_request_versions
    where tenant_id = $1 and canonical_case_id = $2`, [ids.tenant_id, ids.case_id]);
  return Number(result.rows[0]?.count ?? -1);
}

async function durableFailureDiagnostic(
  connection: Pool,
  ids: DurableBrowserFixtureIds,
): Promise<string> {
  const result = await connection.query<{
    revision: number;
    lifecycle_state: string;
    analysis_count: number;
    job_count: number;
    job_state: string;
    report_count: number;
    outbox_count: number;
  }>(`
    select state.revision::integer as revision,
           state.lifecycle_state,
           (select count(*)::integer from public.analysis_runs item
             where item.tenant_id = $1 and item.canonical_case_id = $2) as analysis_count,
           (select count(*)::integer from public.engine_durable_jobs item
             where item.tenant_id = $1 and item.canonical_case_id = $2) as job_count,
           coalesce((select item.state from public.engine_durable_jobs item
             where item.tenant_id = $1 and item.canonical_case_id = $2
             order by item.created_at desc limit 1), 'none') as job_state,
           (select count(*)::integer from public.engine_report_versions item
             where item.tenant_id = $1 and item.canonical_case_id = $2) as report_count,
           (select count(*)::integer from public.engine_outbox_events item
             where item.tenant_id = $1 and item.canonical_case_id = $2) as outbox_count
      from public.engine_case_state state
     where state.tenant_id = $1 and state.canonical_case_id = $2`, [ids.tenant_id, ids.case_id]);
  const row = result.rows[0];
  if (!row || !/^[a-z_]{2,64}$/u.test(row.lifecycle_state)
      || !/^[a-z_]{2,32}$/u.test(row.job_state)) return "RUNTIME_STATE_UNAVAILABLE";
  return [
    `REVISION_${Number(row.revision)}`,
    `STATE_${row.lifecycle_state.toUpperCase()}`,
    `ANALYSIS_${Number(row.analysis_count)}`,
    `JOBS_${Number(row.job_count)}`,
    `JOB_STATE_${row.job_state.toUpperCase()}`,
    `REPORTS_${Number(row.report_count)}`,
    `OUTBOX_${Number(row.outbox_count)}`,
  ].join(":");
}

async function exactlyOneQuery(
  connection: Pool,
  sql: string,
  values: readonly unknown[],
  code: string,
): Promise<Record<string, unknown>> {
  const result = await connection.query(sql, [...values]);
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error(code);
  return record(result.rows[0]);
}

async function collectArtifactReceipts(
  output: string,
  markdownSnapshots: readonly string[],
  downloadedFile: string,
) {
  const files = new Set<string>([downloadedFile]);
  for (const markdown of markdownSnapshots) {
    files.add(markdown);
    files.add(markdown.replace(/\.md$/u, ".png"));
  }
  const receipts = [];
  for (const file of [...files].sort()) {
    const bytes = await readFile(file);
    assert(bytes.byteLength > 32, "DURABLE_BROWSER_ARTIFACT_EMPTY");
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    receipts.push(Object.freeze({
      path: relative,
      byte_count: bytes.byteLength,
      sha256: sha256(bytes),
    }));
  }
  assert(path.resolve(output) === runOutput, "DURABLE_BROWSER_OUTPUT_SCOPE_INVALID");
  return Object.freeze(receipts);
}

async function inspectProductionBuild() {
  const buildIdPath = path.resolve(ROOT, ".next", "BUILD_ID");
  const instrumentationPath = path.resolve(ROOT, ".next", "server", "instrumentation.js");
  const [buildIdMetadata, instrumentationMetadata, buildId, gitHead] = await Promise.all([
    lstat(buildIdPath),
    lstat(instrumentationPath),
    readFile(buildIdPath, "utf8"),
    gitText(["rev-parse", "HEAD"]),
  ]);
  assert(buildIdMetadata.isFile() && !buildIdMetadata.isSymbolicLink()
    && instrumentationMetadata.isFile() && !instrumentationMetadata.isSymbolicLink(),
  "DURABLE_BROWSER_PRODUCTION_BUILD_MISSING");
  return Object.freeze({
    next_build_id_sha256: sha256(buildId.trim()),
    instrumentation_sha256: sha256(await readFile(instrumentationPath)),
    git_head: gitHead,
    production: true,
  });
}

async function createEphemeralCertificate(temporaryRootPath: string) {
  const certificatePath = path.resolve(temporaryRootPath, "certificate.pem");
  const privateKeyPath = path.resolve(temporaryRootPath, "private-key.pem");
  const result = spawnSync(OPENSSL, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ], {
    cwd: temporaryRootPath,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error("DURABLE_BROWSER_EPHEMERAL_CERTIFICATE_FAILED");
  }
  const [certificateMetadata, privateKeyMetadata, certificateBytes] = await Promise.all([
    lstat(certificatePath),
    lstat(privateKeyPath),
    readFile(certificatePath),
  ]);
  assert(certificateMetadata.isFile() && !certificateMetadata.isSymbolicLink()
    && privateKeyMetadata.isFile() && !privateKeyMetadata.isSymbolicLink(),
  "DURABLE_BROWSER_EPHEMERAL_CERTIFICATE_UNSAFE");
  return Object.freeze({
    certificate_path: certificatePath,
    private_key_path: privateKeyPath,
    certificate_sha256: sha256(certificateBytes),
  });
}

async function waitForHttpsServer(origin: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("DURABLE_BROWSER_HTTPS_SERVER_EXITED");
    const response = await localHttpsStatus(origin).catch(() => null);
    lastStatus = response?.status ?? -1;
    if (response?.status === 200
        && response.cache_control?.includes("no-store")
        && response.content_security_policy) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`DURABLE_BROWSER_HTTPS_SERVER_START_TIMEOUT:${lastStatus}`);
}

function localHttpsStatus(origin: string): Promise<Readonly<{
  status: number;
  cache_control: string | null;
  content_security_policy: string | null;
}>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(origin, {
      method: "GET",
      rejectUnauthorized: false,
      headers: { connection: "close" },
      timeout: 2_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(Object.freeze({
        status: response.statusCode ?? 0,
        cache_control: stringHeader(response.headers["cache-control"]),
        content_security_policy: stringHeader(response.headers["content-security-policy"]),
      })));
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", rejectPromise);
    request.end();
  });
}

async function cleanupRuntime(): Promise<Readonly<Record<string, unknown>>> {
  let browserClosed = !browserOpened;
  let httpsServerStopped = server === null;
  let postgresConnectionsAfterServer = 0;
  let postgresStopped = !clusterStarted;
  let temporarySecretsRemoved = temporaryRoot === null;
  if (browserOpened) {
    try {
      runCli("close", ["close"], 30_000);
      browserClosed = true;
    } catch {
      runCliAllowFailure(["kill-all"]);
    }
    browserOpened = false;
  }
  if (server) {
    await stopHttpsServer(server);
    httpsServerStopped = server.exitCode !== null;
    server = null;
  }
  if (admin && target) {
    postgresConnectionsAfterServer = await waitForPostgresConnectionDrain(admin, target.descriptor.database);
    await admin.end();
    admin = null;
  }
  if (clusterStarted && target && paths && binaries) {
    await stopOwnedCluster({ target, paths, binaries });
    await assertOwnedClusterStopped({ target, paths, binaries });
    clusterStarted = false;
    postgresStopped = true;
  }
  if (temporaryRoot) {
    assertOwnedTemporaryRoot(temporaryRoot);
    await rm(temporaryRoot, { recursive: true, force: true });
    temporarySecretsRemoved = !(await exists(temporaryRoot));
    temporaryRoot = null;
  }
  assert(browserClosed && httpsServerStopped && postgresStopped
    && postgresConnectionsAfterServer === 0 && temporarySecretsRemoved,
  "DURABLE_BROWSER_CLEANUP_INCOMPLETE");
  return Object.freeze({
    schema_version: "tivdoc-durable-browser-cleanup-v0.10.2",
    status: "PASS",
    browser_closed: browserClosed,
    https_server_stopped: httpsServerStopped,
    postgres_runtime_connections_after_server: postgresConnectionsAfterServer,
    owned_postgres_stopped_and_port_released: postgresStopped,
    temporary_identity_states_removed: temporarySecretsRemoved,
    ephemeral_certificate_private_key_removed: temporarySecretsRemoved,
    owned_cluster_data_deleted: false,
    synthetic_private_storage_deleted: false,
  });
}

async function stopHttpsServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.stdin.end("shutdown\n");
  const exited = await waitForChildExit(child, 15_000);
  if (exited) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      timeout: 10_000,
    });
  } else {
    child.kill("SIGKILL");
  }
  if (!await waitForChildExit(child, 5_000)) throw new Error("DURABLE_BROWSER_HTTPS_SERVER_CLEANUP_FAILED");
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

async function waitForPostgresConnectionDrain(connection: Pool, database: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await connection.query<{ count: number }>(`
      select count(*)::integer as count from pg_catalog.pg_stat_activity
      where datname = $1 and pid <> pg_catalog.pg_backend_pid()`, [database]);
    const count = Number(result.rows[0]?.count ?? -1);
    if (count === 0) return 0;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("DURABLE_BROWSER_POSTGRES_CONNECTIONS_NOT_DRAINED");
}

function runCliAllowFailure(args: readonly string[]): void {
  spawnSync(process.execPath, [CLI, `-s=${sessionName}`, ...args], {
    cwd: ROOT,
    env: marathonBrowserToolEnvironment(),
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    stdio: "ignore",
  });
}

function assertIgnoredOutput(): void {
  const outputProbe = path.relative(ROOT, path.resolve(OUTPUT_ROOT, "ignore-probe"));
  const tempProbe = path.relative(ROOT, path.resolve(ROOT, ".tmp", "postgresql-dynamic-v0.9.1", "ignore-probe"));
  for (const probe of [outputProbe, tempProbe]) {
    const result = spawnSync("git", ["check-ignore", "--quiet", probe], {
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    assert(result.status === 0, "DURABLE_BROWSER_OUTPUT_NOT_GIT_IGNORED");
  }
}

function assertReceiptContainsNoSecrets(receipt: unknown): void {
  const serialized = JSON.stringify(receipt);
  const forbidden = [
    "postgresql://",
    "BEGIN PRIVATE KEY",
    "__Host-tivdoc_identity",
    "tivdoc_csrf",
    temporaryRoot ?? "forbidden-null-path",
    target?.password.reveal() ?? "forbidden-null-password",
  ];
  assert(forbidden.every((value) => value.length === 0 || !serialized.includes(value)),
    "DURABLE_BROWSER_RECEIPT_SECRET_DISCLOSURE");
}

function assertOwnedTemporaryRoot(value: string): void {
  const resolved = path.resolve(value);
  const parent = path.resolve(tmpdir());
  assert(path.dirname(resolved).toLowerCase() === parent.toLowerCase()
    && path.basename(resolved).startsWith("tivdoc-v0102-browser-")
    && resolved !== parent,
  "DURABLE_BROWSER_TEMPORARY_ROOT_UNSAFE");
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error("DURABLE_BROWSER_GIT_INSPECTION_FAILED");
  }
  return result.stdout.trim();
}

async function exists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ENOENT");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DURABLE_BROWSER_POSTGRES_EVIDENCE_INVALID");
  }
  return value as Record<string, unknown>;
}

function stringHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return null;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_:.-]{2,400}$/u.test(message)
    ? message
    : "DURABLE_BROWSER_RUNTIME_FAILED";
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
