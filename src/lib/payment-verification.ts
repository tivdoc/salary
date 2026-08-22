import { INITIAL_CHECK_CURRENCY, INITIAL_CHECK_PRICE } from "./payment";

export type PaymentVerificationErrorCode =
  | "reference_missing"
  | "transaction_failed"
  | "amount_mismatch"
  | "currency_mismatch"
  | "payment_id_mismatch"
  | "transaction_reused";

export class PaymentVerificationError extends Error {
  constructor(public readonly code: PaymentVerificationErrorCode) {
    super(code);
    this.name = "PaymentVerificationError";
  }
}

export type Invoice4uClearingLog = Record<string, unknown>;

export type VerifiedInvoice4uTransaction = {
  paymentId: string;
  clearingLogId: string;
  confirmationNumber: string;
  amount: number;
  currency: "ILS";
};

function textValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function amountInAgorot(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

export function validateInvoice4uClearingLog(
  log: Invoice4uClearingLog | null,
  expectedPaymentId: string,
): VerifiedInvoice4uTransaction {
  if (!log) throw new PaymentVerificationError("reference_missing");

  const paymentId = textValue(log.PaymentId);
  const clearingLogId = textValue(log.Id);
  const confirmationNumber = textValue(log.ClearingConfirmationNumber);
  if (!paymentId || !clearingLogId || !confirmationNumber) {
    throw new PaymentVerificationError("reference_missing");
  }
  if (paymentId !== expectedPaymentId) {
    throw new PaymentVerificationError("payment_id_mismatch");
  }

  const errors = Array.isArray(log.Errors) ? log.Errors : [];
  const errorMessage = typeof log.ErrorMessage === "string" ? log.ErrorMessage.trim() : "";
  if (log.IsSuccess !== true || errors.length > 0 || errorMessage) {
    throw new PaymentVerificationError("transaction_failed");
  }

  const amount = amountInAgorot(log.Amount);
  if (amount !== Math.round(INITIAL_CHECK_PRICE * 100)) {
    throw new PaymentVerificationError("amount_mismatch");
  }

  const currency = textValue(log.CurrencyName)?.toUpperCase();
  if (currency !== INITIAL_CHECK_CURRENCY) {
    throw new PaymentVerificationError("currency_mismatch");
  }

  return {
    paymentId,
    clearingLogId,
    confirmationNumber,
    amount: amount / 100,
    currency: INITIAL_CHECK_CURRENCY,
  };
}

export function assertTransactionBelongsToCase(
  assignedCaseId: string | null,
  expectedCaseId: string,
) {
  if (assignedCaseId && assignedCaseId !== expectedCaseId) {
    throw new PaymentVerificationError("transaction_reused");
  }
}

export function isIdempotentVerification(
  status: string,
  storedReference: string | null,
  verifiedReference: string,
) {
  if (status !== "verified") return false;
  if (storedReference !== verifiedReference) {
    throw new PaymentVerificationError("transaction_reused");
  }
  return true;
}
