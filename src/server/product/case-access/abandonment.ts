// Site S4 (ב.12) — one message to someone who attached a payslip and did not
// pay, and the opt-out that stops it.
//
// The rules this module exists to hold, each of which the product would
// otherwise get wrong in a way nobody notices until it is embarrassing:
//
//   ONE message. Not a sequence. The sweep marks the case the moment a send
//   succeeds, and the candidate query excludes anything already marked, so a
//   cron running twice sends once — the same property U4's link sweep has.
//
//   The opt-out wins. It is the first condition in the candidate query, before
//   the age, before the state. An opt-out a later rule can override is not one.
//
//   REFUSED is terminal. S1.5 made the delivery allowlist fail closed outside
//   production and drew the line between a send that failed (a provider
//   problem, retry later) and one that was refused (a policy decision, retrying
//   is arguing with ourselves). The candidate query lets `failed` back in and
//   never `refused`.
//
//   The blocking-request case is NOT here. A case waiting on an open request
//   already has D-9's reminders at 48 hours and 5 days and its expiry at ten
//   days; a second, differently-timed reminder about the same silence would be
//   the product talking over itself.
import { productOffer } from "../../../lib/product-offer.ts";
import { resolveCaseAccessDb, type CaseAccessDb } from "./db.ts";

/** ב.12's default: twenty-four hours after the case was opened. */
export const ABANDONMENT_AFTER_HOURS = 24;

export type AbandonmentCandidate = Readonly<{ case_id: string; public_id: string; created_at: string }>;

export type SweepOutcome = Readonly<{
  examined: number;
  sent: number;
  failed: number;
  refused: number;
  skipped_no_contact: number;
}>;

type CandidateRow = Readonly<{ case_id: string; public_id: string; created_at: string }>;

/** Who is due a reminder. Ordered oldest first; the caller decides how many. */
export async function abandonmentCandidates(
  input: Readonly<{ afterHours?: number; limit?: number }> = {},
  db?: CaseAccessDb | null,
): Promise<readonly AbandonmentCandidate[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return [];
  const rows = await store.rpc<CandidateRow>("case_abandonment_candidates", {
    target_after_hours: input.afterHours ?? ABANDONMENT_AFTER_HOURS,
    target_limit: input.limit ?? 50,
  });
  return rows.map((row) => Object.freeze({
    case_id: row.case_id,
    public_id: row.public_id,
    created_at: new Date(row.created_at).toISOString(),
  }));
}

/** The customer said no more. Idempotent, and nothing undoes it from here. */
export async function optOutOfReminders(caseId: string, db?: CaseAccessDb | null): Promise<boolean> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return false;
  const rows = await store.rpc<{ id: string }>("case_reminder_opt_out", { target_case: caseId });
  return rows.length > 0;
}

/** Records what happened to a case's one reminder. */
export async function markAbandonmentReminder(
  input: Readonly<{ caseId: string; state: "sent" | "failed" | "refused" }>,
  db?: CaseAccessDb | null,
): Promise<boolean> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return false;
  const rows = await store.rpc<{ id: string }>("case_abandonment_mark", {
    target_case: input.caseId,
    target_state: input.state,
  });
  return rows.length > 0;
}

/** The opt-out link the message carries, built from the same origin the link uses. */
export function optOutUrl(origin: string, token: string): string {
  return `${origin}/check/reminders/off?t=${encodeURIComponent(token)}`;
}

/** How long the sweep waits, from configuration when it says so and ב.12's default otherwise. */
export function abandonmentAfterHours(): number {
  const configured = (productOffer() as { reminders?: { abandonment_after_hours?: unknown } }).reminders?.abandonment_after_hours;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : ABANDONMENT_AFTER_HOURS;
}
