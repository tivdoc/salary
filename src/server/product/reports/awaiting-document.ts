// Site S2.4 — "אמצא אחר כך", from the funnel answer to the case that says so.
//
// What the choice actually costs the product is a decision about honesty. The
// easy implementation drops the customer at the upload screen and hopes; the
// one here opens a blocking request on the thread, moves the case to a state
// that names what it is waiting for, and stops the SLA clock (D-7.2) because a
// clock that runs while we are the ones waiting is a promise we are breaking on
// paper only.
//
// The order matters and is deliberate: the request is opened FIRST, and the
// case moves only if it opened. A case sitting in `awaiting_document` with no
// request would be waiting for something nobody ever asked for — no reminder at
// 48 hours, no expiry at ten days (D-9), no line in the thread the customer can
// read. Failing back to `questionnaire_completed` leaves the funnel exactly as
// it was before this wave, which is a worse experience and not a broken one.
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db.ts";
import { listCaseRequests, openRequestsForRefusals, type StoredRequest } from "./case-requests.ts";

export const DOCUMENT_MISSING_CODE = "document_missing" as const;

/** What the customer's answer becomes on the thread when the payslip finally arrives. */
export const DOCUMENT_ARRIVED_ANSWER = "התלוש צורף לתיק" as const;

export type AwaitOutcome = Readonly<{
  /** The request that now holds the case, or null when none could be opened. */
  request: StoredRequest | null;
  /** The case's status after the attempt — `awaiting_document` only if the request opened. */
  status: string | null;
}>;

/**
 * The funnel's "I have no payslip" answer, applied to a case that was just
 * created. Idempotent: a second call finds the request already open, opens
 * nothing, and reports the state as it stands.
 */
export async function beginAwaitingDocument(caseId: string, db?: CaseAccessDb | null): Promise<AwaitOutcome> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { request: null, status: null };
  await openRequestsForRefusals({ caseId, codes: [DOCUMENT_MISSING_CODE] }, store);
  const request = await openDocumentRequest(caseId, store);
  if (!request) return { request: null, status: null };
  const rows = await store.rpc<{ value: string | null }>("case_documents_await", { target_case: caseId });
  return { request, status: rows[0]?.value ?? null };
}

/** The open document request on a case, if there is one — what the upload screen and the thread read. */
export async function openDocumentRequest(caseId: string, db?: CaseAccessDb | null): Promise<StoredRequest | null> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return null;
  const requests = await listCaseRequests(caseId, store);
  return requests.find((row) => row.code === DOCUMENT_MISSING_CODE && row.answered_at === null) ?? null;
}

/**
 * The payslip arrived. The request is answered — not deleted — so the thread
 * still shows it was asked, and the case stops being paused by it.
 *
 * Returns how many requests were closed, which is 0 for every case that never
 * said "I'll find it later"; the upload route calls this unconditionally rather
 * than reading the state first, because the read and the write would otherwise
 * be two decisions about the same fact.
 */
export async function documentArrived(caseId: string, db?: CaseAccessDb | null): Promise<number> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return 0;
  const rows = await store.rpc<{ value: number | string }>("case_documents_arrived", {
    target_case: caseId,
    target_answer: DOCUMENT_ARRIVED_ANSWER,
  });
  return Number(rows[0]?.value ?? 0);
}
