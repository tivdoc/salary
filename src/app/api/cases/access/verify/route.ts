import { NextResponse } from "next/server";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UX Run 1 / U0: the inventory entry exists before the route does (CEP-100).
export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-100", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
