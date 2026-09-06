// Site S2.4 acceptance. "אמצא אחר כך" is the one funnel answer that leaves the
// case open with nothing to work on, so what these tests hold is the shape of
// that wait: a request the customer can see, a state that names it, a clock
// that is stopped while it stands, and a way out that closes it exactly once.
import { describe, expect, it } from "vitest";
import { fakeCaseAccessDb, type FakeCase } from "../case-access/fake-db.ts";
import { caseSlaPaused, listCaseRequests } from "./case-requests.ts";
import {
  beginAwaitingDocument,
  documentArrived,
  DOCUMENT_ARRIVED_ANSWER,
  DOCUMENT_MISSING_CODE,
  openDocumentRequest,
} from "./awaiting-document.ts";
import { mappingFor, REQUEST_TIMING } from "./refusal-requests.ts";

const CASE_ID = "33333333-3333-4333-8333-333333333333";

function funnelCase(status = "questionnaire_completed"): FakeCase {
  return {
    id: CASE_ID, public_id: "TV-AWAIT001", email: "a@example.com", phone: null, first_name: "דנה",
    status, payment_status: "not_started", created_at: "2026-09-06T09:00:00.000Z", payment_verified: false,
    contact_verified_at: Date.parse("2026-09-06T09:05:00.000Z"), contact_verified_channel: "email",
  };
}

describe("S2.4 — the case that is waiting for a payslip", () => {
  it("opens one blocking request and names the state", async () => {
    const db = fakeCaseAccessDb([funnelCase()]);
    const outcome = await beginAwaitingDocument(CASE_ID, db);

    expect(outcome.status).toBe("awaiting_document");
    expect(outcome.request?.code).toBe(DOCUMENT_MISSING_CODE);
    expect(outcome.request?.blocking).toBe(true);
    expect(outcome.request?.answered_at).toBeNull();
    expect(db.cases[0]!.status).toBe("awaiting_document");

    // D-9: ten days, measured from when the request was made rather than from
    // the row's own `opened_at` — the store stamps that (here, a fixture clock
    // frozen a day earlier), and what the customer is promised is ten days from
    // now.
    const expires = Date.parse(outcome.request!.expires_at);
    expect(Math.round((expires - Date.now()) / (24 * 3_600 * 1_000))).toBe(REQUEST_TIMING.expiry_days);
  });

  it("stops the SLA clock while the request stands, and starts it when the payslip arrives", async () => {
    const db = fakeCaseAccessDb([funnelCase()]);
    await beginAwaitingDocument(CASE_ID, db);
    expect(caseSlaPaused(await listCaseRequests(CASE_ID, db))).toBe(true);

    expect(await documentArrived(CASE_ID, db)).toBe(1);
    expect(caseSlaPaused(await listCaseRequests(CASE_ID, db))).toBe(false);
  });

  it("keeps the question in the thread after it is answered, rather than deleting it", async () => {
    const db = fakeCaseAccessDb([funnelCase()]);
    await beginAwaitingDocument(CASE_ID, db);
    await documentArrived(CASE_ID, db);

    const requests = await listCaseRequests(CASE_ID, db);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.answer_text).toBe(DOCUMENT_ARRIVED_ANSWER);
    expect(requests[0]!.answered_at).not.toBeNull();
    // The customer's own history still shows what was asked (D-2).
    expect(requests[0]!.question).toBe(mappingFor(DOCUMENT_MISSING_CODE)!.question);
  });

  it("asks once: a second call opens nothing and a second arrival closes nothing", async () => {
    const db = fakeCaseAccessDb([funnelCase()]);
    const first = await beginAwaitingDocument(CASE_ID, db);
    const second = await beginAwaitingDocument(CASE_ID, db);
    expect(second.request?.id).toBe(first.request?.id);
    expect(await listCaseRequests(CASE_ID, db)).toHaveLength(1);

    expect(await documentArrived(CASE_ID, db)).toBe(1);
    expect(await documentArrived(CASE_ID, db)).toBe(0);
  });

  it("does not drag a case back out of payment", async () => {
    // The guard is in SQL and mirrored in the fake: only a case still in the
    // funnel moves. A paid case that needs another document gets the request —
    // it just does not get sent back to a funnel state it has already left.
    const db = fakeCaseAccessDb([funnelCase("paid")]);
    const outcome = await beginAwaitingDocument(CASE_ID, db);
    expect(outcome.status).toBe("paid");
    expect(outcome.request?.code).toBe(DOCUMENT_MISSING_CODE);
  });

  it("without a store, changes nothing and claims nothing", async () => {
    const outcome = await beginAwaitingDocument(CASE_ID, null);
    expect(outcome).toEqual({ request: null, status: null });
    expect(await documentArrived(CASE_ID, null)).toBe(0);
    expect(await openDocumentRequest(CASE_ID, null)).toBeNull();
  });

  it("reads back only the open request, so an answered case is not shown as waiting", async () => {
    const db = fakeCaseAccessDb([funnelCase()]);
    await beginAwaitingDocument(CASE_ID, db);
    expect(await openDocumentRequest(CASE_ID, db)).not.toBeNull();
    await documentArrived(CASE_ID, db);
    expect(await openDocumentRequest(CASE_ID, db)).toBeNull();
  });
});
