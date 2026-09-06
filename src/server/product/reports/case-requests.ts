// Site S3.4 / D-2 — reading and answering the requests on a case.
//
// A request exists because a refusal opened it (S3.3). Nothing else opens one:
// not a screen, not an operator's hunch, not a low confidence score. That is
// why this module has a `listCaseRequests` and an `answerCaseRequest` and no
// `createCaseRequest` a screen could reach — the only creator is
// `openRequestsForRefusals`, which takes refusal codes and nothing else.
//
// The store is the same one-adapter pattern the access system uses, so
// production (PostgREST) and the local runtime (pg) run one SQL and tests run a
// fake. This file imports nothing from the engine.
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db.ts";
import { requestFor, slaPaused, type ThreadRequest } from "./refusal-requests.ts";

export type StoredRequest = ThreadRequest & Readonly<{ id: string; answer_text: string | null }>;

type RequestRow = Readonly<{
  id: string;
  case_id: string;
  code: string;
  question: string;
  answer_kind: string;
  options: string[] | null;
  field_crop: string | null;
  blocking: boolean;
  opened_at: string;
  expires_at: string;
  answered_at: string | null;
  answer_text: string | null;
}>;

function toRequest(row: RequestRow): StoredRequest {
  return {
    id: row.id,
    case_id: row.case_id,
    code: row.code,
    question: row.question,
    answer_kind: row.answer_kind as ThreadRequest["answer_kind"],
    ...(row.options && row.options.length > 0 ? { options: row.options } : {}),
    field_crop: row.field_crop,
    blocking: row.blocking,
    opened_at: new Date(row.opened_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    answered_at: row.answered_at === null ? null : new Date(row.answered_at).toISOString(),
    answer_text: row.answer_text,
  };
}

export async function listCaseRequests(caseId: string, db?: CaseAccessDb | null): Promise<readonly StoredRequest[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return [];
  const rows = await store.rpc<RequestRow>("case_request_list", { target_case: caseId });
  return rows.map(toRequest);
}

/**
 * Opens one request per refusal code that does not already have an open one.
 * A code that asks nothing (`rate_not_published`, `awaiting_verification`,
 * `section_30a_excluded`) opens nothing — `requestFor` returns null and the
 * report shows the reason instead.
 */
export async function openRequestsForRefusals(
  input: Readonly<{ caseId: string; codes: readonly string[]; now?: Date }>,
  db?: CaseAccessDb | null,
): Promise<readonly StoredRequest[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return [];
  const now = input.now ?? new Date();
  const existing = await listCaseRequests(input.caseId, store);
  const opened: StoredRequest[] = [];
  for (const code of new Set(input.codes)) {
    if (existing.some((row) => row.code === code && row.answered_at === null)) continue;
    const request = requestFor(code, { caseId: input.caseId, now });
    if (!request) continue;
    const rows = await store.rpc<RequestRow>("case_request_open", {
      target_case: input.caseId,
      target_code: request.code,
      target_question: request.question,
      target_answer_kind: request.answer_kind,
      target_options: request.options ?? null,
      target_field_crop: request.field_crop,
      target_blocking: request.blocking,
      target_expires_at: request.expires_at,
    });
    if (rows[0]) opened.push(toRequest(rows[0]));
  }
  return opened;
}

export async function answerCaseRequest(
  input: Readonly<{ requestId: string; caseId: string; answer: string }>,
  db?: CaseAccessDb | null,
): Promise<StoredRequest | null> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) return null;
  const rows = await store.rpc<RequestRow>("case_request_answer", {
    target_request: input.requestId,
    target_case: input.caseId,
    target_answer: input.answer.slice(0, 2_000),
  });
  return rows[0] ? toRequest(rows[0]) : null;
}

/** D-7.2: the clock runs unless a blocking request is open. */
export function caseSlaPaused(requests: readonly StoredRequest[]): boolean {
  return slaPaused(requests);
}

/** D-9: a request past its expiry is closed and stops holding the case. */
export function expiredRequests(requests: readonly StoredRequest[], now: Date = new Date()): readonly StoredRequest[] {
  return requests.filter((request) => request.answered_at === null && new Date(request.expires_at) <= now);
}
