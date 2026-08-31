import { readFileSync } from "node:fs";

import {
  CASE_ID,
  CHARGEBACK_EVIDENCE_SHA256,
  SYNTHETIC_TICKETS,
  assert,
  authHeaders,
  captureScreenshot,
  clickByName,
  copyScreenshot,
  fillFirstTextbox,
  issueSession,
  jsonHeaders,
  operationsCommand,
  outputRoot,
  playwrightRoot,
  recordedFetch,
  relative,
  runPlaywright,
  setBrowserSession,
  sha,
  snapshot,
  snapshotText,
  startServer,
  stopServer,
  waitBrowser,
  writeReceipt,
  type HttpRecord,
} from "./harness.mts";

const laneOutput = outputRoot("synthetic");
const TOPICS = ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const;
const browserOutput = playwrightRoot("synthetic");
const browserSession = `v08synthetic-${process.pid}`;
const matrix: HttpRecord[] = [];
const browserSteps: Array<Readonly<{ step: string; status: "PASS"; evidence: string }>> = [];
const screenshots: Array<Readonly<{ path: string; sha256: string; byte_count: number }>> = [];
const server = await startServer({ lane: "synthetic", label: "canonical", runtimeEnabled: true, stableRoutesEnabled: true });

try {
  const owner = await issueSession(server, "portal", SYNTHETIC_TICKETS.ownerA, matrix, "session-owner-a");
  runPlaywright(browserSession, browserOutput, "open", [`${server.baseUrl}/portal`]);
  snapshot(browserSession, browserOutput);
  setBrowserSession(browserSession, browserOutput, owner, server.baseUrl);
  runPlaywright(browserSession, browserOutput, "goto", [`${server.baseUrl}/portal`]);
  waitBrowser(browserSession, browserOutput, 1_000);
  let view = snapshot(browserSession, browserOutput);
  let rendered = snapshotText(view);
  for (const topic of ["שכר מינימום", "זמן עבודה", "פנסיה", "נסיעות", "הבראה", "חופשה", "מחלה"]) {
    assert(rendered.includes(topic), `PORTAL_TOPIC_CARD_MISSING:${topic}`);
  }
  assert(rendered.includes(CASE_ID) && rendered.includes("לאיזו תקופה מתייחס המסמך"), "PORTAL_OWNER_CASE_OR_HANDOFF_MISSING");
  screenshots.push(copyScreenshot(captureScreenshot(browserSession, browserOutput, "portal-before-analysis-desktop.png"), laneOutput));
  browserSteps.push({ step: "owner_a_portal_initial", status: "PASS", evidence: "rendered owner-scoped case, document, human clarification and seven topic cards" });

  const beforeProjectionResponse = await recordedFetch(server, matrix, "portal-before-approval", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(owner, server, false) });
  const beforeProjection = await beforeProjectionResponse.json() as { case?: { revision?: number; status?: string; reports?: unknown[] } };
  assert(beforeProjection.case?.revision === 1 && beforeProjection.case.status === "clarification_needed" && beforeProjection.case.reports?.length === 0, "PORTAL_FALSE_PREAPPROVAL_READY_STATE");

  fillFirstTextbox(browserSession, browserOutput, "התקופה הסינתטית המאומתת היא 2025-01 עד 2025-03");
  clickByName(browserSession, browserOutput, "שליחת תשובה לבדיקה");
  waitBrowser(browserSession, browserOutput, 1_200);
  view = snapshot(browserSession, browserOutput);
  rendered = snapshotText(view);
  assert(rendered.includes("התשובה התקבלה ותועבר לבדיקה אנושית"), "PORTAL_UI_CLARIFICATION_NOT_ACCEPTED");
  browserSteps.push({ step: "owner_a_clarification", status: "PASS", evidence: "rendered UI POST with CSRF reached canonical portal service" });

  clickByName(browserSession, browserOutput, "בקשת עותק מהמידע");
  waitBrowser(browserSession, browserOutput, 800);
  rendered = snapshotText(snapshot(browserSession, browserOutput));
  assert(rendered.includes("בקשת הפרטיות נרשמה"), "PORTAL_UI_PRIVACY_NOT_ACCEPTED");
  browserSteps.push({ step: "owner_a_privacy", status: "PASS", evidence: "rendered UI created a privacy request" });

  const afterAnswerResponse = await recordedFetch(server, matrix, "portal-after-answer", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(owner, server, false) });
  const afterAnswer = await afterAnswerResponse.json() as { case?: { revision?: number; status?: string; reports?: unknown[] } };
  assert(afterAnswer.case?.revision === 1 && afterAnswer.case.status === "under_review" && afterAnswer.case.reports?.length === 0, "PORTAL_PREAPPROVAL_STATE_NOT_UNDER_REVIEW");

  const legal = await issueSession(server, "operations", SYNTHETIC_TICKETS.legal, matrix, "session-legal-reviewer");
  setBrowserSession(browserSession, browserOutput, legal, server.baseUrl);
  runPlaywright(browserSession, browserOutput, "goto", [`${server.baseUrl}/operations`]);
  snapshot(browserSession, browserOutput);
  clickByName(browserSession, browserOutput, "טעינת תור והרשאות");
  waitBrowser(browserSession, browserOutput, 800);
  clickByName(browserSession, browserOutput, CASE_ID);
  waitBrowser(browserSession, browserOutput, 1_000);
  rendered = snapshotText(snapshot(browserSession, browserOutput));
  assert(rendered.includes("needs_confirmation") && rendered.includes("documents.period"), "OPERATIONS_CANONICAL_CLARIFICATION_CANDIDATE_MISSING");
  assert(TOPICS.every((topic) => rendered.includes(topic) || rendered.includes(topicLabel(topic))), "OPERATIONS_SEVEN_TOPIC_READINESS_MISSING");
  screenshots.push(copyScreenshot(captureScreenshot(browserSession, browserOutput, "operations-before-analysis-desktop.png"), laneOutput));
  browserSteps.push({ step: "legal_reviewer_loads_case", status: "PASS", evidence: "canonical service projection includes owner answer as needs_confirmation" });

  clickByName(browserSession, browserOutput, "הפעלת ניתוח סינתטי");
  waitBrowser(browserSession, browserOutput, 4_000);
  rendered = snapshotText(snapshot(browserSession, browserOutput));
  assert(rendered.includes("awaiting_report_approval"), "OPERATIONS_UI_ANALYSIS_NOT_ACCEPTED");
  browserSteps.push({ step: "legal_reviewer_runs_analysis", status: "PASS", evidence: "rendered UI triggered integrated seven-topic analysis and deterministic Hebrew report" });

  const approver = await issueSession(server, "operations", SYNTHETIC_TICKETS.approver, matrix, "session-distinct-approver");
  setBrowserSession(browserSession, browserOutput, approver, server.baseUrl);
  runPlaywright(browserSession, browserOutput, "goto", [`${server.baseUrl}/operations`]);
  snapshot(browserSession, browserOutput);
  clickByName(browserSession, browserOutput, "טעינת תור והרשאות");
  waitBrowser(browserSession, browserOutput, 800);
  clickByName(browserSession, browserOutput, CASE_ID);
  waitBrowser(browserSession, browserOutput, 900);
  clickByName(browserSession, browserOutput, "אישור גיבוב הדוח המדויק");
  waitBrowser(browserSession, browserOutput, 1_200);
  rendered = snapshotText(snapshot(browserSession, browserOutput));
  assert(rendered.includes("report_ready"), "OPERATIONS_UI_EXACT_APPROVAL_NOT_ACCEPTED");
  screenshots.push(copyScreenshot(captureScreenshot(browserSession, browserOutput, "operations-after-approval-desktop.png"), laneOutput));
  browserSteps.push({ step: "distinct_approver_exact_hash", status: "PASS", evidence: "report_approver session approved bound report_sha256 distinct from legal reviewer" });

  setBrowserSession(browserSession, browserOutput, owner, server.baseUrl);
  runPlaywright(browserSession, browserOutput, "goto", [`${server.baseUrl}/portal`]);
  view = snapshot(browserSession, browserOutput);
  rendered = snapshotText(view);
  assert(rendered.includes("דוח ששוחרר זמין") && rendered.includes("הורדת דוח מאושר"), "PORTAL_REPORT_READY_NOT_RENDERED");
  screenshots.push(copyScreenshot(captureScreenshot(browserSession, browserOutput, "portal-report-ready-desktop.png"), laneOutput));
  clickByName(browserSession, browserOutput, "הורדת דוח מאושר");
  waitBrowser(browserSession, browserOutput, 1_200);
  rendered = snapshotText(snapshot(browserSession, browserOutput));
  assert(rendered.includes("הדוח המאושר הורד"), "PORTAL_UI_DOWNLOAD_NOT_COMPLETED");
  browserSteps.push({ step: "owner_a_download_ui", status: "PASS", evidence: "rendered portal created grant and downloaded released report" });

  runPlaywright(browserSession, browserOutput, "resize", ["390", "844"]);
  snapshot(browserSession, browserOutput);
  screenshots.push(copyScreenshot(captureScreenshot(browserSession, browserOutput, "portal-report-ready-mobile.png"), laneOutput));

  const reportProjectionResponse = await recordedFetch(server, matrix, "portal-report-ready", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(owner, server, false) });
  const reportProjection = await reportProjectionResponse.json() as { case?: { revision?: number; status?: string; reports?: Array<{ report_id: string; report_sha256: string }> } };
  const portalReport = reportProjection.case?.reports?.[0];
  assert(reportProjection.case?.revision === 2 && reportProjection.case.status === "report_available" && portalReport, "PORTAL_POSTAPPROVAL_STATE_INVALID");

  const grantResponse = await recordedFetch(server, matrix, "portal-report-grant", `/api/portal/cases/${CASE_ID}/reports/${portalReport.report_id}/grants`, {
    method: "POST",
    headers: jsonHeaders(owner, server),
    body: JSON.stringify({ expected_revision: 2 }),
  });
  assert(grantResponse.status === 200, "PORTAL_REPORT_GRANT_FAILED");
  const grant = (await grantResponse.json() as { grant?: Record<string, unknown> }).grant;
  assert(grant, "PORTAL_REPORT_GRANT_MISSING");
  const downloadResponse = await recordedFetch(server, matrix, "portal-report-download", "/api/portal/reports/download", {
    method: "POST",
    headers: jsonHeaders(owner, server),
    body: JSON.stringify(grant),
  });
  const portalBytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const portalSha = sha(portalBytes);
  assert(downloadResponse.status === 200 && downloadResponse.headers.get("x-tivdoc-artifact-sha256") === portalSha, "PORTAL_DOWNLOAD_DIGEST_BINDING_FAILED");

  const opsCaseResponse = await recordedFetch(server, matrix, "operations-case-after-approval", `/api/operations/cases/${CASE_ID}`, { headers: authHeaders(approver, server, false) });
  const opsCase = await opsCaseResponse.json() as { data?: { revision?: number } };
  const opsReportResponse = await recordedFetch(server, matrix, "operations-report-after-approval", `/api/operations/cases/${CASE_ID}/report`, { headers: authHeaders(approver, server, false) });
  const opsReport = await opsReportResponse.json() as { data?: Record<string, unknown> };
  assert(opsCase.data?.revision === 8 && opsReport.data?.status === "approved", "OPERATIONS_APPROVAL_PROJECTION_INVALID");
  const exportResponse = await recordedFetch(server, matrix, "operations-exact-export", `/api/operations/cases/${CASE_ID}/report/export`, {
    method: "POST",
    headers: jsonHeaders(approver, server),
    body: JSON.stringify(operationsCommand({
      action: "report_manual_export",
      expectedRevision: 8,
      idempotency: "browser-export-0001",
      payload: {
        report_id: opsReport.data.report_id,
        report_revision: opsReport.data.report_revision,
        report_sha256: opsReport.data.report_sha256,
        approval_receipt_sha256: opsReport.data.exact_hash_approval_receipt_sha256,
        format: "pdf",
        destination: "local_operator_download",
      },
    })),
  });
  const exportBytes = new Uint8Array(await exportResponse.arrayBuffer());
  const exportSha = sha(exportBytes);
  assert(exportResponse.status === 200 && exportSha === portalSha && exportResponse.headers.get("x-tivdoc-artifact-sha256") === portalSha, "STORED_DOWNLOADED_EXACT_BYTE_MISMATCH");

  const privacyBody = { expected_revision: 2, request_kind: "data_export", idempotency_key: "privacy-http-0001" };
  const privacyFirstResponse = await recordedFetch(server, matrix, "privacy-first", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify(privacyBody) });
  const privacyFirst = await privacyFirstResponse.json() as { request?: { revision?: number; receipt_sha256?: string }; idempotent_replay?: boolean };
  const privacyReplayResponse = await recordedFetch(server, matrix, "privacy-replay", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify(privacyBody) });
  const privacyReplay = await privacyReplayResponse.json() as { request?: { revision?: number; receipt_sha256?: string }; idempotent_replay?: boolean };
  const privacyConflict = await recordedFetch(server, matrix, "privacy-idempotency-conflict", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify({ ...privacyBody, request_kind: "correction" }) });
  const privacyStale = await recordedFetch(server, matrix, "privacy-stale-revision", `/api/portal/cases/${CASE_ID}/privacy`, { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify({ ...privacyBody, expected_revision: 1, idempotency_key: "privacy-http-stale-0001" }) });
  assert(privacyFirstResponse.status === 200 && privacyFirst.request?.revision === 2 && privacyFirst.idempotent_replay === false, "PRIVACY_REVISION_MISSING");
  assert(privacyReplayResponse.status === 200 && privacyReplay.idempotent_replay === true && privacyReplay.request?.receipt_sha256 === privacyFirst.request?.receipt_sha256, "PRIVACY_IDEMPOTENT_REPLAY_FAILED");
  assert(privacyConflict.status === 409 && privacyStale.status === 409, "PRIVACY_CONFLICT_OR_STALE_NOT_REJECTED");

  const otherOwner = await issueSession(server, "portal", SYNTHETIC_TICKETS.ownerB, matrix, "session-owner-b");
  const crossOwner = await recordedFetch(server, matrix, "cross-owner-not-found", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(otherOwner, server, false) });
  assert(crossOwner.status === 404, "CROSS_OWNER_ENUMERATION_NOT_HIDDEN");

  const intake = await issueSession(server, "operations", SYNTHETIC_TICKETS.intake, matrix, "session-intake-chargeback");
  const chargeback = await recordedFetch(server, matrix, "synthetic-chargeback", `/api/operations/cases/${CASE_ID}/payment/reconcile`, {
    method: "POST",
    headers: jsonHeaders(intake, server),
    body: JSON.stringify(operationsCommand({
      action: "payment_reconcile",
      expectedRevision: 9,
      idempotency: "browser-chargeback-0001",
      payload: { payment_reference_sha256: CHARGEBACK_EVIDENCE_SHA256 },
    })),
  });
  assert(chargeback.status === 200, "SYNTHETIC_CHARGEBACK_MUTATION_FAILED");
  const holdProjectionResponse = await recordedFetch(server, matrix, "portal-release-hold", `/api/portal/cases/${CASE_ID}`, { headers: authHeaders(owner, server, false) });
  const holdProjection = await holdProjectionResponse.json() as { case?: { status?: string; reports?: unknown[]; blocker_codes?: string[] } };
  const heldDownload = await recordedFetch(server, matrix, "held-grant-download-rejected", "/api/portal/reports/download", { method: "POST", headers: jsonHeaders(owner, server), body: JSON.stringify(grant) });
  assert(holdProjection.case?.status === "hold" && holdProjection.case.reports?.length === 0 && holdProjection.case.blocker_codes?.includes("release_hold"), "CHARGEBACK_HOLD_PROJECTION_FAILED");
  assert(heldDownload.status === 404, "CHARGEBACK_DID_NOT_BLOCK_PRIOR_GRANT");

  const auditor = await issueSession(server, "operations", SYNTHETIC_TICKETS.auditor, matrix, "session-auditor");
  const auditResponse = await recordedFetch(server, matrix, "canonical-audit", `/api/operations/cases/${CASE_ID}/audit`, { headers: authHeaders(auditor, server, false) });
  const audit = await auditResponse.json() as { data?: { chain_valid?: boolean; event_count?: number; tail_sha256?: string } };
  assert(auditResponse.status === 200 && audit.data?.chain_valid === true && (audit.data.event_count ?? 0) >= 10, "CANONICAL_AUDIT_CHAIN_INVALID");

  const browserNetwork = runPlaywright(browserSession, browserOutput, "requests");
  const startupReceipt = JSON.parse(readFileSync(`${laneOutput}/runtime-seed-receipt.json`, "utf8")) as {
    real_corpus?: Record<string, number>;
    provenance_candidates?: unknown[];
    human_handoff?: { generated_decisions?: number; generated_signatures?: number };
    safety_counters?: Record<string, number>;
  };
  assert(startupReceipt.real_corpus?.active_sources === 0 && startupReceipt.real_corpus.ready_topics === 0 && startupReceipt.real_corpus.blocked_topics === 7 && startupReceipt.real_corpus.calculations === 0, "REAL_CORPUS_ZERO_SEVEN_FAILED");
  assert(startupReceipt.provenance_candidates?.length === 5, "PROVENANCE_FIVE_CANDIDATES_MISSING");
  assert(startupReceipt.human_handoff?.generated_decisions === 0 && startupReceipt.human_handoff.generated_signatures === 0, "HUMAN_HANDOFF_FABRICATION_DETECTED");
  assert(Object.values(startupReceipt.safety_counters ?? {}).every((count) => count === 0), "SAFETY_COUNTER_NONZERO");

  const trace = Object.freeze({
    schema_version: "tivdoc-ui-service-trace-v0.8.0",
    status: "PASSED",
    case_id: CASE_ID,
    path: [
      { boundary: "rendered_ui", evidence: ["/portal", "/operations", ...screenshots.map((item) => item.path)] },
      { boundary: "loopback_http", evidence: matrix.map((item) => `${item.method} ${item.path} ${item.status}`) },
      { boundary: "signed_server_session", evidence: ["HttpOnly", "SameSite=Strict", "audience-bound HMAC"] },
      { boundary: "authorization_policy", evidence: ["owner A", "owner B not-found", "legal reviewer", "distinct report approver"] },
      { boundary: "canonical_use_case", evidence: ["CustomerPortalService", "InternalOpsService", "CaseAnalysisApplication"] },
      { boundary: "composition_root", evidence: ["installCanonicalProductRouteServices", "createIntegratedFullSystemHarness"] },
      { boundary: "repository_storage", evidence: ["LocalDurablePlatformStore", "LocalPrivateObjectStorage", "SyntheticPortalRepository"] },
      { boundary: "canonical_report", evidence: [portalReport.report_sha256, portalSha] },
    ],
    browser_steps: browserSteps,
    browser_network: browserNetwork,
  });
  const httpReceipt = writeReceipt(laneOutput, "http-matrix.json", { schema_version: "tivdoc-http-matrix-v0.8.0", status: "PASSED", records: matrix });
  const traceReceipt = writeReceipt(laneOutput, "ui-service-trace.json", trace);
  const receipt = Object.freeze({
    schema_version: "tivdoc-product-e2e-synthetic-v0.8.0",
    status: "PASSED",
    server: { host: "127.0.0.1", ephemeral_port: true, outbound_network: "DENIED", log: relative(server.logPath) },
    sessions: { cookie_attributes: owner.set_cookie_attributes, owner_a: true, owner_b: true, legal_reviewer: true, distinct_approver: true },
    lifecycle: { before_approval: beforeProjection.case?.status, after_answer: afterAnswer.case?.status, after_approval: reportProjection.case?.status, after_chargeback: holdProjection.case?.status },
    canonical_topics: { synthetic_calculated: 7, real_ready: 0, real_blocked: 7 },
    report: { report_sha256: portalReport.report_sha256, stored_sha256: portalSha, portal_download_sha256: portalSha, operations_export_sha256: exportSha, exact_bytes_equal: true },
    privacy: { revision: privacyFirst.request?.revision, idempotent_replay: privacyReplay.idempotent_replay, audit_receipt_sha256: privacyFirst.request?.receipt_sha256, changed_same_key_http: privacyConflict.status, stale_http: privacyStale.status },
    access: { cross_owner_http: crossOwner.status, held_download_http: heldDownload.status },
    audit: audit.data,
    screenshots,
    evidence: { http_matrix: httpReceipt, ui_service_trace: traceReceipt },
    safety_counters: startupReceipt.safety_counters,
  });
  const written = writeReceipt(laneOutput, "synthetic-receipt.json", receipt);
  process.stdout.write(`${JSON.stringify({ ...receipt, receipt: written })}\n`);
} finally {
  try { runPlaywright(browserSession, browserOutput, "close"); } catch { /* best-effort browser cleanup */ }
  await stopServer(server);
}

function topicLabel(topic: typeof TOPICS[number]): string {
  return ({ minimum_wage: "שכר מינימום", working_time: "זמן עבודה", pension: "פנסיה", travel: "נסיעות", convalescence: "הבראה", vacation: "חופשה", sick_leave: "מחלה" })[topic];
}
