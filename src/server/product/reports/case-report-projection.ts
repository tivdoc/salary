// Site S3.2 — `case_report_projection` v1: the one contract between the legal
// engine and the product.
//
// The product COMPUTES NOTHING. It renders this document and nothing else. No
// screen adds a figure, downgrades a certainty, or decides that a topic was
// checked; every one of those decisions is made where the evidence lives and
// arrives here already made. The engine gains write access to the table in run
// 16; until then the only rows are fixtures.
//
// ---------------------------------------------------------------------------
// The three gates, in order (external review #1 §ב, replacing D-6.4)
// ---------------------------------------------------------------------------
//
// D-6.4 mixed two different questions into one word. It let a "medium
// certainty" label make a draft parameter look usable, and it made a missing
// applicability fact look like a weak answer instead of a question nobody
// asked. The three gates separate them, and they are asked IN ORDER:
//
//   1. ACTIVATION — may this topic produce a customer-facing answer at all?
//      Only when its RuleSpec and every parameter it uses are ACTIVE (two
//      attestations plus owner activation). `draft`, `owner_recorded` and
//      `derived` are not active. A topic that fails this gate renders as
//      "ממתין לאימות בסיום הפיתוח" and carries no direction, no range and no
//      amount — not a small number, not a hedged one, none.
//
//   2. APPLICABILITY — does this rule apply to THIS case? Every rule declares
//      the facts it needs to know that (days per week, the regular day's
//      length, §30(א) status, sector). A missing applicability fact is a
//      REFUSAL that becomes a question, never a lower certainty. The
//      assumption slot of a derived parameter is an applicability fact: an
//      assumption is something the case has to confirm, not a discount applied
//      to a number.
//
//   3. CERTAINTY — only for a topic that is active AND applicable, exactly as
//      D-6.1–6.3 define it, and `display` follows mechanically from it.
//
// This file makes the order structural rather than advisory: the topic shape
// is a discriminated union, so a projection that carries a certainty for an
// unverified topic, or an amount at low certainty, cannot be constructed — the
// schema rejects it before any screen sees it.
//
// Today every topic is `awaiting_verification`: topics 0/7, no parameter is
// active, nothing is attested. The "all awaiting" fixture is not a placeholder;
// it is the current state of the product.
import { z } from "zod";

/** The product's own topic vocabulary. Deliberately declared here, not imported: the
 *  product half imports nothing from the engine. The test beside this file asserts the
 *  two lists are identical, so a drift in either direction fails rather than diverges. */
export const PROJECTION_TOPICS = [
  "minimum_wage",
  "working_time",
  "pension",
  "travel",
  "convalescence",
  "vacation",
  "sick_leave",
] as const;
export type ProjectionTopic = (typeof PROJECTION_TOPICS)[number];

export const PROJECTION_SCHEMA_VERSION = "tivdoc-case-report-projection-v1" as const;
/** Errata #1 is owner-closed; every report and package says so (long run 10). */
export const PROJECTION_LEGAL_BASIS = "opinion_3ddad7e8 + errata_1_owner_closed" as const;

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const moneySchema = z.object({ currency: z.literal("ILS"), minor_units: z.number().int() }).strict();

/** The grades a parameter can carry. A topic is active only when every one of its parameters is `active`. */
export const PARAMETER_GRADES = ["active", "text_verified", "lexicon", "selection", "derived", "inferred_visual", "administrative", "agreement_interpretation", "draft", "owner_recorded"] as const;

/** Why a topic could not be checked, in the customer's words. Mapped from a refusal code by S3.3. */
const notCheckedSchema = z.object({
  code: z.string().min(3).max(120),
  customer_text: z.string().min(4).max(400),
}).strict();

const assumptionSchema = z.object({
  slot: z.string().min(3).max(80),
  /** One sentence the customer reads. An assumption is stated, never hidden inside a figure. */
  statement: z.string().min(8).max(400),
}).strict();

const retroactiveSchema = z.object({
  /** When the change became known, not when the period began. */
  known_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  source: z.string().min(3).max(200),
}).strict();

const commonTopicFields = {
  topic: z.enum(PROJECTION_TOPICS),
  /** The decisions that were exercised, in their short Hebrew names, so the reader sees what was weighed. */
  branches_examined: z.array(z.string().min(1).max(80)).max(20),
  /** Every parameter this topic would use, with the grade it carries. */
  parameter_grades: z.record(z.string(), z.enum(PARAMETER_GRADES)),
};

// --- gate 1 fails: not active ------------------------------------------------

/**
 * A topic whose rule or parameters are not active. It carries NO certainty, NO
 * display, NO amount and NO direction — the fields do not exist on this shape,
 * so no screen can read one by accident.
 */
export const awaitingVerificationTopicSchema = z.object({
  ...commonTopicFields,
  gate: z.literal("awaiting_verification"),
  activation: z.literal("awaiting_verification"),
  status: z.literal("not_checked"),
  /** The one sentence the customer sees for this topic. Fixed wording; the review chose it. */
  customer_text: z.literal("ממתין לאימות בסיום הפיתוח"),
  /** Which grades held it back, so an operator can see what activation is waiting on. */
  blocked_by_grades: z.array(z.enum(PARAMETER_GRADES)).min(1),
}).strict();

// --- gate 2 fails: active, but the case has not said whether it applies -------

/**
 * A topic that could be answered, if the case answered a question first. This
 * is a REFUSAL, and S3.3 turns it into a request — it is never a certainty.
 */
export const refusedTopicSchema = z.object({
  ...commonTopicFields,
  gate: z.literal("refused"),
  activation: z.literal("active"),
  /** The applicability fact that is missing. The request asks for exactly this. */
  applicability: z.object({ refused: z.string().min(3).max(80) }).strict(),
  status: z.literal("not_checked"),
  not_checked: notCheckedSchema,
  /** Everything the topic still needs. The first is the one the request asks for. */
  missing_facts: z.array(z.string().min(2).max(80)).min(1),
  /** An unconfirmed assumption is a missing applicability fact, not a discount on a number. */
  assumptions: z.array(assumptionSchema).max(10),
}).strict();

// --- both gates pass: certainty applies --------------------------------------

const certaintySchema = z.enum(["high", "medium", "low"]);
const displaySchema = z.enum(["amount", "range", "direction"]);

export const checkedTopicSchema = z.object({
  ...commonTopicFields,
  gate: z.literal("checked"),
  activation: z.literal("active"),
  applicability: z.literal("applicable"),
  status: z.enum(["finding", "no_gap"]),
  certainty: certaintySchema,
  /** Derived mechanically from certainty (D-6.3). Never chosen. */
  display: displaySchema,
  /** D-6.2's fixed sentence for this level. */
  certainty_sentence: z.string().min(8).max(300),
  severity_class: z.enum(["statutory_violation", "order_entitlement"]).nullable(),
  basis_complete: z.boolean(),
  missing_facts: z.array(z.string().min(2).max(80)),
  assumptions: z.array(assumptionSchema).max(10),
  retroactive_update: retroactiveSchema.nullable(),
  /** Present only when `display` is "amount". */
  amount: moneySchema.nullable(),
  /** Present only when `display` is "amount" or "range". */
  range: z.object({ low: moneySchema, high: moneySchema }).strict().nullable(),
  /** Always present for a finding: which way the gap runs. */
  direction: z.enum(["employer_owes", "employee_owes", "none"]),
}).strict().superRefine((topic, context) => {
  // D-6.3, mechanically. This is the rule the whole contract exists to hold.
  if (topic.display !== displayForCertainty(topic.certainty)) {
    context.addIssue({ code: "custom", message: `display_must_follow_certainty:${topic.certainty}` });
  }
  if (topic.display !== "amount" && topic.amount !== null) {
    context.addIssue({ code: "custom", message: "amount_only_at_amount_display" });
  }
  if (topic.display === "direction" && topic.range !== null) {
    context.addIssue({ code: "custom", message: "no_range_at_low_certainty" });
  }
  if (topic.status === "no_gap" && topic.direction !== "none") {
    context.addIssue({ code: "custom", message: "no_gap_has_no_direction" });
  }
  if (topic.status === "finding" && topic.severity_class === null) {
    context.addIssue({ code: "custom", message: "a_finding_carries_a_severity_class" });
  }
});

/** D-6.3: high shows a sum, medium a range, low a direction and no number at all. */
export function displayForCertainty(certainty: z.infer<typeof certaintySchema>): z.infer<typeof displaySchema> {
  return certainty === "high" ? "amount" : certainty === "medium" ? "range" : "direction";
}

/** D-6.2's fixed sentences, verbatim. The renderer never writes its own. */
export const CERTAINTY_SENTENCE: Readonly<Record<"high" | "medium" | "low", string>> = Object.freeze({
  high: "הנתון נשען על המסמכים",
  medium: "הנתון תלוי במה שמסרת",
  low: "אי אפשר לקבוע סכום, וזה מה שיעלה את הוודאות",
});

/** The customer-facing name of each severity class (S3.4's render rule). */
export const SEVERITY_TEXT: Readonly<Record<"statutory_violation" | "order_entitlement", string>> = Object.freeze({
  statutory_violation: "מתחת לרצפת החוק",
  order_entitlement: "מתחת לרצפת צו ההרחבה — זכות הניתנת לתביעה",
});

export const topicProjectionSchema = z.discriminatedUnion("gate", [
  awaitingVerificationTopicSchema,
  refusedTopicSchema,
  checkedTopicSchema,
]);

export const caseReportProjectionSchema = z.object({
  schema_version: z.literal(PROJECTION_SCHEMA_VERSION),
  case_public_id: z.string().regex(/^TV-[A-Z0-9]{8}$/u),
  /** The single month the initial check ran on (D-4.1). The full report covers `months_covered`. */
  check_period_month: monthSchema,
  months_covered: z.array(monthSchema).min(1),
  report_kind: z.enum(["initial", "full"]),
  legal_basis: z.literal(PROJECTION_LEGAL_BASIS),
  generated_at: z.string().datetime(),
  /** Exactly the seven topics, once each: a report that silently omits a topic tells the reader nothing about it. */
  topics: z.array(topicProjectionSchema).length(PROJECTION_TOPICS.length),
}).strict().superRefine((projection, context) => {
  const seen = projection.topics.map((topic) => topic.topic);
  if (new Set(seen).size !== seen.length) context.addIssue({ code: "custom", message: "a_topic_appears_twice" });
  for (const topic of PROJECTION_TOPICS) {
    if (!seen.includes(topic)) context.addIssue({ code: "custom", message: `topic_missing:${topic}` });
  }
  if (!projection.months_covered.includes(projection.check_period_month)) {
    context.addIssue({ code: "custom", message: "check_month_outside_coverage" });
  }
  if (projection.report_kind === "initial" && projection.months_covered.length !== 1) {
    context.addIssue({ code: "custom", message: "an_initial_check_is_one_month" });
  }
});

export type TopicProjection = z.infer<typeof topicProjectionSchema>;
export type CaseReportProjection = z.infer<typeof caseReportProjectionSchema>;
export type CheckedTopic = z.infer<typeof checkedTopicSchema>;

/** Parses and validates. The product never renders a document that did not pass through here. */
export function parseProjection(value: unknown): CaseReportProjection {
  return caseReportProjectionSchema.parse(value);
}

/**
 * What a screen may show for one topic, decided once so no component decides it
 * again. `showsNumber` is the single question every renderer asks before
 * printing a figure — and it is false for every gate but a passing one.
 */
export function renderPermission(topic: TopicProjection): Readonly<{
  showsNumber: boolean;
  showsDirection: boolean;
  line: string;
}> {
  if (topic.gate === "awaiting_verification") {
    return { showsNumber: false, showsDirection: false, line: topic.customer_text };
  }
  if (topic.gate === "refused") {
    return { showsNumber: false, showsDirection: false, line: topic.not_checked.customer_text };
  }
  return {
    showsNumber: topic.display !== "direction",
    showsDirection: true,
    line: topic.certainty_sentence,
  };
}
