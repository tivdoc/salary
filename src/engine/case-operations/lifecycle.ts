import type { Money } from "../domain/primitives";
import type {
  CanonicalHashPort,
  CaseLifecycleState,
  CaseOperationsPort,
  CaseOperationsResult,
  CaseTransitionCommand,
  DeterministicClockPort,
  DeterministicIdPort,
  PaymentEvidencePort,
  PaymentEvidenceSnapshot,
} from "../wave3/contracts";
import { immutable } from "./canonical.ts";
import { assertOpaqueIdentifier, PrivacySafeCaseLogger } from "./privacy.ts";

export const CASE_LIFECYCLE_SCHEMA = "tivdoc-case-lifecycle-v0.6.0" as const;

const NEXT_STATES: Readonly<Record<CaseLifecycleState, readonly CaseLifecycleState[]>> = Object.freeze({
  awaiting_payment: ["awaiting_documents", "cancelled"],
  awaiting_documents: ["awaiting_extraction_review", "cancelled"],
  awaiting_extraction_review: ["awaiting_fact_resolution", "cancelled"],
  awaiting_fact_resolution: ["ready_for_legal_evaluation", "cancelled"],
  ready_for_legal_evaluation: ["awaiting_legal_review", "cancelled"],
  awaiting_legal_review: ["awaiting_report_approval", "cancelled"],
  awaiting_report_approval: ["report_ready", "cancelled"],
  report_ready: ["release_hold", "cancelled"],
  release_hold: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
});

export type UpstreamMutationKind = "documents" | "extraction" | "facts" | "catalog" | "analysis" | "report";

export type CaseAuditEvent = Readonly<{
  schema_version: typeof CASE_LIFECYCLE_SCHEMA;
  event_id: string;
  event_kind: "case_created" | "state_transition" | "payment_reconciled" | "payment_hold" | "upstream_mutation" | "report_approval_bound";
  case_id: string;
  revision: number;
  state_before: CaseLifecycleState | null;
  state_after: CaseLifecycleState;
  actor_id: string;
  actor_role: string;
  occurred_at: string;
  reason: string;
  command_sha256: string;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

type PaymentBinding = Readonly<{
  evidence_id: string;
  evidence_revision: string;
  evidence_sha256: string;
  amount: Money;
  customer_reference: string;
}>;

type StoredCase = {
  case_id: string;
  revision: number;
  state: CaseLifecycleState;
  events: CaseAuditEvent[];
  idempotency: Map<string, Readonly<{ command_sha256: string; result: CaseOperationsResult }>>;
  payment_binding: PaymentBinding | null;
  report_approval: Readonly<{ report_sha256: string; receipt_sha256: string }> | null;
};

export class CaseOperationsError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CaseOperationsError";
  }
}

export type ReviewInvalidator = Readonly<{
  invalidateCase(caseId: string, invalidatedAt: string, reasonCode: string, mutationSha256: string): void;
}>;

export type ReportApprovalVerifier = Readonly<{
  verifyReportApprovalReceipt(caseId: string, reportSha256: string, receiptSha256: string): boolean;
}>;

export class InMemoryCaseOperationsService implements CaseOperationsPort {
  readonly #cases = new Map<string, StoredCase>();
  readonly #paymentEvidence: PaymentEvidencePort;
  readonly #clock: DeterministicClockPort;
  readonly #ids: DeterministicIdPort;
  readonly #hash: CanonicalHashPort;
  readonly #logger: PrivacySafeCaseLogger;
  readonly #reviewInvalidator: ReviewInvalidator | null;
  readonly #reportApprovalVerifier: ReportApprovalVerifier | null;

  constructor(input: Readonly<{
    paymentEvidence: PaymentEvidencePort;
    clock: DeterministicClockPort;
    ids: DeterministicIdPort;
    hash: CanonicalHashPort;
    logger?: PrivacySafeCaseLogger;
    reviewInvalidator?: ReviewInvalidator;
    reportApprovalVerifier?: ReportApprovalVerifier;
  }>) {
    this.#paymentEvidence = input.paymentEvidence;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#hash = input.hash;
    this.#logger = input.logger ?? new PrivacySafeCaseLogger();
    this.#reviewInvalidator = input.reviewInvalidator ?? null;
    this.#reportApprovalVerifier = input.reportApprovalVerifier ?? null;
  }

  createCase(caseId: string, actorId = "system:case-intake"): CaseOperationsResult {
    assertOpaqueIdentifier(caseId);
    if (this.#cases.has(caseId)) throw new CaseOperationsError("case_already_exists");
    const stored: StoredCase = {
      case_id: caseId,
      revision: 0,
      state: "awaiting_payment",
      events: [],
      idempotency: new Map(),
      payment_binding: null,
      report_approval: null,
    };
    const commandSha = this.#hash.hashCanonical({ schema_version: CASE_LIFECYCLE_SCHEMA, action: "create", case_id: caseId });
    const event = this.#makeEvent(stored, {
      eventKind: "case_created",
      stateAfter: "awaiting_payment",
      actorId,
      actorRole: "system",
      reason: "case_created",
      commandSha,
    });
    stored.events.push(event);
    this.#cases.set(caseId, stored);
    const result = this.#result(stored, commandSha, event.event_sha256, false);
    this.#logger.write({
      event_code: "case_created",
      case_id: stored.case_id,
      revision: stored.revision,
      state: stored.state,
      command_sha256: commandSha,
      audit_event_sha256: event.event_sha256,
    });
    return result;
  }

  async transition(command: CaseTransitionCommand): Promise<CaseOperationsResult> {
    const stored = this.#required(command.case_id);
    const commandSha = this.#hash.hashCanonical({ schema_version: CASE_LIFECYCLE_SCHEMA, action: "transition", ...command });
    const replay = this.#replay(stored, command.idempotency_key, commandSha);
    if (replay) return replay;
    if (stored.revision !== command.expected_revision) throw new CaseOperationsError("case_revision_conflict");
    if (!NEXT_STATES[stored.state].includes(command.target_state)) throw new CaseOperationsError("case_transition_invalid");
    if (stored.state === "awaiting_payment" && command.target_state === "awaiting_documents") {
      throw new CaseOperationsError("payment_reconciliation_required");
    }
    if (command.target_state === "report_ready" && stored.report_approval === null) {
      throw new CaseOperationsError("exact_report_approval_required");
    }
    return this.#commit(stored, command.idempotency_key, commandSha, {
      eventKind: "state_transition",
      stateAfter: command.target_state,
      actorId: command.actor_id,
      actorRole: command.actor_role,
      reason: command.reason,
    });
  }

  async reconcilePayment(caseId: string, expectedAmount: Money, expectedCustomerReference: string): Promise<CaseOperationsResult> {
    const stored = this.#required(caseId);
    const evidence = await this.#paymentEvidence.loadVerifiedEvidence(caseId);
    const command = {
      schema_version: CASE_LIFECYCLE_SCHEMA,
      action: "reconcile_payment",
      case_id: caseId,
      expected_amount: expectedAmount,
      expected_customer_reference: expectedCustomerReference,
      evidence: evidence.map((item) => ({ evidence_id: item.evidence_id, evidence_revision: item.evidence_revision, evidence_sha256: item.evidence_sha256 })),
    };
    const commandSha = this.#hash.hashCanonical(command);
    const idempotencyKey = `payment:${commandSha}`;
    const replay = this.#replay(stored, idempotencyKey, commandSha);
    if (replay) return replay;
    const mutation = stored.payment_binding === null ? null : evidence.find((item) => item.evidence_id === stored.payment_binding!.evidence_id
      && (item.evidence_revision !== stored.payment_binding!.evidence_revision || item.evidence_sha256 !== stored.payment_binding!.evidence_sha256));
    const adverse = evidence.find((item) => item.status === "refunded" || item.status === "chargeback");
    if (mutation || adverse) {
      const reason = mutation ? "payment_evidence_hash_or_revision_changed" : `payment_${adverse!.status}`;
      stored.report_approval = null;
      this.#reviewInvalidator?.invalidateCase(caseId, this.#clock.now(), reason, commandSha);
      return this.#commit(stored, idempotencyKey, commandSha, {
        eventKind: "payment_hold",
        stateAfter: "release_hold",
        actorId: "system:payment-reconciliation",
        actorRole: "system",
        reason,
      });
    }
    if (stored.state !== "awaiting_payment") throw new CaseOperationsError("payment_already_reconciled");
    const match = reconcilePaymentEvidence(evidence, caseId, expectedAmount, expectedCustomerReference);
    stored.payment_binding = immutable({
      evidence_id: match.evidence_id,
      evidence_revision: match.evidence_revision,
      evidence_sha256: match.evidence_sha256,
      amount: match.amount,
      customer_reference: match.customer_reference,
    });
    return this.#commit(stored, idempotencyKey, commandSha, {
      eventKind: "payment_reconciled",
      stateAfter: "awaiting_documents",
      actorId: "system:payment-reconciliation",
      actorRole: "system",
      reason: "payment_exact_match_settled",
    });
  }

  async get(caseId: string): Promise<CaseOperationsResult | null> {
    const stored = this.#cases.get(caseId);
    if (!stored) return null;
    const event = stored.events.at(-1)!;
    return this.#result(stored, event.command_sha256, event.event_sha256, false);
  }

  history(caseId: string): readonly CaseAuditEvent[] {
    return immutable(this.#required(caseId).events.map((event) => ({ ...event })));
  }

  logs() {
    return this.#logger.entries();
  }

  bindReportApproval(caseId: string, reportSha256: string, receiptSha256: string): CaseOperationsResult {
    const stored = this.#required(caseId);
    if (!/^[a-f0-9]{64}$/.test(reportSha256) || !/^[a-f0-9]{64}$/.test(receiptSha256)) {
      throw new CaseOperationsError("report_approval_hash_invalid");
    }
    const commandSha = this.#hash.hashCanonical({ action: "bind_report_approval", case_id: caseId, report_sha256: reportSha256, receipt_sha256: receiptSha256 });
    const idempotencyKey = `report-approval:${receiptSha256}`;
    const replay = this.#replay(stored, idempotencyKey, commandSha);
    if (replay) return replay;
    if (stored.state !== "awaiting_report_approval") throw new CaseOperationsError("case_not_awaiting_report_approval");
    if (!this.#reportApprovalVerifier?.verifyReportApprovalReceipt(caseId, reportSha256, receiptSha256)) {
      throw new CaseOperationsError("report_approval_receipt_unverified");
    }
    stored.report_approval = immutable({ report_sha256: reportSha256, receipt_sha256: receiptSha256 });
    return this.#commit(stored, idempotencyKey, commandSha, {
      eventKind: "report_approval_bound",
      stateAfter: stored.state,
      actorId: "system:case-review",
      actorRole: "system",
      reason: "exact_report_approval_bound",
    });
  }

  mutateUpstream(input: Readonly<{
    case_id: string;
    expected_revision: number;
    mutation_kind: UpstreamMutationKind;
    input_sha256: string;
    actor_id: string;
    actor_role: string;
    reason: string;
    idempotency_key: string;
  }>): CaseOperationsResult {
    const stored = this.#required(input.case_id);
    const commandSha = this.#hash.hashCanonical({ schema_version: CASE_LIFECYCLE_SCHEMA, action: "upstream_mutation", ...input });
    const replay = this.#replay(stored, input.idempotency_key, commandSha);
    if (replay) return replay;
    if (stored.revision !== input.expected_revision) throw new CaseOperationsError("case_revision_conflict");
    if (stored.state === "release_hold" || stored.state === "delivered" || stored.state === "cancelled") {
      throw new CaseOperationsError("terminal_or_release_hold_mutation_forbidden");
    }
    const targetByKind: Readonly<Record<UpstreamMutationKind, CaseLifecycleState>> = {
      documents: "awaiting_documents",
      extraction: "awaiting_extraction_review",
      facts: "awaiting_fact_resolution",
      catalog: "ready_for_legal_evaluation",
      analysis: "awaiting_legal_review",
      report: "awaiting_report_approval",
    };
    stored.report_approval = null;
    this.#reviewInvalidator?.invalidateCase(input.case_id, this.#clock.now(), `upstream_${input.mutation_kind}_changed`, commandSha);
    return this.#commit(stored, input.idempotency_key, commandSha, {
      eventKind: "upstream_mutation",
      stateAfter: targetByKind[input.mutation_kind],
      actorId: input.actor_id,
      actorRole: input.actor_role,
      reason: input.reason,
    });
  }

  #required(caseId: string): StoredCase {
    const stored = this.#cases.get(caseId);
    if (!stored) throw new CaseOperationsError("case_not_found");
    return stored;
  }

  #replay(stored: StoredCase, key: string, commandSha: string): CaseOperationsResult | null {
    const prior = stored.idempotency.get(key);
    if (!prior) return null;
    if (prior.command_sha256 !== commandSha) throw new CaseOperationsError("idempotency_key_reused_with_different_command");
    return immutable({ ...prior.result, idempotent_replay: true });
  }

  #commit(
    stored: StoredCase,
    idempotencyKey: string,
    commandSha: string,
    input: Readonly<{
      eventKind: CaseAuditEvent["event_kind"];
      stateAfter: CaseLifecycleState;
      actorId: string;
      actorRole: string;
      reason: string;
    }>,
  ): CaseOperationsResult {
    const event = this.#makeEvent(stored, { ...input, commandSha });
    stored.revision += 1;
    stored.state = input.stateAfter;
    stored.events.push(event);
    const result = this.#result(stored, commandSha, event.event_sha256, false);
    stored.idempotency.set(idempotencyKey, immutable({ command_sha256: commandSha, result }));
    this.#logger.write({
      event_code: input.eventKind,
      case_id: stored.case_id,
      revision: stored.revision,
      state: stored.state,
      command_sha256: commandSha,
      audit_event_sha256: event.event_sha256,
    });
    return result;
  }

  #makeEvent(stored: StoredCase, input: Readonly<{
    eventKind: CaseAuditEvent["event_kind"];
    stateAfter: CaseLifecycleState;
    actorId: string;
    actorRole: string;
    reason: string;
    commandSha: string;
  }>): CaseAuditEvent {
    const unsigned = {
      schema_version: CASE_LIFECYCLE_SCHEMA,
      event_kind: input.eventKind,
      case_id: stored.case_id,
      revision: stored.events.length === 0 ? 0 : stored.revision + 1,
      state_before: stored.events.length === 0 ? null : stored.state,
      state_after: input.stateAfter,
      actor_id: input.actorId,
      actor_role: input.actorRole,
      occurred_at: this.#clock.now(),
      reason: input.reason,
      command_sha256: input.commandSha,
      prior_event_sha256: stored.events.at(-1)?.event_sha256 ?? null,
    };
    const eventSha = this.#hash.hashCanonical(unsigned);
    return immutable({
      ...unsigned,
      event_id: this.#ids.derive("case-audit-event", eventSha),
      event_sha256: eventSha,
    });
  }

  #result(stored: StoredCase, commandSha: string, eventSha: string, replay: boolean): CaseOperationsResult {
    return immutable({
      case_id: stored.case_id,
      revision: stored.revision,
      state: stored.state,
      command_sha256: commandSha,
      audit_event_sha256: eventSha,
      idempotent_replay: replay,
    });
  }
}

export function reconcilePaymentEvidence(
  evidence: readonly PaymentEvidenceSnapshot[],
  caseId: string,
  expectedAmount: Money,
  expectedCustomerReference: string,
): PaymentEvidenceSnapshot {
  if (evidence.length === 0) throw new CaseOperationsError("payment_unmatched");
  if (evidence.some((item) => item.duplicate_of_evidence_id !== null)) throw new CaseOperationsError("payment_duplicate_evidence");
  const caseMatches = evidence.filter((item) => item.case_reference === caseId);
  if (caseMatches.length === 0) throw new CaseOperationsError("payment_case_reference_mismatch");
  const customerMatches = caseMatches.filter((item) => item.customer_reference === expectedCustomerReference);
  if (customerMatches.length === 0) throw new CaseOperationsError("payment_customer_reference_mismatch");
  const currencyMatches = customerMatches.filter((item) => item.amount.currency === expectedAmount.currency);
  if (currencyMatches.length === 0) throw new CaseOperationsError("payment_currency_mismatch");
  const amountMatches = currencyMatches.filter((item) => item.amount.minor_units === expectedAmount.minor_units);
  if (amountMatches.length === 0) throw new CaseOperationsError("payment_amount_mismatch");
  const adverse = amountMatches.find((item) => item.status === "refunded" || item.status === "chargeback");
  if (adverse) throw new CaseOperationsError(`payment_${adverse.status}`);
  const settled = amountMatches.filter((item) => item.status === "settled");
  if (settled.length !== 1) {
    const status = amountMatches[0]?.status ?? "unmatched";
    throw new CaseOperationsError(`payment_${status}`);
  }
  return settled[0];
}

export function allowedLifecycleTransitions(): readonly Readonly<{ from: CaseLifecycleState; to: CaseLifecycleState }>[] {
  return immutable(Object.entries(NEXT_STATES).flatMap(([from, targets]) => targets.map((to) => ({ from: from as CaseLifecycleState, to }))));
}

export function isLifecycleTransitionAllowed(from: CaseLifecycleState, to: CaseLifecycleState): boolean {
  return NEXT_STATES[from].includes(to);
}
