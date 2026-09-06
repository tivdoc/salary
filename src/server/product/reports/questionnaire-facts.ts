// Site S3.1 — what the questionnaire's answers mean to the engine.
//
// Two jobs, and the second is the one that matters:
//
//   1. Name each answer as the fact the engine expects, so a question the
//      customer answered is not asked again as a refusal.
//   2. Mark every one of them `provenance: person`. A person's answer is not a
//      document, so under D-6.1 it caps its topic at MEDIUM certainty — a range,
//      never a sum. Nothing downstream may raise it; the cap travels with the
//      fact rather than being remembered by whoever reads it.
//
// One answer is not a fact at all. §30(א) — a managerial role, or one requiring
// a special measure of personal trust — puts the person outside the Hours of
// Work and Rest Law. That does not lower the working-hours topic's certainty;
// it means the topic does not apply, and the report says so with the reason.
// This module returns that as an EXCLUSION, which S3.3 maps to a "not checked"
// line and no question, because there is nothing to ask.
import type { QuestionnaireInput } from "@/lib/validation";

/** Every fact the questionnaire can produce, in the engine's own vocabulary. */
export type QuestionnaireFact = Readonly<{
  path: string;
  value: string | number | boolean;
  /** Always "person": this came from an answer, not a document. */
  source: "declared";
  read_by: "person";
  /** A person's answer is not verified against a document. */
  verified: false;
  /** D-6.1: a declared fact caps its topic at medium. */
  certainty_ceiling: "medium";
}>;

export type TopicExclusion = Readonly<{
  topic: "working_time";
  refusal_code: "section_30a_excluded";
  reason: string;
}>;

function fact(path: string, value: string | number | boolean): QuestionnaireFact {
  return { path, value, source: "declared", read_by: "person", verified: false, certainty_ceiling: "medium" };
}

/**
 * The facts an answered questionnaire supplies. The paths are the engine's, so
 * a topic that would otherwise refuse for a missing applicability fact finds it
 * here instead of asking the customer a question they already answered.
 */
export function questionnaireFacts(answers: QuestionnaireInput): readonly QuestionnaireFact[] {
  return Object.freeze([
    fact("employment.days_per_week", answers.workDaysPerWeek),
    fact("employment.regular_day_hours", answers.typicalHoursPerDay),
    fact("employment.salary_type", answers.salaryType),
    fact("employment.start_month", answers.employmentStartMonth),
    fact("person.birth_year", answers.birthYear),
    fact("person.sex", answers.sex),
    fact("pension.fund_at_hire", answers.hadPensionFundAtHire),
    fact("travel.employer_provides_transport", answers.employerProvidesTransport),
    fact("travel.commute_over_500m", answers.commuteOver500m),
    fact("employment.still_employed", answers.stillEmployed),
    fact("employment.works_friday", answers.worksFriday),
    fact("employment.works_saturday", answers.worksSaturday),
  ]);
}

/**
 * §30(א). Not a certainty question — an applicability one. The topic is not
 * checked, and the report says why rather than showing an empty result.
 */
export function topicExclusions(answers: QuestionnaireInput): readonly TopicExclusion[] {
  if (!answers.managerialOrTrustRole) return [];
  return Object.freeze([{
    topic: "working_time" as const,
    refusal_code: "section_30a_excluded" as const,
    reason: "לפי סעיף 30(א) לחוק שעות עבודה ומנוחה, החוק אינו חל על תפקיד ניהולי או על תפקיד הדורש מידה מיוחדת של אמון אישי.",
  }]);
}

/**
 * The recognised daily-threshold patterns (errata E3 / Q6). The questionnaire's
 * two answers are the applicability facts the conditional resolution needs; an
 * unrecognised pattern is a REFUSAL that becomes a question, never a default.
 */
export function schedulePattern(answers: QuestionnaireInput): Readonly<{ pattern: "8" | "8.6-7.6" | "9" | null; refusal: string | null }> {
  const days = answers.workDaysPerWeek;
  const hours = answers.typicalHoursPerDay;
  if (days === 6 && Math.abs(hours - 8) < 0.05) return { pattern: "8", refusal: null };
  if (days === 5 && Math.abs(hours - 8.6) < 0.05) return { pattern: "8.6-7.6", refusal: null };
  if (days === 5 && Math.abs(hours - 9) < 0.05) return { pattern: "9", refusal: null };
  return { pattern: null, refusal: "schedule_unknown" };
}
