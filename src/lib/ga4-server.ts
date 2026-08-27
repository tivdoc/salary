import "server-only";
import { processVerifiedGa4Purchase } from "./ga4-server-core";
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

export async function sendGa4PaymentCompleted(input: {
  clientId: string;
  eventId: string;
  transactionId: string;
  value: number;
  currency: string;
}) {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();
  const apiSecret = process.env.GA4_API_SECRET?.trim();
  if (!measurementId || !apiSecret) return "disabled" as const;

  try {
    const endpoint = new URL("https://region1.google-analytics.com/mp/collect");
    endpoint.searchParams.set("measurement_id", measurementId);
    endpoint.searchParams.set("api_secret", apiSecret);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: input.clientId,
        events: [
          {
            name: "payment_completed",
            params: {
              transaction_id: input.transactionId,
              event_id: input.eventId,
              value: input.value,
              currency: input.currency,
              engagement_time_msec: 1,
            },
          },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok ? ("sent" as const) : ("failed" as const);
  } catch {
    return "failed" as const;
  }
}

export async function deliverVerifiedGa4Purchase(caseId: string) {
  if (!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim() || !process.env.GA4_API_SECRET?.trim()) {
    return "disabled" as const;
  }

  const supabase = getSupabaseAdmin();
  try {
    return await processVerifiedGa4Purchase(caseId, {
      async claim(targetCaseId) {
        const result = await supabase.rpc("claim_salary_ga4_purchase", {
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
      async loadClientId(targetCaseId) {
        const result = await supabase
          .from("cases")
          .select("ga_client_id")
          .eq("id", targetCaseId)
          .single();
        if (result.error) throw result.error;
        return result.data?.ga_client_id ?? null;
      },
      send: sendGa4PaymentCompleted,
      async complete(claim) {
        const result = await supabase.rpc("complete_salary_ga4_purchase", {
          target_payment_id: claim.paymentId,
          target_event_id: claim.eventId,
        });
        if (result.error) throw result.error;
      },
      async release(claim) {
        const result = await supabase.rpc("release_salary_ga4_purchase", {
          target_payment_id: claim.paymentId,
          target_event_id: claim.eventId,
        });
        if (result.error) throw result.error;
      },
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "delivery_error";
    console.warn("GA4 payment_completed delivery deferred", code);
    return "failed" as const;
  }
}
