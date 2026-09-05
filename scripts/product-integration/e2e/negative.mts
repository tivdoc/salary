import "../../production-refusal.mjs";
import { readFileSync } from "node:fs";

import {
  CASE_ID,
  SESSION_COOKIE,
  SYNTHETIC_TICKETS,
  assert,
  authHeaders,
  captureScreenshot,
  copyScreenshot,
  issueSession,
  jsonHeaders,
  operationsCommand,
  outputRoot,
  playwrightRoot,
  recordedFetch,
  relative,
  runPlaywright,
  snapshot,
  snapshotText,
  startServer,
  stopServer,
  writeReceipt,
  type HttpRecord,
} from "./harness.mts";

const laneOutput = outputRoot("negative");
const TOPICS = ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const;
const browserOutput = playwrightRoot("negative");
const matrix: HttpRecord[] = [];
const browserSession = `v08negative-${process.pid}`;
const environmentRejections: Array<Readonly<{ environment: string; statuses: readonly number[] }>> = [];
let expiryStatus = 0;

await verifyFeatureOff();
await verifyRejectedRuntime("preview");
await verifyRejectedRuntime("production");
await verifyExpiry();

const server = await startServer({ lane: "negative", label: "matrix", runtimeEnabled: true, stableRoutesEnabled: true, maxSessionSeconds: 900 });
try {
  const owner = await issueSession(server, "portal", SYNTHETIC_TICKETS.ownerA, matrix, "negative-owner-session");
  const ownerB = await issueSession(server, "portal", SYNTHETIC_TICKETS.ownerB, matrix, "negative-owner-b-session");
  const intake = await issueSession(server, "operations", SYNTHETIC_TICKETS.intake, matrix, "negative-intake-session");

  const unsignedHeader = await recordedFetch(server, matrix, "unsigned-identity-header", `/api/portal/cases/${CASE_ID}`, { headers: { authorization: "Bearer unsigned-identity" } });
  const unsignedQuery = await recordedFetch(server, matrix, "unsigned-identity-query", `/api/portal/cases/${CASE_ID}?owner_id=owner-a-01`, { headers: authHeaders(owner, server, false) });
  const unsignedCookie = await recordedFetch(server, matrix, "unsigned-cookie", `/api/portal/cases/${CASE_ID}`, { headers: { cookie: `${SESSION_COOKIE}=unsigned.cookie.value` } });
  const crossOwner = await recordedFetch(server, matrix, "cross-owner", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(ownerB, server, false) });
  const missingCsrf = await recordedFetch(server, matrix, "missing-csrf", `/api/portal/cases/${CASE_ID}/privacy`, {
    method: "POST",
    headers: jsonHeaders(owner, server, false),
    body: JSON.stringify({ expected_revision: 1, request_kind: "data_export", idempotency_key: "missing-csrf-0001" }),
  });
  const badOrigin = await recordedFetch(server, matrix, "bad-origin", `/api/portal/cases/${CASE_ID}/privacy`, {
    method: "POST",
    headers: { ...jsonHeaders(owner, server), origin: "http://127.0.0.2" },
    body: JSON.stringify({ expected_revision: 1, request_kind: "data_export", idempotency_key: "bad-origin-0001" }),
  });
  const wrongAudienceCustomer = await recordedFetch(server, matrix, "customer-cannot-issue-operations", "/api/operations/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: SYNTHETIC_TICKETS.ownerA }),
  });
  const wrongAudienceOperator = await recordedFetch(server, matrix, "operator-cannot-issue-portal", "/api/portal/session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: SYNTHETIC_TICKETS.intake }),
  });
  assert([unsignedHeader, unsignedQuery, unsignedCookie, crossOwner, missingCsrf, badOrigin, wrongAudienceCustomer, wrongAudienceOperator].every((response) => response.status === 404), "AUTH_OR_OWNER_NEGATIVE_MATRIX_FAILED");

  runPlaywright(browserSession, browserOutput, "open", [`${server.baseUrl}/portal`]);
  const unsignedPortal = snapshotText(snapshot(browserSession, browserOutput));
  assert(unsignedPortal.includes("העמוד הזה לא נמצא"), "UNSIGNED_PORTAL_UI_NOT_FOUND_MISSING");
  const notFoundScreenshot = copyScreenshot(captureScreenshot(browserSession, browserOutput, "unsigned-portal-not-found.png"), laneOutput);

  const initialProjectionResponse = await recordedFetch(server, matrix, "clarification-projection", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(owner, server, false) });
  const initialProjection = await initialProjectionResponse.json() as { case?: { revision?: number; clarification_tasks?: Array<{ task_id: string; question_version: number }> } };
  const task = initialProjection.case?.clarification_tasks?.[0];
  assert(initialProjection.case?.revision === 1 && task, "CLARIFICATION_TASK_MISSING");
  const answerBody = {
    expected_revision: 1,
    question_version: task.question_version,
    value: "<script>alert('synthetic')</script>",
    explicit_confirmation: true,
    consent_version: "synthetic-consent-1",
    terms_version: "synthetic-terms-1",
    idempotency_key: "clarification-http-0001",
  };
  const answerFirstResponse = await recordedFetch(server, matrix, "clarification-first", `/api/portal/cases/${CASE_ID}/clarifications/${encodeURIComponent(task.task_id)}/answers`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify(answerBody) });
  const answerFirst = await answerFirstResponse.json() as { candidate?: { revision?: number; requires_human_review?: boolean; candidate_sha256?: string; provenance?: { source_type?: string } }; idempotent_replay?: boolean };
  const answerReplayResponse = await recordedFetch(server, matrix, "clarification-replay", `/api/portal/cases/${CASE_ID}/clarifications/${encodeURIComponent(task.task_id)}/answers`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify(answerBody) });
  const answerReplay = await answerReplayResponse.json() as { candidate?: { revision?: number; candidate_sha256?: string }; idempotent_replay?: boolean };
  const answerConflict = await recordedFetch(server, matrix, "clarification-idempotency-conflict", `/api/portal/cases/${CASE_ID}/clarifications/${encodeURIComponent(task.task_id)}/answers`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify({ ...answerBody, value: "changed" }) });
  const answerStale = await recordedFetch(server, matrix, "clarification-stale", `/api/portal/cases/${CASE_ID}/clarifications/${encodeURIComponent(task.task_id)}/answers`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify({ ...answerBody, expected_revision: 0, idempotency_key: "clarification-stale-0001" }) });
  assert(answerFirstResponse.status === 200 && answerFirst.candidate?.revision === 1 && answerFirst.candidate.requires_human_review === true && answerFirst.candidate.provenance?.source_type === "declared" && answerFirst.idempotent_replay === false, "CLARIFICATION_FIRST_MUTATION_INVALID");
  assert(answerReplayResponse.status === 200 && answerReplay.idempotent_replay === true && answerReplay.candidate?.candidate_sha256 === answerFirst.candidate?.candidate_sha256, "CLARIFICATION_IDEMPOTENT_REPLAY_INVALID");
  assert(answerConflict.status === 409 && answerStale.status === 409, "CLARIFICATION_CONFLICT_OR_STALE_NOT_REJECTED");

  const legal = await issueSession(server, "operations", SYNTHETIC_TICKETS.legal, matrix, "negative-legal-session");
  const factsResponse = await recordedFetch(server, matrix, "operations-sees-declared-candidate", `/api/operations/cases/${CASE_ID}/facts`, { headers: authHeaders(legal, server, false) });
  const facts = await factsResponse.json() as { data?: { snapshot_sha256?: string; facts?: Array<{ status?: string }> } };
  assert(factsResponse.status === 200 && facts.data?.facts?.some((fact) => fact.status === "needs_confirmation") && typeof facts.data.snapshot_sha256 === "string", "OPERATIONS_DECLARED_CANDIDATE_NOT_CANONICAL");
  assert(!JSON.stringify(facts).includes("<script>"), "UNTRUSTED_CLARIFICATION_REFLECTED_IN_OPERATIONS_PROJECTION");
  const analysisBody = operationsCommand({
    action: "analysis_request",
    expectedRevision: 5,
    idempotency: "analysis-negative-0001",
    payload: { analysis_run_id: null, mode: "synthetic_test", requested_topics: TOPICS, input_snapshot_sha256: facts.data.snapshot_sha256 },
  });
  const analysisFirst = await recordedFetch(server, matrix, "analysis-first", `/api/operations/cases/${CASE_ID}/analysis/request`, { method: "POST", headers: jsonHeaders(legal, server), body: JSON.stringify(analysisBody) });
  const analysisReplay = await recordedFetch(server, matrix, "analysis-replay", `/api/operations/cases/${CASE_ID}/analysis/request`, { method: "POST", headers: jsonHeaders(legal, server), body: JSON.stringify(analysisBody) });
  const analysisConflict = await recordedFetch(server, matrix, "analysis-idempotency-conflict", `/api/operations/cases/${CASE_ID}/analysis/request`, { method: "POST", headers: jsonHeaders(legal, server), body: JSON.stringify({ ...analysisBody, reason: "סיבה סינתטית שונה ומפורטת" }) });
  const analysisStale = await recordedFetch(server, matrix, "analysis-stale", `/api/operations/cases/${CASE_ID}/analysis/request`, { method: "POST", headers: jsonHeaders(legal, server), body: JSON.stringify(operationsCommand({ action: "analysis_request", expectedRevision: 5, idempotency: "analysis-stale-0001", payload: { analysis_run_id: null, mode: "synthetic_test", requested_topics: TOPICS, input_snapshot_sha256: facts.data.snapshot_sha256 } })) });
  assert(analysisFirst.status === 200 && analysisReplay.status === 200 && analysisConflict.status === 409 && analysisStale.status === 409, "ANALYSIS_REVISION_IDEMPOTENCY_MATRIX_FAILED");

  const approver = await issueSession(server, "operations", SYNTHETIC_TICKETS.approver, matrix, "negative-approver-session");
  const caseResponse = await recordedFetch(server, matrix, "approval-case", `/api/operations/cases/${CASE_ID}`, { headers: authHeaders(approver, server, false) });
  const reportResponse = await recordedFetch(server, matrix, "approval-report", `/api/operations/cases/${CASE_ID}/report`, { headers: authHeaders(approver, server, false) });
  const caseProjection = await caseResponse.json() as { data?: { revision?: number } };
  const reportProjection = await reportResponse.json() as { data?: Record<string, unknown> };
  assert(caseProjection.data?.revision === 7 && reportProjection.data?.status === "awaiting_approval", "APPROVAL_PRECONDITION_INVALID");
  const exactApprovalPayload = {
    report_id: reportProjection.data.report_id,
    report_revision: reportProjection.data.report_revision,
    report_sha256: reportProjection.data.report_sha256,
    analysis_result_sha256: reportProjection.data.analysis_result_sha256,
    decision: "approved",
  };
  const wrongHash = await recordedFetch(server, matrix, "approval-wrong-hash", `/api/operations/cases/${CASE_ID}/report/approve`, { method: "POST", headers: jsonHeaders(approver, server), body: JSON.stringify(operationsCommand({ action: "report_approve", expectedRevision: 7, idempotency: "approval-wrong-hash-0001", payload: { ...exactApprovalPayload, report_sha256: "a".repeat(64) } })) });
  const wrongRole = await recordedFetch(server, matrix, "approval-wrong-role", `/api/operations/cases/${CASE_ID}/report/approve`, { method: "POST", headers: jsonHeaders(intake, server), body: JSON.stringify(operationsCommand({ action: "report_approve", expectedRevision: 7, idempotency: "approval-wrong-role-0001", payload: exactApprovalPayload })) });
  const approvalMissingCsrf = await recordedFetch(server, matrix, "approval-missing-csrf", `/api/operations/cases/${CASE_ID}/report/approve`, { method: "POST", headers: jsonHeaders(approver, server, false), body: JSON.stringify(operationsCommand({ action: "report_approve", expectedRevision: 7, idempotency: "approval-no-csrf-0001", payload: exactApprovalPayload })) });
  assert(wrongHash.status === 409 && wrongRole.status === 403 && approvalMissingCsrf.status === 404, "EXACT_HASH_ROLE_CSRF_NEGATIVES_FAILED");

  const sqlEnumeration = await recordedFetch(server, matrix, "sql-enumeration", `/api/operations/cases/${encodeURIComponent("x' OR 1=1 --")}`, { headers: authHeaders(legal, server, false) });
  const pathTraversal = await recordedFetch(server, matrix, "path-traversal", "/api/portal/cases/%252e%252e", { headers: authHeaders(owner, server, false) });
  const prototypePayload = await recordedFetch(server, matrix, "prototype-payload", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: `{"expected_revision":1,"request_kind":"data_export","idempotency_key":"prototype-0001","__proto__":{"polluted":true}}` });
  const resourcePayload = await recordedFetch(server, matrix, "oversized-resource", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify({ expected_revision: 1, request_kind: "data_export", idempotency_key: "x".repeat(17_000) }) });
  const ssrfPayload = await recordedFetch(server, matrix, "ssrf-url-payload", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify({ expected_revision: 1, request_kind: "data_export", idempotency_key: "ssrf-probe-0001", callback_url: "http://169.254.169.254/latest/meta-data" }) });
  const filenameInjection = await recordedFetch(server, matrix, "filename-content-disposition-injection", `/api/operations/cases/${CASE_ID}/report/export`, {
    method: "POST",
    headers: jsonHeaders(approver, server),
    body: JSON.stringify(operationsCommand({
      action: "report_manual_export",
      expectedRevision: 7,
      idempotency: "filename-injection-0001",
      payload: {
        report_id: reportProjection.data.report_id,
        report_revision: reportProjection.data.report_revision,
        report_sha256: reportProjection.data.report_sha256,
        approval_receipt_sha256: "a".repeat(64),
        format: "pdf",
        destination: "local_operator_download",
        filename: "synthetic.pdf\r\nX-Injected: true",
      },
    })),
  });
  const paymentMismatch = await recordedFetch(server, matrix, "payment-evidence-mismatch", `/api/operations/cases/${CASE_ID}/payment/reconcile`, { method: "POST", headers: jsonHeaders(intake, server), body: JSON.stringify(operationsCommand({ action: "payment_reconcile", expectedRevision: 7, idempotency: "payment-mismatch-0001", payload: { payment_reference_sha256: "f".repeat(64) } })) });
  assert(sqlEnumeration.status === 404 && pathTraversal.status === 404 && prototypePayload.status === 400 && resourcePayload.status === 400 && ssrfPayload.status === 400 && filenameInjection.status === 400 && paymentMismatch.status === 422, "ADVERSARIAL_INPUT_MATRIX_FAILED");

  const logoutSession = await issueSession(server, "portal", SYNTHETIC_TICKETS.ownerA, matrix, "logout-session");
  const logout = await recordedFetch(server, matrix, "logout", "/api/portal/session", { method: "DELETE", headers: authHeaders(logoutSession, server) });
  const afterLogout = await recordedFetch(server, matrix, "after-logout", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(logoutSession, server, false) });
  assert(logout.status === 204 && afterLogout.status === 404, "LOGOUT_DID_NOT_REVOKE_ACCESS");

  assert(expiryStatus === 404, "EXPIRED_SESSION_RETAINED_ACCESS");

  const startupReceipt = JSON.parse(readFileSync(`${laneOutput}/runtime-seed-receipt.json`, "utf8")) as {
    real_corpus?: Record<string, number>;
    provenance_candidates?: Array<Record<string, unknown>>;
    human_handoff?: { generated_decisions?: number; generated_signatures?: number; owner_actions?: unknown[] };
    safety_counters?: Record<string, number>;
  };
  assert(startupReceipt.real_corpus?.ready_topics === 0 && startupReceipt.real_corpus.blocked_topics === 7 && startupReceipt.real_corpus.calculations === 0 && startupReceipt.real_corpus.findings === 0 && startupReceipt.real_corpus.approvals === 0 && startupReceipt.real_corpus.exports === 0, "REAL_CORPUS_OUTPUT_ZERO_INVARIANT_FAILED");
  assert(startupReceipt.provenance_candidates?.length === 5 && startupReceipt.provenance_candidates.every((candidate) => candidate.eligibility === "PUBLIC_FIXTURE_PROVENANCE_NOT_ELIGIBLE" && candidate.fixture_bytes_read === 0), "PUBLIC_PROVENANCE_GATE_FAILED");
  assert(startupReceipt.human_handoff?.generated_decisions === 0 && startupReceipt.human_handoff.generated_signatures === 0 && startupReceipt.human_handoff.owner_actions?.length === 4, "HUMAN_HANDOFF_INDEX_INVALID");
  assert(Object.values(startupReceipt.safety_counters ?? {}).every((count) => count === 0), "NEGATIVE_SAFETY_COUNTER_NONZERO");

  const serializedOutputs = JSON.stringify({ matrix, startupReceipt });
  assert(!serializedOutputs.includes("v08-hermetic-session-secret") && !serializedOutputs.includes(owner.cookie) && !serializedOutputs.includes(owner.csrf), "SECRET_SCAN_FAILED");
  const httpReceipt = writeReceipt(laneOutput, "http-matrix.json", { schema_version: "tivdoc-negative-http-matrix-v0.8.0", status: "PASSED", records: matrix });
  const adversarialReceipt = writeReceipt(laneOutput, "adversarial-receipt.json", {
    schema_version: "tivdoc-adversarial-receipt-v0.8.0",
    status: "PASSED",
    authentication: { unsigned_header: unsignedHeader.status, unsigned_query: unsignedQuery.status, unsigned_cookie: unsignedCookie.status, production_preview: environmentRejections },
    authorization: { cross_owner: crossOwner.status, wrong_role: wrongRole.status, csrf: [missingCsrf.status, badOrigin.status, approvalMissingCsrf.status] },
    concurrency: { clarification_replay: answerReplay.idempotent_replay, clarification_changed_key: answerConflict.status, clarification_stale: answerStale.status, analysis_replay: analysisReplay.status, analysis_changed_key: analysisConflict.status, analysis_stale: analysisStale.status },
    binding: { wrong_report_hash: wrongHash.status, payment_mismatch: paymentMismatch.status },
    input_guards: { xss_reflected: false, sql: sqlEnumeration.status, path: pathTraversal.status, prototype: prototypePayload.status, resource: resourcePayload.status, ssrf: ssrfPayload.status, ssrf_external_calls: 0, filename_injection: filenameInjection.status },
    session: { logout: afterLogout.status, expiry: expiryStatus },
    privacy_secret_scan: "PASSED",
    safety_counters: startupReceipt.safety_counters,
  });
  const receipt = Object.freeze({
    schema_version: "tivdoc-product-e2e-negative-v0.8.0",
    status: "PASSED",
    server: { host: "127.0.0.1", ephemeral_port: true, outbound_network: "DENIED", log: relative(server.logPath) },
    environment_rejections: environmentRejections,
    clarification: { first_revision: answerFirst.candidate?.revision, replay: answerReplay.idempotent_replay, same_key_changed_http: answerConflict.status, stale_http: answerStale.status, human_review: answerFirst.candidate?.requires_human_review },
    analysis: { first: analysisFirst.status, replay: analysisReplay.status, same_key_changed: analysisConflict.status, stale: analysisStale.status },
    access: { cross_owner: crossOwner.status, wrong_role: wrongRole.status, missing_csrf: missingCsrf.status, expiry: expiryStatus, logout: afterLogout.status },
    adversarial: adversarialReceipt,
    provenance_count: startupReceipt.provenance_candidates?.length,
    human_handoff_actions: startupReceipt.human_handoff?.owner_actions?.length,
    screenshot: notFoundScreenshot,
    http_matrix: httpReceipt,
    safety_counters: startupReceipt.safety_counters,
  });
  const written = writeReceipt(laneOutput, "negative-receipt.json", receipt);
  process.stdout.write(`${JSON.stringify({ ...receipt, receipt: written })}\n`);
} finally {
  try { runPlaywright(browserSession, browserOutput, "close"); } catch { /* best-effort browser cleanup */ }
  await stopServer(server);
}

async function verifyFeatureOff(): Promise<void> {
  const disabled = await startServer({ lane: "negative", label: "feature-off", runtimeEnabled: false, stableRoutesEnabled: false });
  try {
    const statuses = [
      (await recordedFetch(disabled, matrix, "feature-off-portal-ui", "/portal")).status,
      (await recordedFetch(disabled, matrix, "feature-off-operations-ui", "/operations")).status,
      (await recordedFetch(disabled, matrix, "feature-off-portal-api", "/api/portal/cases")).status,
      (await recordedFetch(disabled, matrix, "feature-off-operations-api", "/api/operations/queue")).status,
      (await recordedFetch(disabled, matrix, "feature-off-session", "/api/portal/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: SYNTHETIC_TICKETS.ownerA }) })).status,
    ];
    assert(statuses.every((status) => status === 404), "FEATURE_OFF_NOT_HARD_404");
    environmentRejections.push(Object.freeze({ environment: "feature_off", statuses: Object.freeze(statuses) }));
  } finally {
    await stopServer(disabled);
  }
}

async function verifyRejectedRuntime(environment: "preview" | "production"): Promise<void> {
  const rejected = await startServer({ lane: "negative", label: environment, runtimeEnabled: false, stableRoutesEnabled: true, vercelEnv: environment });
  try {
    const responses: Response[] = [];
    for (const audience of ["portal", "operations"] as const) {
      responses.push(await recordedFetch(rejected, matrix, `${environment}-${audience}-session`, `/api/${audience}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: audience === "portal" ? SYNTHETIC_TICKETS.ownerA : SYNTHETIC_TICKETS.legal }),
      }));
    }
    const statuses = responses.map((response) => response.status);
    assert(statuses.every((status) => status === 404), `${environment.toUpperCase()}_SYNTHETIC_AUTH_NOT_REJECTED`);
    environmentRejections.push(Object.freeze({ environment, statuses: Object.freeze(statuses) }));
  } finally {
    await stopServer(rejected);
  }
}

async function verifyExpiry(): Promise<void> {
  const expiringServer = await startServer({ lane: "negative", label: "expiry", runtimeEnabled: true, stableRoutesEnabled: true, maxSessionSeconds: 1 });
  try {
    const expiring = await issueSession(expiringServer, "portal", SYNTHETIC_TICKETS.ownerA, matrix, "expiring-session");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expiryStatus = (await recordedFetch(expiringServer, matrix, "after-expiry", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(expiring, expiringServer, false) })).status;
    assert(expiryStatus === 404, "EXPIRED_SESSION_RETAINED_ACCESS");
  } finally {
    await stopServer(expiringServer);
  }
}
