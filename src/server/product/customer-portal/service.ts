import { createHash } from "node:crypto";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";
import type { VerifiedActor } from "../../../engine/wave4/contracts";
import {
  PORTAL_SCHEMA_VERSION,
  STATUS_LABELS_HE,
  PortalError,
  customerSafeStatus,
  type ClarificationFactState,
  type CustomerClarificationTask,
  type CustomerReportProjection,
  type LegalInputRequirement,
  type PortalCaseProjection,
  type PortalFlagsPort,
  type ReportAccessGrant,
  type ReportEdition,
  type StoredReportEdition,
} from "./contracts";
import type {
  CustomerPortalRepositoryPort,
  PortalAnswerInput,
  PortalConsentInput,
  PortalPrivacyInput,
  PortalUploadInput,
  ReportDownload,
} from "./repository.ts";

export type { ReportDownload } from "./repository.ts";

const PORTAL_FLAG = "TIVDOC_CUSTOMER_PORTAL_ENABLED" as const;
const SAFE_BLOCKERS = new Set([
  "additional_information_required",
  "document_review_required",
  "human_review_required",
  "coverage_incomplete",
  "release_hold",
]);
const HUMAN_CLARIFICATION_ROLES = new Set([
  "intake_operator",
  "extraction_reviewer",
  "fact_reviewer",
  "legal_reviewer",
]);

export class CustomerPortalService {
  private readonly repository: CustomerPortalRepositoryPort;
  private readonly flags: PortalFlagsPort;
  private readonly now: () => string;

  constructor(
    repository: CustomerPortalRepositoryPort,
    flags: PortalFlagsPort,
    now: () => string,
  ) {
    this.repository = repository;
    this.flags = flags;
    this.now = now;
  }

  getCaseProjection(actor: VerifiedActor, caseId: string): PortalCaseProjection {
    const caseRecord = this.ownerCase(actor, caseId);
    const tasks = this.repository.tasksForCase(caseId).filter((task) => task.status === "open");
    const reports = this.releasedReports(actor, caseId);
    const blockerCodes = safeBlockers(caseRecord.blocker_codes);
    const status = customerSafeStatus(caseRecord.lifecycle_state, tasks.length > 0, blockerCodes.length, reports.length > 0);
    const statusTimeline = caseRecord.lifecycle_history
      .slice()
      .sort((left, right) => left.revision - right.revision)
      .map((event) => {
        const eventStatus = customerSafeStatus(event.lifecycle_state, false, 0);
        return Object.freeze({
          revision: event.revision,
          status: eventStatus,
          status_label_he: STATUS_LABELS_HE[eventStatus],
          occurred_at: event.occurred_at,
        });
      });
    const safeDocuments = caseRecord.document_references.map((document) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(document.declared_type)) throw new PortalError("PORTAL_NOT_FOUND");
      return Object.freeze({ ...document });
    });
    const unsigned = {
      schema_version: PORTAL_SCHEMA_VERSION,
      case_id: caseRecord.case_id,
      revision: caseRecord.revision,
      status,
      status_label_he: STATUS_LABELS_HE[status],
      status_timeline: statusTimeline,
      blocker_codes: blockerCodes,
      document_references: safeDocuments,
      clarification_tasks: tasks,
      reports,
      retention: caseRecord.retention,
    };
    return Object.freeze({ ...unsigned, projection_sha256: canonicalSha256(unsigned) });
  }

  requestClarifications(
    actor: VerifiedActor,
    caseId: string,
    facts: readonly ClarificationFactState[],
    requirements: readonly LegalInputRequirement[],
  ): readonly CustomerClarificationTask[] {
    this.assertEnabled();
    const caseRecord = this.repository.case(caseId);
    if (
      !caseRecord ||
      actor.verified_server_side !== true ||
      !HUMAN_CLARIFICATION_ROLES.has(actor.role) ||
      actor.tenant_id !== caseRecord.tenant_id ||
      !actor.assigned_case_ids.includes(caseId)
    ) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    return this.repository.createClarifications(caseId, facts, requirements);
  }

  requestHumanClarification(
    actor: VerifiedActor,
    caseId: string,
    facts: readonly ClarificationFactState[],
  ): readonly CustomerClarificationTask[] {
    this.assertEnabled();
    const caseRecord = this.repository.case(caseId);
    if (
      !caseRecord ||
      actor.verified_server_side !== true ||
      !HUMAN_CLARIFICATION_ROLES.has(actor.role) ||
      actor.tenant_id !== caseRecord.tenant_id ||
      !actor.assigned_case_ids.includes(caseId)
    ) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    return this.repository.createClarifications(caseId, facts, [], "human_operations_request");
  }

  answerClarification(actor: VerifiedActor, input: PortalAnswerInput) {
    const caseRecord = this.ownerCase(actor, input.case_id);
    this.assertExpectedRevision(caseRecord.revision, input.expected_revision);
    return this.repository.recordAnswer({ actor_id: actor.actor_id, ...input });
  }

  recordConsent(actor: VerifiedActor, input: PortalConsentInput) {
    this.ownerCase(actor, input.case_id);
    return this.repository.recordConsent({ actor_id: actor.actor_id, ...input });
  }

  createPrivacyRequest(actor: VerifiedActor, input: PortalPrivacyInput) {
    const caseRecord = this.ownerCase(actor, input.case_id);
    this.assertExpectedRevision(caseRecord.revision, input.expected_revision);
    return this.repository.createPrivacyRequest({ actor_id: actor.actor_id, ...input });
  }

  reserveUpload(actor: VerifiedActor, input: PortalUploadInput) {
    const caseRecord = this.ownerCase(actor, input.case_id);
    if (!caseRecord.document_references.some((document) => document.document_id === input.document_id)) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    return this.repository.reserveUpload({ actor_id: actor.actor_id, ...input });
  }

  acceptSyntheticInvite(token: string, audience: string) {
    this.assertEnabled();
    return this.repository.acceptInvite({ token, audience });
  }

  listReports(actor: VerifiedActor, caseId: string): readonly CustomerReportProjection[] {
    this.ownerCase(actor, caseId);
    return this.releasedReports(actor, caseId);
  }

  createReportAccessGrant(actor: VerifiedActor, caseId: string, reportId: string, expectedRevision?: number): ReportAccessGrant {
    const caseRecord = this.ownerCase(actor, caseId);
    this.assertExpectedRevision(caseRecord.revision, expectedRevision);
    const report = this.exactReleasedReport(actor, caseId, reportId);
    const expiresAt = new Date(new Date(this.now()).getTime() + 5 * 60_000).toISOString();
    return this.repository.createReportGrant({ actor_id: actor.actor_id, case_id: caseId, report, expires_at: expiresAt });
  }

  downloadReport(actor: VerifiedActor, grant: ReportAccessGrant): ReportDownload {
    this.ownerCase(actor, grant.case_id);
    if (grant.expires_at <= this.now()) throw new PortalError("PORTAL_NOT_FOUND");
    const unsignedGrant = {
      case_id: grant.case_id,
      report_id: grant.report_id,
      artifact_sha256: grant.artifact_sha256,
      object_version_id: grant.object_version_id,
      expires_at: grant.expires_at,
    };
    const storedGrant = this.repository.reportGrant(grant.grant_id);
    if (
      !storedGrant ||
      canonicalSha256(storedGrant) !== canonicalSha256(grant) ||
      grant.grant_id !== `report-grant:${canonicalSha256(unsignedGrant)}` ||
      grant.grant_sha256 !== canonicalSha256(unsignedGrant)
    ) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    const report = this.exactReleasedReport(actor, grant.case_id, grant.report_id);
    if (
      report.artifact_sha256 !== grant.artifact_sha256 ||
      report.object_version_id !== grant.object_version_id
    ) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    const bytes = this.repository.readArtifact(report.object_version_id);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== report.artifact_sha256) throw new PortalError("PORTAL_NOT_FOUND");
    return Object.freeze({
      bytes,
      artifact_sha256: report.artifact_sha256,
      object_version_id: report.object_version_id,
      content_type: "application/pdf" as const,
      filename: `tivdoc-report-${safeOpaqueSuffix(report.report_id)}-r${report.report_revision}.pdf`,
    });
  }

  private releasedReports(actor: VerifiedActor, caseId: string): readonly CustomerReportProjection[] {
    const entitled = this.entitledEditions(actor, caseId);
    const latest = latestReports(this.repository.reportsForCase(caseId));
    const projections: CustomerReportProjection[] = [];
    for (const report of latest) {
      if (!entitled.has(report.edition) || !isReleased(report)) continue;
      if (report.edition === "full_reviewed_report" && (!report.coverage_complete || report.blocker_codes.length > 0)) continue;
      const blockerCodes = safeBlockers(report.blocker_codes);
      const screening = report.edition === "screening_summary" && (!report.coverage_complete || blockerCodes.length > 0);
      projections.push(Object.freeze({
        report_id: report.report_id,
        report_revision: report.report_revision,
        edition: report.edition,
        report_sha256: report.report_sha256,
        scope_status: screening ? "screening_with_blockers" : "complete_reviewed",
        blocker_codes: blockerCodes,
        customer_message_he: screening
          ? "זהו סיכום בדיקה בהיקף מוגבל. קיימים נושאים שעדיין ממתינים למידע או לביקורת, ולכן אין לראות בו חישוב מלא או מסקנה בדבר היעדר זכאות."
          : "זהו דוח שנבדק ושוחרר עבור התיק והמהדורה המצוינים.",
        released: true as const,
      }));
    }
    return projections.sort((left, right) => `${left.edition}:${left.report_id}`.localeCompare(`${right.edition}:${right.report_id}`));
  }

  private exactReleasedReport(actor: VerifiedActor, caseId: string, reportId: string): StoredReportEdition {
    const entitled = this.entitledEditions(actor, caseId);
    const report = latestReports(this.repository.reportsForCase(caseId)).find((candidate) => candidate.report_id === reportId);
    if (
      !report ||
      !entitled.has(report.edition) ||
      !isReleased(report) ||
      (report.edition === "full_reviewed_report" && (!report.coverage_complete || report.blocker_codes.length > 0))
    ) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    return report;
  }

  private entitledEditions(actor: VerifiedActor, caseId: string): ReadonlySet<ReportEdition> {
    const evidence = this.repository.evidenceForCase(caseId).filter((item) => item.owner_actor_id === actor.actor_id);
    const result = new Set<ReportEdition>();
    for (const edition of ["screening_summary", "full_reviewed_report"] as const) {
      const relevant = evidence.filter((item) => item.edition === edition);
      if (relevant.length > 0 && relevant.every((item) => item.source === "verified_server_evidence" && item.status === "verified")) {
        result.add(edition);
      }
    }
    return result;
  }

  private ownerCase(actor: VerifiedActor, caseId: string) {
    this.assertEnabled();
    const caseRecord = this.repository.case(caseId);
    if (
      !caseRecord ||
      actor.verified_server_side !== true ||
      actor.role !== "customer_owner" ||
      actor.actor_id !== caseRecord.owner_actor_id ||
      actor.tenant_id !== caseRecord.tenant_id ||
      !actor.assigned_case_ids.includes(caseId)
    ) {
      throw new PortalError("PORTAL_NOT_FOUND");
    }
    return caseRecord;
  }

  private assertEnabled(): void {
    if (!this.flags.isEnabled(PORTAL_FLAG)) throw new PortalError("PORTAL_NOT_FOUND");
  }

  private assertExpectedRevision(actual: number, expected: number | undefined): void {
    if (expected !== undefined && actual !== expected) throw new PortalError("PORTAL_REVISION_CONFLICT");
  }
}

function latestReports(history: readonly StoredReportEdition[]): readonly StoredReportEdition[] {
  const latest = new Map<string, StoredReportEdition>();
  for (const report of history) {
    const current = latest.get(report.report_id);
    if (!current || report.report_revision > current.report_revision) latest.set(report.report_id, report);
  }
  return [...latest.values()];
}

function isReleased(report: StoredReportEdition): boolean {
  return report.release_state === "released" &&
    report.release_receipt_sha256 !== null &&
    /^[0-9a-f]{64}$/.test(report.release_receipt_sha256) &&
    /^[0-9a-f]{64}$/.test(report.artifact_sha256) &&
    /^[0-9a-f]{64}$/.test(report.report_sha256);
}

function safeBlockers(blockers: readonly string[]): readonly string[] {
  const normalized = blockers.map((blocker) => SAFE_BLOCKERS.has(blocker) ? blocker : "human_review_required");
  return [...new Set(normalized)].sort();
}

function safeOpaqueSuffix(value: string): string {
  return canonicalSha256({ report_id: value }).slice(0, 12);
}
