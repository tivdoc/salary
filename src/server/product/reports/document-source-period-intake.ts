import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {LEGACY_PAID_TOPICS,parseLegacyPaidScope,type LegacyPaidScope} from '../orders/legacy-paid-receipt.ts';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const DOCUMENT_SOURCE_PERIOD_INTAKE_POLICY='legacy-source-intake-v1' as const;
export const sourceIntakeDocumentSchema=z.object({id:z.uuid(),version_id:z.uuid(),sha256:sha,type:z.string(),page_count:z.number().int().min(1).max(100).nullable()});
export const sourceIntakeAnchorSchema=z.object({revision:z.number().int().positive(),input_sha256:sha,journal_sha256:sha,input:z.unknown()});
export type SourceIntakeDocument=z.infer<typeof sourceIntakeDocumentSchema>;
export type SourceIntakeAnchor=z.infer<typeof sourceIntakeAnchorSchema>;
const topics=z.array(z.enum(LEGACY_PAID_TOPICS)).length(9).refine(v=>JSON.stringify(v)===JSON.stringify(LEGACY_PAID_TOPICS));
const base=z.object({case_id:z.uuid(),order_id:z.uuid(),order_origin:z.literal('legacy_paid_receipt'),order_receipt_sha256:sha,purchased_topics:topics,
 source_revision:z.number().int().positive(),source_input_sha256:sha,source_journal_sha256:sha,month:z.null(),policy_version:z.literal(DOCUMENT_SOURCE_PERIOD_INTAKE_POLICY)});
export const documentSourcePeriodIntakeTargetSchema=base.extend({schema_version:z.literal('document-source-period-intake-v1'),product_document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,
 page_count:z.number().int().min(1).max(100),subject:z.object({kind:z.literal('source_period_and_type')}).strict(),target_sha256:sha}).strict().superRefine((t,ctx)=>{
 const {target_sha256,...body}=t;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'SOURCE_INTAKE_TARGET_HASH'});
});
export type DocumentSourcePeriodIntakeTarget=z.infer<typeof documentSourcePeriodIntakeTargetSchema>;
export const legacySourceDocumentNeedTargetSchema=base.extend({schema_version:z.literal('legacy-source-intake-document-v1'),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).nullable(),target_sha256:sha}).strict().superRefine((t,ctx)=>{
 const {target_sha256,...body}=t;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'SOURCE_INTAKE_TARGET_HASH'});
});
const journalSchema=z.object({case_id:z.uuid(),documents:z.array(sourceIntakeDocumentSchema.omit({page_count:true})),legacy_orders:z.array(z.unknown())});
/** The caller authenticates the PG hash against stored input::text. This module
 * separately checks canonical bytes, exact original scope and source membership. */
export function assertSourceIntakeAnchor(raw:unknown,scope:LegacyPaidScope,document?:SourceIntakeDocument){
 const anchor=sourceIntakeAnchorSchema.parse(raw),journal=journalSchema.parse(anchor.input);
 if(canonicalSha256(anchor.input)!==anchor.journal_sha256||journal.case_id!==scope.case_id)throw Error('SOURCE_INTAKE_ANCHOR_HASH');
 const scopes=journal.legacy_orders.map(parseLegacyPaidScope).filter(s=>s.id===scope.id);
 if(scopes.length!==1||scopes[0].receipt_sha256!==scope.receipt_sha256)throw Error('SOURCE_INTAKE_ANCHOR_SCOPE');
 if(document&&journal.documents.filter(d=>d.id===document.id&&d.version_id===document.version_id&&d.sha256===document.sha256&&d.type===document.type).length!==1)
  throw Error('SOURCE_INTAKE_ANCHOR_DOCUMENT');
 return anchor;
}
function scopeBody(scope:LegacyPaidScope,anchor:SourceIntakeAnchor){return {case_id:scope.case_id,order_id:scope.id,order_origin:'legacy_paid_receipt' as const,
 order_receipt_sha256:scope.receipt_sha256,purchased_topics:[...scope.topics],source_revision:anchor.revision,source_input_sha256:anchor.input_sha256,
 source_journal_sha256:anchor.journal_sha256,month:null,policy_version:DOCUMENT_SOURCE_PERIOD_INTAKE_POLICY};}
export function documentSourcePeriodIntakeTarget(input:{source:{document:SourceIntakeDocument;anchor:SourceIntakeAnchor};scope:LegacyPaidScope}){
 const scope=parseLegacyPaidScope(input.scope),document=sourceIntakeDocumentSchema.parse(input.source.document),anchor=assertSourceIntakeAnchor(input.source.anchor,scope,document);
 if(document.page_count===null)throw Error('SOURCE_INTAKE_PAGE_COUNT_REQUIRED');
 const body={...scopeBody(scope,anchor),schema_version:'document-source-period-intake-v1' as const,product_document_id:document.id,version_id:document.version_id,
  source_sha256:document.sha256,page_count:document.page_count,subject:{kind:'source_period_and_type' as const}};
 return deepFreeze(documentSourcePeriodIntakeTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function legacySourceDocumentNeedTarget(input:{scope:LegacyPaidScope;anchor:SourceIntakeAnchor;month?:string}){
 const scope=parseLegacyPaidScope(input.scope),anchor=assertSourceIntakeAnchor(input.anchor,scope),body={...scopeBody(scope,anchor),month:input.month??null,schema_version:'legacy-source-intake-document-v1' as const};
 return deepFreeze(legacySourceDocumentNeedTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(v=>v.from<=v.to).refine(v=>
 (Number(v.to.slice(0,4))-Number(v.from.slice(0,4)))*12+Number(v.to.slice(5,7))-Number(v.from.slice(5,7))<600,'SOURCE_INTAKE_PERIOD_TOO_WIDE');
export const documentSourcePeriodIntakeAnswerSchema=z.discriminatedUnion('action',[
 z.object({v:z.literal(1),action:z.literal('correct'),value:z.object({document_kind:z.enum(['payslip','attendance','contract','other']),period:period.nullable(),
  page:z.number().int().min(1).max(100),source_label:z.string().trim().min(1).max(400)}).strict()}).strict(),
 z.object({v:z.literal(1),action:z.enum(['unknown','unreadable'])}).strict(),
]);
export function parseDocumentSourcePeriodIntakeAnswer(raw:unknown){
 let value=raw;if(typeof value==='string'){if(value.length>2000)throw Error('REQUEST_ANSWER_INVALID');try{value=JSON.parse(value);}catch{throw Error('REQUEST_ANSWER_INVALID');}}
 const result=documentSourcePeriodIntakeAnswerSchema.safeParse(value);if(!result.success)throw Error('REQUEST_ANSWER_INVALID');return result.data;
}
export function validateDocumentSourcePeriodIntakeAnswer(target:unknown,raw:unknown){
 const t=documentSourcePeriodIntakeTargetSchema.parse(target),answer=parseDocumentSourcePeriodIntakeAnswer(raw);
 if(answer.action==='correct'&&answer.value.page>t.page_count)throw Error('REQUEST_ANSWER_INVALID');return answer;
}
export function documentSourcePeriodIntakeQuestion(target:unknown){
 const t=documentSourcePeriodIntakeTargetSchema.parse(target);return {code:`document_field:${t.target_sha256}`,question:'מה סוג המסמך ומהם תאריכי התקופה המופיעים בו? יש להעתיק את כותרת התקופה או לציין שלא מוצגת תקופה.',
 answer_kind:'choice' as const,options:['העתקת הפרט מהמקור','לא ניתן לקרוא','לא יודע/ת'],field_crop:'source.period_and_type',blocking:true};
}
export function documentSourcePeriodIntakeDisplay(target:unknown){
 const t=documentSourcePeriodIntakeTargetSchema.parse(target);return {question:documentSourcePeriodIntakeQuestion(t).question,field:'source.period_and_type',raw_value:null,
 source:{version_id:t.version_id,source_sha256:t.source_sha256,page:1,text_fragment:null,region:null,source_scope:null,bounding_box:null},target_sha256:t.target_sha256,
 actions:['correct','unreadable','unknown'] as const,scope:'source_period_intake_only' as const,period_intake_context:{page_count:t.page_count,month:null}};
}
export function resolveDocumentSourcePeriodIntakeVerification(input:{target:unknown;scope:LegacyPaidScope;currentDocument:SourceIntakeDocument;anchor:SourceIntakeAnchor;
 currentRevision:number;requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:unknown}){
 const target=documentSourcePeriodIntakeTargetSchema.parse(input.target),scope=parseLegacyPaidScope(input.scope);
 z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);z.number().int().positive().parse(input.currentRevision);
 const answeredAt=z.iso.datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==scope.case_id)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(input.anchor.revision>input.currentRevision)return {state:'stale' as const};
 const current=documentSourcePeriodIntakeTarget({scope,source:{document:input.currentDocument,anchor:input.anchor}});
 if(current.target_sha256!==target.target_sha256)return {state:'stale' as const};
 const answer=validateDocumentSourcePeriodIntakeAnswer(target,input.answer);
 const body={schema_version:'customer-source-period-intake-reading-v1' as const,origin:'customer_document_reading' as const,target,
 request_id:input.requestId,answer_revision:input.answerRevision,identity_id:input.identityId,answered_at:new Date(answeredAt).toISOString(),answer};
 return deepFreeze({state:'intake_current' as const,reading:{...body,reading_sha256:canonicalSha256(body)}});
}
export type SourcePeriodIntakeReading=Extract<ReturnType<typeof resolveDocumentSourcePeriodIntakeVerification>,{state:'intake_current'}>['reading'];
