// Site S6.1 / S6.2 acceptance.
//
// Two properties carry the whole wave. The first is D-10.2's direction: a
// report publishes itself only when every condition holds, so a case nobody
// anticipated lands in front of a person rather than in front of a customer.
// The second is that an operator cannot move a number — proven here not by
// checking what they typed but by showing there is no path: the published
// report's projection is the same object that was read.
import { describe, expect, it } from "vitest";
import { fakeCaseAccessDb, type FakeCase } from "../case-access/fake-db.ts";
import { S04_HIGH_CERTAINTY, S05_LOW_CERTAINTY, S06_REFUSED, ALL_AWAITING_VERIFICATION } from "./case-report-projection.fixtures.ts";
import { parseProjection, type CaseReportProjection } from "./case-report-projection.ts";
import {
  AUTOMATIC_FINDING_CEILING_MINOR_UNITS,
  publicationDecision,
  QUEUE_REASON_TEXT,
  QUEUE_REASONS,
} from "./publication-gate.ts";
import {
  checkWording,
  decideReview,
  recordPublicationDecision,
  listReviewQueue,
  markRecheckRequired,
  publishedReport,
  reportsTouchedByParameter,
  setWording,
} from "./report-qa.ts";

const CASE_ID = "88888888-8888-4888-8888-888888888888";
const PROJECTION_ID = "99999999-9999-4999-8999-999999999999";
const SECOND_PROJECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR = "operator:dana@tivdoc.example";

const CASE: FakeCase = {
  id: CASE_ID, public_id: "TV-S6TEST01", email: "qa@example.com", phone: null, first_name: null,
  status: "under_review", payment_status: "verified", created_at: "2026-09-06T09:00:00.000Z", payment_verified: true,
};

function withFinding(base: CaseReportProjection, patch: Record<string, unknown>): CaseReportProjection {
  const topics = base.topics.map((topic) => (topic.gate === "checked" && topic.status === "finding" ? { ...topic, ...patch } : topic));
  return parseProjection({ ...base, topics });
}

describe("D-10.2 / D-10.3 — which reports a person must read", () => {
  it("publishes a clean initial report on the automatic track without a human", () => {
    const decision = publicationDecision(S04_HIGH_CERTAINTY, { documentTrack: "automatic" });
    expect(decision).toMatchObject({ automatic: true, reasons: [], document_track: "automatic" });
  });

  it("sends a full report to a person however clean it is (D-10.3)", () => {
    const full = parseProjection({
      ...S04_HIGH_CERTAINTY,
      report_kind: "full",
      months_covered: [S04_HIGH_CERTAINTY.check_period_month, "2025-06"].sort(),
    });
    expect(publicationDecision(full, { documentTrack: "automatic" }).reasons).toEqual(["full_report"]);
  });

  it("names each of D-10.2's four conditions separately", () => {
    expect(publicationDecision(S04_HIGH_CERTAINTY, { documentTrack: "human" }).reasons).toEqual(["document_not_automatic_track"]);
    expect(publicationDecision(S05_LOW_CERTAINTY, { documentTrack: "automatic" }).reasons).toEqual(["finding_at_low_certainty"]);

    const over = withFinding(S04_HIGH_CERTAINTY, {
      amount: { currency: "ILS", minor_units: AUTOMATIC_FINDING_CEILING_MINOR_UNITS + 1 },
    });
    expect(publicationDecision(over, { documentTrack: "automatic" }).reasons).toEqual(["finding_over_ceiling"]);

    const conflicted = parseProjection({
      ...S04_HIGH_CERTAINTY,
      topics: S04_HIGH_CERTAINTY.topics.map((topic) => (topic.gate === "checked" ? { ...topic, missing_facts: ["fact.conflicted"] } : topic)),
    });
    expect(publicationDecision(conflicted, { documentTrack: "automatic" }).reasons).toContain("contradiction_marked");
  });

  it("counts the top of a range, not only a stated amount", () => {
    const ranged = withFinding(S04_HIGH_CERTAINTY, {
      certainty: "medium",
      display: "range",
      certainty_sentence: "הנתון תלוי במה שמסרת",
      amount: null,
      range: { low: { currency: "ILS", minor_units: 100_000 }, high: { currency: "ILS", minor_units: AUTOMATIC_FINDING_CEILING_MINOR_UNITS + 500 } },
    });
    expect(publicationDecision(ranged, { documentTrack: "automatic" }).reasons).toEqual(["finding_over_ceiling"]);
  });

  it("does not treat a not-checked topic as a reason on its own", () => {
    // Nothing was claimed about these topics, so there is nothing to review.
    expect(publicationDecision(ALL_AWAITING_VERIFICATION, { documentTrack: "automatic" }).automatic).toBe(true);
    expect(publicationDecision(S06_REFUSED, { documentTrack: "automatic" }).automatic).toBe(true);
  });

  it("gives every reason a sentence, and keeps them in one order", () => {
    for (const reason of QUEUE_REASONS) expect(QUEUE_REASON_TEXT[reason].length).toBeGreaterThan(8);
    const everything = publicationDecision(
      parseProjection({ ...S05_LOW_CERTAINTY, report_kind: "full", months_covered: [S05_LOW_CERTAINTY.check_period_month] }),
      { documentTrack: "human" },
    );
    expect(everything.reasons).toEqual(["full_report", "document_not_automatic_track", "finding_at_low_certainty"]);
  });
});

describe("S6.1 — the queue, the wording and the log", () => {
  it("queues only what the gate refuses, and records why", async () => {
    const db = fakeCaseAccessDb([CASE]);
    // A clean report is recorded as published by the gate — never shown to a person.
    const clean = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S04_HIGH_CERTAINTY, documentTrack: "automatic" }, db);
    expect(clean.row).toMatchObject({ state: "published", queue_reasons: [], operator_identity: "system:publication_gate" });
    expect(await listReviewQueue({}, db)).toHaveLength(0);

    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: SECOND_PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    expect(queued.row?.state).toBe("queued");
    expect(queued.row?.queue_reasons).toEqual(["finding_at_low_certainty"]);
    expect(await listReviewQueue({}, db)).toHaveLength(1);

    // The enqueue is a log line too, and it names the actor even when no person acted.
    expect(db.report_qa_log.map((line) => line.action)).toEqual(["published", "queued"]);
    expect(db.report_qa_log.every((line) => line.operator_identity === "system:publication_gate")).toBe(true);
  });

  it("does not queue the same report twice while it is still waiting", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const first = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    const second = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    expect(second.row?.id).toBe(first.row?.id);
    expect(await listReviewQueue({}, db)).toHaveLength(1);
  });

  it("refuses wording that carries a figure, and accepts prose", () => {
    expect(checkWording({ minimum_wage: "הפער נובע מהפרשי שעות ולא מהתעריף." })).toEqual([]);
    expect(checkWording({ minimum_wage: "מגיע לך בערך 6,000 ₪" })).toEqual([{ topic: "minimum_wage", code: "carries_a_figure" }]);
    expect(checkWording({ minimum_wage: "הסכום הוא 4,200 שקלים" })).toEqual([{ topic: "minimum_wage", code: "carries_a_figure" }]);
    // An ordinary number is not a figure: a year, a section, a small count.
    expect(checkWording({ working_time: "הבדיקה מתייחסת לחודש 2025-07 בלבד, לפי סעיף 5." })).toEqual([]);
    expect(checkWording({ not_a_topic: "משהו" })).toEqual([{ topic: "not_a_topic", code: "unknown_topic" }]);
    expect(checkWording({ pension: "קצר" })).toEqual([{ topic: "pension", code: "too_short" }]);
  });

  it("stores nothing when any sentence is refused", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    const result = await setWording({
      qaId: queued.row!.id,
      operator: OPERATOR,
      wording: { minimum_wage: "ניסוח תקין לחלוטין שאפשר לפרסם", pension: "מגיע לך 9,000 ₪" },
    }, db);
    expect(result.refusals).toEqual([{ topic: "pension", code: "carries_a_figure" }]);
    expect(result.row).toBeNull();
    expect(db.report_qa[0]!.wording).toEqual({});
  });

  it("publishes the engine's projection unchanged, beside the operator's words", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const before = JSON.stringify(S05_LOW_CERTAINTY);
    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    await setWording({ qaId: queued.row!.id, operator: OPERATOR, wording: { minimum_wage: "מה שחסר כאן הוא אישור שלך על מספר השעות." } }, db);
    const published = await decideReview({ qaId: queued.row!.id, state: "published", operator: OPERATOR, reviewSeconds: 240 }, db);

    expect(published?.state).toBe("published");
    expect(published?.operator_identity).toBe(OPERATOR);
    expect(published?.review_seconds).toBe(240);

    const report = publishedReport(published!, S05_LOW_CERTAINTY)!;
    expect(report.wording.minimum_wage).toContain("אישור שלך");
    // The whole guarantee, in one line: the operator's pass moved no number.
    expect(JSON.stringify(report.projection)).toBe(before);
  });

  it("will not decide without an operator", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    await expect(decideReview({ qaId: queued.row!.id, state: "published", operator: " " }, db)).rejects.toThrow("CASE_REPORT_QA_OPERATOR_REQUIRED");
    expect(db.report_qa[0]!.state).toBe("queued");
  });

  it("keeps every step in the log with the identity that took it", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    await setWording({ qaId: queued.row!.id, operator: OPERATOR, wording: { minimum_wage: "ניסוח שעבר בקרה אנושית" } }, db);
    await decideReview({ qaId: queued.row!.id, state: "published", operator: OPERATOR }, db);

    expect(db.report_qa_log.map((line) => line.action)).toEqual(["queued", "wording_edited", "published"]);
    expect(db.report_qa_log.every((line) => line.operator_identity.length > 1)).toBe(true);
  });
});

describe("S6.2 — a parameter changed", () => {
  it("returns published reports that used the parameter to the queue, and leaves the rest alone", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    await decideReview({ qaId: queued.row!.id, state: "published", operator: OPERATOR }, db);

    const used = Object.keys(S05_LOW_CERTAINTY.topics.find((topic) => Object.keys(topic.parameter_grades).length > 0)!.parameter_grades)[0]!;
    expect(reportsTouchedByParameter([{ qaId: queued.row!.id, projection: S05_LOW_CERTAINTY }], used)).toEqual([queued.row!.id]);
    expect(reportsTouchedByParameter([{ qaId: queued.row!.id, projection: S05_LOW_CERTAINTY }], "a_parameter_no_report_used")).toEqual([]);

    expect(await markRecheckRequired({ qaIds: [queued.row!.id], operator: "system:r8_invalidation", reason: `parameter_changed:${used}` }, db)).toBe(1);
    const back = await listReviewQueue({}, db);
    expect(back[0]!.state).toBe("recheck_required");
    expect(back[0]!.queue_reasons).toContain(`parameter_changed:${used}`);
    // The customer's copy is not withdrawn; the record of publication stands.
    expect(back[0]!.published_at).not.toBeNull();
  });

  it("does not reopen a report that was never published", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const queued = await recordPublicationDecision({ caseId: CASE_ID, projectionId: PROJECTION_ID, projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    expect(await markRecheckRequired({ qaIds: [queued.row!.id], operator: "system:r8_invalidation", reason: "parameter_changed:x" }, db)).toBe(0);
    expect(db.report_qa[0]!.state).toBe("queued");
  });

  it("without a store, changes nothing", async () => {
    expect(await markRecheckRequired({ qaIds: ["any"], operator: "op", reason: "r" }, null)).toBe(0);
    expect(await listReviewQueue({}, null)).toEqual([]);
  });
});
