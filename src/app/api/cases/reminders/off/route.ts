import { NextResponse } from "next/server";
import { optOutOfRemindersByToken } from "@/server/product/case-access/service";
import { refusedEntrypoint, strictJsonObject } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Site S4 (ב.12) — "stop sending me these".
 *
 * A POST, not a GET, even though it is reached from a link in a message: a mail
 * client's link prefetcher, a corporate scanner and a browser's speculative
 * fetch all issue GETs, and any of them would silently opt someone out of
 * something they never clicked. The link opens a page; the page asks once and
 * posts.
 *
 * It always answers ok. An unknown token, an expired one and a valid one are
 * indistinguishable from outside, because "is this token live?" is not a
 * question an unauthenticated caller may ask — and because a person who clicked
 * an old link should be told they will not be bothered again, which is true
 * either way.
 */
export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-108", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const body = await strictJsonObject(request, 2_048);
  const token = typeof body?.token === "string" ? body.token : null;
  try {
    await optOutOfRemindersByToken(token);
  } catch (error) {
    // The customer asked not to be contacted. Reporting a failure here would
    // invite them to click again; the sweep's own guard is the case row, and a
    // row that did not change means the next sweep may still send. That is
    // recorded rather than hidden.
    console.error("Reminder opt-out failed", error instanceof Error ? error.name : "error");
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
