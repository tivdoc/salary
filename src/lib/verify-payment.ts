import "server-only";
import { Invoice4uClient, invoice4uErrorCode } from "./invoice4u";
import {
  PaymentVerificationError,
  isIdempotentVerification,
  validateInvoice4uClearingLog,
} from "./payment-verification";
import { getSupabaseAdmin } from "./supabase-admin";
import { recordCaseFunnelEvent } from "./funnel-server";

export type PaymentVerificationResult =
  | "verified"
  | "already_verified"
  | "pending"
  | "rejected";

export async function verifyPendingInvoice4uPayment(
  caseId: string,
): Promise<PaymentVerificationResult> {
  const supabase = getSupabaseAdmin();
  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select("id,status,provider_reference,provider_payment_id,provider_clearing_log_id")
    .eq("case_id", caseId)
    .eq("idempotency_key", `${caseId}:initial-check`)
    .maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment?.provider_clearing_log_id) return "pending";

  if (
    payment.status === "verified" &&
    payment.provider_reference &&
    isIdempotentVerification(
      payment.status,
      payment.provider_reference,
      payment.provider_reference,
    )
  ) {
    return "already_verified";
  }

  let clearingLog;
  try {
    clearingLog = await new Invoice4uClient().getClearingLogById(
      payment.provider_clearing_log_id,
    );
  } catch (error) {
    console.error(
      "Payment verification provider lookup failed",
      invoice4uErrorCode(error) ?? "unknown_provider_error",
    );
    throw error;
  }
  if (!clearingLog) {
    console.error("Payment verification provider log not found");
    return "pending";
  }

  let transaction;
  try {
    transaction = validateInvoice4uClearingLog(clearingLog, payment.provider_clearing_log_id);
  } catch (error) {
    if (error instanceof PaymentVerificationError && error.code === "transaction_pending") {
      return "pending";
    }
    if (error instanceof PaymentVerificationError && error.code === "reference_missing") {
      const keys = Object.keys(clearingLog).sort().join(",");
      console.error(
        "Payment verification reference field shape",
        `keys=${keys};paymentId=${"PaymentId" in clearingLog};id=${"Id" in clearingLog};confirmation=${"ClearingConfirmationNumber" in clearingLog}`,
      );
    }
    console.error(
      "Payment verification rejected",
      error instanceof PaymentVerificationError ? error.code : "unknown_validation_error",
    );
    if (error instanceof PaymentVerificationError && error.code === "transaction_failed") {
      await Promise.all([
        supabase.from("payments").update({ status: "failed" }).eq("id", payment.id),
        supabase
          .from("cases")
          .update({ payment_status: "failed" })
          .eq("id", caseId)
          .neq("payment_status", "verified"),
      ]);
    }
    return "rejected";
  }

  const { data: newlyVerified, error: verificationError } = await supabase.rpc(
    "verify_salary_payment",
    {
      target_case_id: caseId,
      expected_clearing_log_id: transaction.clearingLogId,
      observed_payment_id: transaction.paymentId,
      observed_confirmation_number: transaction.confirmationNumber,
      observed_amount: transaction.amount,
      observed_currency: transaction.currency,
    },
  );
  if (verificationError) {
    console.error("Payment verification database transition rejected", verificationError.code);
    return "rejected";
  }
  await recordCaseFunnelEvent(caseId, "payment_verified");
  return newlyVerified ? "verified" : "already_verified";
}
