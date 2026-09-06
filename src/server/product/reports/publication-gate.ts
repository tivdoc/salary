// Site S6.1 — D-10.2 and D-10.3: which reports a person has to read before a
// customer does.
//
// The gate is deliberately a *positive* list. An initial report publishes
// itself only when all four of D-10.2's conditions hold; anything else goes to
// the queue. Written the other way round — a list of things that block — a
// condition nobody thought of would default to publishing, and the whole point
// of the gate is that the default is a human.
//
// D-10.2, verbatim in its four parts:
//   the document is on the automatic track,
//   every finding is at high or medium certainty,
//   there are no contradiction markers,
//   and no finding exceeds 5,000 ₪.
//
// D-10.3 sits above all of it: a full report is always human. That is what the
// full report's price pays for, so no combination of clean inputs may skip it.
//
// This module decides and explains; it stores nothing and sends nothing.
import type { CaseReportProjection, TopicProjection } from "./case-report-projection.ts";

/** How the case's documents were read. The automatic track is D-8.3's cost number. */
export const DOCUMENT_TRACKS = ["automatic", "human"] as const;
export type DocumentTrack = (typeof DOCUMENT_TRACKS)[number];

/** D-10.2's ceiling: 5,000 ₪, in the minor units the projection carries. */
export const AUTOMATIC_FINDING_CEILING_MINOR_UNITS = 500_000;

export const QUEUE_REASONS = [
  /** D-10.3: a full report is always read by a person. */
  "full_report",
  /** D-10.2: the documents did not come through the automatic track. */
  "document_not_automatic_track",
  /** D-10.2: a finding stands at low certainty. */
  "finding_at_low_certainty",
  /** D-10.2: two sources disagree and the disagreement is unresolved. */
  "contradiction_marked",
  /** D-10.2: a finding is larger than the ceiling a machine may publish alone. */
  "finding_over_ceiling",
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

export const QUEUE_REASON_TEXT: Readonly<Record<QueueReason, string>> = Object.freeze({
  full_report: "דוח מלא — תמיד בבקרה אנושית (D-10.3).",
  document_not_automatic_track: "המסמך לא עבר במסלול האוטומטי.",
  finding_at_low_certainty: "יש ממצא ברמת ודאות נמוכה.",
  contradiction_marked: "יש סימון סתירה בין מקורות.",
  // Derived from the ceiling above rather than retyped: the sentence an
  // operator reads and the rule the gate applies move together.
  finding_over_ceiling: `יש ממצא מעל ${(AUTOMATIC_FINDING_CEILING_MINOR_UNITS / 100).toLocaleString("he-IL")} ₪.`,
});

/**
 * The codes that mean two sources disagree. `fact.conflicted` is the engine's
 * own; the prefix catches the field-carrying forms (`conflict:hours_regular`)
 * without this file having to enumerate fields it does not own.
 */
function marksContradiction(value: string): boolean {
  return value === "fact.conflicted" || value.startsWith("conflict:") || value.startsWith("fact.conflicted:");
}

function topicMarksContradiction(topic: TopicProjection): boolean {
  if (topic.gate === "refused") {
    if (marksContradiction(topic.not_checked.code)) return true;
    return topic.missing_facts.some(marksContradiction);
  }
  if (topic.gate === "checked") return topic.missing_facts.some(marksContradiction);
  return false;
}

/** The largest figure a topic actually claims, in minor units — the top of a range counts. */
export function topicCeilingMinorUnits(topic: TopicProjection): number {
  if (topic.gate !== "checked" || topic.status !== "finding") return 0;
  const amount = topic.amount?.minor_units ?? 0;
  const high = topic.range?.high.minor_units ?? 0;
  return Math.max(Math.abs(amount), Math.abs(high));
}

export type PublicationDecision = Readonly<{
  /** True only when D-10.3 does not apply and all four D-10.2 conditions hold. */
  automatic: boolean;
  /** Empty exactly when `automatic` is true; in QUEUE_REASONS order, deduplicated. */
  reasons: readonly QueueReason[];
  /** For M01 (S6.3): which track this case's documents came through. */
  document_track: DocumentTrack;
}>;

/**
 * D-10.2 and D-10.3, applied to one report.
 *
 * A topic that was never checked — awaiting verification, or refused for a
 * missing fact — is not a reason on its own. It carries no finding, no number
 * and no certainty, so there is nothing for a reviewer to disagree with; what
 * the report says about it is a sentence this contract already fixed. The
 * refusal that WOULD hold a report is a contradiction, and that is tested for
 * by name rather than by "not checked".
 */
export function publicationDecision(
  projection: CaseReportProjection,
  input: Readonly<{ documentTrack: DocumentTrack }>,
): PublicationDecision {
  const reasons = new Set<QueueReason>();

  if (projection.report_kind === "full") reasons.add("full_report");
  if (input.documentTrack !== "automatic") reasons.add("document_not_automatic_track");

  for (const topic of projection.topics) {
    if (topicMarksContradiction(topic)) reasons.add("contradiction_marked");
    if (topic.gate !== "checked" || topic.status !== "finding") continue;
    if (topic.certainty === "low") reasons.add("finding_at_low_certainty");
    if (topicCeilingMinorUnits(topic) > AUTOMATIC_FINDING_CEILING_MINOR_UNITS) reasons.add("finding_over_ceiling");
  }

  const ordered = QUEUE_REASONS.filter((reason) => reasons.has(reason));
  return Object.freeze({
    automatic: ordered.length === 0,
    reasons: Object.freeze(ordered),
    document_track: input.documentTrack,
  });
}
