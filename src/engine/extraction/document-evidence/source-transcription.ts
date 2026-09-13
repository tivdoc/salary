import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
const reviewTopicSchema=z.enum(['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']);


const sha=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
export const DOCUMENT_EVIDENCE_SOURCE_TRANSCRIPTION_POLICY='document-evidence-source-transcription-v1' as const;
const dependency=z.object({version_id:z.uuid(),request_id:z.uuid(),answer_revision:z.number().int().positive().safe(),answer_sha256:sha}).strict();
export const evidenceSourcePurchaseSchema=z.object({order_id:z.uuid(),origin:z.enum(['saved_order','legacy_paid_receipt']),receipt_sha256:sha,
 topics:z.array(reviewTopicSchema).min(1).max(10)}).strict().refine(p=>new Set(p.topics).size===p.topics.length&&p.topics.some(t=>t==='contract'||t==='bonuses'),'SOURCE_TRANSCRIPTION_PURCHASE');
/** The loader supplies this from the current source journal and the physical
 * page receipt. A client-supplied self-hash does not authenticate a source. */
export const evidenceSourceDocumentSchema=z.object({case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,
 document_kind:z.literal('contract'),document_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/u).nullable(),page_count:z.number().int().positive().max(100),
 reading_dependencies:z.array(dependency).max(512)}).strict().superRefine((s,c)=>{
 if(s.reading_dependencies.some(d=>d.version_id!==s.version_id)||new Set(s.reading_dependencies.map(d=>d.request_id)).size!==s.reading_dependencies.length)
  c.addIssue({code:'custom',message:'SOURCE_TRANSCRIPTION_DEPENDENCIES'});
});
export type EvidenceSourceDocument=z.infer<typeof evidenceSourceDocumentSchema>;
export type EvidenceSourcePurchase=z.infer<typeof evidenceSourcePurchaseSchema>;
const sourceTranscriptionTargetBase=evidenceSourceDocumentSchema.safeExtend({
 schema_version:z.enum(['document-evidence-source-transcription-v1','document-evidence-source-transcription-v2']),policy_version:z.enum(['document-evidence-source-transcription-v1','document-evidence-source-transcription-v2']),
 month,period,page:z.number().int().positive().max(100).nullable(),subject:z.object({kind:z.literal('financial_clause'),semantic:z.literal('clause_text')}).strict(),
 order_id:z.uuid(),order_origin:z.enum(['saved_order','legacy_paid_receipt']),order_receipt_sha256:sha,purchased_topics:z.array(reviewTopicSchema).min(1).max(10),target_sha256:sha,
}).superRefine((t,c)=>{
 const {target_sha256,...body}=t;
 if(canonicalSha256(body)!==target_sha256)c.addIssue({code:'custom',message:'SOURCE_TRANSCRIPTION_TARGET_HASH'});
 if(t.policy_version!==t.schema_version||(t.schema_version==='document-evidence-source-transcription-v1'?t.page===null||t.page>t.page_count:t.page!==null)
  ||canonicalSha256(t.period)!==canonicalSha256(sourceTranscriptionMonthPeriod(t.month)))c.addIssue({code:'custom',message:'SOURCE_TRANSCRIPTION_PERIOD_PAGE'});
 if(!evidenceSourcePurchaseSchema.safeParse({order_id:t.order_id,origin:t.order_origin,receipt_sha256:t.order_receipt_sha256,topics:t.purchased_topics}).success)
  c.addIssue({code:'custom',message:'SOURCE_TRANSCRIPTION_PURCHASE'});
});
export const documentEvidenceSourceTranscriptionTargetSchema=z.union([
 sourceTranscriptionTargetBase.safeExtend({schema_version:z.literal('document-evidence-source-transcription-v1'),
  policy_version:z.literal('document-evidence-source-transcription-v1'),page:z.number().int().positive().max(100)}),
 sourceTranscriptionTargetBase.safeExtend({schema_version:z.literal('document-evidence-source-transcription-v2'),
  policy_version:z.literal('document-evidence-source-transcription-v2'),page:z.null()}),
]);
export type DocumentEvidenceSourceTranscriptionTarget=z.infer<typeof documentEvidenceSourceTranscriptionTargetSchema>;
export function sourceTranscriptionMonthPeriod(value:string){
 const checked=month.parse(value),from=checked+'-01',date=new Date(from+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+1);date.setUTCDate(0);
 return period.parse({from,to:date.toISOString().slice(0,10)});
}
export function documentEvidenceSourceTranscriptionTarget(input:{source:EvidenceSourceDocument;purchase:EvidenceSourcePurchase;month:string;page:number|null}):DocumentEvidenceSourceTranscriptionTarget{
 const source=evidenceSourceDocumentSchema.parse(input.source),purchase=evidenceSourcePurchaseSchema.parse(input.purchase);
 const body={...source,reading_dependencies:[...source.reading_dependencies].sort((a,b)=>a.request_id.localeCompare(b.request_id)),
  schema_version:input.page===null?'document-evidence-source-transcription-v2' as const:'document-evidence-source-transcription-v1' as const,
  policy_version:input.page===null?'document-evidence-source-transcription-v2' as const:DOCUMENT_EVIDENCE_SOURCE_TRANSCRIPTION_POLICY,
  month:input.month,period:sourceTranscriptionMonthPeriod(input.month),page:input.page,subject:{kind:'financial_clause' as const,semantic:'clause_text' as const},
  order_id:purchase.order_id,order_origin:purchase.origin,order_receipt_sha256:purchase.receipt_sha256,purchased_topics:purchase.topics};
 return deepFreeze(documentEvidenceSourceTranscriptionTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}

/** No confirm action exists: an untranscribed source has no proposed value. */
const fixedPageAnswerSchema=z.discriminatedUnion('action',[
 z.object({schema_version:z.literal('document-evidence-source-answer-v1'),action:z.literal('correct'),
  value:z.object({raw_value:z.string().trim().min(1).max(1600),locator:z.string().trim().min(1).max(120)}).strict()}).strict(),
 z.object({schema_version:z.literal('document-evidence-source-answer-v1'),action:z.literal('unknown')}).strict(),
 z.object({schema_version:z.literal('document-evidence-source-answer-v1'),action:z.literal('unreadable')}).strict(),
]);
const selectedPageAnswerSchema=z.discriminatedUnion('action',[
 z.object({schema_version:z.literal('document-evidence-source-answer-v2'),action:z.literal('correct'),
  value:z.object({page:z.number().int().positive().max(100),raw_value:z.string().trim().min(1).max(1600),locator:z.string().trim().min(1).max(120)}).strict()}).strict(),
 z.object({schema_version:z.literal('document-evidence-source-answer-v2'),action:z.literal('unknown')}).strict(),
 z.object({schema_version:z.literal('document-evidence-source-answer-v2'),action:z.literal('unreadable')}).strict(),
]);
export const documentEvidenceSourceAnswerSchema=z.union([fixedPageAnswerSchema,selectedPageAnswerSchema]);
export type DocumentEvidenceSourceAnswer=z.infer<typeof documentEvidenceSourceAnswerSchema>;
export function validateDocumentEvidenceSourceAnswer(target:unknown,wire:unknown){
 const t=documentEvidenceSourceTranscriptionTargetSchema.parse(target);
 try{
  const answer=documentEvidenceSourceAnswerSchema.parse(typeof wire==='string'?JSON.parse(wire):wire);
  if(JSON.stringify(answer).length>2000||answer.schema_version!==(t.page===null?'document-evidence-source-answer-v2':'document-evidence-source-answer-v1')
   ||answer.action==='correct'&&answer.schema_version==='document-evidence-source-answer-v2'&&answer.value.page>t.page_count)throw Error('REQUEST_ANSWER_INVALID');
  return answer;
 }catch{throw Error('REQUEST_ANSWER_INVALID');}
}
export type EvidenceSourceTranscriptionContext=Readonly<{kind:'financial_clause';max_characters:1600}&({page:number}|{page:null;page_count:number})>;
export function documentEvidenceSourceTranscriptionQuestion(input:unknown){
 const t=documentEvidenceSourceTranscriptionTargetSchema.parse(input);
 return {code:`document_field:${t.target_sha256}`,question:t.page===null
  ?'במסמך תנאי ההעסקה, יש לבחור את העמוד שבו מופיע סעיף כספי רלוונטי ולהעתיק אותו במלואו, לרבות התנאים וההפניות שבו. אם לא נמצא סעיף מתאים, יש לבחור לא יודע. ההעתקה אינה אישור זכאות או תוקף ההסכם.'
  :`בעמוד ${t.page} במסמך תנאי ההעסקה, יש להעתיק סעיף כספי רלוונטי במלואו, לרבות התנאים וההפניות שבו. אם אין סעיף כזה בעמוד, יש לבחור לא יודע. ההעתקה אינה אישור זכאות או תוקף ההסכם.`,
  answer_kind:'choice' as const,options:['העתקת הסעיף מהמקור','לא קריא','לא יודע'],field_crop:'source_transcription.financial_clause',blocking:false};
}
const excludedSchemas=new Set(['document-evidence-source-transcription-v1','document-evidence-source-transcription-v2','obligation-payment-choice-v1','obligation-payment-link-v1']);
/** Complete source-answer dependencies, not just already-known period fields.
 * New period answers stale old targets; this target's own answer does not. */
export function evidenceSourceReadingDependencies(journal:unknown,caseId:string,versionId:string){
 z.uuid().parse(caseId);z.uuid().parse(versionId);
 const {answers}=z.object({answers:z.array(z.record(z.string(),z.unknown()))}).parse(journal);
 const rows:z.infer<typeof dependency>[]=[];
 for(const raw of answers){
  if(typeof raw.code!=='string'||!raw.code.startsWith('document_field:')||!raw.field_target||typeof raw.field_target!=='object')continue;
  const target=raw.field_target as Record<string,unknown>;
  if(target.version_id!==versionId||excludedSchemas.has(String(target.schema_version)))continue;
  const a=z.object({id:z.uuid(),case_id:z.literal(caseId),answer_revision:z.number().int().positive().safe(),answer:z.string(),
   answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true})}).parse(raw);
  if(target.case_id!==caseId)throw Error('SOURCE_TRANSCRIPTION_FOREIGN_DEPENDENCY');
  rows.push({version_id:versionId,request_id:a.id,answer_revision:a.answer_revision,answer_sha256:canonicalSha256(a.answer)});
 }
 if(new Set(rows.map(r=>r.request_id)).size!==rows.length)throw Error('SOURCE_TRANSCRIPTION_DUPLICATE_DEPENDENCY');
 return rows.sort((a,b)=>a.request_id.localeCompare(b.request_id));
}
export const documentEvidenceSourceReadingSchema=z.object({schema_version:z.literal('document-evidence-source-reading-v1'),
 origin:z.literal('identified_document_transcription'),target:documentEvidenceSourceTranscriptionTargetSchema,request_id:z.uuid(),answer_revision:z.number().int().positive().safe(),
 identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),answer:documentEvidenceSourceAnswerSchema,
 value:z.object({kind:z.literal('text'),text:z.string().min(1).max(1600),page:z.number().int().positive(),locator:z.string().min(1).max(120)}).strict().nullable(),
 state:z.enum(['identified_reading','unknown','unreadable']),basis:z.literal('system_action_context:identified_source_transcription'),
 legal_applicability_approved:z.literal(false),verification_sha256:sha,
}).strict();
export type DocumentEvidenceSourceReading=z.infer<typeof documentEvidenceSourceReadingSchema>;
export function resolveDocumentEvidenceSourceReading(input:{target:unknown;currentSource:EvidenceSourceDocument;currentPurchase:EvidenceSourcePurchase;caseId:string;month:string;
 requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:unknown}){
 const target=documentEvidenceSourceTranscriptionTargetSchema.parse(input.target),answer=validateDocumentEvidenceSourceAnswer(target,input.answer);
 if(target.case_id!==z.uuid().parse(input.caseId)||input.currentSource.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().safe().parse(input.answerRevision);z.iso.datetime({offset:true}).parse(input.answeredAt);
 let current:DocumentEvidenceSourceTranscriptionTarget;
 try{current=documentEvidenceSourceTranscriptionTarget({source:input.currentSource,purchase:input.currentPurchase,month:input.month,page:target.page});}catch{return {state:'stale' as const};}
 if(current.target_sha256!==target.target_sha256)return {state:'stale' as const};
 const body={schema_version:'document-evidence-source-reading-v1' as const,origin:'identified_document_transcription' as const,target,request_id:input.requestId,
  answer_revision:input.answerRevision,identity_id:input.identityId,answered_at:input.answeredAt,answer,
  value:answer.action==='correct'?{kind:'text' as const,text:answer.value.raw_value,page:answer.schema_version==='document-evidence-source-answer-v2'?answer.value.page:target.page,locator:answer.value.locator}:null,
  state:answer.action==='correct'?'identified_reading' as const:answer.action,basis:'system_action_context:identified_source_transcription' as const,legal_applicability_approved:false as const};
 return {state:'current' as const,reading:deepFreeze(documentEvidenceSourceReadingSchema.parse({...body,verification_sha256:canonicalSha256(body)}))};
}
export function parseDocumentEvidenceSourceReading(input:unknown){
 const r=documentEvidenceSourceReadingSchema.parse(input),{verification_sha256,...body}=r,answer=validateDocumentEvidenceSourceAnswer(r.target,r.answer);
 const value=answer.action==='correct'?{kind:'text',text:answer.value.raw_value,page:answer.schema_version==='document-evidence-source-answer-v2'?answer.value.page:r.target.page,locator:answer.value.locator}:null;
 if(canonicalSha256(body)!==verification_sha256||canonicalSha256(value)!==canonicalSha256(r.value)||r.state!==(answer.action==='correct'?'identified_reading':answer.action))
  throw Error('SOURCE_TRANSCRIPTION_READING_CHANGED');
 return deepFreeze(r);
}
