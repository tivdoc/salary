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
import type {DocumentReadingDisplay} from '@/lib/document-reading-display';
import {documentReadingTargetSchema} from './document-field-confirmation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentFieldVerificationDisplay} from './reading-verification';
import {privateDocumentReviewReports,privateDocumentReviewArtifact} from './private-document-review';
import {realAiServiceCustomerRequestReview} from './real-ai-service-customer';
import {reviewRequestsCoveredByFieldReadings,reviewRequestsCoveredByFieldReadingGroups,reviewFieldReadingCheckLabels,reviewFieldRequestsNotRequired,reviewHistoricalRequestProjection,REVIEW_DEFERRABLE_SCALAR_FIELDS} from './review-field-coverage';
import {validateSavedReadingAnswer} from './validate-reading-answer';
import {reviewSharedPersonalRequestProjection} from './review-shared-personal-coverage';
import {projectSourceIntakeUploadContext,sourceIntakeUploadContextSchema,type SourceIntakeUploadState} from '../documents/source-intake-upload';
import {savedLegacySourceIntake} from '../processing/saved-legacy-source-intake';
import {sourceIntakeReadingCoverage,type SourceIntakeCoverage} from '../processing/source-intake-coverage';

const reviewNamespace='document_review:';
const reviewStateSchema=z.object({request_id:z.uuid(),source_current:z.boolean(),target:reviewCompletionTargetSchema.nullable()}).strict();
function parseReviewStates(value:unknown,caseId:string){
 const rows=z.array(reviewStateSchema).parse(value);
 if(new Set(rows.map(r=>r.request_id)).size!==rows.length||rows.some(r=>r.source_current&&r.target===null||r.target&&r.target.case_id!==caseId))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
 return rows;
}

const reviewUploadStateSchema=z.object({request_id:z.uuid(),state:z.enum(['requested','received_pending_review','insufficient','satisfied','stale']),
 source_current:z.boolean(),information_satisfied:z.boolean(),analysis_run_id:z.string().min(1).max(200).nullable(),
 reason:z.enum(['submitted_source_replaced','duplicate_content','dependent_check_not_evaluated','requested_evidence_unresolved',
  'target_specific_observation_required','submitted_document_not_fully_verified','target_specific_observed_source','unsupported_document_kind']).nullable(),
}).strict().superRefine((row,ctx)=>{
 if(row.information_satisfied!==(row.state==='satisfied')||row.information_satisfied&&!row.source_current)
  ctx.addIssue({code:'custom',message:'Inconsistent document satisfaction state'});
 if(['requested','received_pending_review'].includes(row.state)?row.analysis_run_id!==null||row.reason!==null:row.analysis_run_id===null||row.reason===null)
  ctx.addIssue({code:'custom',message:'Inconsistent document assessment receipt'});
 if(row.state==='satisfied'&&row.reason!=='target_specific_observed_source')ctx.addIssue({code:'custom',message:'Positive document evidence required'});
});
type DocumentUploadState=Omit<z.infer<typeof reviewUploadStateSchema>,'request_id'|'source_current'>;
type SourceIntakeProjection=Readonly<{source_intake_upload_state?:SourceIntakeUploadState;source_intake_coverage?:readonly Pick<SourceIntakeCoverage,'state'|'period'|'kind'|'months'>[]}>;

const conflictSourceSchema=z.object({conflict_reason:z.enum(['conflicting_observations','provider_reported_conflict']),
 source_observations:z.array(z.object({candidate_id:z.uuid(),raw_value:z.string().max(1000).nullable(),page:z.number().int().positive().max(100),source_label:z.string().max(1000).nullable()}).strict()).max(12)}).strict();
export type StoredRequest = ThreadRequest & SourceIntakeProjection & Readonly<{ id: string; covered_by_field_request_id?:string; covered_by_field_request_ids?:readonly string[]; covered_by_confirmed_reading?:true; covered_by_unresolved_reading?:true; replacement_review_request_id?:string; not_required_for_current_review?:true; answer_text: string | null; answer_revision?: number; draft_revision?: number; draft_text?: string | null; statement_month?: string | null; source_current?: boolean; document_upload_state?:DocumentUploadState; reading_display?:DocumentReadingDisplay; hours_conflict_source?:z.infer<typeof conflictSourceSchema> }>;

export function documentRequestSatisfied(request:StoredRequest):boolean{
 return request.source_current===true&&request.source_intake_upload_state?.state==='satisfied'&&request.source_intake_upload_state.information_satisfied===true
  ||request.source_current!==false&&request.document_upload_state?.state==='satisfied'&&request.document_upload_state.information_satisfied===true;
}

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

export async function listCaseRequests(caseId: string, db?: CaseAccessDb | null, identityId?: string, sessionToken?: string|null): Promise<readonly StoredRequest[]> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) throw new Error("CASE_STORE_UNAVAILABLE");
  const rows = await store.rpc<RequestRow>("case_request_list", { target_case: caseId });
  const revisions = await store.rpc<{request_id:string;answer_revision:number;latest_answer:string|null;draft_revision:number;draft_text:string|null}>("case_request_revision_list", {target_case:caseId});
  const bound = rows.filter(row => row.code.startsWith('document_field:'));
  const june=rows.filter(row=>row.code.startsWith('minimum_wage_june2026:'));
  const fields = identityId && bound.length ? await store.rpc<{request_id:string;source_current:boolean}>('case_request_field_states',{target_case:caseId,target_identity:identityId}) : [];
  const fieldTargets=identityId&&bound.length?await store.rpc<{request_id:string;target:unknown}>('case_request_field_reading_targets',{target_case:caseId,target_identity:identityId}):[];
  const displays=new Map<string,DocumentReadingDisplay>();
  for(const entry of fieldTargets){
   const target=documentReadingTargetSchema.parse(entry.target),request=bound.find(r=>r.id===entry.request_id);
   if(!request||target.case_id!==caseId||request.code!==`document_field:${target.target_sha256}`||displays.has(entry.request_id))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
   const display=documentFieldVerificationDisplay(target);
   displays.set(entry.request_id,{question:display.question,field:display.field,raw_value:display.raw_value,
    page:display.source.page,text_fragment:display.source.text_fragment,bounding_box:display.source.bounding_box,
    ...(target.schema_version==='document-row-cell-confirmation-v1'?{row_context:{group_id:canonicalSha256({case_id:target.case_id,product_document_id:target.product_document_id,
     version_id:target.version_id,source_sha256:target.source_sha256,month:target.month,policy_version:target.policy_version,
      extraction_result_sha256:target.extraction_result_sha256,original_component:target.original_component}),label:target.original_component.source_label,cell:target.cell}}:{}),
    ...(target.schema_version==='document-source-transcription-v1'?{transcription_context:{kind:target.subject.kind}}:{}),
    ...('evidence_context'in display?{evidence_context:display.evidence_context}:{}),
    ...('source_transcription_context'in display?{source_transcription_context:display.source_transcription_context}:{}),
    ...('tariff_context'in display?{tariff_context:display.tariff_context}:{}),
    ...('period_intake_context'in display?{period_intake_context:display.period_intake_context}:{}),
    ...('obligation_context'in display?{obligation_context:display.obligation_context}:{}),
    ...('structure_context'in display?{structure_context:display.structure_context}:{})});
  }
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
  const documentReviews=reviews.filter(r=>r.answer_kind==='document');
  const intakeDocuments=rows.filter(r=>r.answer_kind==='document'&&r.code.startsWith('legacy.source.document:'));
  const intakeContext=identityId&&intakeDocuments.length?await store.rpc<{value:unknown}>('case_request_source_intake_upload_context',{target_case:caseId,target_identity:identityId}):null;
  if(intakeContext&&(intakeContext.length!==1||!Array.isArray(intakeContext[0].value)))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
  const intakeStates=intakeContext?z.array(sourceIntakeUploadContextSchema).max(256).parse(intakeContext[0].value).map(item=>{
   const t=item.scope.target,row=intakeDocuments.find(r=>r.id===item.scope.request_id);
   if(!row||row.code!==`legacy.source.document:${t.order_id}${t.month?':'+t.month:''}`||item.reading_request_ids.some(id=>{
    const target=fieldTargets.find(f=>f.request_id===id)?.target,parsed=documentReadingTargetSchema.safeParse(target);
    if(!parsed.success||parsed.data.schema_version!=='document-source-period-intake-v1')return true;
    const reading=parsed.data;return reading.order_id!==t.order_id||reading.order_receipt_sha256!==t.order_receipt_sha256
     ||!item.receipt?.files.some(f=>f.document_id===reading.product_document_id&&f.version_id===reading.version_id&&f.source_sha256===reading.source_sha256);
   }))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
   const state=projectSourceIntakeUploadContext(item,caseId).state;
   const saved=savedLegacySourceIntake(item.journalContext),scope=saved.scopes.find(s=>s.id===t.order_id&&s.receipt_sha256===t.order_receipt_sha256);
   const coverage=state.source_current&&scope&&item.receipt?sourceIntakeReadingCoverage(saved,scope)
    .filter(c=>item.receipt!.files.some(f=>f.document_id===c.document_id&&f.version_id===c.version_id&&f.source_sha256===c.source_sha256))
    .map(({state,period,kind,months})=>({state,period,kind,months})):[];
   return {...state,coverage};
  }):[];
  if(identityId&&intakeDocuments.length&&(intakeStates.length!==intakeDocuments.length||new Set(intakeStates.map(s=>s.request_id)).size!==intakeStates.length
   ||intakeStates.some(s=>!intakeDocuments.some(r=>r.id===s.request_id)||s.reading_request_ids.some(id=>!fields.some(f=>f.request_id===id&&f.source_current)
    ||!displays.get(id)?.period_intake_context))))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
  const uploadStates=identityId&&documentReviews.length?z.array(reviewUploadStateSchema).parse(await store.rpc('case_request_review_upload_states',{target_case:caseId,target_identity:identityId})):[];
  if(identityId&&documentReviews.length&&(uploadStates.length!==documentReviews.length||new Set(uploadStates.map(s=>s.request_id)).size!==uploadStates.length
   ||uploadStates.some(s=>!documentReviews.some(r=>r.id===s.request_id)||reviewStates.find(r=>r.request_id===s.request_id)?.source_current!==s.source_current)))throw Error('REQUEST_FIELD_STATE_UNAVAILABLE');
  const states=[...fields,...juneStates,...transcriptionStates,...hoursStates,...conflictStates,...reviewStates,...intakeStates],allBound=[...bound,...june,...transcriptions,...hours,...conflicts,...reviews,...intakeDocuments];
  if (identityId && allBound.length && (states.length !== allBound.length || new Set(states.map(s=>s.request_id)).size !== states.length || states.some(s=>typeof s.source_current!=='boolean'||!allBound.some(r=>r.id===s.request_id)))) throw new Error('REQUEST_FIELD_STATE_UNAVAILABLE');
  const coveredGroups=new Map<string,readonly string[]>();
  const covered=new Map<string,string>(),notRequired=new Set<string>(),alreadyRead=new Set<string>(),unresolvedRead=new Set<string>(),replacementReviews=new Map<string,string>();
  // Two bounded protected lookups per case, only when both question families
  // can overlap. No artifact, stale artifact or no exact match means no hiding.
  const sharedPersonalCandidates=reviewStates.filter(r=>r.source_current&&r.target?.kind==='factual'
   &&r.target.required_evidence_kind==='customer_declaration'&&/^entitlement\.(minimum_wage|pension|travel|convalescence|vacation|work\.personal)\./u.test(r.target.fact_key));
  const minimumSourceOverlap=reviewStates.some(r=>r.source_current&&r.target?.kind==='factual'&&r.target.answer_kind==='text'
   &&r.target.required_evidence_kind==='observed_reading'&&r.target.source_pins.length===1&&/^entitlement\.minimum_wage\.[a-f0-9]{28}$/u.test(r.target.fact_key));
  const fieldOverlap=(reviewStates.some(r=>r.source_current&&r.target?.kind==='factual'&&r.target.answer_kind==='number'&&r.target.required_evidence_kind==='observed_reading')
   ||[...displays.values()].some(display=>display.row_context||display.transcription_context||display.structure_context||display.field.startsWith('source_scope.')||REVIEW_DEFERRABLE_SCALAR_FIELDS.some(field=>field===display.field)))
   &&fieldTargets.some(t=>bound.some(r=>r.id===t.request_id&&(r.answered_at===null||reviewStates.some(s=>s.source_current)))&&fields.some(f=>f.request_id===t.request_id&&f.source_current));
  if(identityId&&(fieldOverlap||minimumSourceOverlap||sharedPersonalCandidates.length>1)){
   const summaries=await privateDocumentReviewReports(caseId,identityId,store);
   const summary=summaries.filter(r=>r.current).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
   let review:Awaited<ReturnType<typeof realAiServiceCustomerRequestReview>>=null;
   if(summary){
    const artifact=await privateDocumentReviewArtifact(caseId,identityId,summary.report_id,store);
    if(artifact?.current&&artifact.bundle.analysis_run_id===summary.analysis_run_id&&artifact.bundle.document_review){
     review=artifact.bundle.document_review;
    }
   }
   if(!review&&sessionToken){
    // Optional display evidence cannot answer a request or make its underlying
    // action unavailable. Missing/expired/foreign evidence and lookup failures
    // preserve the ordinary questions. Owner/QA authority is never promoted.
    review=await realAiServiceCustomerRequestReview({caseId,identityId,sessionToken}).catch(()=>null);
   }
   if(review){
     const fieldRequests=fieldTargets.map(entry=>{
      const request=bound.find(r=>r.id===entry.request_id)!;
      return {request_id:request.id,code:request.code,target:documentReadingTargetSchema.parse(entry.target),
       source_current:fields.find(f=>f.request_id===request.id)?.source_current===true,answered_at:request.answered_at,
       answer_text:revisions.find(r=>r.request_id===request.id)?.latest_answer??request.answer_text,expires_at:request.expires_at};
     });
     for(const match of fieldOverlap?reviewFieldReadingCheckLabels({review,fieldRequests,nowMs:Date.now()}):[]){
      const display=displays.get(match.field_request_id);
      // Preserve the historical scalar display contract byte for byte.
      if(display&&(display.row_context||display.transcription_context||display.structure_context||display.field.startsWith('source_scope.'))&&match.check_titles.length)displays.set(match.field_request_id,{...display,dependent_checks:match.check_titles});
     }
     for(const entry of fieldOverlap?reviewFieldRequestsNotRequired({review,fieldRequests,nowMs:Date.now()}):[])notRequired.add(entry.field_request_id);
     const genericRequests=reviewStates.flatMap(state=>{
      const row=reviews.find(r=>r.id===state.request_id);return row&&state.target?[{request_id:row.id,code:row.code,target:state.target,source_current:state.source_current,answered_at:row.answered_at,expires_at:row.expires_at}]:[];
     });
     for(const match of reviewSharedPersonalRequestProjection({review,requests:genericRequests,nowMs:Date.now()})){
      notRequired.add(match.request_id);replacementReviews.set(match.request_id,match.replacement_request_id);
     }
     for(const match of fieldOverlap||minimumSourceOverlap?reviewHistoricalRequestProjection({review,fieldRequests,reviewRequests:genericRequests,nowMs:Date.now()}):[]){
      if(match.state==='resolved_source_fact')notRequired.add(match.request_id);
      else if(match.state==='not_required'){notRequired.add(match.request_id);if('replacement_request_id'in match&&typeof match.replacement_request_id==='string')replacementReviews.set(match.request_id,match.replacement_request_id);}
      else if(match.state==='period_required'){covered.set(match.request_id,match.field_request_id);if(match.reading_state==='unresolved_answer')unresolvedRead.add(match.request_id);}
      else{covered.set(match.request_id,match.field_request_id);alreadyRead.add(match.request_id);}
     }
     for(const match of fieldOverlap?reviewRequestsCoveredByFieldReadingGroups({review,fieldRequests,nowMs:Date.now()}):[]){
      const state=reviewStates.find(r=>r.source_current&&r.target?.target_sha256===match.target_sha256);
      if(state&&reviews.some(r=>r.id===state.request_id))coveredGroups.set(state.request_id,match.field_requests.map(r=>r.request_id));
     }
     for(const match of fieldOverlap?reviewRequestsCoveredByFieldReadings({review,fieldRequests,nowMs:Date.now()}):[]){
      const state=reviewStates.find(r=>r.source_current&&r.target?.target_sha256===match.target_sha256);
      if(state&&reviews.some(r=>r.id===state.request_id)){covered.set(state.request_id,match.field_request_id);if(match.reading_state==='unresolved_answer')unresolvedRead.add(state.request_id);}
     }
   }
  }
  return rows.map(row => {
    const revision = revisions.find(value => value.request_id === row.id);
    const state = states.find(value => value.request_id === row.id);
    const conflict=conflictStates.find(value=>value.request_id===row.id);
    const upload=uploadStates.find(value=>value.request_id===row.id);
    const intake=intakeStates.find(value=>value.request_id===row.id);
    const intakeProjection:SourceIntakeProjection=intake?{source_intake_upload_state:{state:intake.state,information_satisfied:intake.information_satisfied,reason:intake.reason,reading_request_ids:intake.reading_request_ids},source_intake_coverage:intake.coverage}:{};
    const document_upload_state:DocumentUploadState|undefined=upload?{state:upload.state,information_satisfied:upload.information_satisfied,analysis_run_id:upload.analysis_run_id,reason:upload.reason}:undefined;
    const source=conflict&&!(conflict.source_current===false&&conflict.conflict_reason===null)
      ?conflictSourceSchema.parse({conflict_reason:conflict.conflict_reason,source_observations:conflict.source_observations}):undefined;
    return {...toRequest(row),...intakeProjection,...(coveredGroups.has(row.id)?{covered_by_field_request_ids:coveredGroups.get(row.id)}:{}),...(unresolvedRead.has(row.id)?{covered_by_unresolved_reading:true as const}:{}),...(replacementReviews.has(row.id)?{replacement_review_request_id:replacementReviews.get(row.id)}:{}),...(alreadyRead.has(row.id)?{covered_by_confirmed_reading:true as const}:{}),...(notRequired.has(row.id)?{not_required_for_current_review:true as const}:{}),...(displays.has(row.id)?{question:displays.get(row.id)!.question}:{}),...(covered.has(row.id)?{covered_by_field_request_id:covered.get(row.id)}:{}),...(state?{source_current:state.source_current}:{}),...(document_upload_state?{document_upload_state}:{}),...(displays.has(row.id)?{reading_display:displays.get(row.id)}:{}),...(source?{hours_conflict_source:source}:{}),answer_text:revision?.latest_answer ?? row.answer_text,answer_revision:revision?.answer_revision ?? 0,draft_revision:revision?.draft_revision ?? 0,draft_text:revision?.draft_text ?? null};
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
  if(request.code.startsWith('document_field:'))await validateSavedReadingAnswer({store,caseId:input.caseId,identityId:input.identityId,requestId:input.requestId,code:request.code,answer});
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
  return slaPaused(requests.filter(request=>request.source_current!==false&&!request.not_required_for_current_review&&!documentRequestSatisfied(request)));
}

/** D-9: a request past its expiry is closed and stops holding the case. */
export function expiredRequests(requests: readonly StoredRequest[], now: Date = new Date()): readonly StoredRequest[] {
  return requests.filter((request) => request.answered_at === null && !documentRequestSatisfied(request) && new Date(request.expires_at) <= now);
}

export async function editCaseRequest(input:{caseId:string;requestId:string;identityId:string;answer:string;expectedRevision:number;kind:'draft'|'correction'},db?:CaseAccessDb|null){
 const store=db??await resolveCaseAccessDb();if(!store)throw new Error('REQUEST_STORE_UNAVAILABLE');
 if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<0||input.answer.length>2000)throw new Error('REQUEST_EDIT_INVALID');
 let answer=input.answer;
 const request=(await listCaseRequests(input.caseId,store)).find(r=>r.id===input.requestId);
 if(!request)throw new Error('REQUEST_FORBIDDEN');
 if(request.code.startsWith(reviewNamespace))answer=await validateReviewAnswer(store,request,input.caseId,input.identityId,input.answer,input.kind==='draft');
 else if(input.kind==='correction')answer=validateRequestAnswer(request,input.answer);
 if(request.code.startsWith('document_field:'))await validateSavedReadingAnswer({store,caseId:input.caseId,identityId:input.identityId,requestId:input.requestId,code:request.code,answer});
 const rows=await store.rpc<{value:number}>('case_request_edit',{target_case:input.caseId,target_request:input.requestId,target_identity:input.identityId,target_answer:answer,expected_revision:input.expectedRevision,edit_kind:input.kind});
 if(rows.length!==1||rows[0].value!==input.expectedRevision+1)throw new Error('REQUEST_EDIT_RECEIPT_MISSING');
 return rows[0].value;
}
