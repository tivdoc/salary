import { createHash } from "node:crypto";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";
import type { VerifiedActor } from "../../../engine/wave4/contracts";
import type { PortalCaseRecord, StoredReportEdition } from "./contracts";
import { CustomerPortalService } from "./service";
import { SyntheticPortalRepository } from "./synthetic-repository";

export class MutablePortalClock {
  current: string;
  constructor(current = "2030-01-01T00:00:00.000Z") { this.current = current; }
  now(): string { return this.current; }
}

export function syntheticActor(owner: "a" | "b"): VerifiedActor {
  return Object.freeze({
    actor_id: `synthetic-owner-${owner}`,
    role: "customer_owner",
    tenant_id: `synthetic-tenant-${owner}`,
    assigned_case_ids: [`synthetic-case-${owner}`],
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
}

export function syntheticOperator(caseIds: readonly string[] = ["synthetic-case-a"]): VerifiedActor {
  return Object.freeze({
    actor_id: "synthetic-operator",
    role: "fact_reviewer",
    tenant_id: "synthetic-tenant-a",
    assigned_case_ids: caseIds,
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
}

export function syntheticCase(owner: "a" | "b", overrides: Partial<PortalCaseRecord> = {}): PortalCaseRecord {
  const base: PortalCaseRecord = {
    case_id: `synthetic-case-${owner}`,
    tenant_id: `synthetic-tenant-${owner}`,
    owner_actor_id: `synthetic-owner-${owner}`,
    revision: 2,
    lifecycle_state: "awaiting_fact_resolution",
    lifecycle_history: [
      { revision: 1, lifecycle_state: "awaiting_documents", occurred_at: "2029-12-01T00:00:00.000Z" },
      { revision: 2, lifecycle_state: "awaiting_fact_resolution", occurred_at: "2030-01-01T00:00:00.000Z" },
    ],
    blocker_codes: ["internal_missing_input_code"],
    document_references: [{ document_id: `synthetic-document-${owner}`, declared_type: "payslip", status: "accepted", revision: 1 }],
    retention: { retention_class: "case_record", legal_hold: false, deletion_status: "not_requested" },
  };
  return Object.freeze({ ...base, ...overrides });
}

export function createHarness(enabled = true) {
  const clock = new MutablePortalClock();
  const repository = new SyntheticPortalRepository(clock, "test");
  repository.seedCase(syntheticCase("a"));
  repository.seedCase(syntheticCase("b"));
  const flags = { isEnabled: (flag: string) => enabled && flag === "TIVDOC_CUSTOMER_PORTAL_ENABLED" };
  const service = new CustomerPortalService(repository, flags, () => clock.now());
  return { clock, repository, service, ownerA: syntheticActor("a"), ownerB: syntheticActor("b"), operator: syntheticOperator() };
}

export function seedEvidenceAndReport(
  repository: SyntheticPortalRepository,
  input: Readonly<{
    owner?: "a" | "b";
    reportId?: string;
    edition?: "screening_summary" | "full_reviewed_report";
    releaseState?: StoredReportEdition["release_state"];
    coverageComplete?: boolean;
    blockerCodes?: readonly string[];
    evidenceStatus?: "verified" | "revoked" | "refunded" | "chargeback";
    reportRevision?: number;
  }> = {},
): StoredReportEdition {
  const owner = input.owner ?? "a";
  const edition = input.edition ?? "screening_summary";
  const reportId = input.reportId ?? `synthetic-report-${edition}`;
  const bytes = new TextEncoder().encode(`synthetic-pdf-artifact:${reportId}:${input.reportRevision ?? 1}`);
  const artifactSha = createHash("sha256").update(bytes).digest("hex");
  repository.seedProductEvidence(Object.freeze({
    evidence_id: `synthetic-evidence:${owner}:${edition}:${input.evidenceStatus ?? "verified"}`,
    evidence_sha256: canonicalSha256({ owner, edition, status: input.evidenceStatus ?? "verified" }),
    case_id: `synthetic-case-${owner}`,
    owner_actor_id: `synthetic-owner-${owner}`,
    edition,
    status: input.evidenceStatus ?? "verified",
    source: "verified_server_evidence",
  }));
  const releaseState = input.releaseState ?? "released";
  const report: StoredReportEdition = Object.freeze({
    report_id: reportId,
    report_revision: input.reportRevision ?? 1,
    case_id: `synthetic-case-${owner}`,
    edition,
    report_sha256: canonicalSha256({ reportId, edition, revision: input.reportRevision ?? 1 }),
    artifact_sha256: artifactSha,
    object_version_id: `synthetic-object:${canonicalSha256({ reportId, artifactSha })}`,
    release_receipt_sha256: releaseState === "released" ? canonicalSha256({ release: reportId }) : null,
    release_state: releaseState,
    coverage_complete: input.coverageComplete ?? edition === "full_reviewed_report",
    blocker_codes: [...(input.blockerCodes ?? (edition === "screening_summary" ? ["coverage_incomplete"] : []))],
    created_at: "2030-01-01T00:00:00.000Z",
  });
  repository.seedReport(report, bytes);
  return report;
}
