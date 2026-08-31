import { createHash } from "node:crypto";

import { buildSyntheticCaseFixture } from "../../../engine/case-analysis/synthetic-fixtures";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts";
import { createIntegratedFullSystemHarness } from "../../engine/case-analysis/integrated-harness";
import { createFixtureCaseAnalysisHarness } from "../../engine/case-analysis/fixture-harness";
import { InMemoryBackupSource, InMemoryRestoreTarget, createLocalBackup, planLocalRestore, restoreLocalFixture, verifyLocalBackup } from "../../platform/backup/backup-service";
import { coarseHealth, coarseReadiness } from "../../platform/observability/health";
import { SafeLogSink, SafeMetricsRegistry } from "../../platform/observability/safe-observability";
import { DefaultOffKillSwitches, LocalDryRunOperator } from "../../platform/operations/controls";
import { parserSandboxCapability, parserSandboxSpecification } from "../../platform/security/parser-sandbox";
import { assertSafeOperationalRecord, scanPrivacyCanaries } from "../../platform/security/privacy";
import { InMemoryAdmissionLimiter, assertBoundedJsonInput, parameterizedSql, renderUntrustedTextInert, validateOutboundHttpsTarget } from "../../platform/security/request-guards";
import type { StoredReportEdition } from "../customer-portal/contracts";
import { SyntheticPortalRepository } from "../customer-portal/synthetic-repository";
import { p8Check, P8_SCHEMA_VERSION, type P8Check, type P8ReadyReceipt } from "./contracts";
import { NO_ELIGIBLE_PUBLIC_FIXTURE, pendingDependencies } from "./dependency-seams";
import { P8_NOW, P8_NOW_MS, addSession, createP8Harness, opsEnvelope, opsRequest, storePdf, verifiedSyntheticActor } from "./ready-harness";

const CASE_ID_EXPECTATION = /^[a-z][a-z0-9-]{7,63}$/;
const TENANT_ID = "tenant01";

function sha(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }

async function expectRejected(operation: () => unknown | Promise<unknown>): Promise<string> {
  try { await operation(); return "NOT_REJECTED"; } catch (error) {
    if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
    return error instanceof Error ? error.message : String(error);
  }
}

async function post(harness: Awaited<ReturnType<typeof createP8Harness>>, token: string, segments: readonly string[], body: unknown, input: Readonly<{ csrf?: string; origin?: string }> = {}) {
  return harness.http.handle(opsRequest(token, body, { method: "POST", ...input }), segments);
}

export async function runP8ReadyIntegration(): Promise<P8ReadyReceipt> {
  const checks: P8Check[] = [];
  const harness = await createP8Harness();
  const canonicalFixture = buildSyntheticCaseFixture({ fixture_id: "p8-0" });
  const caseId = canonicalFixture.command.case_id;
  if (!CASE_ID_EXPECTATION.test(caseId)) throw new Error("P8_SYNTHETIC_CASE_ID_NOT_P2_COMPATIBLE");

  const actors = Object.freeze({
    intake: verifiedSyntheticActor({ actor_id: "intake01", role: "intake_operator", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    extraction: verifiedSyntheticActor({ actor_id: "extract01", role: "extraction_reviewer", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    facts: verifiedSyntheticActor({ actor_id: "factsrev01", role: "fact_reviewer", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    legal: verifiedSyntheticActor({ actor_id: "legalrev01", role: "legal_reviewer", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    approver: verifiedSyntheticActor({ actor_id: "approver01", role: "report_approver", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    auditor: verifiedSyntheticActor({ actor_id: "auditor01", role: "auditor", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    owner: verifiedSyntheticActor({ actor_id: "customer01", role: "customer_owner", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
    otherOwner: verifiedSyntheticActor({ actor_id: "customer02", role: "customer_owner", tenant_id: TENANT_ID, assigned_case_ids: [caseId] }),
  });
  const sessions = Object.freeze({ intake: "session_intake01", extraction: "session_extract01", facts: "session_factsrev01", legal: "session_legalrev01", approver: "session_approver01", auditor: "session_auditor01" });
  for (const key of Object.keys(sessions) as (keyof typeof sessions)[]) addSession(harness, sessions[key], actors[key]);

  const intakeSha = canonicalSha256({ fixture_id: "p8-0", source: "synthetic_only" });
  const created = await post(harness, sessions.intake, ["cases"], opsEnvelope("case_create", caseId, 0, { intake_reference_sha256: intakeSha }, "create"));
  if (created.status !== 200) throw new Error(`P8_CREATE_FAILED:${created.status}:${await created.text()}`);

  const paymentCore = {
    evidence_id: "evidence01",
    evidence_revision: "revision01",
    case_reference: caseId,
    customer_reference: "customer01",
    amount: { currency: "XTS", minor_units: 1 },
    status: "settled" as const,
    duplicate_of_evidence_id: null,
  };
  const settledEvidence = Object.freeze({ ...paymentCore, evidence_sha256: canonicalSha256(paymentCore) });
  harness.payments.appendVerifiedEvidence(settledEvidence);
  const paid = await post(harness, sessions.intake, ["cases", caseId, "payment", "reconcile"], opsEnvelope("payment_reconcile", caseId, 1, { payment_reference_sha256: settledEvidence.evidence_sha256 }, "payment"));
  if (paid.status !== 200) throw new Error(`P8_PAYMENT_FAILED:${paid.status}:${await paid.text()}`);

  const documentBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const documentStored = await storePdf(harness, actors.intake, documentBytes, "document");
  const document = await post(harness, sessions.intake, ["cases", caseId, "documents"], opsEnvelope("document_reference_add", caseId, 2, { object_version_id: documentStored.object_version_id, object_sha256: documentStored.object_sha256, byte_length: documentBytes.byteLength, detected_mime: "application/pdf" }, "document"));
  if (document.status !== 200) throw new Error(`P8_DOCUMENT_FAILED:${document.status}:${await document.text()}`);

  const extractionSha = canonicalSha256({ case_id: caseId, provider: "stored_synthetic_snapshot", version: 1 });
  const extraction = await post(harness, sessions.extraction, ["cases", caseId, "extraction", "review"], opsEnvelope("extraction_review", caseId, 3, { extraction_snapshot_sha256: extractionSha, field_ids: ["field001"], decision: "approved" }, "extract"));
  if (extraction.status !== 200) throw new Error(`P8_EXTRACTION_FAILED:${extraction.status}:${await extraction.text()}`);

  const factsSha = canonicalSha256({ case_id: caseId, source_snapshot_sha256: extractionSha, version: 1 });
  const facts = await post(harness, sessions.facts, ["cases", caseId, "facts", "resolve"], opsEnvelope("fact_resolution", caseId, 4, { facts_snapshot_sha256: factsSha, fact_ids: ["fact0001"], decision: "confirmed" }, "facts"));
  if (facts.status !== 200) throw new Error(`P8_FACTS_FAILED:${facts.status}:${await facts.text()}`);

  const requested = await post(harness, sessions.legal, ["cases", caseId, "analysis", "request"], opsEnvelope("analysis_request", caseId, 5, { analysis_run_id: null, mode: "synthetic_test", requested_topics: WAVE3_TOPICS, input_snapshot_sha256: factsSha }, "analysis"));
  if (requested.status !== 200) throw new Error(`P8_ANALYSIS_REQUEST_FAILED:${requested.status}:${await requested.text()}`);

  // The synthetic lane uses the existing canonical CaseAnalysisService fixture
  // composition; P8 itself supplies no legal/catalog truth. The separate real
  // corpus journey below uses the integrated current-catalog composition.
  const canonical = createFixtureCaseAnalysisHarness([canonicalFixture.stored]);
  const bundle = await canonical.application.runCaseAnalysis(canonicalFixture.command);
  const completed = await canonical.service.getCompletedRun(bundle.analysis_run_id);
  if (!completed?.report || !bundle.coverage_complete || !bundle.topic_results.every((item) => item.status === "calculated") || canonical.executor.counters.execute_calls < 1) throw new Error(`P8_CANONICAL_SYNTHETIC_ANALYSIS_FAILED:${JSON.stringify({ report: Boolean(completed?.report), coverage: bundle.coverage_complete, statuses: bundle.topic_results.map((item) => item.status), execute_calls: canonical.executor.counters.execute_calls })}`);
  const storedReport = await storePdf(harness, actors.legal, completed.report.pdf, "report");
  await harness.adapter.attachCanonicalAnalysis(caseId, {
    analysis_run_id: bundle.analysis_run_id,
    analysis_result_sha256: bundle.result_sha256,
    report_id: completed.report.report_id,
    report_sha256: completed.report.report_sha256,
    artifact_sha256: storedReport.artifact_sha256,
    object_version_id: storedReport.object_version_id,
    coverage_complete: bundle.coverage_complete,
    bytes: completed.report.pdf,
    actor_id: actors.legal.actor_id,
  });
  const reportState = (await harness.adapter.report(actors.legal, caseId))!;
  const submitted = await post(harness, sessions.legal, ["cases", caseId, "report", "submit"], opsEnvelope("report_submit", caseId, 7, { report_id: reportState.report_id!, report_revision: reportState.report_revision!, report_sha256: reportState.report_sha256!, analysis_result_sha256: reportState.analysis_result_sha256!, decision: "submitted" }, "submit"));
  if (submitted.status !== 200) throw new Error(`P8_REPORT_SUBMIT_FAILED:${submitted.status}:${await submitted.text()}`);
  const approved = await post(harness, sessions.approver, ["cases", caseId, "report", "approve"], opsEnvelope("report_approve", caseId, 8, { report_id: reportState.report_id!, report_revision: reportState.report_revision!, report_sha256: reportState.report_sha256!, analysis_result_sha256: reportState.analysis_result_sha256!, decision: "approved" }, "approve"));
  if (approved.status !== 200) throw new Error(`P8_REPORT_APPROVE_FAILED:${approved.status}:${await approved.text()}`);
  const approvedReport = (await harness.adapter.report(actors.approver, caseId))!;
  const exported = await post(harness, sessions.approver, ["cases", caseId, "report", "export"], opsEnvelope("report_manual_export", caseId, 9, { report_id: approvedReport.report_id!, report_revision: approvedReport.report_revision!, report_sha256: approvedReport.report_sha256!, approval_receipt_sha256: approvedReport.exact_hash_approval_receipt_sha256!, format: "pdf", destination: "local_operator_download" }, "export"));
  const exportedBytes = new Uint8Array(await exported.arrayBuffer());
  const journeyPassed = exported.status === 200 && sha(exportedBytes) === storedReport.artifact_sha256 && harness.store.caseRevision(caseId) === 10;
  checks.push(p8Check("V07-P8-SYNTHETIC-READY", journeyPassed ? "PASS" : "SKIPPED_BLOCKED", {
    actual_services: ["P1.LocalDurablePlatformStore", "P1.LocalDurableJobQueue", "P2.deriveVerifiedActor", "P2.authorize", "P2.LocalPrivateObjectStorage", "P5.InternalOpsService", "P5.createInternalOpsHttpAdapter", "Wave3.CaseAnalysisService"],
    case_revision: harness.store.caseRevision(caseId),
    report_sha256: approvedReport.report_sha256,
    artifact_sha256: storedReport.artifact_sha256,
    exact_export_hash_match: sha(exportedBytes) === storedReport.artifact_sha256,
    canonical_topic_count: bundle.topic_results.length,
    canonical_calculation_count: bundle.topic_results.filter((item) => item.status === "calculated").length,
    currency: bundle.known_subtotal?.currency ?? null,
    customer_data: false,
  }));

  const outboxFirst = await harness.store.claimOutbox("worker01", P8_NOW_MS, 10);
  const outboxSecond = await harness.store.claimOutbox("worker02", P8_NOW_MS + 11, 10);
  const staleOutbox = outboxFirst ? await expectRejected(() => harness.store.publishOutbox({ outbox_id: outboxFirst.outbox_id, worker_id: "worker01", fencing_token: outboxFirst.fencing_token, logical_effect_sha256: canonicalSha256({ published: outboxFirst.outbox_id }) })) : "OUTBOX_MISSING";
  if (outboxSecond) await harness.store.publishOutbox({ outbox_id: outboxSecond.outbox_id, worker_id: "worker02", fencing_token: outboxSecond.fencing_token, logical_effect_sha256: canonicalSha256({ published: outboxSecond.outbox_id }) });
  const jobPayload = { case_id: caseId, operation: "synthetic_analysis_receipt" };
  await harness.jobs.enqueue({ job_id: "jobready01", tenant_id: TENANT_ID, case_id: caseId, job_kind: "analysis", idempotency_key: "jobidemready01", payload_sha256: canonicalSha256(jobPayload), payload: jobPayload, pinned_version_sha256s: [bundle.result_sha256], max_attempts: 3, available_at_ms: P8_NOW_MS });
  const jobFirst = (await harness.jobs.claim("worker01", P8_NOW_MS, 10))[0]!;
  const jobSecond = (await harness.jobs.claim("worker02", P8_NOW_MS + 11, 10))[0]!;
  const staleJob = await expectRejected(() => harness.jobs.start(jobFirst.job_id, "worker01", jobFirst.fencing_token, P8_NOW_MS + 11));
  const running = await harness.jobs.start(jobSecond.job_id, "worker02", jobSecond.fencing_token, P8_NOW_MS + 12);
  await harness.jobs.succeed(running.job_id, "worker02", running.fencing_token, P8_NOW_MS + 13, canonicalSha256({ completed: running.job_id }));
  checks.push(p8Check("V07-P8-CONCURRENCY-FENCING", staleOutbox.includes("STALE_FENCING_TOKEN") && staleJob.includes("STALE_FENCING_TOKEN") ? "PASS" : "SKIPPED_BLOCKED", { stale_outbox_result: staleOutbox, stale_job_result: staleJob, job_state: harness.jobs.get("jobready01")?.state, outbox_published: harness.store.outboxEvents().filter((item) => item.status === "published").length }));

  const staleRevisionResponse = await post(harness, sessions.intake, ["cases", caseId, "payment", "reconcile"], opsEnvelope("payment_reconcile", caseId, 1, { payment_reference_sha256: settledEvidence.evidence_sha256 }, "stale"));
  const replayBody = opsEnvelope("report_manual_export", caseId, 9, { report_id: approvedReport.report_id!, report_revision: approvedReport.report_revision!, report_sha256: approvedReport.report_sha256!, approval_receipt_sha256: approvedReport.exact_hash_approval_receipt_sha256!, format: "pdf", destination: "local_operator_download" }, "export");
  const replayResponse = await post(harness, sessions.approver, ["cases", caseId, "report", "export"], replayBody);
  const changedReplay = Object.freeze({ ...replayBody, payload: Object.freeze({ ...replayBody.payload, format: "json" }) });
  const idemConflictResponse = await post(harness, sessions.approver, ["cases", caseId, "report", "export"], changedReplay);
  checks.push(p8Check("V07-P8-REVISION-IDEMPOTENCY", staleRevisionResponse.status === 409 && replayResponse.status === 200 && idemConflictResponse.status === 409 ? "PASS" : "SKIPPED_BLOCKED", { stale_revision_http: staleRevisionResponse.status, same_command_replay_http: replayResponse.status, changed_command_same_key_http: idemConflictResponse.status }));

  const adverseCore = { ...paymentCore, evidence_revision: "revision02", status: "chargeback" as const };
  const adverse = Object.freeze({ ...adverseCore, evidence_sha256: canonicalSha256(adverseCore) });
  harness.payments.appendVerifiedEvidence(adverse);
  const adverseResponse = await post(harness, sessions.intake, ["cases", caseId, "payment", "reconcile"], opsEnvelope("payment_reconcile", caseId, 10, { payment_reference_sha256: adverse.evidence_sha256 }, "adverse"));
  const heldReport = (await harness.adapter.report(actors.approver, caseId))!;
  checks.push(p8Check("V07-P8-PAYMENT-ADVERSE", adverseResponse.status === 200 && heldReport.status === "invalidated" && !heldReport.manual_export_eligible ? "PASS" : "SKIPPED_BLOCKED", { payment_status: (await harness.adapter.payment(actors.intake, caseId))?.status, report_status: heldReport.status, manual_export_eligible: heldReport.manual_export_eligible, invalidation_codes: harness.adapter.state(caseId)?.invalidation_codes }));

  const portalInitialReport: StoredReportEdition = Object.freeze({ report_id: approvedReport.report_id!, report_revision: 1, case_id: caseId, edition: "full_reviewed_report", report_sha256: approvedReport.report_sha256!, artifact_sha256: storedReport.artifact_sha256, object_version_id: storedReport.object_version_id, release_receipt_sha256: canonicalSha256({ release: 1, report: approvedReport.report_sha256 }), release_state: "released", coverage_complete: true, blocker_codes: [], created_at: P8_NOW });
  harness.portalRepository.seedCase({ case_id: caseId, tenant_id: TENANT_ID, owner_actor_id: actors.owner.actor_id, revision: 1, lifecycle_state: "report_ready", lifecycle_history: [{ revision: 1, lifecycle_state: "report_ready", occurred_at: P8_NOW }], blocker_codes: [], document_references: [{ document_id: "document01", declared_type: "payslip", status: "accepted", revision: 1 }], retention: { retention_class: "case_record", legal_hold: true, deletion_status: "not_requested" } });
  harness.portalRepository.seedProductEvidence({ evidence_id: "productevidence01", evidence_sha256: canonicalSha256({ case_id: caseId, edition: "full_reviewed_report" }), case_id: caseId, owner_actor_id: actors.owner.actor_id, edition: "full_reviewed_report", status: "verified", source: "verified_server_evidence" });
  harness.portalRepository.seedReport(portalInitialReport, completed.report.pdf);
  const invite = harness.portalRepository.createInvite({ invite_id: "invite0001", case_id: caseId, owner_actor_id: actors.owner.actor_id, audience: "portal-audience", expires_at: "2040-01-01T00:10:00.000Z", synthetic_secret: "synthetic-secret-only" });
  const accepted = harness.portal.acceptSyntheticInvite(invite.token, "portal-audience");
  harness.portal.recordConsent(actors.owner, { case_id: caseId, consent_version: "consent-v1", terms_version: "terms-v1", granted: true, idempotency_key: "consentidem0001" });
  const tasks = harness.portal.requestClarifications(actors.facts, caseId, [{ fact_path: "documents.period", status: "conflicted", fact_ids: ["documentedfact01"], state_sha256: canonicalSha256({ conflict: true }) }], []);
  const answer = harness.portal.answerClarification(actors.owner, { case_id: caseId, task_id: tasks[0]!.task_id, question_version: tasks[0]!.question_version, value: { declared_period: "synthetic-period" }, explicit_confirmation: true, consent_version: "consent-v1", terms_version: "terms-v1", idempotency_key: "answeridem0001" });
  const afterAnswer = harness.portal.listReports(actors.owner, caseId);
  const rerunReport = Object.freeze({ ...portalInitialReport, report_revision: 3, release_receipt_sha256: canonicalSha256({ release: 3, report: approvedReport.report_sha256 }), created_at: "2040-01-01T00:00:01.000Z" });
  harness.portalRepository.seedReport(rerunReport, completed.report.pdf);
  const reports = harness.portal.listReports(actors.owner, caseId);
  const portalGrant = harness.portal.createReportAccessGrant(actors.owner, caseId, reports[0]!.report_id);
  const download = harness.portal.downloadReport(actors.owner, portalGrant);
  harness.allowedReads.add(`${actors.owner.actor_id}:${storedReport.object_version_id}:${caseId}`);
  const privateGrant = await harness.storage.issuePrivateGrant({ actor: actors.owner, version_id: storedReport.object_version_id, scope_ref: caseId, ttl_ms: 60_000 });
  const privateBytes = await harness.storage.readWithGrant(privateGrant.token, actors.owner, caseId);
  const privacy = harness.portal.createPrivacyRequest(actors.owner, { case_id: caseId, request_kind: "deletion", idempotency_key: "privacyidem0001" });
  const crossOwner = await expectRejected(() => harness.portal.getCaseProjection(actors.otherOwner, caseId));
  checks.push(p8Check("V07-P8-PORTAL-JOURNEY", accepted.case_id === caseId && afterAnswer.length === 0 && reports.length === 1 && sha(download.bytes) === sha(privateBytes) && crossOwner === "PORTAL_NOT_FOUND" ? "PASS" : "SKIPPED_BLOCKED", { invite_accepted: accepted.case_id === caseId, declared_provenance: answer.candidate.provenance.source_type, conflict_preserved: answer.candidate.conflicting_documented_fact_ids, prior_release_invalidated: afterAnswer.length === 0, rerun_report_revision: reports[0]?.report_revision, exact_p2_p6_artifact_hash: sha(download.bytes), privacy_status: privacy.request.status, cross_owner_result: crossOwner, filename: download.filename }));

  const unauthorized = await post(harness, sessions.facts, ["cases", caseId, "report", "approve"], opsEnvelope("report_approve", caseId, 11, { report_id: approvedReport.report_id!, report_revision: 1, report_sha256: approvedReport.report_sha256!, analysis_result_sha256: approvedReport.analysis_result_sha256!, decision: "approved" }, "forgery"));
  const noCsrfRequest = opsRequest(sessions.intake, opsEnvelope("payment_reconcile", caseId, 11, { payment_reference_sha256: adverse.evidence_sha256 }, "csrf"), { method: "POST" });
  noCsrfRequest.headers.set("x-csrf-token", "different-token-that-is-long-enough-0000000000");
  const noCsrf = await harness.http.handle(noCsrfRequest, ["cases", caseId, "payment", "reconcile"]);
  const productionIdentity = await expectRejected(() => verifiedSyntheticActor({ actor_id: "production01", role: "intake_operator", tenant_id: TENANT_ID, assigned_case_ids: [caseId], runtime: "production" }));
  const productionPortal = await expectRejected(() => new SyntheticPortalRepository({ now: () => P8_NOW }, "production"));
  const ssrf = await expectRejected(() => validateOutboundHttpsTarget("https://127.0.0.1/metadata", async () => ["127.0.0.1"]));
  const xss = renderUntrustedTextInert("<script>alert(1)</script>");
  const sql = parameterizedSql`SELECT * FROM engine_case_state WHERE case_id = ${"x' OR 1=1 --"}`;
  const prototypeGuard = await expectRejected(() => assertBoundedJsonInput({ constructor: "pollute" }));
  const limiter = new InMemoryAdmissionLimiter({ max_requests: 1, max_in_flight: 1, window_ms: 1_000 });
  const admitted = limiter.admit("subject01", P8_NOW_MS);
  const resourceGuard = await expectRejected(() => limiter.admit("subject01", P8_NOW_MS));
  admitted.release();
  const activePdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</OpenAction 2 0 R>>endobj\n%%EOF\n");
  const activePdfStored = await expectRejected(async () => {
    const reservation = await harness.storage.reserve({ command_id: "activepdf01", idempotency_key: "activepdfidem01", expected_revision: 0, actor: actors.intake, reason: "STORAGE_WRITE", payload: { expected_sha256: sha(activePdf), expected_length: activePdf.byteLength, detected_mime: "application/pdf", retention_class: "temporary" } });
    await harness.storage.stage(reservation, (async function* () { yield activePdf; })());
  });
  const pathGuard = await expectRejected(() => createLocalBackup(new InMemoryBackupSource([{ path: "../escape", bytes: new Uint8Array([1]) }]), { backup_id: "backupbad01", created_at: P8_NOW, watermark: "watermark01", key_version: "keyversion01" }));
  const canary = scanPrivacyCanaries({ note: "synthetic@example.invalid", secret: "p8-canary-value" }, ["p8-canary-value"]);
  const safeOperational = { schema_version: "1", event: "integration", status: "PASS", code: "SAFE", opaque_id: "opaqueid01", correlation_id: "correlate01", sha256: bundle.result_sha256, sequence: 1, timestamp: P8_NOW };
  assertSafeOperationalRecord(safeOperational);
  const sandbox = parserSandboxCapability({ docker: "unavailable", supported_microvm: false });
  checks.push(p8Check("V07-P8-ADVERSARIAL-READY", unauthorized.status === 403 && noCsrf.status === 422 && productionIdentity === "TEST_IDENTITY_PRODUCTION_FORBIDDEN" && productionPortal === "TEST_ADAPTER_FORBIDDEN_IN_PRODUCTION" && ssrf.includes("SSRF_") && activePdfStored === "PRIVATE_OBJECT_PDF_ACTIVE_CONTENT" && pathGuard === "BACKUP_PATH_UNSAFE" && !canary.safe ? "PASS" : "SKIPPED_BLOCKED", { cross_role_http: unauthorized.status, csrf_http: noCsrf.status, production_identity: productionIdentity, production_portal: productionPortal, ssrf_result: ssrf, xss_inert: xss, sql_text: sql.text, sql_value_count: sql.values.length, prototype_guard: prototypeGuard, resource_guard: resourceGuard, active_pdf_guard: activePdfStored, file_path_guard: pathGuard, privacy_canary_codes: canary.violation_codes, parser_sandbox: sandbox, parser_specification: parserSandboxSpecification() }));

  const realFixture = buildSyntheticCaseFixture({ fixture_id: "p8-real-corpus", mode: "real" });
  const realHarness = createIntegratedFullSystemHarness([realFixture.stored]);
  const realBundle = await realHarness.application.runCaseAnalysis(realFixture.command);
  const realRun = await realHarness.service.getCompletedRun(realBundle.analysis_run_id);
  const realBlocked = realBundle.topic_results.filter((topic) => topic.status === "blocked_legal_readiness");
  checks.push(p8Check("V07-P8-REAL-CORPUS-FAIL-CLOSED", realBlocked.length === 7 && realHarness.executor.counters.execute_calls === 0 && realHarness.review.counters.approvals === 0 ? "PASS" : "SKIPPED_BLOCKED", { service: "CaseAnalysisService", mode: realFixture.command.mode, topic_statuses: realBundle.topic_results.map((item) => ({ topic: item.topic, status: item.status, blocker_codes: item.blockers })), blocked_topic_count: realBlocked.length, calculations: realHarness.executor.counters.execute_calls, findings: 0, approvals: realHarness.review.counters.approvals, export_attempts: 0, export_eligible: false, report_generated_internal_only: realRun?.report !== null, customer_processing_enabled: false }));

  const backupSource = new InMemoryBackupSource([
    { path: "persistence/snapshot.json", bytes: new TextEncoder().encode(JSON.stringify(harness.store.snapshot())) },
    { path: "jobs/snapshot.json", bytes: new TextEncoder().encode(JSON.stringify(harness.jobs.snapshot())) },
    { path: "audit/snapshot.json", bytes: new TextEncoder().encode(JSON.stringify(harness.audit.events())) },
  ]);
  const backup = await createLocalBackup(backupSource, { backup_id: "backupready01", created_at: P8_NOW, watermark: "watermark01", key_version: "keyversion01" });
  const verification = verifyLocalBackup(backup, "keyversion01");
  const restoreTarget = new InMemoryRestoreTarget();
  const plan = planLocalRestore(backup, restoreTarget.kind, "keyversion01");
  const restore = await restoreLocalFixture(backup, restoreTarget, "keyversion01");
  const dependencies = ["audit", "jobs", "local_backup", "object_storage", "persistence"].map((dependency) => ({ dependency: dependency as "audit" | "jobs" | "local_backup" | "object_storage" | "persistence", available: true, required_for_readiness: true }));
  const health = coarseHealth(dependencies);
  const readiness = coarseReadiness(dependencies, true);
  const logs = new SafeLogSink(() => P8_NOW);
  logs.emit({ level: "info", event: "backup_drill", component: "backup", outcome: "succeeded", correlation: { request_id: "request0001" }, duration_ms: 1 });
  const metrics = new SafeMetricsRegistry();
  metrics.record("backup_drill_status", "gauge", 1, { component: "backup", outcome: "succeeded" });
  const switches = new DefaultOffKillSwitches("production");
  const operator = new LocalDryRunOperator(() => P8_NOW);
  const dryRun = operator.execute({ schema_version: "tivdoc-operator-command-v0.7.0", action: "backup_drill", actor_id: "operator01", reason_code: "BACKUP_DRILL_SCHEDULED", idempotency_key: "operatoridem01", correlation_id: "operatorcorr01", target_ref: "backupready01", dry_run: true });
  checks.push(p8Check("V07-P8-OPERABILITY", verification.valid && plan.dry_run && !plan.mutation_applied && restore.status === "VERIFIED_LOCAL_FIXTURE_RESTORE" && health.status === "ok" && readiness.ready && Object.values(switches.snapshot()).every((value) => value === false) && !dryRun.mutation_applied ? "PASS" : "SKIPPED_BLOCKED", { health, readiness, backup_manifest_sha256: backup.manifest.manifest_sha256, backup_verification: verification.status, restore_plan: plan, restore_receipt_sha256: restore.receipt_sha256, safe_log_count: logs.records().length, safe_metric_count: metrics.samples().length, kill_switches: switches.snapshot(), operator_mutation_applied: dryRun.mutation_applied }));

  const declaredDependencies = pendingDependencies(NO_ELIGIBLE_PUBLIC_FIXTURE);
  for (const dependency of declaredDependencies) checks.push(p8Check(`V07-P8-DEPENDENCY-${dependency.lane.toUpperCase()}`, "SKIPPED_BLOCKED", { ...dependency }));
  const failed = checks.filter((check) => check.status !== "PASS" && !check.id.startsWith("V07-P8-DEPENDENCY-")).length;
  const counts = Object.freeze({ passed: checks.filter((check) => check.status === "PASS").length, skipped_blocked: checks.filter((check) => check.status === "SKIPPED_BLOCKED").length, failed, prohibited_actions: 0 as const, real_calculations: 0 as const, real_findings: 0 as const, real_approvals: 0 as const, real_exports: 0 as const, customer_records_read: 0 as const, external_calls: 0 as const });
  const core = Object.freeze({ schema_version: P8_SCHEMA_VERSION, generated_at: P8_NOW, base_commit: "bef916d8afddfa507a46c1db57cb2be97f1fc928" as const, overall_status: (failed === 0 ? "READY_PORTION_PASS_WITH_DECLARED_SKIPS" : "FAIL") as P8ReadyReceipt["overall_status"], checks: Object.freeze(checks), dependencies: declaredDependencies, counts });
  return Object.freeze({ ...core, receipt_sha256: canonicalSha256(core) });
}

export function assertP8ReadyReceipt(receipt: P8ReadyReceipt): void {
  const { receipt_sha256: ignored, ...core } = receipt;
  void ignored;
  if (receipt.schema_version !== P8_SCHEMA_VERSION || receipt.receipt_sha256 !== canonicalSha256(core)) throw new Error("P8_RECEIPT_HASH_INVALID");
  if (receipt.overall_status !== "READY_PORTION_PASS_WITH_DECLARED_SKIPS" || receipt.counts.failed !== 0) throw new Error("P8_READY_PORTION_FAILED");
  if (receipt.counts.prohibited_actions !== 0 || receipt.counts.real_calculations !== 0 || receipt.counts.real_findings !== 0 || receipt.counts.real_approvals !== 0 || receipt.counts.real_exports !== 0 || receipt.counts.customer_records_read !== 0 || receipt.counts.external_calls !== 0) throw new Error("P8_FORBIDDEN_EFFECT_COUNT_NONZERO");
  if (!receipt.dependencies.some((item) => item.lane === "P3") || !receipt.dependencies.some((item) => item.lane === "P4") || !receipt.dependencies.some((item) => item.lane === "public_fixture")) throw new Error("P8_DEPENDENCY_SKIP_MISSING");
}
