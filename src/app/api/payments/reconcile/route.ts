import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reconcilePendingPayments } from "@/lib/reconcile-payments";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.PAYMENT_RECONCILIATION_SECRET?.trim();
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!secret || !supplied) return false;
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-024", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await reconcilePendingPayments();
    return NextResponse.json(summary, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "reconciliation_error";
    console.error("Payment reconciliation job failed", code);
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 503 });
  }
}
