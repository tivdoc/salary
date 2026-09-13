import { INITIAL_CHECK_CURRENCY, INITIAL_CHECK_PRICE } from "./payment";

export type PaymentVerificationErrorCode =
  | "transaction_pending"
  | "reference_missing"
  | "transaction_failed"
  | "transaction_not_charge"
  | "transaction_requires_reconciliation"
  | "amount_mismatch"
  | "currency_mismatch"
  | "clearing_log_mismatch"
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
  const text=typeof value==='number'?String(value):typeof value==='string'?value.trim():'';
  const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(text);if(!match)return null;
  const minor=Number(match[1])*100+Number((match[2]??'').padEnd(2,'0'));return Number.isSafeInteger(minor)?minor:null;
}

export function validateInvoice4uClearingLog(
  log: Invoice4uClearingLog | null,
  expectedClearingLogId: string,
  expected: {amountMinor:number;currency:"ILS";orderId?:string;paymentId?:string|null} = {amountMinor:Math.round(INITIAL_CHECK_PRICE*100),currency:INITIAL_CHECK_CURRENCY},
): VerifiedInvoice4uTransaction {
  if (!log) throw new PaymentVerificationError("reference_missing");

  const paymentId = textValue(log.PaymentId);
  const clearingLogId = textValue(log.Id);
  const confirmationNumber =
    textValue(log.ClearingConfirmationNumber) ??
    textValue(log.ClearingTraceId) ??
    textValue(log.TransactionId);
  if (!paymentId || !clearingLogId || !confirmationNumber) {
    throw new PaymentVerificationError("reference_missing");
  }
  if (paymentId === "0") {
    throw new PaymentVerificationError("transaction_pending");
  }
  if (clearingLogId !== expectedClearingLogId) {
    throw new PaymentVerificationError("clearing_log_mismatch");
  }

  const errors = Array.isArray(log.Errors) ? log.Errors : [];
  const errorMessage = typeof log.ErrorMessage === "string" ? log.ErrorMessage.trim() : "";
  if (log.IsSuccess !== true || errors.length > 0 || errorMessage) {
    throw new PaymentVerificationError("transaction_failed");
  }
  if (expected.paymentId != null && paymentId !== expected.paymentId) {
    throw new PaymentVerificationError("transaction_reused");
  }

  // Invoice4U's current Clearing Logs contract distinguishes request/response,
  // charge/token/refund and previously credited originals. A successful refund
  // or token creation must never authorize a new purchased entitlement.
  // Old envelopes without these fields remain readable; present malformed or
  // contradictory fields fail closed, rather than being coerced to false/zero.
  if ((log.LogType !== undefined && log.LogType !== 2)
      || (log.IsCredit !== undefined && log.IsCredit !== false)
      || (log.TransactionType !== undefined && ![0, 2, 3, 4, 5, 7, 8].includes(log.TransactionType as number))) {
    throw new PaymentVerificationError("transaction_not_charge");
  }
  if ((log.CreditedTransaction !== undefined && log.CreditedTransaction !== false)
      || (log.CreditAmount !== undefined && amountInAgorot(log.CreditAmount) !== 0)) {
    throw new PaymentVerificationError("transaction_requires_reconciliation");
  }

  const amount = amountInAgorot(log.Amount);
  if (!Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 || amount !== expected.amountMinor) {
    throw new PaymentVerificationError("amount_mismatch");
  }

  // Native Currency is an enum: 1 NIS, 2 USD, 3 EUR. CurrencyName is retained
  // for historical envelopes; neither representation may contradict the other.
  const currency = textValue(log.CurrencyName)?.toUpperCase();
  const hasNativeCurrency = log.Currency !== undefined;
  if (expected.currency !== 'ILS'
      || (hasNativeCurrency && textValue(log.Currency) !== '1')
      || (log.CurrencyName !== undefined && currency !== 'ILS' && currency !== 'NIS')
      || (!hasNativeCurrency && currency !== 'ILS' && currency !== 'NIS')) {
    throw new PaymentVerificationError("currency_mismatch");
  }

  if(expected.orderId&&log.OrderIdClientUsage!==undefined&&textValue(log.OrderIdClientUsage)!==expected.orderId)throw new PaymentVerificationError("transaction_reused");
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
