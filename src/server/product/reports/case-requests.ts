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
import { RequestAnswerError, validateRequestAnswer } from "./request-answer.ts";
import { requestFor, slaPaused, type ThreadRequest } from "./refusal-requests.ts";
import {HOURS_CONFLICT_NAMESPACE} from './document-hours-conflict-answer';
import {z} from 'zod';
import {reviewCompletionTargetSchema,type ReviewCompletionTarget} from '@/engine/document-review/completions';

const reviewNamespace='document_review:';
const reviewStateSchema=z.object({request_id:z.uuid(),source_current:z.boolean(),target:reviewCompletionTargetSchema.nullable()}).strict();
function parseReviewStates(value:unknown,caseId:string){
 const rows=z.array(reviewStateSchema).parse(value);
 if(new Set(rows.map(r=>r.request_id)).size!==rows.length||rows.some(r=>r.source_current&&r.target===null||r.target&&r.target.case_id!==caseId))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
 return rows;
}

const conflictSourceSchema=z.object({conflict_reason:z.enum(['conflicting_observations','provider_reported_conflict']),
 source_observations:z.array(z.object({candidate_id:z.uuid(),raw_value:z.string().max(1000).nullable(),page:z.number().int().positive().max(100),source_label:z.string().max(1000).nullable()}).strict()).max(12)}).strict();
export type StoredRequest = ThreadRequest & Readonly<{ id: string; answer_text: string | null; answer_revision?: number; draft_revision?: number; draft_text?: string | null; statement_month?: string | null; source_current?: boolean; hours_conflict_source?:z.infer<typeof conflictSourceSchema> }>;

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
  statement_month?: string | null;
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
    statement_month: row.statement_month ?? null,
  };
}

export async function listCaseRequests(caseId: string, db?: CaseAccessDb | null, identityId?: string): Promise<readonly StoredRequest[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) throw new Error("CASE_STORE_UNAVAILABLE");
  const rows = await store.rpc<RequestRow>("case_request_list", { target_case: caseId });
  const revisions = await store.rpc<{request_id:string;answer_revision:number;latest_answer:string|null;draft_revision:number;draft_text:string|null}>("case_request_revision_list", {target_case:caseId});
  const bound = rows.filter(row => row.code.startsWith('document_field:'));
  const june=rows.filter(row=>row.code.startsWith('minimum_wage_june2026:'));
  const fields = identityId && bound.length ? await store.rpc<{request_id:string;source_current:boolean}>('case_request_field_states',{target_case:caseId,target_identity:identityId}) : [];
  const juneStates=identityId&&june.length?await store.rpc<{request_id:string;source_current:boolean}>('case_request_june_states',{target_case:caseId,target_identity:identityId}):[];
  const transcriptions=rows.filter(row=>row.code.startsWith('document_transcription:'));
  const transcriptionStates=identityId&&transcriptions.length?await store.rpc<{request_id:string;source_current:boolean}>('case_request_transcription_states',{target_case:caseId,target_identity:identityId}):[];
  const hours=rows.filter(row=>row.code.startsWith('june2026_regular_hours:'));
  const hoursStates=identityId&&hours.length?await store.rpc<{request_id:string;source_current:boolean}>('case_request_regular_hours_states',{target_case:caseId,target_identity:identityId}):[];
  const conflicts=rows.filter(row=>row.code.startsWith(HOURS_CONFLICT_NAMESPACE));
  const conflictStates=identityId&&conflicts.length?await store.rpc<{request_id:string;source_current:boolean;conflict_reason:unknown;source_observations:unknown}>('case_request_hours_conflict_states',{target_case:caseId,target_identity:identityId}):[];
  const reviews=rows.filter(row=>row.code.startsWith(reviewNamespace));
  const reviewStates=identityId&&reviews.length?parseReviewStates(await store.rpc('case_request_review_states',{target_case:caseId,target_identity:identityId}),caseId):[];
  if(reviewStates.some(s=>s.target&&reviews.find(r=>r.id===s.request_id)?.code!==reviewNamespace+s.target.target_sha256))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
  const states=[...fields,...juneStates,...transcriptionStates,...hoursStates,...conflictStates,...reviewStates],allBound=[...bound,...june,...transcriptions,...hours,...conflicts,...reviews];
  if (identityId && allBound.length && (states.length !== allBound.length || new Set(states.map(s=>s.request_id)).size !== states.length || states.some(s=>typeof s.source_current!=='boolean'||!allBound.some(r=>r.id===s.request_id)))) throw new Error('REQUEST_FIELD_STATE_UNAVAILABLE');
  return rows.map(row => {
    const revision = revisions.find(value => value.request_id === row.id);
    const state = states.find(value => value.request_id === row.id);
    const conflict=conflictStates.find(value=>value.request_id===row.id);
    const source=conflict&&!(conflict.source_current===false&&conflict.conflict_reason===null)
      ?conflictSourceSchema.parse({conflict_reason:conflict.conflict_reason,source_observations:conflict.source_observations}):undefined;
    return {...toRequest(row),...(state?{source_current:state.source_current}:{}),...(source?{hours_conflict_source:source}:{}),answer_text:revision?.latest_answer ?? row.answer_text,answer_revision:revision?.answer_revision ?? 0,draft_revision:revision?.draft_revision ?? 0,draft_text:revision?.draft_text ?? null};
  });
}

/** The complete target is server-only. Customer responses retain the existing
 * source_current flag and answer history, without source hashes or raw targets. */
async function validateReviewAnswer(store:CaseAccessDb,request:StoredRequest,caseId:string,identityId:string|undefined,text:string,draft=false){
 if(!identityId)throw Error('REQUEST_FIELD_FORBIDDEN');
 const states=parseReviewStates(await store.rpc('case_request_review_states',{target_case:caseId,target_identity:identityId}),caseId);
 const matching=states.filter(s=>s.request_id===request.id);
 if(matching.length!==1)throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
 const state=matching[0];
 if(!state.source_current)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 const target:ReviewCompletionTarget=reviewCompletionTargetSchema.parse(state.target);
 if(request.code!==reviewNamespace+target.target_sha256)throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
 const {normalizeSavedReviewAnswer,savedReviewRequestQuestion}=await import('../processing/saved-review-requests');
 if(request.answer_kind!=='text'||request.question!==savedReviewRequestQuestion(target)||request.options?.length)throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
 if(draft&&text==='')return text;
 try{normalizeSavedReviewAnswer(target,text);}catch{throw new RequestAnswerError();}
 // SQL stores the original plain declaration; typed materialization happens
 // later from its identified journal row, never from customer receipt JSON.
 return draft?text:text.trim();
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
  input: Readonly<{ requestId: string; caseId: string; answer: string; identityId?:string }>,
  db?: CaseAccessDb | null,
): Promise<StoredRequest | null> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) throw new Error("REQUEST_STORE_UNAVAILABLE");
  const request = (await listCaseRequests(input.caseId, store)).find(row => row.id === input.requestId);
  if (!request) return null;
  // The locked SQL operation owns expiry and exact-original retry semantics.
  // A stale browser clock or lost successful response is not a second answer.
  const review=request.code.startsWith(reviewNamespace);
  const answer = review?await validateReviewAnswer(store,request,input.caseId,input.identityId,input.answer):validateRequestAnswer(request, input.answer);
  const bound=review||request.code.startsWith('document_field:')||request.code.startsWith('dev_financial_hours:')||request.code.startsWith('minimum_wage_june2026:')||request.code.startsWith('document_transcription:')||request.code.startsWith('june2026_regular_hours:')||request.code.startsWith(HOURS_CONFLICT_NAMESPACE);
  if(bound&&!input.identityId)throw new Error('REQUEST_FIELD_FORBIDDEN');
  const rows = await store.rpc<RequestRow>(bound?"case_request_answer_identified":"case_request_answer", {
    target_request: input.requestId,
    target_case: input.caseId,
    target_answer: answer,
    ...(bound?{target_identity:input.identityId}:{}),
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

export async function editCaseRequest(input:{caseId:string;requestId:string;identityId:string;answer:string;expectedRevision:number;kind:'draft'|'correction'},db?:CaseAccessDb|null){
 const store=db??await resolveCaseAccessDb();if(!store)throw new Error('REQUEST_STORE_UNAVAILABLE');
 if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<0||input.answer.length>2000)throw new Error('REQUEST_EDIT_INVALID');
 let answer=input.answer;
 const request=(await listCaseRequests(input.caseId,store)).find(r=>r.id===input.requestId);
 if(!request)throw new Error('REQUEST_FORBIDDEN');
 if(request.code.startsWith(reviewNamespace))answer=await validateReviewAnswer(store,request,input.caseId,input.identityId,input.answer,input.kind==='draft');
 else if(input.kind==='correction')answer=validateRequestAnswer(request,input.answer);
 const rows=await store.rpc<{value:number}>('case_request_edit',{target_case:input.caseId,target_request:input.requestId,target_identity:input.identityId,target_answer:answer,expected_revision:input.expectedRevision,edit_kind:input.kind});
 if(rows.length!==1||rows[0].value!==input.expectedRevision+1)throw new Error('REQUEST_EDIT_RECEIPT_MISSING');
 return rows[0].value;
}
