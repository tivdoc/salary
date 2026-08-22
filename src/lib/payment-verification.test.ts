import { describe, expect, it } from "vitest";
import {
  PaymentVerificationError,
  assertTransactionBelongsToCase,
  isIdempotentVerification,
  validateInvoice4uClearingLog,
} from "./payment-verification";

const validLog = {
  Amount: 9.99,
  CurrencyName: "ILS",
  IsSuccess: true,
  PaymentId: "45668",
  Id: 68871,
  ClearingConfirmationNumber: "1117795",
  Errors: [],
  ErrorMessage: "",
};

function expectCode(action: () => unknown, code: PaymentVerificationError["code"]) {
  try {
    action();
    throw new Error("Expected verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentVerificationError);
    expect((error as PaymentVerificationError).code).toBe(code);
  }
}

describe("Invoice4u clearing verification", () => {
  it("accepts a successful 9.99 ILS transaction with real references", () => {
    expect(validateInvoice4uClearingLog(validLog, "45668")).toEqual({
      paymentId: "45668",
      clearingLogId: "68871",
      confirmationNumber: "1117795",
      amount: 9.99,
      currency: "ILS",
    });
  });

  it("rejects a wrong amount", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, Amount: 9.98 }, "45668"),
      "amount_mismatch",
    );
  });

  it("rejects a wrong currency", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, CurrencyName: "USD" }, "45668"),
      "currency_mismatch",
    );
  });

  it("rejects a failed transaction", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, IsSuccess: false }, "45668"),
      "transaction_failed",
    );
  });

  it("rejects a missing provider reference", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, Id: null }, "45668"),
      "reference_missing",
    );
  });

  it("rejects a PaymentId that was not created for this case", () => {
    expectCode(
      () => validateInvoice4uClearingLog(validLog, "other-payment"),
      "payment_id_mismatch",
    );
  });

  it("rejects a transaction already assigned to another case", () => {
    expectCode(
      () => assertTransactionBelongsToCase("case-b", "case-a"),
      "transaction_reused",
    );
  });

  it("treats a duplicate callback or provider poll as idempotent", () => {
    expect(isIdempotentVerification("verified", "68871", "68871")).toBe(true);
  });
});
