import type { PaymentEvidencePort, PaymentEvidenceSnapshot } from "../../../engine/wave3/contracts";
import { immutable } from "../../../engine/case-operations/canonical.ts";
import { CaseOperationsError } from "../../../engine/case-operations/lifecycle.ts";

const PAYMENT_KEYS = [
  "amount",
  "case_reference",
  "customer_reference",
  "duplicate_of_evidence_id",
  "evidence_id",
  "evidence_revision",
  "evidence_sha256",
  "status",
] as const;

export class InMemoryVerifiedPaymentEvidenceStore implements PaymentEvidencePort {
  readonly #history = new Map<string, PaymentEvidenceSnapshot[]>();
  readonly provider_call_count = 0;

  appendVerifiedEvidence(evidence: PaymentEvidenceSnapshot): void {
    const keys = Object.keys(evidence).sort();
    if (keys.length !== PAYMENT_KEYS.length || keys.some((key, index) => key !== [...PAYMENT_KEYS].sort()[index])) {
      throw new CaseOperationsError("payment_evidence_unknown_or_missing_field");
    }
    if (!/^[a-f0-9]{64}$/.test(evidence.evidence_sha256)) throw new CaseOperationsError("payment_evidence_hash_invalid");
    if (!Number.isSafeInteger(evidence.amount.minor_units)) throw new CaseOperationsError("payment_evidence_money_invalid");
    if (!/^[A-Z]{3}$/.test(evidence.amount.currency)) throw new CaseOperationsError("payment_evidence_currency_invalid");
    const prior = this.#history.get(evidence.evidence_id) ?? [];
    const duplicate = prior.find((item) => item.evidence_revision === evidence.evidence_revision);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(evidence)) throw new CaseOperationsError("payment_evidence_revision_mutated");
      return;
    }
    this.#history.set(evidence.evidence_id, [...prior, immutable({ ...evidence, amount: { ...evidence.amount } })]);
  }

  async loadVerifiedEvidence(caseId: string): Promise<readonly PaymentEvidenceSnapshot[]> {
    const latest = [...this.#history.values()].map((history) => history.at(-1)!).filter((item) => item.case_reference === caseId || this.#history.size === 1);
    return immutable(latest.map((item) => ({ ...item, amount: { ...item.amount } })).sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, "en")));
  }

  history(evidenceId: string): readonly PaymentEvidenceSnapshot[] {
    return immutable((this.#history.get(evidenceId) ?? []).map((item) => ({ ...item, amount: { ...item.amount } })));
  }
}
