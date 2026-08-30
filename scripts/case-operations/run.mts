import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ContentAddressedIdPort, Sha256CanonicalHashPort, canonicalJson } from "../../src/engine/case-operations/canonical.ts";
import {
  allowedLifecycleTransitions,
  CaseOperationsError,
  InMemoryCaseOperationsService,
  reconcilePaymentEvidence,
} from "../../src/engine/case-operations/lifecycle.ts";
import { InMemoryCaseReviewService, ManualExportEligibilityService } from "../../src/engine/case-operations/review.ts";
import { InMemoryVerifiedPaymentEvidenceStore } from "../../src/server/engine/case-operations/verified-payment-evidence.ts";
import { DeterministicCaseReportBuilder, reopenReportPdf } from "../../src/server/reports/deterministic-report-builder.ts";
import { syntheticReportBundle } from "../../src/server/reports/synthetic-report-fixture.ts";
import type { CaseLifecycleState, PaymentEvidenceSnapshot } from "../../src/engine/wave3/contracts.ts";

const outputRoot = path.resolve("output", "parallel-wave-3", "workers", "w1-case-ops");
const hash = new Sha256CanonicalHashPort();
const ids = new ContentAddressedIdPort();
const clock = { now: () => "2026-08-30T12:00:00.000Z" };
const caseId = "case:synthetic:report:001";
const customerReference = "customer:opaque:synthetic:001";
const expectedAmount = { currency: "XTS", minor_units: 50_000 } as const;

function evidence(overrides: Partial<PaymentEvidenceSnapshot> = {}): PaymentEvidenceSnapshot {
  return {
    evidence_id: "payment:evidence:synthetic:001",
    evidence_revision: "1",
    evidence_sha256: "a".repeat(64),
    case_reference: caseId,
    customer_reference: customerReference,
    amount: expectedAmount,
    status: "settled",
    duplicate_of_evidence_id: null,
    ...overrides,
  };
}

async function buildDemo() {
  const payments = new InMemoryVerifiedPaymentEvidenceStore();
  payments.appendVerifiedEvidence(evidence());
  const reviews = new InMemoryCaseReviewService({ clock, ids, hash });
  const cases = new InMemoryCaseOperationsService({ paymentEvidence: payments, clock, ids, hash, reviewInvalidator: reviews, reportApprovalVerifier: reviews });
  cases.createCase(caseId);
  let current = await cases.reconcilePayment(caseId, expectedAmount, customerReference);
  const targets: CaseLifecycleState[] = [
    "awaiting_extraction_review",
    "awaiting_fact_resolution",
    "ready_for_legal_evaluation",
    "awaiting_legal_review",
    "awaiting_report_approval",
  ];
  let replayStable = false;
  let sameKeyDifferentRejected = false;
  for (const [index, target] of targets.entries()) {
    const command = {
      case_id: current.case_id,
      expected_revision: current.revision,
      target_state: target,
      actor_id: "actor:synthetic:reviewer",
      actor_role: "synthetic_reviewer",
      reason: `synthetic_transition_${index}`,
      idempotency_key: `synthetic:transition:${index}`,
    } as const;
    const first = await cases.transition(command);
    if (index === 0) {
      const replay = await cases.transition(command);
      replayStable = replay.idempotent_replay && replay.audit_event_sha256 === first.audit_event_sha256 && replay.revision === first.revision;
      try {
        await cases.transition({ ...command, reason: "different_command" });
      } catch (error) {
        sameKeyDifferentRejected = error instanceof CaseOperationsError && error.code === "idempotency_key_reused_with_different_command";
      }
    }
    current = first;
  }
  const bundle = syntheticReportBundle(hash);
  const builder = new DeterministicCaseReportBuilder(hash, ids);
  const report = await builder.build(bundle);
  const replay = await builder.build(bundle);
  const reportStable = ["json_sha256", "html_sha256", "pdf_sha256", "manifest_sha256", "report_sha256"]
    .every((key) => report[key as keyof typeof report] === replay[key as keyof typeof replay]);
  const task = reviews.createTask({ case_id: caseId, task_kind: "report_approval", input_sha256: bundle.result_sha256, output_sha256: report.report_sha256 });
  const reviewReceipt = await reviews.decide({
    task_id: task.task_id,
    task_kind: task.task_kind,
    reviewer_id: "reviewer:synthetic:human:001",
    reviewer_role: "case_report_reviewer",
    decision: "approved",
    input_sha256: task.input_sha256,
    output_sha256: task.output_sha256,
    decided_at: clock.now(),
    reason: "synthetic_fixture_exact_hash_review_only",
    schema_version: "tivdoc-case-review-decision-v0.6.0",
  });
  cases.bindReportApproval(caseId, report.report_sha256, reviewReceipt.receipt_sha256);
  const afterBinding = await cases.get(caseId);
  const ready = await cases.transition({
    case_id: caseId,
    expected_revision: afterBinding!.revision,
    target_state: "report_ready",
    actor_id: "actor:synthetic:reviewer",
    actor_role: "case_report_reviewer",
    reason: "synthetic_exact_hash_report_approved",
    idempotency_key: "synthetic:report-ready:001",
  });
  const exportGate = new ManualExportEligibilityService(cases, reviews);
  const exportEligible = await exportGate.isEligible(caseId, report.report_sha256);
  const reopened = await reopenReportPdf(report.pdf);
  return {
    payments,
    reviews,
    cases,
    ready,
    bundle,
    report,
    reviewReceipt,
    reportStable,
    replayStable,
    sameKeyDifferentRejected,
    exportEligible,
    reopened,
  };
}

function paymentMatrix() {
  const rows: Array<Readonly<{ case_id: string; candidate: readonly PaymentEvidenceSnapshot[]; expected: string }>> = [
    { case_id: "PAYMENT_001_MATCHED_SETTLED", candidate: [evidence()], expected: "accepted" },
    { case_id: "PAYMENT_002_UNMATCHED", candidate: [], expected: "payment_unmatched" },
    { case_id: "PAYMENT_003_CASE_REFERENCE", candidate: [evidence({ case_reference: "case:other" })], expected: "payment_case_reference_mismatch" },
    { case_id: "PAYMENT_004_CUSTOMER_REFERENCE", candidate: [evidence({ customer_reference: "customer:other" })], expected: "payment_customer_reference_mismatch" },
    { case_id: "PAYMENT_005_AMOUNT", candidate: [evidence({ amount: { currency: "XTS", minor_units: 1 } })], expected: "payment_amount_mismatch" },
    { case_id: "PAYMENT_006_CURRENCY", candidate: [evidence({ amount: { currency: "USD", minor_units: 50_000 } })], expected: "payment_currency_mismatch" },
    { case_id: "PAYMENT_007_PENDING", candidate: [evidence({ status: "pending" })], expected: "payment_pending" },
    { case_id: "PAYMENT_008_FAILED", candidate: [evidence({ status: "failed" })], expected: "payment_failed" },
    { case_id: "PAYMENT_009_CANCELLED", candidate: [evidence({ status: "cancelled" })], expected: "payment_cancelled" },
    { case_id: "PAYMENT_010_DUPLICATE", candidate: [evidence({ duplicate_of_evidence_id: "payment:evidence:other" })], expected: "payment_duplicate_evidence" },
    { case_id: "PAYMENT_011_REFUND", candidate: [evidence({ status: "refunded" })], expected: "payment_refunded" },
    { case_id: "PAYMENT_012_CHARGEBACK", candidate: [evidence({ status: "chargeback" })], expected: "payment_chargeback" },
  ];
  return rows.map((row) => {
    let actual = "accepted";
    try {
      reconcilePaymentEvidence(row.candidate, caseId, expectedAmount, customerReference);
    } catch (error) {
      actual = error instanceof CaseOperationsError ? error.code : "unexpected_error";
    }
    return { case_id: row.case_id, expected_result: row.expected, actual_result: actual, passed: actual === row.expected };
  });
}

async function writeArtifacts(demo: Awaited<ReturnType<typeof buildDemo>>) {
  const reportRoot = path.join(outputRoot, "synthetic-report");
  await mkdir(reportRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportRoot, "report.json"), demo.report.json),
    writeFile(path.join(reportRoot, "report.html"), demo.report.html),
    writeFile(path.join(reportRoot, "report.pdf"), demo.report.pdf),
    writeFile(path.join(reportRoot, "manifest.json"), demo.report.manifest),
  ]);
}

async function adverseHold(status: "refunded" | "chargeback" | "evidence_mutation") {
  const payments = new InMemoryVerifiedPaymentEvidenceStore();
  payments.appendVerifiedEvidence(evidence());
  const reviews = new InMemoryCaseReviewService({ clock, ids, hash });
  const cases = new InMemoryCaseOperationsService({ paymentEvidence: payments, clock, ids, hash, reviewInvalidator: reviews, reportApprovalVerifier: reviews });
  cases.createCase(caseId);
  await cases.reconcilePayment(caseId, expectedAmount, customerReference);
  if (status === "evidence_mutation") {
    payments.appendVerifiedEvidence(evidence({ evidence_revision: "2", evidence_sha256: "e".repeat(64) }));
  } else {
    payments.appendVerifiedEvidence(evidence({ evidence_id: `payment:evidence:${status}`, evidence_sha256: status === "refunded" ? "e".repeat(64) : "f".repeat(64), status }));
  }
  return cases.reconcilePayment(caseId, expectedAmount, customerReference);
}

async function resultFor(command: string) {
  const demo = await buildDemo();
  const payments = paymentMatrix();
  const refundHold = await adverseHold("refunded");
  const chargebackHold = await adverseHold("chargeback");
  const mutationHold = await adverseHold("evidence_mutation");
  const exportBeforeMutation = demo.exportEligible;
  demo.cases.mutateUpstream({
    case_id: caseId,
    expected_revision: demo.ready.revision,
    mutation_kind: "analysis",
    input_sha256: "d".repeat(64),
    actor_id: "actor:synthetic:reviewer",
    actor_role: "analysis_reviewer",
    reason: "synthetic_analysis_revision",
    idempotency_key: "synthetic:analysis-mutation:001",
  });
  const exportAfterMutation = await new ManualExportEligibilityService(demo.cases, demo.reviews).isEligible(caseId, demo.report.report_sha256);
  let manualOverrideRejected = false;
  const overrideTask = demo.reviews.createTask({ case_id: "case:synthetic:override", task_kind: "report_approval", input_sha256: "1".repeat(64), output_sha256: "2".repeat(64) });
  try {
    await demo.reviews.decide({
      task_id: overrideTask.task_id,
      task_kind: overrideTask.task_kind,
      reviewer_id: "reviewer:synthetic:001",
      reviewer_role: "case_report_reviewer",
      decision: "approved",
      input_sha256: overrideTask.input_sha256,
      output_sha256: overrideTask.output_sha256,
      decided_at: clock.now(),
      reason: "unsafe_manual_override_attempt",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
      replacement_monetary_total: { currency: "XTS", minor_units: 1 },
    } as never);
  } catch {
    manualOverrideRejected = true;
  }
  const logText = canonicalJson(demo.cases.logs());
  const privacyPassed = !/(customer_reference|minor_units|document_bytes|reason|@)/i.test(logText);
  const lifecycleAllowed = allowedLifecycleTransitions();
  const matrix = [
    { case_id: "CASE_LIFECYCLE_001", expected_result: "18_allowed_103_denied", actual_result: `${lifecycleAllowed.length}_allowed_${121 - lifecycleAllowed.length}_denied`, passed: lifecycleAllowed.length === 18 },
    { case_id: "CASE_IDEMPOTENCY_001", expected_result: true, actual_result: demo.replayStable, passed: demo.replayStable },
    { case_id: "CASE_IDEMPOTENCY_002", expected_result: true, actual_result: demo.sameKeyDifferentRejected, passed: demo.sameKeyDifferentRejected },
    { case_id: "CASE_REVIEW_001", expected_result: true, actual_result: exportBeforeMutation, passed: exportBeforeMutation },
    { case_id: "CASE_REVIEW_002_MUTATION_INVALIDATES", expected_result: false, actual_result: exportAfterMutation, passed: !exportAfterMutation },
    { case_id: "CASE_REVIEW_003_NO_MONETARY_OVERRIDE", expected_result: true, actual_result: manualOverrideRejected, passed: manualOverrideRejected },
    { case_id: "CASE_REPORT_001", expected_result: true, actual_result: demo.reportStable, passed: demo.reportStable },
    { case_id: "CASE_REPORT_002", expected_result: 7, actual_result: demo.bundle.topic_results.length, passed: demo.bundle.topic_results.length === 7 },
    { case_id: "CASE_PDF_001", expected_result: 1, actual_result: demo.reopened.page_count, passed: demo.reopened.page_count === 1 && demo.reopened.subject.includes(demo.report.report_id) },
    { case_id: "CASE_PRIVACY_001", expected_result: true, actual_result: privacyPassed, passed: privacyPassed },
    { case_id: "CASE_PAYMENT_HOLD_001_REFUND", expected_result: "release_hold", actual_result: refundHold.state, passed: refundHold.state === "release_hold" },
    { case_id: "CASE_PAYMENT_HOLD_002_CHARGEBACK", expected_result: "release_hold", actual_result: chargebackHold.state, passed: chargebackHold.state === "release_hold" },
    { case_id: "CASE_PAYMENT_HOLD_003_EVIDENCE_MUTATION", expected_result: "release_hold", actual_result: mutationHold.state, passed: mutationHold.state === "release_hold" },
    ...payments,
  ];
  const zeros = {
    customer_files_read: 0,
    payment_provider_calls: demo.payments.provider_call_count,
    delivery_attempts: 0,
    external_writes: 0,
    openai_calls: 0,
    external_supabase_connections: 0,
    migrations: 0,
    deploy_actions: 0,
  };
  const result = {
    schema_version: "tivdoc-wave3-w1-case-operations-result-v0.6.0",
    command,
    cases: matrix,
    case_count: matrix.length,
    passed_count: matrix.filter((item) => item.passed).length,
    passed: matrix.every((item) => item.passed) && Object.values(zeros).every((value) => value === 0),
    artifact_hashes: {
      synthetic_input_sha256: hash.hashCanonical({ evidence: evidence(), bundle: demo.bundle }),
      analysis_result_sha256: demo.bundle.result_sha256,
      json_sha256: demo.report.json_sha256,
      html_sha256: demo.report.html_sha256,
      pdf_sha256: demo.report.pdf_sha256,
      manifest_sha256: demo.report.manifest_sha256,
      report_sha256: demo.report.report_sha256,
      review_receipt_sha256: demo.reviewReceipt.receipt_sha256,
      audit_tail_sha256: demo.ready.audit_event_sha256,
    },
    manual_export_eligible_before_mutation: exportBeforeMutation,
    manual_export_eligible_after_mutation: exportAfterMutation,
    final_case_state: demo.ready.state,
    logs: demo.cases.logs(),
    zero_prohibited_operations: zeros,
  };
  await mkdir(outputRoot, { recursive: true });
  await writeArtifacts(demo);
  await writeFile(path.join(outputRoot, `${command}.json`), canonicalJson(result), "utf8");
  return result;
}

const aliases: Readonly<Record<string, string>> = {
  "case:ops:verify": "verify",
  "case:ops:synthetic-demo": "synthetic-demo",
  "case:report:verify": "report-verify",
  "case:privacy:verify": "privacy-verify",
};
const requested = process.argv[2] ?? "verify";
const command = aliases[requested] ?? requested;
if (!["verify", "synthetic-demo", "report-verify", "privacy-verify", "all"].includes(command)) {
  throw new TypeError(`case_operations_command_unknown:${requested}`);
}
const result = await resultFor(command);
process.stdout.write(canonicalJson(result));
if (!result.passed) process.exitCode = 2;
