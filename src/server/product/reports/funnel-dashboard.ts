// Site S6.3 — M01, the measurement board.
//
// D-11.3 is the constraint that gives this module its shape: about sixty events
// are recorded, and the board shows eight numbers. Six conversions (D-11.1) and
// two costs (D-11.2). Everything else is exhaust, and putting it on the board
// would make the eight harder to read rather than the picture fuller.
//
// The rule this file exists to hold: **a number with no data is not zero.**
// "0% of visitors started a check" and "nobody has visited yet" look identical
// on a dashboard and mean opposite things, and the owner reads this board to
// decide whether the product works. So every number carries its numerator, its
// denominator, and an `available` flag that is false when the denominator is
// empty — and a renderer shows "—" rather than a percentage it cannot support.
//
// This module imports nothing from the engine.
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db.ts";

/** D-11.1's six conversions, in the order the funnel walks them. */
export const FUNNEL_STEPS = [
  "landing_to_start",
  "start_to_case",
  "case_to_upload",
  "upload_to_payment",
  "payment_to_finding",
  "finding_to_full_report",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const FUNNEL_STEP_TEXT: Readonly<Record<FunnelStep, string>> = Object.freeze({
  landing_to_start: "כניסה לדף הבית ← התחלת בדיקה",
  start_to_case: "התחלה ← תיק נוצר",
  case_to_upload: "תיק ← תלוש הועלה",
  upload_to_payment: "העלאה ← תשלום אומת",
  payment_to_finding: "תשלום ← נמצאו נקודות (S04)",
  finding_to_full_report: "S04 ← רכישת דוח מלא",
});

/** The event on each side of each conversion, so the query has one source of truth. */
const STEP_EVENTS: Readonly<Record<FunnelStep, Readonly<{ from: string; to: string }>>> = Object.freeze({
  landing_to_start: { from: "landing_view", to: "start_check" },
  start_to_case: { from: "start_check", to: "case_created" },
  case_to_upload: { from: "case_created", to: "document_uploaded" },
  upload_to_payment: { from: "document_uploaded", to: "payment_verified" },
  // The last two are not funnel events: they are report outcomes, and they are
  // counted from the reports themselves below.
  payment_to_finding: { from: "payment_verified", to: "report_with_finding" },
  finding_to_full_report: { from: "report_with_finding", to: "full_report_purchased" },
});

export type Ratio = Readonly<{
  numerator: number;
  denominator: number;
  /** The share, or null when there is nothing to divide by. Never 0 for "no data". */
  rate: number | null;
  available: boolean;
}>;

function ratio(numerator: number, denominator: number): Ratio {
  const available = denominator > 0;
  return Object.freeze({
    numerator,
    denominator,
    rate: available ? numerator / denominator : null,
    available,
  });
}

export type FunnelBoard = Readonly<{
  /** D-11.1: six conversions. */
  steps: Readonly<Record<FunnelStep, Ratio>>;
  /** D-11.2, first: the share of reports that never needed a person. */
  automatic_track: Ratio;
  /** D-11.2, second: human review minutes per reviewed case. Null with no reviewed case. */
  review_minutes_per_case: number | null;
  /** What the board was built from, so a reader can tell an empty product from a broken query. */
  source: Readonly<{ events_counted: number; reports_counted: number; generated_at: string }>;
}>;

export type EventCount = Readonly<{ event_name: string; cases: number }>;

export type ReportCounts = Readonly<{
  /** Reports that reached the publication gate at all. */
  reports: number;
  /** Of those, the ones the gate published without a person (D-11.2). */
  automatic_reports: number;
  reviewed_reports: number;
  review_seconds_total: number;
  cases_reviewed: number;
  /** Paid cases whose report carried at least one finding — D-10.1's S04. */
  cases_with_finding: number;
  /** Of those, the ones that went on to buy the full report. */
  full_reports_purchased: number;
}>;

/**
 * The board, from counts already gathered. Pure, so the arithmetic is testable
 * without a database and the same numbers can be produced from a fixture.
 */
export function buildFunnelBoard(
  events: readonly EventCount[],
  reports: ReportCounts,
  generatedAt: Date = new Date(),
): FunnelBoard {
  const byName = new Map(events.map((entry) => [entry.event_name, entry.cases]));
  const count = (name: string): number => {
    if (name === "report_with_finding") return reports.cases_with_finding;
    if (name === "full_report_purchased") return reports.full_reports_purchased;
    return byName.get(name) ?? 0;
  };

  const steps = Object.fromEntries(
    FUNNEL_STEPS.map((step) => [step, ratio(count(STEP_EVENTS[step].to), count(STEP_EVENTS[step].from))]),
  ) as Record<FunnelStep, Ratio>;

  return Object.freeze({
    steps: Object.freeze(steps),
    automatic_track: ratio(reports.automatic_reports, reports.reports),
    review_minutes_per_case: reports.cases_reviewed > 0
      ? Math.round((reports.review_seconds_total / reports.cases_reviewed / 60) * 10) / 10
      : null,
    source: Object.freeze({
      events_counted: events.reduce((total, entry) => total + entry.cases, 0),
      reports_counted: reports.reports,
      generated_at: generatedAt.toISOString(),
    }),
  });
}

/** The two cost numbers' raw counts, read from the review table (S6.1). */
export async function readReportCounts(
  input: Readonly<{ casesWithFinding?: number; fullReportsPurchased?: number }> = {},
  db?: CaseAccessDb | null,
): Promise<ReportCounts> {
  const empty: ReportCounts = {
    reports: 0, automatic_reports: 0, reviewed_reports: 0, review_seconds_total: 0, cases_reviewed: 0,
    cases_with_finding: input.casesWithFinding ?? 0, full_reports_purchased: input.fullReportsPurchased ?? 0,
  };
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return empty;
  const rows = await store.rpc<Readonly<{
    reports: number | string; automatic_reports: number | string; reviewed_reports: number | string;
    review_seconds_total: number | string; cases_reviewed: number | string;
  }>>("case_report_qa_track_summary", {});
  const row = rows[0];
  if (!row) return empty;
  return Object.freeze({
    reports: Number(row.reports),
    automatic_reports: Number(row.automatic_reports),
    reviewed_reports: Number(row.reviewed_reports),
    review_seconds_total: Number(row.review_seconds_total),
    cases_reviewed: Number(row.cases_reviewed),
    cases_with_finding: input.casesWithFinding ?? 0,
    full_reports_purchased: input.fullReportsPurchased ?? 0,
  });
}

/** Formats a ratio for the board. An unavailable number is a dash, never a zero. */
export function formatRate(value: Ratio): string {
  return value.available && value.rate !== null ? `${Math.round(value.rate * 1000) / 10}%` : "—";
}
