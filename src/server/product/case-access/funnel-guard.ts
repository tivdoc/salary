// External review #1, finding 1. What a funnel page asks before it renders:
// is there a case in this browser, and has its contact been verified. No
// document binds and no payment starts before the second answer is yes.
// No "server-only" marker: the page test imports this under vitest, and the module lives under src/server by construction.
import { redirect } from "next/navigation";
import { readCaseIdFromCookie } from "../../../lib/case-cookie.ts";
import { funnelCaseState } from "./service.ts";

/** Redirects to /check when there is no case, or to the verification step when the contact is not verified yet; returns the case id otherwise. */
export async function requireVerifiedFunnelCase(): Promise<string> {
  const caseId = await readCaseIdFromCookie();
  if (!caseId) redirect("/check");
  const state = await funnelCaseState(caseId);
  if (!state.exists) redirect("/check");
  if (!state.contact_verified) redirect("/check?verify=1");
  return caseId;
}
