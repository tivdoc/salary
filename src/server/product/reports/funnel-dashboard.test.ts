// Site S6.3 acceptance. The board's job is to be readable by someone deciding
// whether to keep building this product, which makes its most important
// property a negative one: it must never show a number it cannot support.
import { describe, expect, it } from "vitest";
import { fakeCaseAccessDb, type FakeCase } from "../case-access/fake-db.ts";
import { S04_HIGH_CERTAINTY, S05_LOW_CERTAINTY } from "./case-report-projection.fixtures.ts";
import {
  buildFunnelBoard,
  formatRate,
  FUNNEL_STEPS,
  FUNNEL_STEP_TEXT,
  readReportCounts,
  type EventCount,
  type ReportCounts,
} from "./funnel-dashboard.ts";
import { decideReview, recordPublicationDecision } from "./report-qa.ts";

const NO_REPORTS: ReportCounts = {
  reports: 0, automatic_reports: 0, reviewed_reports: 0, review_seconds_total: 0,
  cases_reviewed: 0, cases_with_finding: 0, full_reports_purchased: 0,
};

const CASE: FakeCase = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", public_id: "TV-S63TEST", email: "m01@example.com", phone: null,
  first_name: null, status: "under_review", payment_status: "verified", created_at: "2026-09-06T09:00:00.000Z", payment_verified: true,
};

describe("M01 — the eight numbers", () => {
  it("shows exactly D-11's six conversions and two costs, each with a label", () => {
    expect(FUNNEL_STEPS).toHaveLength(6);
    for (const step of FUNNEL_STEPS) expect(FUNNEL_STEP_TEXT[step].length).toBeGreaterThan(8);
    const board = buildFunnelBoard([], NO_REPORTS);
    expect(Object.keys(board.steps)).toEqual([...FUNNEL_STEPS]);
    expect(board).toHaveProperty("automatic_track");
    expect(board).toHaveProperty("review_minutes_per_case");
  });

  it("says nothing rather than zero when nothing has happened", () => {
    const board = buildFunnelBoard([], NO_REPORTS);
    for (const step of FUNNEL_STEPS) {
      expect(board.steps[step]).toMatchObject({ available: false, rate: null });
      expect(formatRate(board.steps[step])).toBe("—");
    }
    expect(board.automatic_track.rate).toBeNull();
    expect(board.review_minutes_per_case).toBeNull();
    expect(board.source.reports_counted).toBe(0);
  });

  it("distinguishes a real zero from an absent one", () => {
    // A hundred people landed and none started: that IS 0%, and it must say so.
    const board = buildFunnelBoard([{ event_name: "landing_view", cases: 100 }], NO_REPORTS);
    expect(board.steps.landing_to_start).toMatchObject({ numerator: 0, denominator: 100, rate: 0, available: true });
    expect(formatRate(board.steps.landing_to_start)).toBe("0%");
    // While the step after it has no denominator at all.
    expect(formatRate(board.steps.start_to_case)).toBe("—");
  });

  it("counts the four funnel conversions from the events, in order", () => {
    const events: readonly EventCount[] = [
      { event_name: "landing_view", cases: 400 },
      { event_name: "start_check", cases: 200 },
      { event_name: "case_created", cases: 100 },
      { event_name: "document_uploaded", cases: 50 },
      { event_name: "payment_verified", cases: 25 },
    ];
    const board = buildFunnelBoard(events, { ...NO_REPORTS, cases_with_finding: 15, full_reports_purchased: 3 });
    expect(formatRate(board.steps.landing_to_start)).toBe("50%");
    expect(formatRate(board.steps.start_to_case)).toBe("50%");
    expect(formatRate(board.steps.case_to_upload)).toBe("50%");
    expect(formatRate(board.steps.upload_to_payment)).toBe("50%");
    expect(formatRate(board.steps.payment_to_finding)).toBe("60%");
    expect(formatRate(board.steps.finding_to_full_report)).toBe("20%");
  });

  it("computes the two cost numbers from the reports, not from the events", () => {
    const board = buildFunnelBoard([], {
      ...NO_REPORTS,
      reports: 10, automatic_reports: 7, reviewed_reports: 3,
      review_seconds_total: 1_620, cases_reviewed: 3,
    });
    expect(formatRate(board.automatic_track)).toBe("70%");
    expect(board.review_minutes_per_case).toBe(9);
  });

  it("reads the report counts from the review table itself", async () => {
    const db = fakeCaseAccessDb([CASE]);
    // One report the gate published on its own, one a person reviewed.
    await recordPublicationDecision({ caseId: CASE.id, projectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", projection: S04_HIGH_CERTAINTY, documentTrack: "automatic" }, db);
    const queued = await recordPublicationDecision({ caseId: CASE.id, projectionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", projection: S05_LOW_CERTAINTY, documentTrack: "automatic" }, db);
    await decideReview({ qaId: queued.row!.id, state: "published", operator: "operator:qa@tivdoc.example", reviewSeconds: 300 }, db);

    const counts = await readReportCounts({ casesWithFinding: 1, fullReportsPurchased: 0 }, db);
    expect(counts).toMatchObject({ reports: 2, automatic_reports: 1, reviewed_reports: 1, review_seconds_total: 300, cases_reviewed: 1 });

    const board = buildFunnelBoard([], counts);
    expect(formatRate(board.automatic_track)).toBe("50%");
    expect(board.review_minutes_per_case).toBe(5);
  });

  it("without a store, reports nothing rather than an empty product", async () => {
    const counts = await readReportCounts({}, null);
    expect(counts.reports).toBe(0);
    expect(buildFunnelBoard([], counts).automatic_track.available).toBe(false);
  });
});
