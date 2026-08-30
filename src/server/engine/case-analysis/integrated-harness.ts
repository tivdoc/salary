import type {
  CaseReviewDecision,
  CaseReviewPort,
  LegalCatalogSelection,
  ReportBuilderPort,
  RuleSpecExecutionResult,
  RuleSpecExecutorPort,
} from "../../../engine/wave3/contracts.ts";
import type { ReportRegistrationPort, StoredCaseInputSnapshot } from "../../../engine/case-analysis/contracts.ts";
import {
  ContentAddressedIdPort,
  FixedClock,
  InMemoryStoredSnapshotPort,
  NodeCanonicalHashPort,
  SafeLogCollector,
} from "../../../engine/case-analysis/fixture-ports.ts";
import { CaseAnalysisService } from "../../../engine/case-analysis/service.ts";
import { CaseReviewError, InMemoryCaseReviewService, ManualExportEligibilityService } from "../../../engine/case-operations/review.ts";
import { InMemoryCaseOperationsService } from "../../../engine/case-operations/lifecycle.ts";
import { LegalOperationsCatalog } from "../../../engine/legal-operations/catalog.ts";
import { LegalOperationsRuleSpecExecutor } from "../legal-operations/rulespec-executor.ts";
import { InMemoryVerifiedPaymentEvidenceStore } from "../case-operations/verified-payment-evidence.ts";
import { DeterministicCaseReportBuilder, REPORT_TEMPLATE_VERSION } from "../../reports/deterministic-report-builder.ts";
import { CaseAnalysisApplication } from "./application.ts";
import { InMemoryCaseAnalysisRepository } from "./in-memory-repository.ts";

class IntegratedRuleSpecExecutor implements RuleSpecExecutorPort {
  readonly delegate = new LegalOperationsRuleSpecExecutor();
  readonly counters = { execute_calls: 0, external_calls: 0 };

  async execute(input: Readonly<{
    selection: LegalCatalogSelection;
    rule_input: Parameters<RuleSpecExecutorPort["execute"]>[0]["rule_input"];
    execution_id: string;
    calculated_at: string;
  }>): Promise<RuleSpecExecutionResult> {
    if (input.selection.mode !== "synthetic_test") throw new Error("INTEGRATED_REAL_RULE_EXECUTION_FORBIDDEN");
    this.delegate.registerFixtureSnapshot(input.selection.topic, input.rule_input);
    this.counters.execute_calls += 1;
    return this.delegate.execute(input);
  }
}

type RegisteredReport = Readonly<{
  case_id: string;
  report_sha256: string;
  analysis_result_sha256: string;
  eligible: boolean;
  task_id: string;
}>;

export class IntegratedCaseReviewAdapter implements ReportRegistrationPort, CaseReviewPort {
  readonly counters = { registrations: 0, decisions: 0, approvals: 0 };
  readonly service: InMemoryCaseReviewService;
  readonly #clock: FixedClock;
  readonly #latest = new Map<string, RegisteredReport>();

  constructor(input: Readonly<{ service: InMemoryCaseReviewService; clock: FixedClock }>) {
    this.service = input.service;
    this.#clock = input.clock;
  }

  registerReport(input: Readonly<{
    case_id: string;
    report_sha256: string;
    analysis_result_sha256: string;
    export_eligible_after_review: boolean;
  }>): void {
    const prior = this.#latest.get(input.case_id);
    if (prior && prior.report_sha256 !== input.report_sha256) {
      this.service.invalidateCase(input.case_id, this.#clock.now(), "report_revision_changed", input.report_sha256);
    }
    const task = this.service.createTask({
      case_id: input.case_id,
      task_kind: "report_approval",
      input_sha256: input.report_sha256,
      output_sha256: input.report_sha256,
    });
    this.#latest.set(input.case_id, {
      case_id: input.case_id,
      report_sha256: input.report_sha256,
      analysis_result_sha256: input.analysis_result_sha256,
      eligible: input.export_eligible_after_review,
      task_id: task.task_id,
    });
    this.counters.registrations += 1;
  }

  async decide(decision: CaseReviewDecision) {
    this.counters.decisions += 1;
    const registration = [...this.#latest.values()].find((entry) => entry.task_id === decision.task_id);
    if (!registration?.eligible || registration.report_sha256 !== decision.input_sha256
        || decision.input_sha256 !== decision.output_sha256) {
      throw new CaseReviewError("report_review_not_eligible");
    }
    const receipt = await this.service.decide(decision);
    if (decision.decision === "approved") this.counters.approvals += 1;
    return receipt;
  }

  async isReportExportEligible(caseId: string, reportSha256: string) {
    const registration = this.#latest.get(caseId);
    return registration?.eligible === true
      && registration.report_sha256 === reportSha256
      && await this.service.isReportExportEligible(caseId, reportSha256);
  }

  current(caseId: string) {
    return this.#latest.get(caseId) ?? null;
  }
}

/** The merged W1 + W2 + W3 application composition used by CLI/API/test adapters. */
export function createIntegratedFullSystemHarness(snapshots: readonly StoredCaseInputSnapshot[]) {
  const clock = new FixedClock("2040-01-01T00:00:00.000Z");
  const ids = new ContentAddressedIdPort();
  const hashes = new NodeCanonicalHashPort();
  const snapshotPort = new InMemoryStoredSnapshotPort();
  for (const snapshot of snapshots) snapshotPort.add(snapshot);
  const repository = new InMemoryCaseAnalysisRepository();
  const legalCatalog = new LegalOperationsCatalog();
  const executor = new IntegratedRuleSpecExecutor();
  const caseReviews = new InMemoryCaseReviewService({ clock, ids, hash: hashes });
  const review = new IntegratedCaseReviewAdapter({ service: caseReviews, clock });
  const reportBuilder: ReportBuilderPort = new DeterministicCaseReportBuilder(hashes, ids);
  const logs = new SafeLogCollector();
  const payments = new InMemoryVerifiedPaymentEvidenceStore();
  const caseOperations = new InMemoryCaseOperationsService({
    paymentEvidence: payments,
    clock,
    ids,
    hash: hashes,
    reviewInvalidator: caseReviews,
    reportApprovalVerifier: caseReviews,
  });
  const manualExport = new ManualExportEligibilityService(caseOperations, review);
  const service = new CaseAnalysisService({
    clock,
    ids,
    hashes,
    snapshots: snapshotPort,
    repository,
    legalCatalog,
    executor,
    reportBuilder,
    reportRegistration: review,
    logs,
    templateVersion: REPORT_TEMPLATE_VERSION,
  });
  const application = new CaseAnalysisApplication(service);
  return {
    application,
    service,
    repository,
    legalCatalog,
    executor,
    review,
    caseReviews,
    reportBuilder,
    logs,
    snapshots: snapshotPort,
    clock,
    ids,
    hashes,
    payments,
    caseOperations,
    manualExport,
  };
}
