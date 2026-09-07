import { INITIAL_CHECK_CURRENCY, INITIAL_CHECK_PRICE } from "./payment";

export type PaymentVerificationErrorCode =
  | "transaction_pending"
  | "reference_missing"
  | "transaction_failed"
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
  expected: {amountMinor:number;currency:"ILS";orderId?:string} = {amountMinor:Math.round(INITIAL_CHECK_PRICE*100),currency:INITIAL_CHECK_CURRENCY},
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

  const amount = amountInAgorot(log.Amount);
  if (amount !== expected.amountMinor) {
    throw new PaymentVerificationError("amount_mismatch");
  }

  const currency = textValue(log.CurrencyName)?.toUpperCase();
  if (currency !== expected.currency) {
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
