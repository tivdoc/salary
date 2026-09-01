import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase-admin";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";

export async function GET(request: Request) {
  await guardStableHttpEntrypoint("CEP-019", request);
  return NextResponse.json(
    {
      ok: true,
      services: {
        supabase: isSupabaseConfigured(),
        payment: Boolean(
          process.env.INVOICE4U_API_KEY && process.env.INVOICE4U_CLEARING_COMPANY_TYPE,
        ),
        analytics: Boolean(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID),
        analyticsServer: Boolean(
          process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && process.env.GA4_API_SECRET,
        ),
        metaPixel: Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID),
        metaCapi: Boolean(
          process.env.META_CAPI_ACCESS_TOKEN &&
            (process.env.META_DATASET_ID || process.env.NEXT_PUBLIC_META_PIXEL_ID),
        ),
        paymentRecovery: Boolean(process.env.PAYMENT_RECONCILIATION_SECRET),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
