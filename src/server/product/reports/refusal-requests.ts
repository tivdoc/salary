// Site S3.3 — one table: refusal code → what the customer is asked, or why the
// topic says "not checked".
//
// The distinction this table exists to hold. A refusal is not a weak answer and
// not an error; it is the engine saying "I would answer this if someone told me
// X". Three things can follow from one, and exactly one of them follows from
// each code:
//
//   a REQUEST that blocks   the case cannot finish without it. The SLA clock
//                           stops while it is open (D-7.2), the customer is
//                           reminded at 48 hours and 5 days, and it expires at
//                           10 days (D-9).
//   a REQUEST that does not the answer improves with it and stands without it.
//                           No clock stops; no reminder chases the customer.
//   NO REQUEST              nobody can supply what is missing — the rate is not
//                           published yet, or the topic is not verified. Asking
//                           would be a question with no possible answer, so the
//                           report says what happened and stops.
//
// A code that mapped to nothing would leave a topic reading "not checked" with
// no reason, which is the failure this table prevents; the test asserts every
// code the projection can carry is mapped.
import { z } from "zod";

export const REQUEST_ANSWER_KINDS = ["choice", "number", "text", "document", "none"] as const;
export type RequestAnswerKind = (typeof REQUEST_ANSWER_KINDS)[number];

export type RefusalMapping = Readonly<{
  /** The refusal code, as the engine emits it. A `:` suffix carries the field it is about. */
  code: string;
  /** What follows: a thread request, or a line of text and nothing else. */
  outcome: "request" | "not_checked_only";
  /** Blocking requests stop the SLA clock. Only a request can block. */
  blocking: boolean;
  /** The question, in the customer's words. Null when nothing is asked. */
  question: string | null;
  answer_kind: RequestAnswerKind;
  /** For a choice, the options the customer picks from. */
  options?: readonly string[];
  /** Shown beside the question: the part of the payslip the answer is about. */
  field_crop: string | null;
  /** What the report says for this topic while the refusal stands. */
  not_checked_text: string;
}>;

/** D-9 and D-7.2, in one place so no screen invents its own timing. */
export const REQUEST_TIMING = Object.freeze({
  reminder_hours: [48, 120] as const,
  expiry_days: 10,
  /** A blocking request stops the clock; a non-blocking one never does. */
  blocking_pauses_sla: true,
});

export const REFUSAL_MAPPINGS: readonly RefusalMapping[] = Object.freeze([
  {
    code: "schedule_unknown",
    outcome: "request",
    blocking: true,
    question: "כמה ימים בשבוע אתה עובד?",
    answer_kind: "choice",
    options: ["5", "6"],
    field_crop: null,
    not_checked_text: "לא בדקנו את שעות העבודה: צריך לדעת כמה ימים בשבוע אתה עובד ומה אורך יום העבודה הרגיל.",
  },
  {
    code: "regular_day_hours_unknown",
    outcome: "request",
    blocking: true,
    question: "כמה שעות נמשך יום העבודה הרגיל שלך?",
    answer_kind: "number",
    field_crop: null,
    not_checked_text: "לא בדקנו את שעות העבודה: אורך יום העבודה הרגיל קובע את הסף שממנו מתחילות שעות נוספות.",
  },
  {
    code: "low_confidence:hours_regular",
    outcome: "request",
    blocking: false,
    question: "כמה שעות רגילות מופיעות בתלוש?",
    answer_kind: "number",
    field_crop: "hours_regular",
    not_checked_text: "קראנו את מספר השעות בתלוש בביטחון נמוך; אישור שלך יעלה את הוודאות.",
  },
  {
    code: "low_confidence:base_wage",
    outcome: "request",
    blocking: false,
    question: "מה שכר הבסיס שמופיע בתלוש?",
    answer_kind: "number",
    field_crop: "base_wage",
    not_checked_text: "קראנו את שכר הבסיס בביטחון נמוך; אישור שלך יעלה את הוודאות.",
  },
  {
    code: "fact.missing",
    outcome: "request",
    blocking: true,
    question: "חסר לנו נתון כדי לבדוק את הנושא הזה. אפשר להשלים?",
    answer_kind: "text",
    field_crop: null,
    not_checked_text: "לא בדקנו: חסר נתון נדרש.",
  },
  {
    code: "fact.conflicted",
    outcome: "request",
    blocking: true,
    question: "שני מקורות אומרים דברים שונים. מה נכון?",
    answer_kind: "text",
    field_crop: null,
    not_checked_text: "לא בדקנו: שני מקורות סותרים זה את זה, ואי אפשר להכריע ביניהם בלעדיך.",
  },
  {
    code: "document_unreadable",
    outcome: "request",
    blocking: true,
    question: "התלוש לא נקרא. אפשר לצרף צילום ברור יותר?",
    answer_kind: "document",
    field_crop: null,
    not_checked_text: "לא בדקנו: לא הצלחנו לקרוא את המסמך.",
  },
  {
    // Nobody can answer this: the rate does not exist yet. Asking would be cruel and useless.
    code: "rate_not_published",
    outcome: "not_checked_only",
    blocking: false,
    question: null,
    answer_kind: "none",
    field_crop: null,
    not_checked_text: "לא נבדק: התעריף לתקופה זו טרם פורסם ברשומות.",
  },
  {
    // §30(א): the law itself excludes the topic for this role. Not a gap, not a question.
    code: "section_30a_excluded",
    outcome: "not_checked_only",
    blocking: false,
    question: null,
    answer_kind: "none",
    field_crop: null,
    not_checked_text: "לא נבדק: לפי סעיף 30(א) לחוק שעות עבודה ומנוחה, חוק שעות העבודה אינו חל על תפקיד ניהולי או תפקיד הדורש מידה מיוחדת של אמון אישי.",
  },
  {
    // Gate 1. There is no question to ask — the work is ours, not the customer's.
    code: "awaiting_verification",
    outcome: "not_checked_only",
    blocking: false,
    question: null,
    answer_kind: "none",
    field_crop: null,
    not_checked_text: "ממתין לאימות בסיום הפיתוח",
  },
]);

const mappingByCode = new Map(REFUSAL_MAPPINGS.map((entry) => [entry.code, entry]));

/**
 * The mapping for a refusal code. A code carrying a field (`low_confidence:x`)
 * falls back to its family when the exact field is not mapped, so a new field
 * degrades to a general question instead of vanishing.
 */
export function mappingFor(code: string): RefusalMapping | null {
  const exact = mappingByCode.get(code);
  if (exact) return exact;
  const family = code.includes(":") ? code.slice(0, code.indexOf(":")) : null;
  if (family === null) return null;
  return [...mappingByCode.values()].find((entry) => entry.code.startsWith(`${family}:`)) ?? null;
}

export const threadRequestSchema = z.object({
  case_id: z.string().uuid(),
  code: z.string().min(3).max(120),
  question: z.string().min(4).max(400),
  answer_kind: z.enum(REQUEST_ANSWER_KINDS),
  options: z.array(z.string().min(1).max(60)).max(10).optional(),
  field_crop: z.string().min(2).max(60).nullable(),
  blocking: z.boolean(),
  opened_at: z.string().datetime(),
  /** D-9: ten days from opening. */
  expires_at: z.string().datetime(),
  answered_at: z.string().datetime().nullable(),
}).strict();

export type ThreadRequest = z.infer<typeof threadRequestSchema>;

/** Builds the request a refusal opens, or null when the code asks nothing. */
export function requestFor(code: string, input: Readonly<{ caseId: string; now: Date }>): ThreadRequest | null {
  const mapping = mappingFor(code);
  if (!mapping || mapping.outcome !== "request" || mapping.question === null) return null;
  const expires = new Date(input.now.getTime() + REQUEST_TIMING.expiry_days * 24 * 3_600 * 1_000);
  return threadRequestSchema.parse({
    case_id: input.caseId,
    code: mapping.code,
    question: mapping.question,
    answer_kind: mapping.answer_kind,
    ...(mapping.options ? { options: [...mapping.options] } : {}),
    field_crop: mapping.field_crop,
    blocking: mapping.blocking,
    opened_at: input.now.toISOString(),
    expires_at: expires.toISOString(),
    answered_at: null,
  });
}

/** When the reminders for an open request fall due (D-9). */
export function reminderTimes(openedAt: Date): Date[] {
  return REQUEST_TIMING.reminder_hours.map((hours) => new Date(openedAt.getTime() + hours * 3_600 * 1_000));
}

/** The SLA clock runs unless a blocking request is open (D-7.2). */
export function slaPaused(requests: readonly ThreadRequest[]): boolean {
  return requests.some((request) => request.blocking && request.answered_at === null);
}
