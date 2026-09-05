// L11-3 / D3.2 (run 11). Gap severity classes.
//
// Two of the open decisions separate a STATUTORY figure from an
// EXTENSION-ORDER figure for the same quantity: the hourly minimum wage
// (monthly ÷ 186 in the Minimum Wage Law, ÷ 182 under the 2018 42-hour order
// and the 10.6.2018 directive) and the daily overtime threshold (8 hours in
// §2(א) of the 1951 law, 8.6 on a five-day week under the steering
// committee's reading of the 42-hour order). The lawyer-approved opinion asks
// that a gap be CLASSED by which figures it exists under, and that the class
// be a field on the finding — never a reason to drop it:
//
//   statutory_violation   the payment is below the entitlement under BOTH
//                         figures (below the statute, whichever reading applies)
//   order_entitlement     the payment lies between the two entitlements — the
//                         gap exists under one reading only, the one the
//                         extension-order figure separates from the statute
//                         (claimable; not administratively enforced)
//   no_gap                the payment meets the entitlement under both
//   order_figure_unbound  the order figure's branch is not bound, so only the
//                         statutory comparison can be stated
//   not_comparable        a branch did not run or has no money output
//
// A shadow delta is entitlement − paid, so the class follows from the sign of
// the two deltas and nothing else; no figure is retyped here. The weekly
// dimension (45 statutory, 42 in the 2018 order) is named as not computed:
// no executable spec derives weekly overtime from weekly hours yet.
export const GAP_SEVERITY_CLASSES = ["statutory_violation", "order_entitlement", "no_gap", "order_figure_unbound", "not_comparable"] as const;
export type GapSeverityClass = (typeof GAP_SEVERITY_CLASSES)[number];

export type GapSeverityDecision = Readonly<{
  decision_id: string;
  dimension: string;
  statutory_branch: string;
  order_branch: string;
  statutory_figure: string;
  order_figure: string;
  /** L12-2 / D2: what the class means in the DEFAULT view, in one Hebrew sentence. */
  default_view_note_he: string;
}>;

const DECISION = "legal.reference.il.decision";

export const GAP_SEVERITY_DECISIONS: readonly GapSeverityDecision[] = Object.freeze([
  {
    decision_id: `${DECISION}.min_wage_hourly_divisor`,
    dimension: "hourly minimum wage",
    statutory_branch: "186",
    order_branch: "182",
    statutory_figure: "the monthly minimum wage ÷ 186 (Minimum Wage Law §6)",
    order_figure: "the monthly minimum wage ÷ 182 (2018 42-hour extension order; Labour Ministry directive of 10.6.2018)",
    default_view_note_he: "בתצוגת ברירת המחדל (182) תשלום בין 34.64 ל־35.40 לשעה הוא פער מסוג זכות מכוח צו הרחבה; מתחת ל־34.64 — הפרה סטטוטורית.",
  },
  {
    decision_id: `${DECISION}.working_time_daily_threshold`,
    dimension: "daily overtime threshold",
    statutory_branch: "statute",
    order_branch: "administrative",
    statutory_figure: "8 hours a day (§2(א), Hours of Work and Rest Law 1951)",
    order_figure: "8.6 hours a day on the regular day of a five-day week, 7.6 on its shortened day — derived (43 ÷ 5; 4 × 8.6 + 7.6 = 42) from the 2018 order under the assumption five_day_even_distribution, grade derived, bound since L12-1",
    default_view_note_he: "בתצוגת ברירת המחדל (8.6 / 7.6) שעה בין 8.0 ל־8.6 ביום רגיל בשבוע של חמישה ימים אינה פער; לפי ענף החוק (8) היא זכות מכוח צו הרחבה — לא הפרה סטטוטורית.",
  },
]);

export const GAP_SEVERITY_DIMENSIONS_NOT_COMPUTED = Object.freeze([
  {
    dimension: "weekly overtime threshold",
    statutory_figure: "45 hours a week (Hours of Work and Rest Law 1951)",
    order_figure: "42 hours a week (2018 42-hour extension order; il.working_time.weekly_overtime_threshold_hours@2018.1.0, registered and bound in the working-time draft)",
    reason: "no executable spec derives weekly overtime from weekly hours; the 42-hour parameter is registered and the class is defined, the computation is not yet run",
  },
]);

/** The one sentence the Hebrew rendering carries under each classed decision. */
export const GAP_SEVERITY_SENTENCE_HE =
  "סיווג חומרת הפער: **הפרה סטטוטורית** — התשלום נמוך מהזכאות גם לפי הסכום שבחוק וגם לפי הסכום שבצו ההרחבה; **זכות מכוח צו הרחבה** — הפער קיים רק בין הסכום שבחוק לסכום שבצו ההרחבה (ניתנת לתביעה, אינה נאכפת מנהלית). הסיווג הוא שדה על הממצא ואינו מסתיר ממצא.";

export type GapSeverity = Readonly<{
  class: GapSeverityClass;
  /** Under which readings the payment falls short: "statute", "order", both, or none. */
  gap_under: readonly ("statute" | "order")[];
  statutory_delta: string | null;
  order_delta: string | null;
  /** L12-2 / D2: the default view — which branch is the default and whether the month is short under it. */
  default_branch?: string | null;
  gap_under_default?: boolean | null;
}>;

export function gapSeverityDecision(decisionId: string): GapSeverityDecision | null {
  return GAP_SEVERITY_DECISIONS.find((entry) => entry.decision_id === decisionId) ?? null;
}

/**
 * The class from the two deltas. A delta is entitlement − paid as a decimal
 * string of minor units; positive means the month paid less than the reading
 * computes. Both deltas known: below both → statutory_violation; below one →
 * order_entitlement; below neither → no_gap. Order figure unbound: only the
 * statutory side can be stated.
 */
export function classifyGapFromDeltas(input: Readonly<{ statutory_delta: string | null; order_delta: string | null; order_bound: boolean }>): GapSeverity {
  const short = (delta: string | null) => (delta === null ? null : BigInt(delta) > BigInt(0));
  const statute = short(input.statutory_delta);
  if (!input.order_bound) {
    return Object.freeze({
      class: "order_figure_unbound" as const,
      gap_under: statute ? (["statute"] as const) : ([] as const),
      statutory_delta: input.statutory_delta,
      order_delta: null,
    });
  }
  const order = short(input.order_delta);
  if (statute === null || order === null) {
    return Object.freeze({ class: "not_comparable" as const, gap_under: [] as const, statutory_delta: input.statutory_delta, order_delta: input.order_delta });
  }
  const under = [...(statute ? ["statute" as const] : []), ...(order ? ["order" as const] : [])];
  const klass: GapSeverityClass = statute && order ? "statutory_violation" : under.length === 1 ? "order_entitlement" : "no_gap";
  return Object.freeze({ class: klass, gap_under: Object.freeze(under), statutory_delta: input.statutory_delta, order_delta: input.order_delta });
}
