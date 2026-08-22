import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase-admin";

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      services: {
        supabase: isSupabaseConfigured(),
        payment: Boolean(
          process.env.INVOICE4U_API_KEY && process.env.INVOICE4U_CLEARING_COMPANY_TYPE,
        ),
        analytics: Boolean(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
