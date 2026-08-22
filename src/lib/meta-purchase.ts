import "server-only";
import { metaRequestContext, sendMetaCapiEvent } from "./meta-capi";
import { resolveMetaCapiConfig } from "./meta-events";
import {
  processVerifiedMetaPurchase,
} from "./meta-purchase-core";
import { getSupabaseAdmin } from "./supabase-admin";

type ClaimRow = {
  payment_id: string;
  event_id: string;
  payment_status: string;
  payment_amount: number | string;
  payment_currency: string;
};

function firstClaim(data: unknown): ClaimRow | null {
  if (!Array.isArray(data) || !data.length) return null;
  const row = data[0] as Partial<ClaimRow>;
  if (!row.payment_id || !row.event_id) return null;
  return row as ClaimRow;
}

export async function deliverVerifiedMetaPurchase(caseId: string, request: Request) {
  if (!resolveMetaCapiConfig(process.env)) return "disabled";
  const supabase = getSupabaseAdmin();
  const context = metaRequestContext(request, "/check/received");

  try {
    return await processVerifiedMetaPurchase(
      caseId,
      context.eventSourceUrl,
      {
        clientIpAddress: context.clientIpAddress,
        clientUserAgent: context.clientUserAgent,
        fbp: context.fbp,
        fbc: context.fbc,
      },
      {
        async claim(targetCaseId) {
          const result = await supabase.rpc("claim_salary_meta_purchase", {
            target_case_id: targetCaseId,
          });
          if (result.error) throw result.error;
          const row = firstClaim(result.data);
          return row
            ? {
                paymentId: row.payment_id,
                eventId: row.event_id,
                status: row.payment_status,
                amount: Number(row.payment_amount),
                currency: row.payment_currency,
              }
            : null;
        },
        async loadCustomer(targetCaseId) {
          const result = await supabase
            .from("cases")
            .select("first_name,email,phone")
            .eq("id", targetCaseId)
            .single();
          if (result.error || !result.data) throw result.error ?? new Error("Case not found");
          return {
            firstName: result.data.first_name,
            email: result.data.email,
            phone: result.data.phone,
          };
        },
        async send(event) {
          const result = await sendMetaCapiEvent(event);
          return result.status;
        },
        async complete(claim) {
          const result = await supabase.rpc("complete_salary_meta_purchase", {
            target_payment_id: claim.paymentId,
            target_event_id: claim.eventId,
          });
          if (result.error) throw result.error;
        },
        async release(claim) {
          const result = await supabase.rpc("release_salary_meta_purchase", {
            target_payment_id: claim.paymentId,
            target_event_id: claim.eventId,
          });
          if (result.error) throw result.error;
        },
      },
    );
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "delivery_error";
    console.warn("Meta Purchase delivery deferred", code);
    return "failed";
  }
}
