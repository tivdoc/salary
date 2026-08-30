import { describe, expect, it } from "vitest";
import type { CaseLifecycleState, DeterministicClockPort, PaymentEvidenceSnapshot } from "../wave3/contracts";
import { WAVE3_TOPICS } from "../wave3/contracts";
import { ContentAddressedIdPort, Sha256CanonicalHashPort } from "./canonical";
import {
  allowedLifecycleTransitions,
  InMemoryCaseOperationsService,
  isLifecycleTransitionAllowed,
  reconcilePaymentEvidence,
} from "./lifecycle";
import { InMemoryCaseReviewService, ManualExportEligibilityService } from "./review";
import { InMemoryVerifiedPaymentEvidenceStore } from "../../server/engine/case-operations/verified-payment-evidence";

const hash = new Sha256CanonicalHashPort();
const ids = new ContentAddressedIdPort();
const clock: DeterministicClockPort = { now: () => "2026-08-30T12:00:00.000Z" };
const expectedAmount = { currency: "XTS", minor_units: 50_000 } as const;
const baseEvidence: PaymentEvidenceSnapshot = {
  evidence_id: "payment:evidence:001",
  evidence_revision: "1",
  evidence_sha256: "a".repeat(64),
  case_reference: "case:synthetic:001",
  customer_reference: "customer:opaque:001",
  amount: expectedAmount,
  status: "settled",
  duplicate_of_evidence_id: null,
};

function setup(evidence = baseEvidence) {
  const payments = new InMemoryVerifiedPaymentEvidenceStore();
  payments.appendVerifiedEvidence(evidence);
  const reviews = new InMemoryCaseReviewService({ clock, ids, hash });
  const cases = new InMemoryCaseOperationsService({ paymentEvidence: payments, clock, ids, hash, reviewInvalidator: reviews, reportApprovalVerifier: reviews });
  cases.createCase("case:synthetic:001");
  return { payments, reviews, cases };
}

async function reachReportApproval(cases: InMemoryCaseOperationsService) {
  let current = await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
  const targets: CaseLifecycleState[] = [
    "awaiting_extraction_review",
    "awaiting_fact_resolution",
    "ready_for_legal_evaluation",
    "awaiting_legal_review",
    "awaiting_report_approval",
  ];
  for (const [index, target] of targets.entries()) {
    current = await cases.transition({
      case_id: current.case_id,
      expected_revision: current.revision,
      target_state: target,
      actor_id: "actor:synthetic:reviewer",
      actor_role: "synthetic_reviewer",
      reason: `synthetic_step_${index}`,
      idempotency_key: `transition:synthetic:${index}`,
    });
  }
  return current;
}

describe("case lifecycle and payment reconciliation", () => {
  it("freezes every allowed and denied graph transition", () => {
    const states: CaseLifecycleState[] = [
      "awaiting_payment", "awaiting_documents", "awaiting_extraction_review", "awaiting_fact_resolution",
      "ready_for_legal_evaluation", "awaiting_legal_review", "awaiting_report_approval", "report_ready",
      "release_hold", "delivered", "cancelled",
    ];
    const allowed = new Set(allowedLifecycleTransitions().map((item) => `${item.from}->${item.to}`));
    for (const from of states) {
      for (const to of states) expect(isLifecycleTransitionAllowed(from, to)).toBe(allowed.has(`${from}->${to}`));
    }
    expect(allowed).toEqual(new Set([
      "awaiting_payment->awaiting_documents", "awaiting_payment->cancelled",
      "awaiting_documents->awaiting_extraction_review", "awaiting_documents->cancelled",
      "awaiting_extraction_review->awaiting_fact_resolution", "awaiting_extraction_review->cancelled",
      "awaiting_fact_resolution->ready_for_legal_evaluation", "awaiting_fact_resolution->cancelled",
      "ready_for_legal_evaluation->awaiting_legal_review", "ready_for_legal_evaluation->cancelled",
      "awaiting_legal_review->awaiting_report_approval", "awaiting_legal_review->cancelled",
      "awaiting_report_approval->report_ready", "awaiting_report_approval->cancelled",
      "report_ready->release_hold", "report_ready->cancelled",
      "release_hold->delivered", "release_hold->cancelled",
    ]));
  });

  it.each([
    ["PAYMENT_UNMATCHED", [], "payment_unmatched"],
    ["PAYMENT_CASE_REF", [{ ...baseEvidence, case_reference: "case:other" }], "payment_case_reference_mismatch"],
    ["PAYMENT_CUSTOMER_REF", [{ ...baseEvidence, customer_reference: "customer:other" }], "payment_customer_reference_mismatch"],
    ["PAYMENT_CURRENCY", [{ ...baseEvidence, amount: { currency: "USD", minor_units: 50_000 } }], "payment_currency_mismatch"],
    ["PAYMENT_AMOUNT", [{ ...baseEvidence, amount: { currency: "XTS", minor_units: 49_999 } }], "payment_amount_mismatch"],
    ["PAYMENT_PENDING", [{ ...baseEvidence, status: "pending" as const }], "payment_pending"],
    ["PAYMENT_FAILED", [{ ...baseEvidence, status: "failed" as const }], "payment_failed"],
    ["PAYMENT_CANCELLED", [{ ...baseEvidence, status: "cancelled" as const }], "payment_cancelled"],
    ["PAYMENT_REFUND", [{ ...baseEvidence, status: "refunded" as const }], "payment_refunded"],
    ["PAYMENT_CHARGEBACK", [{ ...baseEvidence, status: "chargeback" as const }], "payment_chargeback"],
    ["PAYMENT_DUPLICATE", [{ ...baseEvidence, duplicate_of_evidence_id: "payment:evidence:000" }], "payment_duplicate_evidence"],
  ])("rejects %s without partial state", (_caseId, evidence, reason) => {
    expect(() => reconcilePaymentEvidence(evidence, baseEvidence.case_reference, expectedAmount, baseEvidence.customer_reference)).toThrowError(reason);
  });

  it("advances only exact settled server evidence and makes same-key/same-command a no-op", async () => {
    const { cases } = setup();
    const paid = await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
    expect(paid.state).toBe("awaiting_documents");
    const command = {
      case_id: paid.case_id,
      expected_revision: paid.revision,
      target_state: "awaiting_extraction_review" as const,
      actor_id: "actor:synthetic:001",
      actor_role: "synthetic_reviewer",
      reason: "synthetic_document_complete",
      idempotency_key: "transition:idem:001",
    };
    const first = await cases.transition(command);
    const replay = await cases.transition(command);
    expect(replay).toEqual({ ...first, idempotent_replay: true });
    expect(cases.history(first.case_id)).toHaveLength(3);
    await expect(cases.transition({ ...command, reason: "changed" })).rejects.toThrowError("idempotency_key_reused_with_different_command");
    expect(cases.history(first.case_id)).toHaveLength(3);
  });

  it("rejects a client-style paid flag at the strict server evidence boundary", () => {
    const payments = new InMemoryVerifiedPaymentEvidenceStore();
    expect(() => payments.appendVerifiedEvidence({ ...baseEvidence, paid: true } as never)).toThrowError("payment_evidence_unknown_or_missing_field");
    expect(payments.provider_call_count).toBe(0);
  });

  it("rejects non-opaque case identifiers before creating state or logs", () => {
    const payments = new InMemoryVerifiedPaymentEvidenceStore();
    const cases = new InMemoryCaseOperationsService({ paymentEvidence: payments, clock, ids, hash });
    expect(() => cases.createCase("person@example.com")).toThrowError("privacy_identifier_not_opaque");
    expect(cases.logs()).toEqual([]);
  });

  it.each([
    ["documents", "awaiting_documents"],
    ["extraction", "awaiting_extraction_review"],
    ["facts", "awaiting_fact_resolution"],
    ["catalog", "ready_for_legal_evaluation"],
    ["analysis", "awaiting_legal_review"],
    ["report", "awaiting_report_approval"],
  ] as const)("binds exact approval then invalidates it on %s mutation", async (mutationKind, expectedState) => {
    const { cases, reviews } = setup();
    const current = await reachReportApproval(cases);
    const reportSha = "b".repeat(64);
    const task = reviews.createTask({ case_id: current.case_id, task_kind: "report_approval", input_sha256: "c".repeat(64), output_sha256: reportSha });
    const receipt = await reviews.decide({
      task_id: task.task_id,
      task_kind: task.task_kind,
      reviewer_id: "reviewer:human:001",
      reviewer_role: "case_report_reviewer",
      decision: "approved",
      input_sha256: task.input_sha256,
      output_sha256: task.output_sha256,
      decided_at: clock.now(),
      reason: "synthetic_fixture_review_only",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
    });
    expect(() => cases.bindReportApproval(current.case_id, reportSha, "f".repeat(64))).toThrowError("report_approval_receipt_unverified");
    const bound = cases.bindReportApproval(current.case_id, reportSha, receipt.receipt_sha256);
    const boundReplay = cases.bindReportApproval(current.case_id, reportSha, receipt.receipt_sha256);
    expect(boundReplay).toEqual({ ...bound, idempotent_replay: true });
    const afterBinding = await cases.get(current.case_id);
    const ready = await cases.transition({
      case_id: current.case_id,
      expected_revision: afterBinding!.revision,
      target_state: "report_ready",
      actor_id: "actor:synthetic:reviewer",
      actor_role: "case_report_reviewer",
      reason: "exact_hash_approved",
      idempotency_key: "transition:report-ready:001",
    });
    const exportGate = new ManualExportEligibilityService(cases, reviews);
    expect(await exportGate.isEligible(current.case_id, reportSha)).toBe(true);
    const mutated = cases.mutateUpstream({
      case_id: current.case_id,
      expected_revision: ready.revision,
      mutation_kind: mutationKind,
      input_sha256: "d".repeat(64),
      actor_id: "actor:synthetic:reviewer",
      actor_role: "fact_reviewer",
      reason: `synthetic_${mutationKind}_revision`,
      idempotency_key: `mutation:${mutationKind}:001`,
    });
    expect(mutated.state).toBe(expectedState);
    expect(await exportGate.isEligible(current.case_id, reportSha)).toBe(false);
    expect(reviews.tasksForCase(current.case_id)).toHaveLength(1);
    expect(reviews.decisionsForCase(current.case_id)).toHaveLength(1);
    expect(reviews.invalidationsForCase(current.case_id)).toHaveLength(1);
  });

  it.each(["refunded", "chargeback"] as const)("moves a previously paid case to release hold on %s", async (status) => {
    const { cases, payments } = setup();
    await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
    payments.appendVerifiedEvidence({
      ...baseEvidence,
      evidence_id: `payment:evidence:${status}`,
      evidence_sha256: status === "refunded" ? "e".repeat(64) : "f".repeat(64),
      status,
    });
    const held = await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
    expect(held.state).toBe("release_hold");
    expect(cases.history(held.case_id).at(-1)?.reason).toBe(`payment_${status}`);
  });

  it("moves a previously paid case to release hold on evidence hash/revision mutation", async () => {
    const { cases, payments } = setup();
    await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
    payments.appendVerifiedEvidence({ ...baseEvidence, evidence_revision: "2", evidence_sha256: "e".repeat(64) });
    const held = await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
    expect(held.state).toBe("release_hold");
    expect(cases.history(held.case_id).at(-1)?.reason).toBe("payment_evidence_hash_or_revision_changed");
  });

  it("emits privacy-safe logs with no reason, amount, customer reference, or document bytes", async () => {
    const { cases } = setup();
    await cases.reconcilePayment("case:synthetic:001", expectedAmount, "customer:opaque:001");
    const serialized = JSON.stringify(cases.logs());
    expect(serialized).not.toMatch(/customer_reference|minor_units|reason|document_bytes|raw_document|50000/i);
    expect(cases.logs()).toHaveLength(2);
    expect(WAVE3_TOPICS).toHaveLength(7);
  });
});
