import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,type DocumentReviewInput} from '@/engine/document-review/contracts';
import {parseReviewCompletionInput,type ReviewCompletionNeed,type ReviewEvidence} from '@/engine/document-review/completions';
import {assertEntitlementComposition,composeEntitlementReview} from '@/engine/entitlement-review/compose';
import {travelEntitlementInputSchema} from '@/engine/entitlement-review/travel/contracts';
import {travelProductRoute} from '@/engine/entitlement-review/travel/product-facts';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY} from '@/engine/entitlement-review/travel/floor-policy';
import {materializeTravelTariffSource,type TravelTariffJournalEntry} from '@/engine/entitlement-review/travel/tariff-source';
import {travelTariffDocumentSchema,travelTariffGroupSchema} from '@/engine/entitlement-review/travel/tariff-contracts';
import {documentTravelTariffSourceSchema,documentTravelTariffTargetSchema,documentTravelTariffTarget,documentTravelTariffQuestion,
 resolveDocumentTravelTariffVerification,DOCUMENT_TRAVEL_TARIFF_POLICY,type DocumentTravelTariffSource} from '../reports/document-travel-tariff';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,type SourceJob} from './source-dispatch';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^2026-(05|06|07)$/u);
export const savedTravelTariffPurposeSchema=z.object({schema_version:z.literal('document-source-purpose-v1'),purpose_id:z.uuid(),case_id:z.uuid(),
 document_id:z.uuid(),version_id:z.uuid(),file_sha256:sha,document_type:z.literal('other'),evidence_purpose:z.literal('travel_tariff'),
 month,page_count:z.number().int().min(1).max(100),group:travelTariffGroupSchema,identity_id:z.uuid(),recorded_at:z.iso.datetime({offset:true}),purpose_sha256:sha,
}).strict().superRefine((value,ctx)=>{const {purpose_sha256,...body}=value;
 if(canonicalSha256(body)!==purpose_sha256)ctx.addIssue({code:'custom',message:'SAVED_TARIFF_PURPOSE_HASH'});
 if(value.group.page>value.page_count)ctx.addIssue({code:'custom',message:'SAVED_TARIFF_PURPOSE_PAGE'});
});
const documentPin=z.object({id:z.uuid(),version_id:z.uuid(),sha256:sha,type:z.string()});
const answerSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string(),code:z.string(),answer_kind:z.literal('choice'),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true}),field_target:documentTravelTariffTargetSchema});
type SourceRecord={source:DocumentTravelTariffSource;journal:TravelTariffJournalEntry[]};
type AnswerHistory={request_id:string;answer_revision:number;target_sha256:string;current:boolean};

/** The supplied journal/current-document rows have already been authenticated by
 * the transaction reader below. Hashes bind their bytes; they do not authenticate
 * a browser-supplied source purpose or actor. No extraction is required. */
export function savedTravelTariffReadings(input:{caseId:string;month:string;journal:unknown;currentDocuments:unknown}){
 const caseId=z.uuid().parse(input.caseId),selectedMonth=month.parse(input.month);
 const saved=z.object({case_id:z.uuid(),documents:z.array(documentPin),source_purposes:z.array(z.unknown()).max(128).optional(),
  answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(input.journal);
 if(saved.case_id!==caseId)throw Error('SAVED_TARIFF_CASE_MISMATCH');
 const current=z.array(documentPin).parse(input.currentDocuments),records:SourceRecord[]=[],history:AnswerHistory[]=[],seenPurposes=new Set<string>();
 for(const raw of saved.source_purposes??[]){
  if(!raw||typeof raw!=='object'||!('evidence_purpose' in raw)||raw.evidence_purpose!=='travel_tariff')continue;
  const p=savedTravelTariffPurposeSchema.parse(raw);
  if(p.case_id!==caseId)throw Error('SAVED_TARIFF_FOREIGN_PURPOSE');
  if(seenPurposes.has(p.purpose_id))throw Error('SAVED_TARIFF_PURPOSE_DUPLICATE');seenPurposes.add(p.purpose_id);
  if(p.month!==selectedMonth)continue;
  // An immutable old purpose is historical after replacement/removal. It cannot
  // authorize the new version, even when the visible PDF contents look alike.
  const pin=saved.documents.find(d=>d.id===p.document_id&&d.version_id===p.version_id);if(!pin)continue;
  if(pin.sha256!==p.file_sha256||pin.type!=='other')throw Error('SAVED_TARIFF_SOURCE_PIN');
  if(current.filter(d=>d.id===pin.id&&d.version_id===pin.version_id&&d.sha256===pin.sha256&&d.type===pin.type).length!==1)throw Error('SAVED_TARIFF_CURRENT_SOURCE');
  const document=travelTariffDocumentSchema.parse({case_id:caseId,document_id:p.document_id,version_id:p.version_id,file_sha256:p.file_sha256,
   page_count:p.page_count,month:p.month,evidence_purpose:p.evidence_purpose,document_type:p.document_type,purpose_sha256:p.purpose_sha256});
  records.push({source:documentTravelTariffSourceSchema.parse({document,group:p.group}),journal:[]});
 }
 const seenAnswers=new Set<string>();
 for(const raw of saved.answers??[]){
  if(typeof raw.code!=='string'||!raw.code.startsWith('document_field:')||!raw.field_target||typeof raw.field_target!=='object'
   ||!('schema_version' in raw.field_target)||raw.field_target.schema_version!=='document-travel-tariff-transcription-v1')continue;
  const a=answerSchema.parse(raw),t=a.field_target;
  if(a.case_id!==caseId||t.case_id!==caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
  if(a.code!==`document_field:${t.target_sha256}`||a.scope_month!==t.month)throw Error('REQUEST_FIELD_TARGET_INVALID');
  if(seenAnswers.has(a.id))throw Error('SAVED_REQUEST_ID_AMBIGUOUS');seenAnswers.add(a.id);
  const record=records.find(r=>r.source.document.document_id===t.product_document_id&&r.source.document.month===t.month);
  let isCurrent=false;
  if(record){const result=resolveDocumentTravelTariffVerification({target:t,source:record.source,caseId,month:selectedMonth,policyVersion:DOCUMENT_TRAVEL_TARIFF_POLICY,
   requestId:a.id,answerRevision:a.answer_revision,identityId:a.answer_identity_id,answeredAt:a.answer_created_at,answer:a.answer});
   if(result.state==='tariff_current'){record.journal.push(result.entry);isCurrent=true;}}
  history.push({request_id:a.id,answer_revision:a.answer_revision,target_sha256:t.target_sha256,current:isCurrent});
 }
 return deepFreeze({records,history});
}
export type SavedTravelTariffReadings=ReturnType<typeof savedTravelTariffReadings>;

/** One exact immutable revision, under the existing current-source lock. Never
 * read a second latest journal or use a mutable upload as historical authority. */
export async function readSavedTravelTariffReadings(context:PostgresTransactionContext,job:SourceJob,selectedMonth:string){
 month.parse(selectedMonth);await lockCurrentSource(context,job);
 const rows=await context.client.query(statement('saved_travel_tariff_journal',
  `select v.input,v.input_sha256,encode(sha256(convert_to(v.input::text,'UTF8')),'hex') actual_sha256,
   coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'sha256',d.content_sha256,'type',d.document_type))
    from public.documents d where d.case_id=v.case_id),'[]'::jsonb) current_documents
   from private.case_input_versions v where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3
    and session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||v.case_id::text`,
  [job.case_id,job.revision,job.input_sha256]));
 const row=rows.rows[0];
 if(rows.row_count!==1||!row||row.input_sha256!==job.input_sha256||row.actual_sha256!==job.input_sha256)throw Error('SAVED_INPUT_HASH_MISMATCH');
 return savedTravelTariffReadings({caseId:job.case_id,month:selectedMonth,journal:row.input,currentDocuments:row.current_documents});
}

/** This adapter is opt-in by the ordinary automatic profile plus a current
 * purpose receipt. It records a source reading, never an accepted legal gate. */
export function attachSavedTravelTariffReadings(candidate:DocumentReviewInput,saved:SavedTravelTariffReadings){
 if(!saved.records.length||!candidate.purchased_scope.topics.includes('travel')||!candidate.entitlement_evidence?.travel)
  return {input:candidate,dependencies:[],history:saved.history};
 const input=documentReviewInputSchema.parse(candidate),raw=travelEntitlementInputSchema.parse(input.entitlement_evidence!.travel);
 if(saved.records.length!==1){
  // Preserve all existing receipts and monetary observations. The ambiguity is
  // an explicit source-association gap and cannot become a chosen fare.
  const travel={...raw,discounted_daily_fare:raw.discounted_daily_fare?{...raw.discounted_daily_fare,state:'conflict' as const,printed_value:null}:null,
   monthly_pass_cost:raw.monthly_pass_cost?{...raw.monthly_pass_cost,state:'conflict' as const,printed_value:null}:null,
   ...(raw.fare_source_context?{fare_source_context:{...raw.fare_source_context,association:{...raw.fare_source_context.association,state:'conflict' as const,value:null}}}:{})};
  return {input:documentReviewInputSchema.parse({...input,entitlement_evidence:{...input.entitlement_evidence,travel},coverage_gaps:[...input.coverage_gaps,
   {check_id:raw.check_prefix+'.expected',topic:'travel',kind:'missing_fact',detail:'קיימים כמה מקורות תעריף לחודש. עדיין לא זוהה איזה מקטע מתייחס למסלול ולכרטיס המתאימים.',next_step:'יש לזהות מקור תעריף אחד למסלול ולתקופה; אין לבחור מקור לפי הסכום.'}]}),dependencies:[],history:saved.history};
 }
 const record=saved.records[0],out=materializeTravelTariffSource({travel:{...raw,calculation_policy:TRAVEL_GENERAL_ORDER_FLOOR_POLICY},
  current:record.source.document,group:record.source.group,journal:record.journal});
 const d=record.source.document,documents=[...input.documents],prior=documents.find(doc=>doc.document_id===d.document_id||doc.version_id===d.version_id);
 if(prior&&(prior.file_sha256!==d.file_sha256||prior.version_id!==d.version_id))throw Error('SAVED_TARIFF_REVIEW_SOURCE');
 const document={case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page_count:d.page_count,kind:'other' as const,
  label:'מקור תעריף נסיעה שהועלה',period:null,reading_origin:out.receipts.length?'identified_document_reading' as const:'source_inventory' as const,
  reading_sha256:canonicalSha256({schema_version:'saved-travel-tariff-effective-reading-v1',purpose_sha256:d.purpose_sha256,receipts:out.receipts}),
  ...(out.accepted_reading_sha256.length?{accepted_reading_sha256:[...out.accepted_reading_sha256]}:{})};
 if(prior)documents.splice(documents.indexOf(prior),1);documents.push(document);
 const completion=parseReviewCompletionInput(input.completion_input),completionDocuments=completion.documents.filter(doc=>doc.pin.version_id!==d.version_id);
 completionDocuments.push({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:'other',period:null,
  review:out.receipts.length?'partial':'not_reviewed'});
 return {input:documentReviewInputSchema.parse({...input,documents,entitlement_evidence:{...input.entitlement_evidence,travel:out.travel},
  completion_input:{...completion,documents:completionDocuments}}),dependencies:out.dependencies.map(dependency=>({...dependency,source:record.source})),history:saved.history};
}

const tariffFactKey='travel.tariff_source',tariffEvidencePrefix='saved-travel-tariff-context:';
const tariffSourceQuestion='יש להעלות מקור תעריף נסיעה למסלול ולחודש הנבדק, ולציין את העמוד והמקטע שבהם מופיעים המסלול, פרופיל ההנחה, הכיוונים ותקופת התוקף. המחירים והכרטיסים ייבדקו בנפרד.';
const contextKeys=['route_reference','discount_profile','association','effective_period','directions'] as const;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
function ownTariffNeed(need:ReviewCompletionNeed){return need.fact_key===tariffFactKey&&need.question===tariffSourceQuestion
 &&need.kind==='document'&&need.document_kind==='other'&&need.answer_kind==='document'&&need.required_evidence_kind==='document'
 &&need.reason==='missing'&&!need.general_question&&!need.source_pins.length;}

/** Invoke after authenticated answer replay/composition and before method
 * recipes/final command hashing. Only this generated planner projection changes;
 * raw source facts, original question targets and answer history remain intact.
 * Upload receipt ≠ information receipt: a current purpose prevents a repeated
 * upload, while only its exact positive context reading supplies information. */
export function projectSavedTravelTariffCompletions(candidate:DocumentReviewInput,saved:SavedTravelTariffReadings):DocumentReviewInput{
 if(!candidate.purchased_scope.topics.includes('travel')||!candidate.entitlement_evidence?.travel)return candidate;
 const raw=travelEntitlementInputSchema.parse(candidate.entitlement_evidence.travel);
 if(raw.calculation_policy!==TRAVEL_GENERAL_ORDER_FLOOR_POLICY)return candidate;
 assertEntitlementComposition(candidate);
 const travel=travelEntitlementInputSchema.parse(candidate.entitlement_composition!.evidence.travel),route=travelProductRoute(travel);
 const completion=parseReviewCompletionInput(candidate.completion_input);
 const needs=completion.needs.filter(n=>!ownTariffNeed(n)),evidence=completion.evidence.filter(e=>!e.evidence_id.startsWith(tariffEvidencePrefix));
 for(const {source} of saved.records)if(source.document.case_id!==candidate.case_id||source.document.month!==candidate.period.from.slice(0,7)
  ||source.document.month!==candidate.period.to.slice(0,7))throw Error('SAVED_TARIFF_COMPLETION_SCOPE');
 if(route.kind==='required'&&!saved.records.length){
  if(needs.some(n=>n.fact_key===tariffFactKey))throw Error('SAVED_TARIFF_COMPLETION_NEED_COLLISION');
  const dependent_check_ids=[travel.check_prefix+'.expected',travel.check_prefix+'.comparison'];
  if(dependent_check_ids.some(id=>!candidate.checks.some(c=>c.check_id===id)&&!candidate.coverage_gaps.some(g=>g.check_id===id)))throw Error('SAVED_TARIFF_COMPLETION_DEPENDENCY');
  needs.push({fact_key:tariffFactKey,kind:'document',document_kind:'other',reason:'missing',required_evidence_kind:'document',
   question:tariffSourceQuestion,answer_kind:'document',source_pins:[],dependent_check_ids,general_question:false});
 }
 if(route.kind==='required'&&saved.records.length===1){
  const record=saved.records[0],d=record.source.document;
  const replay=materializeTravelTariffSource({travel,current:d,group:record.source.group,journal:record.journal});
  const reading=replay.receipts.find(r=>r.subject==='context'),context=travel.fare_source_context,reconstructed=replay.travel.fare_source_context;
  if(reading){
   const doc=candidate.documents.find(doc=>doc.case_id===d.case_id&&doc.document_id===d.document_id&&doc.version_id===d.version_id
    &&doc.file_sha256===d.file_sha256&&doc.page_count===d.page_count&&doc.kind==='other');
   const pin={case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256};
   const planner=completion.documents.find(doc=>same(doc.pin,pin));
   const value=reading.value?.subject==='context'?reading.value:null;
   const contextMatches=context?.schema_version==='travel-fare-source-context-v2'&&reconstructed?.schema_version==='travel-fare-source-context-v2'
    &&context.source_group_sha256===reading.source_group_sha256&&contextKeys.every(key=>context[key].state==='observed'
     &&context[key].value!==null&&same(context[key],reconstructed[key]));
   const declaredRoute=travel.product_facts?.route_reference,declaredProfile=travel.product_facts?.personal_discount_profile;
   const agrees=(fact:typeof declaredRoute|typeof declaredProfile,actual:string)=>!fact||fact.state==='missing'
    ||((fact.state==='observed'||fact.state==='declared')&&fact.value===actual);
   const observed=reading.state==='identified'&&value&&contextMatches&&doc?.reading_origin==='identified_document_reading'
    &&doc.accepted_reading_sha256?.includes(reading.receipt_sha256)&&(planner?.review==='partial'||planner?.review==='complete')
    &&value.value.effective_period.from<=candidate.period.from&&value.value.effective_period.to>=candidate.period.to
    &&value.value.directions===route.directions&&agrees(declaredRoute,value.value.route_reference)&&agrees(declaredProfile,value.value.discount_profile);
   // All source pins must already be part of the same composed input. An
   // unrelated or replaced purpose is never patched into the planner here.
   if(!doc||!planner)throw Error('SAVED_TARIFF_COMPLETION_SOURCE');
   const state:ReviewEvidence['state']=observed?'observed':reading.state==='unknown'||reading.state==='unreadable'?'unknown':'conflicted';
   evidence.push({evidence_id:tariffEvidencePrefix+d.purpose_sha256,case_id:candidate.case_id,fact_key:tariffFactKey,period:candidate.period,
    origin:'document',state,value:observed?JSON.stringify(value):null,source_pins:[pin],source_reviewed:true});
  }
 }
 // External needs precede generated entitlement needs in the canonical
 // composer. Recompose to preserve that ordering and its replay invariant.
 return composeEntitlementReview({...candidate,completion_input:{...completion,needs,evidence}});
}

/** The SQL opener rechecks purpose/currentness and paid travel scope itself.
 * No OCR checkpoint, client selector or confidence flag authorizes this path. */
export async function openSavedTravelTariffRequests(context:PostgresTransactionContext,job:SourceJob,selectedMonth:string,input:DocumentReviewInput){
 await lockCurrentSource(context,job);
 const orders=await readSavedOrders(context,job);
 if(!orders.some(order=>order.topics.includes('travel')&&purchasedMonths(order).includes(selectedMonth)))return [];
 if(input.case_id!==job.case_id||input.period.from.slice(0,7)!==selectedMonth||input.period.to.slice(0,7)!==selectedMonth)throw Error('SAVED_TARIFF_REVIEW_SCOPE');
 if(input.entitlement_composition)assertEntitlementComposition(input);
 const travel=input.entitlement_composition?.evidence.travel??input.entitlement_evidence?.travel;
 if(!travel||travelProductRoute(travelEntitlementInputSchema.parse(travel)).kind!=='required')return [];
 const attached=attachSavedTravelTariffReadings(input,await readSavedTravelTariffReadings(context,job,selectedMonth)),opened=[];
 for(const dependency of attached.dependencies){
  if(dependency.answered)continue;
  const target=documentTravelTariffTarget({source:dependency.source,subject:dependency.target.subject});
  const result=await context.client.query(statement('saved_travel_tariff_open','select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),documentTravelTariffQuestion(target).question]));
  opened.push({requestId:z.uuid().parse(result.rows[0]?.id),month:selectedMonth,subject:target.tariff.subject,targetSha256:target.target_sha256});
 }
 return opened;
}
