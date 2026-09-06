// Site S3.2 fixtures. The engine writes this table in run 16; until then these
// are the only documents that exist, and they are what every screen and every
// test renders against.
//
// Four of them, and the fourth is the important one:
//
//   S04  a topic that passes both gates at HIGH certainty — a finding with a sum.
//   S05  a topic that passes both gates at LOW certainty — a direction, no number.
//   S06  a topic refused for a missing applicability fact — a question, not a weak answer.
//   ALL  every topic awaiting verification. This is not a placeholder: it is the
//        product's state today (topics 0/7, no parameter active, nothing attested),
//        and it is what a real case would render right now.
import {
  CERTAINTY_SENTENCE,
  displayForCertainty,
  PROJECTION_LEGAL_BASIS,
  PROJECTION_SCHEMA_VERSION,
  PROJECTION_TOPICS,
  parseProjection,
  type CaseReportProjection,
  type ProjectionTopic,
  type TopicProjection,
} from "./case-report-projection.ts";

const GENERATED_AT = "2026-09-06T09:00:00.000Z";
const MONTH = "2026-06";

function awaiting(topic: ProjectionTopic, blocked: Array<"draft" | "owner_recorded" | "derived"> = ["draft"]): TopicProjection {
  return {
    topic,
    gate: "awaiting_verification",
    activation: "awaiting_verification",
    status: "not_checked",
    customer_text: "ממתין לאימות בסיום הפיתוח",
    blocked_by_grades: blocked,
    branches_examined: [],
    parameter_grades: {},
  };
}

/** S04: both gates pass, high certainty — the only shape that may carry a sum. */
export const S04_HIGH_CERTAINTY_FINDING: TopicProjection = {
  topic: "minimum_wage",
  gate: "checked",
  activation: "active",
  applicability: "applicable",
  status: "finding",
  certainty: "high",
  display: displayForCertainty("high"),
  certainty_sentence: CERTAINTY_SENTENCE.high,
  severity_class: "statutory_violation",
  basis_complete: true,
  missing_facts: [],
  assumptions: [],
  retroactive_update: null,
  amount: { currency: "ILS", minor_units: 41_250 },
  range: null,
  direction: "employer_owes",
  branches_examined: ["חלוקת שכר מינימום לשעה — 182"],
  parameter_grades: { "il.minimum_wage.hourly@2026.1.0": "active" },
};

/** S05: both gates pass, low certainty — a direction and no number anywhere (D-6.3). */
export const S05_LOW_CERTAINTY_DIRECTION: TopicProjection = {
  topic: "pension",
  gate: "checked",
  activation: "active",
  applicability: "applicable",
  status: "finding",
  certainty: "low",
  display: displayForCertainty("low"),
  certainty_sentence: CERTAINTY_SENTENCE.low,
  severity_class: "order_entitlement",
  basis_complete: false,
  missing_facts: ["pension_fund_at_hire"],
  assumptions: [],
  retroactive_update: null,
  amount: null,
  range: null,
  direction: "employer_owes",
  branches_examined: ["תקרת השכר — סעיף 2 גמלאות"],
  parameter_grades: { "il.pension.mandatory_wage_cap@2026.2.0": "active" },
};

/** S06: active, but the case never said how many days a week it works — a refusal, so a question. */
export const S06_REFUSED_FOR_APPLICABILITY: TopicProjection = {
  topic: "working_time",
  gate: "refused",
  activation: "active",
  applicability: { refused: "days_per_week" },
  status: "not_checked",
  not_checked: {
    code: "schedule_unknown",
    customer_text: "לא בדקנו את שעות העבודה: צריך לדעת כמה ימים בשבוע אתה עובד ומה אורך יום העבודה הרגיל.",
  },
  missing_facts: ["days_per_week", "regular_day_hours"],
  assumptions: [
    {
      slot: "five_day_even_distribution",
      statement: "החישוב של 8.6 שעות ביום מניח חלוקה שווה של 43 שעות על חמישה ימים; אם סידור העבודה שונה, הסף היומי שונה.",
    },
  ],
  branches_examined: ["הסף היומי — מותנה בסידור העבודה"],
  parameter_grades: { "il.working_time.daily_overtime_threshold_hours@2018.1.0": "derived" },
};

function projection(topics: TopicProjection[], kind: "initial" | "full" = "initial"): CaseReportProjection {
  return parseProjection({
    schema_version: PROJECTION_SCHEMA_VERSION,
    case_public_id: "TV-S3FIXT01",
    check_period_month: MONTH,
    months_covered: [MONTH],
    report_kind: kind,
    legal_basis: PROJECTION_LEGAL_BASIS,
    generated_at: GENERATED_AT,
    topics,
  });
}

/** Every topic awaiting verification — the product's actual state today. */
export const ALL_AWAITING_VERIFICATION: CaseReportProjection = projection(
  PROJECTION_TOPICS.map((topic) => awaiting(topic, topic === "working_time" ? ["derived"] : ["draft"])),
);

/** The three named states, with every other topic in its real state rather than invented. */
export const MIXED_S04_S05_S06: CaseReportProjection = projection(
  PROJECTION_TOPICS.map((topic) => {
    if (topic === "minimum_wage") return S04_HIGH_CERTAINTY_FINDING;
    if (topic === "pension") return S05_LOW_CERTAINTY_DIRECTION;
    if (topic === "working_time") return S06_REFUSED_FOR_APPLICABILITY;
    return awaiting(topic);
  }),
);

/**
 * The three named states as whole reports, each with one topic in the state
 * and the rest awaiting verification. S6.1's gate reads a report rather than a
 * topic, and a fixture that mixed all three at once could not show which
 * condition sent it to the queue.
 */
export const S04_HIGH_CERTAINTY: CaseReportProjection = projection(
  PROJECTION_TOPICS.map((topic) => (topic === "minimum_wage" ? S04_HIGH_CERTAINTY_FINDING : awaiting(topic))),
);
export const S05_LOW_CERTAINTY: CaseReportProjection = projection(
  PROJECTION_TOPICS.map((topic) => (topic === "pension" ? S05_LOW_CERTAINTY_DIRECTION : awaiting(topic))),
);
export const S06_REFUSED: CaseReportProjection = projection(
  PROJECTION_TOPICS.map((topic) => (topic === "working_time" ? S06_REFUSED_FOR_APPLICABILITY : awaiting(topic))),
);

export const PROJECTION_FIXTURES = Object.freeze({
  all_awaiting_verification: ALL_AWAITING_VERIFICATION,
  mixed_s04_s05_s06: MIXED_S04_S05_S06,
  s04_high_certainty: S04_HIGH_CERTAINTY,
  s05_low_certainty: S05_LOW_CERTAINTY,
  s06_refused: S06_REFUSED,
});
