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
    expect(validateInvoice4uClearingLog(validLog, "68871")).toEqual({
      paymentId: "45668",
      clearingLogId: "68871",
      confirmationNumber: "1117795",
      amount: 9.99,
      currency: "ILS",
    });
  });

  it("rejects a wrong amount", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, Amount: 9.98 }, "68871"),
      "amount_mismatch",
    );
  });

  it("rejects a wrong currency", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, CurrencyName: "USD" }, "68871"),
      "currency_mismatch",
    );
  });

  it("rejects a failed transaction", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, IsSuccess: false }, "68871"),
      "transaction_failed",
    );
  });

  it("treats Invoice4u PaymentId 0 as a transaction that is still pending", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, PaymentId: 0 }, "68871"),
      "transaction_pending",
    );
  });

  it("rejects a missing provider reference", () => {
    expectCode(
      () => validateInvoice4uClearingLog({ ...validLog, Id: null }, "68871"),
      "reference_missing",
    );
  });

  it("accepts Cardcom clearing trace when Invoice4u omits its confirmation number", () => {
    expect(
      validateInvoice4uClearingLog(
        { ...validLog, ClearingConfirmationNumber: null, ClearingTraceId: "trace-7788" },
        "68871",
      ).confirmationNumber,
    ).toBe("trace-7788");
  });

  it("falls back to the provider transaction ID when no confirmation or trace exists", () => {
    expect(
      validateInvoice4uClearingLog(
        {
          ...validLog,
          ClearingConfirmationNumber: null,
          ClearingTraceId: null,
          TransactionId: "transaction-9911",
        },
        "68871",
      ).confirmationNumber,
    ).toBe("transaction-9911");
  });

  it("rejects a transaction without any real confirmation, trace, or transaction ID", () => {
    expectCode(
      () =>
        validateInvoice4uClearingLog(
          {
            ...validLog,
            ClearingConfirmationNumber: null,
            ClearingTraceId: null,
            TransactionId: null,
          },
          "68871",
        ),
      "reference_missing",
    );
  });

  it("rejects a clearing log that was not created for this case", () => {
    expectCode(
      () => validateInvoice4uClearingLog(validLog, "other-clearing-log"),
      "clearing_log_mismatch",
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
