import "server-only";
import { Invoice4uClient } from "./invoice4u";
import {
  PaymentVerificationError,
  isIdempotentVerification,
  validateInvoice4uClearingLog,
} from "./payment-verification";
import { getSupabaseAdmin } from "./supabase-admin";

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
    .select("id,status,provider_reference,provider_payment_id")
    .eq("case_id", caseId)
    .eq("idempotency_key", `${caseId}:initial-check`)
    .maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment?.provider_payment_id) return "pending";

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

  const clearingLog = await new Invoice4uClient().getClearingLog(payment.provider_payment_id);
  if (!clearingLog) return "pending";

  let transaction;
  try {
    transaction = validateInvoice4uClearingLog(clearingLog, payment.provider_payment_id);
  } catch (error) {
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
      expected_payment_id: transaction.paymentId,
      observed_clearing_log_id: transaction.clearingLogId,
      observed_confirmation_number: transaction.confirmationNumber,
      observed_amount: transaction.amount,
      observed_currency: transaction.currency,
    },
  );
  if (verificationError) return "rejected";
  return newlyVerified ? "verified" : "already_verified";
}
