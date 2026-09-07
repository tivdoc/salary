import "server-only";
import { deliverVerifiedGa4Purchase } from "./ga4-server";
import { deliverVerifiedMetaPurchase } from "./meta-purchase";
import { getSupabaseAdmin } from "./supabase-admin";
import { verifyPendingInvoice4uPayment } from "./verify-payment";

export type ReconciliationSummary = {
  scanned: number;
  verified: number;
  alreadyVerified: number;
  pending: number;
  rejected: number;
  failed: number;
  analyticsScanned: number;
  analyticsFailed: number;
};

export async function reconcilePendingPayments(limit = 50): Promise<ReconciliationSummary> {
  const supabase = getSupabaseAdmin();
  const summary: ReconciliationSummary = {
    scanned: 0,
    verified: 0,
    alreadyVerified: 0,
    pending: 0,
    rejected: 0,
    failed: 0,
    analyticsScanned: 0,
    analyticsFailed: 0,
  };

  const { data: payments, error } = await supabase
    .from("payments")
    .select("case_id")
    .eq("provider", "invoice4u")
    .eq("status", "pending")
    .not("provider_clearing_log_id", "is", null)
    .order("provider_checkout_created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw error;

  for (const payment of payments ?? []) {
    summary.scanned += 1;
    try {
      const result = await verifyPendingInvoice4uPayment(payment.case_id);
      summary[result === "already_verified" ? "alreadyVerified" : result] += 1;
      await supabase
        .from("payments")
        .update({
          reconciliation_attempted_at: new Date().toISOString(),
          reconciliation_error: result === "rejected" ? "provider_rejected" : null,
        })
        .eq("case_id", payment.case_id)
        .eq("idempotency_key", `${payment.case_id}:initial-check`);

      if (result === "verified" || result === "already_verified") {
        await Promise.all([
          deliverVerifiedMetaPurchase(payment.case_id),
          deliverVerifiedGa4Purchase(payment.case_id),
        ]);
      }
    } catch (caught) {
      summary.failed += 1;
      const code =
        caught && typeof caught === "object" && typeof (caught as { code?: unknown }).code === "string"
          ? (caught as { code: string }).code
          : "reconciliation_failed";
      await supabase
        .from("payments")
        .update({
          reconciliation_attempted_at: new Date().toISOString(),
          reconciliation_error: code.slice(0, 120),
        })
        .eq("case_id", payment.case_id)
        .eq("idempotency_key", `${payment.case_id}:initial-check`);
    }
  }

  const { data: analyticsBacklog, error: analyticsError } = await supabase
    .from("payments")
    .select("case_id,cases!inner(is_qa)")
    .eq("provider", "invoice4u")
    .eq("status", "verified")
    .eq("cases.is_qa", false)
    .or("meta_purchase_sent_at.is.null,ga4_purchase_sent_at.is.null")
    .limit(Math.min(Math.max(limit, 1), 100));
  if (analyticsError) throw analyticsError;

  for (const payment of analyticsBacklog ?? []) {
    summary.analyticsScanned += 1;
    try {
      const [metaDelivery, ga4Delivery] = await Promise.all([
        deliverVerifiedMetaPurchase(payment.case_id),
        deliverVerifiedGa4Purchase(payment.case_id),
      ]);
      if (metaDelivery === "failed" || ga4Delivery === "failed") {
        summary.analyticsFailed += 1;
      }
    } catch {
      summary.analyticsFailed += 1;
    }
  }

  return summary;
}
