import { describe, expect, it } from "vitest";
import { PortalError } from "./contracts";
import { CustomerPortalService } from "./service";
import { SyntheticPortalRepository } from "./synthetic-repository";
import { createHarness, seedEvidenceAndReport, syntheticActor, syntheticCase } from "./test-fixtures";

function expectNotFound(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({ code: "PORTAL_NOT_FOUND" }));
}

describe("CustomerPortalService owner projection", () => {
  it("returns only an owner-scoped, coarse projection and hides internal blocker codes", () => {
    const { service, ownerA } = createHarness();
    const projection = service.getCaseProjection(ownerA, "synthetic-case-a");
    expect(projection.case_id).toBe("synthetic-case-a");
    expect(projection.blocker_codes).toEqual(["human_review_required"]);
    expect(projection.status).toBe("blocked");
    expect(projection.status_timeline.map((event) => event.status)).toEqual(["awaiting_documents", "under_review"]);
    expect(JSON.stringify(projection)).not.toContain("synthetic-owner-a");
    expect(JSON.stringify(projection)).not.toContain("synthetic-tenant-a");
  });

  it("does not claim a report is available without an entitled released artifact", () => {
    const { clock } = createHarness();
    const repository = new SyntheticPortalRepository(clock, "test");
    repository.seedCase(syntheticCase("a", { lifecycle_state: "report_ready", blocker_codes: [] }));
    const service = new CustomerPortalService(repository, { isEnabled: () => true }, () => clock.now());
    expect(service.getCaseProjection(syntheticActor("a"), "synthetic-case-a").status).toBe("under_review");
    seedEvidenceAndReport(repository, { edition: "full_reviewed_report" });
    expect(service.getCaseProjection(syntheticActor("a"), "synthetic-case-a").status).toBe("report_available");
  });

  it("uses one non-disclosing failure for cross-owner, unassigned, wrong tenant, and disabled access", () => {
    const { service, ownerA, ownerB } = createHarness();
    expectNotFound(() => service.getCaseProjection(ownerA, "synthetic-case-b"));
    expectNotFound(() => service.getCaseProjection(ownerB, "synthetic-case-a"));
    expectNotFound(() => service.getCaseProjection({ ...ownerA, assigned_case_ids: [] }, "synthetic-case-a"));
    expectNotFound(() => service.getCaseProjection({ ...ownerA, tenant_id: "synthetic-tenant-b" }, "synthetic-case-a"));
    expectNotFound(() => createHarness(false).service.getCaseProjection(ownerA, "synthetic-case-a"));
  });

  it("rejects the synthetic repository in production mode", () => {
    expect(() => new SyntheticPortalRepository({ now: () => "2030-01-01T00:00:00.000Z" }, "production"))
      .toThrowError(expect.objectContaining({ code: "TEST_ADAPTER_FORBIDDEN_IN_PRODUCTION" }));
  });
});

describe("deterministic clarification workflow", () => {
  it("versions exact missing, conflicted, legal-requirement, and human-operation questions", () => {
    const { service, operator } = createHarness();
    const facts = [
      { fact_path: "documents.period" as const, status: "missing" as const, fact_ids: [], state_sha256: "a".repeat(64) },
      { fact_path: "work.regular_hours" as const, status: "conflicted" as const, fact_ids: ["synthetic-fact-b", "synthetic-fact-a"], state_sha256: "b".repeat(64) },
    ];
    const requirements = [{ requirement_id: "synthetic-requirement", requirement_version: "1", fact_path: "employment.start_date" as const, requirement_sha256: "c".repeat(64) }];
    const first = service.requestClarifications(operator, "synthetic-case-a", facts, requirements);
    const replay = service.requestClarifications(operator, "synthetic-case-a", facts, requirements);
    expect(first).toEqual(replay);
    expect(first).toHaveLength(3);
    expect(first.map((task) => task.question_version)).toEqual([1, 1, 1]);
    expect(first.find((task) => task.fact_path === "work.regular_hours")?.conflicting_fact_ids).toEqual(["synthetic-fact-a", "synthetic-fact-b"]);

    const revised = service.requestClarifications(operator, "synthetic-case-a", [{ ...facts[0], state_sha256: "d".repeat(64) }], []);
    expect(revised[0].question_version).toBe(2);
    expect(revised[0].task_id).not.toBe(first.find((task) => task.fact_path === "documents.period")?.task_id);
    const human = service.requestHumanClarification(operator, "synthetic-case-a", [{ ...facts[0], state_sha256: "e".repeat(64) }]);
    expect(human[0].origin).toBe("human_operations_request");
    expect(() => service.requestHumanClarification(syntheticActor("a"), "synthetic-case-a", facts)).toThrowError(PortalError);
  });

  it("records declared provenance, preserves conflicts, requires review, and invalidates a released report", () => {
    const { service, repository, ownerA, operator } = createHarness();
    seedEvidenceAndReport(repository);
    service.recordConsent(ownerA, {
      case_id: "synthetic-case-a", consent_version: "consent-1", terms_version: "terms-1", granted: true, idempotency_key: "consent-key-0001",
    });
    const [task] = service.requestClarifications(operator, "synthetic-case-a", [{
      fact_path: "work.regular_hours", status: "conflicted", fact_ids: ["synthetic-documented-fact"], state_sha256: "f".repeat(64),
    }], []);
    const answer = service.answerClarification(ownerA, {
      case_id: "synthetic-case-a",
      task_id: task.task_id,
      question_version: task.question_version,
      value: "synthetic-declared-value",
      explicit_confirmation: true,
      consent_version: "consent-1",
      terms_version: "terms-1",
      idempotency_key: "answer-key-00001",
    });
    expect(answer.candidate.provenance.source_type).toBe("declared");
    expect(answer.candidate.provenance.source_reference).toMatchObject({
      question_id: task.task_id, question_version: 1, consent_version: "consent-1", terms_version: "terms-1", explicit_confirmation: true,
    });
    expect(answer.candidate.conflicting_documented_fact_ids).toEqual(["synthetic-documented-fact"]);
    expect(answer.candidate.requires_human_review).toBe(true);
    expect(service.listReports(ownerA, "synthetic-case-a")).toEqual([]);
    expect(repository.reportsForCase("synthetic-case-a").at(-1)?.release_state).toBe("invalidated");
    expect(repository.declaredCandidates("synthetic-case-a")).toHaveLength(1);
  });

  it("requires current consent and makes answers idempotent", () => {
    const { service, ownerA, operator } = createHarness();
    const [task] = service.requestClarifications(operator, "synthetic-case-a", [{
      fact_path: "documents.period", status: "missing", fact_ids: [], state_sha256: "1".repeat(64),
    }], []);
    const input = {
      case_id: "synthetic-case-a", task_id: task.task_id, question_version: 1, value: "synthetic-period", explicit_confirmation: true as const,
      consent_version: "consent-1", terms_version: "terms-1", idempotency_key: "answer-key-00002",
    };
    expect(() => service.answerClarification(ownerA, input)).toThrowError(expect.objectContaining({ code: "CONSENT_VERSION_MISMATCH" }));
    service.recordConsent(ownerA, { case_id: "synthetic-case-a", consent_version: "consent-1", terms_version: "terms-1", granted: true, idempotency_key: "consent-key-0002" });
    expect(service.answerClarification(ownerA, input).idempotent_replay).toBe(false);
    expect(service.answerClarification(ownerA, input).idempotent_replay).toBe(true);
    expect(() => service.answerClarification(ownerA, { ...input, value: "changed" })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" }));
  });
});

describe("verified entitlement and exact artifact access", () => {
  it("shows a truthful blocked screening without a zero or no-entitlement claim", () => {
    const { service, repository, ownerA } = createHarness();
    seedEvidenceAndReport(repository, { blockerCodes: ["unmapped_internal_blocker"], coverageComplete: false });
    const [report] = service.listReports(ownerA, "synthetic-case-a");
    expect(report.scope_status).toBe("screening_with_blockers");
    expect(report.blocker_codes).toEqual(["human_review_required"]);
    expect(report.customer_message_he).toContain("אין לראות בו חישוב מלא");
    expect(report.customer_message_he).toContain("היעדר זכאות");
    expect(report.customer_message_he).not.toMatch(/\b0\b/);
  });

  it("denies pending, incomplete full, refunded, revoked, chargeback, and cross-owner artifacts", () => {
    for (const evidenceStatus of ["refunded", "revoked", "chargeback"] as const) {
      const { service, repository, ownerA } = createHarness();
      seedEvidenceAndReport(repository, { evidenceStatus });
      expect(service.listReports(ownerA, "synthetic-case-a")).toEqual([]);
    }
    const pending = createHarness();
    seedEvidenceAndReport(pending.repository, { releaseState: "pending_review" });
    expect(pending.service.listReports(pending.ownerA, "synthetic-case-a")).toEqual([]);
    const incomplete = createHarness();
    seedEvidenceAndReport(incomplete.repository, { edition: "full_reviewed_report", coverageComplete: false, blockerCodes: ["coverage_incomplete"] });
    expect(incomplete.service.listReports(incomplete.ownerA, "synthetic-case-a")).toEqual([]);
    expectNotFound(() => incomplete.service.createReportAccessGrant(incomplete.ownerA, "synthetic-case-a", "synthetic-report-full_reviewed_report"));
    expectNotFound(() => incomplete.service.listReports(incomplete.ownerB, "synthetic-case-a"));
  });

  it("grants only the exact released owner artifact for five minutes and rejects expiry or forgery", () => {
    const { service, repository, ownerA, ownerB, clock } = createHarness();
    const report = seedEvidenceAndReport(repository, { edition: "full_reviewed_report" });
    const grant = service.createReportAccessGrant(ownerA, "synthetic-case-a", report.report_id);
    expect(grant.expires_at).toBe("2030-01-01T00:05:00.000Z");
    const download = service.downloadReport(ownerA, grant);
    expect(download.artifact_sha256).toBe(report.artifact_sha256);
    expect(new TextDecoder().decode(download.bytes)).toContain("synthetic-pdf-artifact");
    expect(repository.auditHistory("synthetic-case-a").at(-1)?.action).toBe("report_access_granted");
    expectNotFound(() => service.downloadReport(ownerB, grant));
    expectNotFound(() => service.downloadReport(ownerA, { ...grant, object_version_id: "forged-object" }));
    clock.current = "2030-01-01T00:05:00.000Z";
    expectNotFound(() => service.downloadReport(ownerA, grant));
  });

  it("cannot derive entitlement from client amount or a product flag", () => {
    const { service, repository, ownerA } = createHarness();
    const report = seedEvidenceAndReport(repository, { evidenceStatus: "refunded" });
    const forged = { amount: "synthetic-amount", product_flag: true, report_id: report.report_id };
    expect(forged.product_flag).toBe(true);
    expect(service.listReports(ownerA, "synthetic-case-a")).toEqual([]);
    expectNotFound(() => service.createReportAccessGrant(ownerA, "synthetic-case-a", report.report_id));
  });
});

describe("invite, upload, consent, privacy, and safe audit contracts", () => {
  it("rejects invite replay, expiry, audience mismatch, token forgery, and enumeration identically", () => {
    const { repository, service, clock } = createHarness();
    const first = repository.createInvite({ invite_id: "synthetic-invite-1", case_id: "synthetic-case-a", owner_actor_id: "synthetic-owner-a", audience: "portal-v07", expires_at: "2030-01-01T00:10:00.000Z", synthetic_secret: "local-only-secret" });
    expectNotFound(() => service.acceptSyntheticInvite(first.token, "wrong-audience"));
    expectNotFound(() => service.acceptSyntheticInvite(`${first.token}-forged`, "portal-v07"));
    expectNotFound(() => service.acceptSyntheticInvite("unknown-token", "portal-v07"));
    expect(service.acceptSyntheticInvite(first.token, "portal-v07").case_id).toBe("synthetic-case-a");
    expectNotFound(() => service.acceptSyntheticInvite(first.token, "portal-v07"));
    const second = repository.createInvite({ invite_id: "synthetic-invite-2", case_id: "synthetic-case-a", owner_actor_id: "synthetic-owner-a", audience: "portal-v07", expires_at: "2030-01-01T00:11:00.000Z", synthetic_secret: "local-only-secret-2" });
    clock.current = "2030-01-01T00:11:00.000Z";
    expectNotFound(() => service.acceptSyntheticInvite(second.token, "portal-v07"));
  });

  it("versions and deduplicates consent and privacy requests while respecting legal hold", () => {
    const { service, ownerA } = createHarness();
    const consentInput = { case_id: "synthetic-case-a", consent_version: "consent-1", terms_version: "terms-1", granted: true, idempotency_key: "consent-key-0003" };
    expect(service.recordConsent(ownerA, consentInput).consent.revision).toBe(1);
    expect(service.recordConsent(ownerA, consentInput).idempotent_replay).toBe(true);
    expect(() => service.recordConsent(ownerA, { ...consentInput, granted: false })).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_COMMAND_MISMATCH" }));
    const privacy = { case_id: "synthetic-case-a", request_kind: "data_export" as const, idempotency_key: "privacy-key-0001" };
    expect(service.createPrivacyRequest(ownerA, privacy).request.revision).toBe(1);
    expect(service.createPrivacyRequest(ownerA, privacy).idempotent_replay).toBe(true);

    const clock = { now: () => "2030-01-01T00:00:00.000Z" };
    const repository = new SyntheticPortalRepository(clock, "test");
    repository.seedCase(syntheticCase("a", { retention: { retention_class: "legal_record", legal_hold: true, deletion_status: "not_requested" } }));
    const heldService = new CustomerPortalService(repository, { isEnabled: () => true }, clock.now);
    expect(heldService.createPrivacyRequest(syntheticActor("a"), { case_id: "synthetic-case-a", request_kind: "deletion", idempotency_key: "privacy-key-0002" }).request.status)
      .toBe("restricted_by_legal_hold");
  });

  it("reserves a local upload contract only for an owner document and records PII-free receipts", () => {
    const { service, repository, ownerA, ownerB } = createHarness();
    const result = service.reserveUpload(ownerA, {
      case_id: "synthetic-case-a",
      document_id: "synthetic-document-a",
      expected_sha256: "a".repeat(64),
      expected_length: 256,
      detected_mime: "application/pdf",
      expires_at: "2030-01-01T00:10:00.000Z",
      idempotency_key: "upload-key-00001",
    });
    expect(result.session.state).toBe("reserved");
    expect(service.reserveUpload(ownerA, {
      case_id: "synthetic-case-a", document_id: "synthetic-document-a", expected_sha256: "a".repeat(64), expected_length: 256,
      detected_mime: "application/pdf", expires_at: "2030-01-01T00:10:00.000Z", idempotency_key: "upload-key-00001",
    }).idempotent_replay).toBe(true);
    expectNotFound(() => service.reserveUpload(ownerB, {
      case_id: "synthetic-case-a", document_id: "synthetic-document-a", expected_sha256: "a".repeat(64), expected_length: 256,
      detected_mime: "application/pdf", expires_at: "2030-01-01T00:10:00.000Z", idempotency_key: "upload-key-00002",
    }));
    const serializedAudit = JSON.stringify(repository.auditHistory("synthetic-case-a"));
    expect(serializedAudit).not.toContain("application/pdf");
    expect(serializedAudit).not.toContain("synthetic-declared-value");
    expect(repository.auditHistory("synthetic-case-a").every((receipt) => /^[0-9a-f]{64}$/.test(receipt.receipt_sha256))).toBe(true);
  });
});
