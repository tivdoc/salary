// Site S6.1 / S6.2 — the report review queue, as the operations surface uses it.
//
// One rule shapes every function here: an operator changes words, never
// numbers. That is not enforced by checking what an operator typed against
// what the engine computed — it is enforced by there being nowhere for a
// number to travel. The projection is read-only to this module and to the
// table behind it; what an operator writes lands in a separate `wording` map
// and is published beside the projection, never merged into it. A number
// changes only when the engine writes a new projection row.
//
// The one thing prose can still do is smuggle a figure — "you are owed about
// 6,000" written under a finding the engine put at 4,000 — so a note that
// carries a currency figure is refused by name. Ordinary numbers (a month, a
// section, a count of days) pass.
//
// This module imports nothing from the engine.
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db.ts";
import { PROJECTION_TOPICS, type CaseReportProjection } from "./case-report-projection.ts";
import { publicationDecision, type DocumentTrack, type QueueReason } from "./publication-gate.ts";

export const QA_STATES = ["queued", "approved", "published", "rejected", "recheck_required"] as const;
export type QaState = (typeof QA_STATES)[number];

/** The states in which a report is waiting for a person. */
export const OPEN_QA_STATES: readonly QaState[] = Object.freeze(["queued", "recheck_required"]);

/** What the automatic enqueue records as the actor, since no person did it. */
export const AUTOMATIC_ACTOR = "system:publication_gate" as const;

export type QaRow = Readonly<{
  id: string;
  case_id: string;
  projection_id: string;
  report_kind: "initial" | "full";
  document_track: DocumentTrack;
  state: QaState;
  queue_reasons: readonly string[];
  wording: Readonly<Record<string, string>>;
  operator_identity: string | null;
  review_seconds: number | null;
  queued_at: string;
  decided_at: string | null;
  published_at: string | null;
}>;

type RawRow = Readonly<{
  id: string; case_id: string; projection_id: string; report_kind: string; document_track: string;
  state: string; queue_reasons: string[] | null; wording: Record<string, unknown> | null;
  operator_identity: string | null; review_seconds: number | string | null;
  queued_at: string; decided_at: string | null; published_at: string | null;
}>;

function toRow(raw: RawRow): QaRow {
  const wording: Record<string, string> = {};
  for (const [topic, value] of Object.entries(raw.wording ?? {})) {
    if (typeof value === "string") wording[topic] = value;
  }
  return Object.freeze({
    id: raw.id,
    case_id: raw.case_id,
    projection_id: raw.projection_id,
    report_kind: raw.report_kind === "full" ? "full" : "initial",
    document_track: raw.document_track === "human" ? "human" : "automatic",
    state: (QA_STATES as readonly string[]).includes(raw.state) ? raw.state as QaState : "queued",
    queue_reasons: Object.freeze([...(raw.queue_reasons ?? [])]),
    wording: Object.freeze(wording),
    operator_identity: raw.operator_identity,
    review_seconds: raw.review_seconds === null ? null : Number(raw.review_seconds),
    queued_at: new Date(raw.queued_at).toISOString(),
    decided_at: raw.decided_at === null ? null : new Date(raw.decided_at).toISOString(),
    published_at: raw.published_at === null ? null : new Date(raw.published_at).toISOString(),
  });
}

// --- the wording an operator may write ---------------------------------------

/**
 * What money looks like in this product's prose: a currency mark or word, or a
 * number written with a thousands separator.
 *
 * It deliberately does NOT refuse every digit. A year, a section number, a
 * count of days and a month all belong in a reviewer's sentence, and a rule
 * that banned them would push operators into writing worse Hebrew rather than
 * into writing no figures. A sum, in a report about money, is written with a
 * unit or a separator — and that is what this catches.
 *
 * The guarantee that an operator moved no number does not rest on this regex.
 * It rests on there being no numeric field in the row at all; this is the
 * second line, against the sum written in words.
 */
const CURRENCY_SHAPED = /₪|ש"ח|שקל|\d{1,3}(?:,\d{3})+/u;

export type WordingRefusal = Readonly<{ topic: string; code: "unknown_topic" | "too_short" | "too_long" | "carries_a_figure" }>;

/**
 * Validates the operator's sentences. Returns the refusals; an empty array
 * means every entry may be stored.
 *
 * `carries_a_figure` is the rule that matters: a sentence with a sum in it is a
 * number the engine did not produce, and the customer cannot tell the two
 * apart on the page.
 */
export function checkWording(wording: Readonly<Record<string, string>>): readonly WordingRefusal[] {
  const refusals: WordingRefusal[] = [];
  for (const [topic, text] of Object.entries(wording)) {
    if (!(PROJECTION_TOPICS as readonly string[]).includes(topic)) {
      refusals.push({ topic, code: "unknown_topic" });
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.length < 4) refusals.push({ topic, code: "too_short" });
    else if (trimmed.length > 400) refusals.push({ topic, code: "too_long" });
    else if (CURRENCY_SHAPED.test(trimmed)) refusals.push({ topic, code: "carries_a_figure" });
  }
  return Object.freeze(refusals);
}

// --- the queue ---------------------------------------------------------------

/**
 * D-10.2/D-10.3 applied to one generated report. Every report that reaches the
 * gate gets a row: one waiting for a person, or one the gate published itself,
 * recorded under `AUTOMATIC_ACTOR` so "who published this" always has an
 * answer.
 *
 * Recording the automatic ones too is what makes D-11.2's automatic-track
 * share a real percentage — the queue alone is the numerator without the
 * denominator — and what lets R-8 reach a report no person ever read.
 *
 * The gate is evaluated here rather than trusted from a caller, so a caller
 * that forgets to check cannot publish something a person should have read.
 */
export async function recordPublicationDecision(
  input: Readonly<{
    caseId: string;
    projectionId: string;
    projection: CaseReportProjection;
    documentTrack: DocumentTrack;
    actor?: string;
  }>,
  db?: CaseAccessDb | null,
): Promise<Readonly<{ decision: ReturnType<typeof publicationDecision>; row: QaRow | null }>> {
  const decision = publicationDecision(input.projection, { documentTrack: input.documentTrack });
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { decision, row: null };
  const rows = await store.rpc<RawRow>("case_report_qa_enqueue", {
    target_case: input.caseId,
    target_projection: input.projectionId,
    target_report_kind: input.projection.report_kind,
    target_document_track: decision.document_track,
    target_reasons: [...decision.reasons],
    target_state: decision.automatic ? "published" : "queued",
    target_actor: decision.automatic ? AUTOMATIC_ACTOR : (input.actor ?? AUTOMATIC_ACTOR),
  });
  return { decision, row: rows[0] ? toRow(rows[0]) : null };
}

/** The queue, oldest first. Defaults to what is actually waiting for a person. */
export async function listReviewQueue(
  input: Readonly<{ states?: readonly QaState[]; limit?: number }> = {},
  db?: CaseAccessDb | null,
): Promise<readonly QaRow[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return [];
  const rows = await store.rpc<RawRow>("case_report_qa_list", {
    target_states: [...(input.states ?? OPEN_QA_STATES)],
    target_limit: input.limit ?? 50,
  });
  return rows.map(toRow);
}

/** Stores the operator's sentences. Refused wording is not partially applied. */
export async function setWording(
  input: Readonly<{ qaId: string; wording: Readonly<Record<string, string>>; operator: string }>,
  db?: CaseAccessDb | null,
): Promise<Readonly<{ row: QaRow | null; refusals: readonly WordingRefusal[] }>> {
  const refusals = checkWording(input.wording);
  if (refusals.length > 0) return { row: null, refusals };
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return { row: null, refusals };
  const rows = await store.rpc<RawRow>("case_report_qa_wording_set", {
    target_qa: input.qaId,
    target_wording: input.wording,
    target_actor: input.operator,
  });
  return { row: rows[0] ? toRow(rows[0]) : null, refusals };
}

/**
 * Approve, publish or reject. The operator's identity is required by the
 * signature, not defaulted, because the log line is the whole point of the
 * queue: "who published this" must have an answer for every published report.
 */
export async function decideReview(
  input: Readonly<{ qaId: string; state: "approved" | "published" | "rejected"; operator: string; reviewSeconds?: number }>,
  db?: CaseAccessDb | null,
): Promise<QaRow | null> {
  if (input.operator.trim().length < 2) throw new Error("CASE_REPORT_QA_OPERATOR_REQUIRED");
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return null;
  const rows = await store.rpc<RawRow>("case_report_qa_decide", {
    target_qa: input.qaId,
    target_state: input.state,
    target_actor: input.operator,
    target_review_seconds: input.reviewSeconds ?? null,
  });
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * S6.2. A parameter changed (R-8) and published reports that leaned on it are
 * no longer trustworthy. They return to the queue as `recheck_required` — the
 * customer's copy is not withdrawn, because a report that vanishes is worse
 * than one marked as being looked at again; the case screen says it is under
 * re-check, and D-6's retroactive sentence is what the new report will carry.
 */
export async function markRecheckRequired(
  input: Readonly<{ qaIds: readonly string[]; operator: string; reason: string }>,
  db?: CaseAccessDb | null,
): Promise<number> {
  if (input.qaIds.length === 0) return 0;
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return 0;
  const rows = await store.rpc<{ value: number | string }>("case_report_qa_recheck", {
    target_qa_ids: [...input.qaIds],
    target_actor: input.operator,
    target_reason: input.reason,
  });
  return Number(rows[0]?.value ?? 0);
}

/**
 * Which published reports a changed parameter reaches. The projection carries
 * `parameter_grades` per topic, so the answer is read from what each report
 * actually used rather than guessed from the case's shape.
 */
export function reportsTouchedByParameter(
  published: ReadonlyArray<Readonly<{ qaId: string; projection: CaseReportProjection }>>,
  parameterKey: string,
): readonly string[] {
  return published
    .filter((entry) => entry.projection.topics.some((topic) => parameterKey in topic.parameter_grades))
    .map((entry) => entry.qaId);
}

export type PublishedReport = Readonly<{
  projection: CaseReportProjection;
  /** The operator's sentences, beside the projection and never inside it. */
  wording: Readonly<Record<string, string>>;
  operator_identity: string;
  published_at: string;
}>;

/**
 * What a published report is: the engine's projection, byte for byte, plus the
 * operator's words. Assembling it here rather than in a renderer is what makes
 * "the operator changed no number" checkable — the projection object this
 * returns is the one that was read.
 */
export function publishedReport(row: QaRow, projection: CaseReportProjection): PublishedReport | null {
  if (row.state !== "published" || row.operator_identity === null || row.published_at === null) return null;
  return Object.freeze({
    projection,
    wording: row.wording,
    operator_identity: row.operator_identity,
    published_at: row.published_at,
  });
}

/** The queue reasons a row carries, as the codes S6.1's screen renders. */
export function queueReasonsOf(row: QaRow): readonly QueueReason[] {
  return row.queue_reasons as readonly QueueReason[];
}
