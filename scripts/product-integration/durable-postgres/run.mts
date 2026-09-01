import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  applyCleanMigrationChain,
  applyCompatibilityBootstrap,
  assertOwnedClusterStopped,
  createOwnedDatabase,
  createOwnedLocalTarget,
  discoverMigrationChain,
  initializeOwnedCluster,
  resolveDynamicPostgresPaths,
  runSafeCommand,
  selectRandomHighLoopbackPort,
  startOwnedCluster,
  stopOwnedCluster,
  type ApprovedPostgresTarget,
  type DynamicPostgresPaths,
  type PinnedPostgresBinaries,
} from "../../canonical-persistence-v091/foundation/index.mts";
import {
  PINNED_BINARY_SHA256,
  PINNED_DISTRIBUTION_BYTES,
  PINNED_DISTRIBUTION_FILE_COUNT,
  PINNED_DISTRIBUTION_TREE_SHA256,
  PINNED_EDB_ARCHIVE_SHA256,
  PINNED_EDB_ARCHIVE_URL,
  REQUIRED_POSTGRES_BINARIES,
} from "../../canonical-persistence-v091/foundation/pinned-binaries.mts";
import {
  configureDynamicRoleSessions,
  generateDynamicRoleSecrets,
  roleConnectionUrls,
  targetConnectionUrl,
} from "../../canonical-persistence-v091/orchestration/roles.mts";
import { startCanonicalApplicationPostgres } from "../../../src/server/platform/composition/canonical-postgres-application.ts";
import { NodePostgresConnectionFactory } from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import {
  DurableProductPostgresApplication,
  createSyntheticDurableReport,
} from "../../../src/server/product/durable-postgres/application.ts";
import {
  DURABLE_PRODUCT_BLOCKERS,
  DURABLE_PRODUCT_SCHEMA_VERSION,
  type DurableApprovalInput,
  type DurableProductSnapshot,
  type DurableReportReference,
} from "../../../src/server/product/durable-postgres/contracts.ts";
import {
  HermeticSessionManager,
  type ProductAudience,
  type VerifiedProductSession,
} from "../../../src/server/product/auth/hermetic-session.ts";
import type { VerifiedActor } from "../../../src/engine/wave4/contracts.ts";

const root = path.resolve(process.cwd());
const head = gitText(["rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("W2_GIT_HEAD_INVALID");
if (process.env.NODE_ENV !== "test" || process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview") {
  throw new Error("W2_HERMETIC_RUNTIME_REQUIRED");
}

const suffix = randomBytes(6).toString("hex");
const tenantId = `tenant_w2_${suffix}`;
const caseId = `case_w2_${suffix}`;
const otherCaseId = `case_w2_other_${suffix}`;
const runId = `analysis_w2_${suffix}`;
const reportId = `report_w2_${suffix}`;
const jobId = `job_w2_${suffix}`;
const outboxId = `outbox_w2_${suffix}`;
const effectId = `effect_w2_${suffix}`;
const baseMs = Date.UTC(2026, 8, 1, 10, 0, 0);
const worker = verifiedActor("scoped_background_worker", `worker_actor_${suffix}`, tenantId, [caseId]);
const approver = verifiedActor("report_approver", `approver_actor_${suffix}`, tenantId, [caseId]);
const owner = verifiedActor("customer_owner", `owner_actor_${suffix}`, tenantId, [caseId]);
const otherOwner = verifiedActor("customer_owner", `other_owner_${suffix}`, tenantId, [otherCaseId]);
const report = createSyntheticDurableReport({ report_id: reportId, report_revision: 1, marker: `marker_${suffix}` });
const reportReference: DurableReportReference = Object.freeze({
  report_id: report.report_id,
  report_revision: report.report_revision,
  report_sha256: report.report_sha256,
  pdf_sha256: report.pdf_sha256,
});
const logicalEffectSha256 = sha256(`logical-effect:${suffix}:${report.report_sha256}`);

let target: ApprovedPostgresTarget | null = null;
let paths: DynamicPostgresPaths | null = null;
let binaries: PinnedPostgresBinaries | null = null;
let driver: NodePostgresConnectionFactory | null = null;
let server: ReturnType<typeof createServer> | null = null;
let serverStarted = false;
let clusterStarted = false;
let shutdownVerified = false;

try {
  const databasePort = await selectRandomHighLoopbackPort();
  target = createOwnedLocalTarget({ port: databasePort, suffix: `w2_${suffix}` });
  paths = resolveDynamicPostgresPaths(root, target);
  binaries = await inspectCachedPinnedPostgres(paths);
  await initializeOwnedCluster({ target, paths, binaries });
  await startOwnedCluster({ target, paths, binaries });
  clusterStarted = true;
  await createOwnedDatabase({ target, paths, binaries });
  const chain = await discoverMigrationChain(paths);
  await applyCompatibilityBootstrap({ target, paths, binaries });
  const roleSecrets = generateDynamicRoleSecrets();
  await configureDynamicRoleSessions({ admin_connection_url: targetConnectionUrl(target), secrets: roleSecrets });
  await applyCleanMigrationChain({ target, paths, binaries, chain });
  const serviceUrl = roleConnectionUrls({ target, database: target.descriptor.database, secrets: roleSecrets }).service_role;

  let runtime = await startRuntime(serviceUrl, target, head);
  driver = runtime.driver;
  let product = runtime.product;
  const proof = product.proof();
  await product.createCase({
    tenant_id: tenantId,
    case_id: caseId,
    actor: worker,
    occurred_at: new Date(baseMs).toISOString(),
  });
  await product.prepareReportPipeline({
    tenant_id: tenantId,
    case_id: caseId,
    actor: worker,
    report,
    pipeline: Object.freeze({
      analysis_run_id: runId,
      job_id: jobId,
      outbox_id: outboxId,
      logical_effect_id: effectId,
      logical_effect_sha256: logicalEffectSha256,
    }),
    idempotency_key: `pipeline_idem_${suffix}`,
    available_at_ms: baseMs + 1_000,
    occurred_at: new Date(baseMs + 1_000).toISOString(),
  });
  const preCrash = await product.claimAndStart({
    tenant_id: tenantId,
    case_id: caseId,
    actor: worker,
    worker_id: `worker_before_restart_${suffix}`,
    job_id: jobId,
    now_ms: baseMs + 2_000,
    lease_ms: 1_000,
  });

  await driver.close();
  driver = null;
  await stopOwnedCluster({ target, paths, binaries });
  clusterStarted = false;
  await startOwnedCluster({ target, paths, binaries });
  clusterStarted = true;
  runtime = await startRuntime(serviceUrl, target, head);
  driver = runtime.driver;
  product = runtime.product;
  const recovered = await product.recoverAndComplete({
    tenant_id: tenantId,
    case_id: caseId,
    actor: worker,
    worker_id: `worker_after_restart_${suffix}`,
    job_id: jobId,
    now_ms: baseMs + 5_000,
    lease_ms: 5_000,
    logical_effect_sha256: logicalEffectSha256,
    outbox_id: outboxId,
  });

  const httpPort = await selectRandomHighLoopbackPort();
  const sessions = createSessions({ approver, owner, otherOwner, suffix });
  server = createServer((request, response) => {
    void handleHttp({ request, response, product, sessions: sessions.manager, tenant_id: tenantId, reviewer_organization_id: `review_org_${suffix}` });
  });
  await listen(server, httpPort);
  serverStarted = true;
  const origin = `http://127.0.0.1:${httpPort}`;
  const operationsSession = issueSession(sessions.manager, sessions.operations_ticket, "operations", origin);
  const portalSession = issueSession(sessions.manager, sessions.portal_ticket, "portal", origin);
  const otherPortalSession = issueSession(sessions.manager, sessions.other_portal_ticket, "portal", origin);

  const operationsRevision = await httpJson(origin, `/api/operations/cases/${caseId}/revision`, {
    method: "GET",
    cookie: operationsSession.cookie,
  });
  const portalRevision = await httpJson(origin, `/api/portal/cases/${caseId}/revision`, {
    method: "GET",
    cookie: portalSession.cookie,
  });
  if (operationsRevision.status !== 200 || portalRevision.status !== 200
      || operationsRevision.body.revision !== 1 || portalRevision.body.revision !== 1) {
    throw new Error("W2_HTTP_SHARED_REVISION_FAILED");
  }

  const approvalBody = Object.freeze({
    report: reportReference,
    task_id: `review_task_${suffix}`,
    idempotency_key: `approval_idem_${suffix}`,
    expected_revision: 1,
    decided_at: new Date(baseMs + 6_000).toISOString(),
    reason: "Synthetic exact report approval after worker restart.",
  });
  const approval = await httpJson(origin, `/api/operations/cases/${caseId}/report/approve`, {
    method: "POST",
    cookie: operationsSession.cookie,
    csrf: operationsSession.csrf_token,
    body: approvalBody,
  });
  const approvalReplay = await httpJson(origin, `/api/operations/cases/${caseId}/report/approve`, {
    method: "POST",
    cookie: operationsSession.cookie,
    csrf: operationsSession.csrf_token,
    body: approvalBody,
  });
  if (approval.status !== 200 || approval.body.idempotent_replay !== false
      || approvalReplay.status !== 200 || approvalReplay.body.idempotent_replay !== true
      || approval.body.audit_event_sha256 !== approvalReplay.body.audit_event_sha256) {
    throw new Error("W2_HTTP_APPROVAL_IDEMPOTENCY_FAILED");
  }

  const stale = await httpJson(origin, `/api/operations/cases/${caseId}/report/approve`, {
    method: "POST",
    cookie: operationsSession.cookie,
    csrf: operationsSession.csrf_token,
    body: { ...approvalBody, expected_revision: 2, idempotency_key: `stale_idem_${suffix}` },
  });
  const changed = await httpJson(origin, `/api/operations/cases/${caseId}/report/approve`, {
    method: "POST",
    cookie: operationsSession.cookie,
    csrf: operationsSession.csrf_token,
    body: { ...approvalBody, reason: "Changed payload must conflict deterministically." },
  });
  const missingCsrf = await httpJson(origin, `/api/operations/cases/${caseId}/report/approve`, {
    method: "POST",
    cookie: operationsSession.cookie,
    body: approvalBody,
  });
  if (stale.status !== 409 || changed.status !== 409 || missingCsrf.status !== 404) {
    throw new Error(`W2_HTTP_NEGATIVE_APPROVAL_MATRIX_FAILED:${stale.status}:${changed.status}:${missingCsrf.status}`);
  }

  const crossOwner = await httpJson(origin, `/api/portal/cases/${caseId}/revision`, {
    method: "GET",
    cookie: otherPortalSession.cookie,
  });
  if (crossOwner.status !== 404) throw new Error("W2_HTTP_CROSS_OWNER_CONCEALMENT_FAILED");

  const downloaded = await httpBytes(origin, `/api/portal/cases/${caseId}/report/download`, {
    cookie: portalSession.cookie,
    csrf: portalSession.csrf_token,
    body: { report: reportReference },
  });
  if (downloaded.status !== 200 || downloaded.sha256 !== report.pdf_sha256
      || downloaded.header_sha256 !== report.pdf_sha256
      || !Buffer.from(downloaded.bytes).equals(Buffer.from(report.pdf))) {
    throw new Error("W2_HTTP_EXACT_DOWNLOAD_FAILED");
  }

  const logout = await httpJson(origin, "/api/portal/session/logout", {
    method: "POST",
    cookie: portalSession.cookie,
    csrf: portalSession.csrf_token,
    body: {},
  });
  const afterLogout = await httpJson(origin, `/api/portal/cases/${caseId}/revision`, {
    method: "GET",
    cookie: portalSession.cookie,
  });
  if (logout.status !== 204 || afterLogout.status !== 404) throw new Error("W2_HTTP_LOGOUT_FAILED");

  await product.assertNoPendingReplay({
    tenant_id: tenantId,
    case_id: caseId,
    actor: worker,
    worker_id: `worker_replay_probe_${suffix}`,
    now_ms: baseMs + 20_000,
    lease_ms: 5_000,
  });
  const snapshot = await product.snapshot({ tenant_id: tenantId, case_id: caseId });
  assertSnapshot(snapshot);

  await closeServer(server);
  serverStarted = false;
  server = null;
  await driver.close();
  driver = null;
  await stopOwnedCluster({ target, paths, binaries });
  clusterStarted = false;
  await assertOwnedClusterStopped({ target, paths, binaries });
  shutdownVerified = true;

  process.stdout.write(`${JSON.stringify(Object.freeze({
    schema_version: "tivdoc-w2-durable-product-dynamic-receipt-v0.10.0",
    status: "PASS_WITH_EXACT_BLOCKERS",
    proof_class: "REAL_LOOPBACK_HTTP_AND_REAL_POSTGRESQL_DYNAMIC_PROOF",
    canonical_product_schema: DURABLE_PRODUCT_SCHEMA_VERSION,
    canonical_persistence_schema: proof.persistence_schema,
    postgres_version: binaries.postgres_version,
    journeys: Object.freeze({
      signed_hermetic_session_http: "PASS",
      portal_and_operations_same_revision: "PASS",
      csrf_and_cross_owner_concealment: "PASS",
      stale_revision_and_changed_payload_conflict: "PASS",
      exact_hash_approval_and_replay: "PASS",
      server_restart_worker_recovery: "PASS",
      outbox_logical_effect_exactly_once: "PASS",
      exact_approved_download_bytes: "PASS",
      logout_revocation: "PASS",
      rendered_next_ui: "BLOCKED_EXACT",
      durable_identity_session_restart: "BLOCKED_EXACT",
      durable_privacy_workflow: "BLOCKED_EXACT",
      private_storage_provider_download: "BLOCKED_EXACT",
    }),
    worker: Object.freeze({
      pre_crash_state: preCrash.job_state,
      recovered_state: recovered.job_state,
      genuine_database_stop_start: true,
      fresh_connection_factory_after_restart: true,
    }),
    snapshot,
    blockers: DURABLE_PRODUCT_BLOCKERS,
    acceptance: Object.freeze({
      "MC-06": "PARTIAL_EXACT_BLOCKERS",
      "MC-07": "PARTIAL_EXACT_BLOCKERS",
      "MC-08": "PARTIAL_STORAGE_BLOCKER_OTHERWISE_DYNAMIC_PASS",
      "MC-09": "PASS",
    }),
    safety: Object.freeze({
      synthetic_data_only: true,
      customer_documents_read: 0,
      external_connections: 0,
      provider_calls: 0,
      legal_sources_activated: 0,
      legal_parameters_activated: 0,
      legal_rules_activated: 0,
      credentials_emitted: 0,
      product_reachable_memory_fallbacks: proof.product_reachable_memory_fallbacks,
    }),
    shutdown_verified: shutdownVerified,
  }))}\n`);
} finally {
  if (server && serverStarted) await closeServer(server).catch(() => undefined);
  if (driver) await driver.close().catch(() => undefined);
  if (target && paths && binaries && clusterStarted) {
    await stopOwnedCluster({ target, paths, binaries }).catch(() => undefined);
    await assertOwnedClusterStopped({ target, paths, binaries }).then(() => { shutdownVerified = true; }).catch(() => undefined);
  }
  if (target && paths && shutdownVerified) await removeOwnedRuntime(paths, target);
}

async function startRuntime(connectionUrl: string, target: ApprovedPostgresTarget, buildIdentitySha: string) {
  const driver = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: connectionUrl,
    max_connections: 8,
    application_name: "tivdoc-w2-durable-product-v010",
  });
  try {
    const composition = await startCanonicalApplicationPostgres({
      mode: "isolated_postgres",
      execution_boundary: "test",
      target: Object.freeze({
        target_id: target.descriptor.target_id,
        host: target.descriptor.host,
        database: target.descriptor.database,
        disposable: true,
        validation: "LOOPBACK_DISPOSABLE_VALIDATED",
      }),
      build_identity_sha: buildIdentitySha,
    }, { connection_factory: driver });
    return Object.freeze({ driver, product: new DurableProductPostgresApplication(composition) });
  } catch (error) {
    await driver.close();
    throw error;
  }
}

function createSessions(input: Readonly<{ approver: VerifiedActor; owner: VerifiedActor; otherOwner: VerifiedActor; suffix: string }>) {
  const secret = randomBytes(48).toString("base64url");
  const operationsTicket = `operations_ticket_${input.suffix}`;
  const portalTicket = `portal_ticket_${input.suffix}`;
  const otherPortalTicket = `other_portal_ticket_${input.suffix}`;
  const environment = Object.freeze({
    TIVDOC_HERMETIC_MODE: "1",
    TIVDOC_PRODUCT_SESSION_SECRET: secret,
    TIVDOC_PRODUCT_SESSION_MAX_AGE_SECONDS: "900",
    TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON: JSON.stringify({
      [operationsTicket]: { audience: "operations", actor: input.approver },
      [portalTicket]: { audience: "portal", actor: input.owner },
      [otherPortalTicket]: { audience: "portal", actor: input.otherOwner },
    }),
  });
  return Object.freeze({
    manager: new HermeticSessionManager({ environment, nodeEnv: "test", vercelEnv: "" }),
    operations_ticket: operationsTicket,
    portal_ticket: portalTicket,
    other_portal_ticket: otherPortalTicket,
  });
}

function issueSession(manager: HermeticSessionManager, ticket: string, audience: ProductAudience, origin: string) {
  const issued = manager.issue(new Request(`${origin}/api/${audience}/session`), audience, ticket);
  if (!issued) throw new Error("W2_SESSION_ISSUE_FAILED");
  return Object.freeze({ cookie: issued.cookie.split(";", 1)[0]!, csrf_token: issued.csrf_token });
}

async function handleHttp(input: Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  product: DurableProductPostgresApplication;
  sessions: HermeticSessionManager;
  tenant_id: string;
  reviewer_organization_id: string;
}>): Promise<void> {
  try {
    const request = await webRequest(input.request);
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const audience = segments[1] === "portal" ? "portal" : segments[1] === "operations" ? "operations" : null;
    if (!audience) return send(input.response, jsonResponse(404, { error: "not_found" }));
    const mutating = request.method === "POST";
    const session = input.sessions.verify(request, audience, mutating);
    if (!session) return send(input.response, jsonResponse(404, { error: "not_found" }));

    if (mutating && segments.length === 4 && segments[2] === "session" && segments[3] === "logout") {
      const expired = input.sessions.revoke(request, audience);
      if (!expired) return send(input.response, jsonResponse(404, { error: "not_found" }));
      return send(input.response, new Response(null, { status: 204, headers: { "set-cookie": expired } }));
    }
    if (request.method === "GET" && segments.length === 5 && segments[2] === "cases" && segments[4] === "revision") {
      const caseId = segments[3]!;
      const revision = await input.product.revision({ tenant_id: input.tenant_id, case_id: caseId, actor: session.actor, audience });
      return send(input.response, jsonResponse(200, { revision }));
    }
    if (request.method === "POST" && audience === "operations" && segments.length === 6
        && segments[2] === "cases" && segments[4] === "report" && segments[5] === "approve") {
      const caseId = segments[3]!;
      const body = await exactJson(request, ["decided_at", "expected_revision", "idempotency_key", "reason", "report", "task_id"]);
      const report = exactReport(body.report);
      const approval: DurableApprovalInput = Object.freeze({
        tenant_id: input.tenant_id,
        case_id: caseId,
        identity: syntheticIdentity(session, input.reviewer_organization_id),
        report,
        task_id: requiredString(body.task_id),
        idempotency_key: requiredString(body.idempotency_key),
        expected_revision: requiredInteger(body.expected_revision),
        decided_at: requiredString(body.decided_at),
        reason: requiredString(body.reason),
      });
      return send(input.response, jsonResponse(200, await input.product.approveExactReport(approval)));
    }
    if (request.method === "POST" && audience === "portal" && segments.length === 6
        && segments[2] === "cases" && segments[4] === "report" && segments[5] === "download") {
      const caseId = segments[3]!;
      const body = await exactJson(request, ["report"]);
      const download = await input.product.downloadApprovedPdf({
        tenant_id: input.tenant_id,
        case_id: caseId,
        actor: session.actor,
        report: exactReport(body.report),
      });
      return send(input.response, new Response(download.bytes, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": download.content_type,
          "x-tivdoc-artifact-sha256": download.report.pdf_sha256,
        },
      }));
    }
    return send(input.response, jsonResponse(404, { error: "not_found" }));
  } catch (error) {
    const code = errorCode(error);
    const status = code === "CASE_REVISION_CONFLICT" || code === "IDEMPOTENCY_KEY_COMMAND_MISMATCH" ? 409
      : code === "DURABLE_PRODUCT_FORBIDDEN" ? 403
        : code === "DURABLE_PRODUCT_NOT_FOUND" || code === "DURABLE_PRODUCT_REPORT_NOT_FOUND" ? 404
          : code === "W2_HTTP_INVALID_REQUEST" ? 400
            : 500;
    return send(input.response, jsonResponse(status, { error: status === 500 ? "request_failed" : "request_rejected" }));
  }
}

function syntheticIdentity(session: VerifiedProductSession, reviewerOrganizationId: string) {
  return Object.freeze({
    actor: session.actor,
    issuer: "tivdoc-hermetic-w2",
    audience: "operations",
    session_id: `session_${sha256(session.actor.actor_id).slice(0, 24)}`,
    token_id: `token_${sha256(`${session.actor.actor_id}:token`).slice(0, 24)}`,
    rotation_counter: 0,
    reviewer_organization_id: reviewerOrganizationId,
    issued_at_epoch: session.expires_at_epoch - 900,
    expires_at_epoch: session.expires_at_epoch,
    product_audience: "operations" as const,
  });
}

async function webRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host;
  if (!host || !/^127\.0\.0\.1:\d{4,5}$/u.test(host)) throw new Error("W2_HTTP_INVALID_REQUEST");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > 65_536) throw new Error("W2_HTTP_INVALID_REQUEST");
    chunks.push(bytes);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

async function exactJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type") !== "application/json") throw new Error("W2_HTTP_INVALID_REQUEST");
  let value: unknown;
  try { value = await request.json(); } catch { throw new Error("W2_HTTP_INVALID_REQUEST"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("W2_HTTP_INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) throw new Error("W2_HTTP_INVALID_REQUEST");
  return record;
}

function exactReport(value: unknown): DurableReportReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("W2_HTTP_INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "pdf_sha256,report_id,report_revision,report_sha256") throw new Error("W2_HTTP_INVALID_REQUEST");
  return Object.freeze({
    report_id: requiredString(record.report_id),
    report_revision: requiredInteger(record.report_revision),
    report_sha256: requiredString(record.report_sha256),
    pdf_sha256: requiredString(record.pdf_sha256),
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || /[\u0000-\u001f]/u.test(value)) throw new Error("W2_HTTP_INVALID_REQUEST");
  return value;
}

function requiredInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("W2_HTTP_INVALID_REQUEST");
  return value as number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
}

async function send(response: ServerResponse, web: Response): Promise<void> {
  response.statusCode = web.status;
  web.headers.forEach((value, key) => response.setHeader(key, value));
  const bytes = web.body ? Buffer.from(await web.arrayBuffer()) : Buffer.alloc(0);
  response.end(bytes);
}

async function httpJson(origin: string, resource: string, input: Readonly<{
  method: "GET" | "POST";
  cookie: string;
  csrf?: string;
  body?: unknown;
}>) {
  const headers: Record<string, string> = { cookie: input.cookie };
  if (input.method === "POST") {
    headers["content-type"] = "application/json";
    headers.origin = origin;
    headers["sec-fetch-site"] = "same-origin";
    if (input.csrf) headers["x-tivdoc-csrf"] = input.csrf;
  }
  const response = await fetch(`${origin}${resource}`, {
    method: input.method,
    headers,
    body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
  });
  let body: Record<string, unknown> = {};
  if (response.status !== 204) body = await response.json() as Record<string, unknown>;
  return Object.freeze({ status: response.status, body });
}

async function httpBytes(origin: string, resource: string, input: Readonly<{ cookie: string; csrf: string; body: unknown }>) {
  const response = await fetch(`${origin}${resource}`, {
    method: "POST",
    headers: {
      cookie: input.cookie,
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "x-tivdoc-csrf": input.csrf,
    },
    body: JSON.stringify(input.body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return Object.freeze({
    status: response.status,
    bytes,
    sha256: sha256(bytes),
    header_sha256: response.headers.get("x-tivdoc-artifact-sha256"),
  });
}

function verifiedActor(role: VerifiedActor["role"], actorId: string, tenantIdValue: string, assignedCaseIds: readonly string[]): VerifiedActor {
  return Object.freeze({
    actor_id: actorId,
    role,
    tenant_id: tenantIdValue,
    assigned_case_ids: Object.freeze([...assignedCaseIds]),
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
}

function assertSnapshot(snapshot: DurableProductSnapshot): void {
  if (snapshot.case_revision !== 1 || snapshot.report_versions !== 1 || snapshot.approval_versions !== 1
      || snapshot.durable_jobs !== 1 || snapshot.outbox_events !== 1 || snapshot.logical_effects !== 1
      || snapshot.audit_events !== 4 || !snapshot.audit_chain_valid || !snapshot.audit_tail_sha256) {
    throw new Error("W2_DURABLE_SNAPSHOT_INVARIANT_FAILED");
  }
}

function listen(serverValue: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    serverValue.once("error", reject);
    serverValue.listen(port, "127.0.0.1", () => resolvePromise());
  });
}

function closeServer(serverValue: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => serverValue.close((error) => error ? reject(error) : resolvePromise()));
}

async function removeOwnedRuntime(pathsValue: DynamicPostgresPaths, targetValue: ApprovedPostgresTarget): Promise<void> {
  if (path.dirname(pathsValue.cluster_root) !== pathsValue.runtime_root
      || path.basename(pathsValue.cluster_root) !== targetValue.descriptor.target_id
      || !targetValue.descriptor.destructive_control_authorized) {
    throw new Error("W2_OWNED_RUNTIME_CLEANUP_FORBIDDEN");
  }
  await rm(pathsValue.cluster_root, { recursive: true, force: true });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "domain_code" in error && typeof (error as { domain_code?: unknown }).domain_code === "string") return (error as { domain_code: string }).domain_code;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/u.test(error.message)) return error.message;
  return "W2_HTTP_INTERNAL_ERROR";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectCachedPinnedPostgres(pathsValue: DynamicPostgresPaths): Promise<PinnedPostgresBinaries> {
  const distribution = await realpath(pathsValue.distribution_root);
  const executablePaths = {} as Record<(typeof REQUIRED_POSTGRES_BINARIES)[number], string>;
  const binaryHashes = {} as Record<(typeof REQUIRED_POSTGRES_BINARIES)[number], string>;
  for (const name of REQUIRED_POSTGRES_BINARIES) {
    const lexical = path.resolve(pathsValue.binaries_root, `${name}.exe`);
    const metadata = await lstat(lexical);
    const resolved = await realpath(lexical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !resolved.startsWith(`${distribution}${path.sep}`)) {
      throw new Error(`W2_POSTGRES_BINARY_UNSAFE:${name}`);
    }
    const digest = sha256(await readFile(resolved));
    if (digest !== PINNED_BINARY_SHA256[name]) throw new Error(`W2_POSTGRES_BINARY_HASH_MISMATCH:${name}`);
    executablePaths[name] = resolved;
    binaryHashes[name] = digest;
  }
  const version = await runSafeCommand({
    executable: executablePaths.postgres,
    args: Object.freeze(["--version"]),
    cwd: pathsValue.repository_root,
    timeout_ms: 5_000,
  });
  const versionOutput = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/u, 1)[0] ?? "";
  if (!/^postgres \(PostgreSQL\) 17\.11$/u.test(versionOutput)) throw new Error("W2_POSTGRES_VERSION_MISMATCH");
  return Object.freeze({
    schema_version: "tivdoc-pinned-postgresql-binaries-v0.9.1",
    postgres_version: "17.11",
    architecture: "x64",
    source_kind: "edb_official_windows_binaries_zip",
    source_url: PINNED_EDB_ARCHIVE_URL,
    source_sha256: PINNED_EDB_ARCHIVE_SHA256,
    source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS",
    distribution_file_count: PINNED_DISTRIBUTION_FILE_COUNT,
    distribution_bytes: PINNED_DISTRIBUTION_BYTES,
    distribution_tree_sha256: PINNED_DISTRIBUTION_TREE_SHA256,
    executable_paths: Object.freeze(executablePaths),
    binary_sha256: Object.freeze(binaryHashes),
    version_output: versionOutput,
    credentials_emitted: 0,
  });
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", windowsHide: true });
  if ((result.status ?? 1) !== 0) throw new Error("W2_GIT_COMMAND_FAILED");
  return (result.stdout ?? "").trim();
}
