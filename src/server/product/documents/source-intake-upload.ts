import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {LEGACY_PAID_TOPICS} from '../orders/legacy-paid-receipt';
import {legacySourceDocumentNeedTargetSchema,legacySourceDocumentNeedTarget,sourceIntakeAnchorSchema} from '../reports/document-source-period-intake';
import {savedLegacySourceIntake,effectiveLegacySourcePeriods,sourceIntakeJournalInputSchema,sourceIntakeFullMonths} from '../processing/saved-legacy-source-intake';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const topics=z.array(z.enum(LEGACY_PAID_TOPICS)).length(9).refine(v=>JSON.stringify(v)===JSON.stringify(LEGACY_PAID_TOPICS));
export const sourceIntakeUploadScopeSchema=z.object({schema_version:z.literal('legacy-source-intake-upload-scope-v1'),request_id:z.uuid(),
 target:legacySourceDocumentNeedTargetSchema}).strict();
export type SourceIntakeUploadScope=z.infer<typeof sourceIntakeUploadScopeSchema>;
export const sourceIntakeUploadFileSchema=z.object({document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,document_kind:z.enum(['payslip','attendance','contract']),
 period_month:z.null(),page_count:z.number().int().min(1).max(100),duplicate_content:z.boolean()}).strict();
export const sourceIntakeUploadReceiptSchema=z.object({schema_version:z.literal('legacy-source-intake-upload-receipt-v1'),case_id:z.uuid(),request_id:z.uuid(),target_sha256:sha,
 order_id:z.uuid(),order_origin:z.literal('legacy_paid_receipt'),order_receipt_sha256:sha,purchased_topics:topics,month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).nullable(),batch_id:z.uuid(),received_at:z.iso.datetime({offset:true}),
 state:z.literal('received_pending_reading'),information_satisfied:z.literal(false),files:z.array(sourceIntakeUploadFileSchema).min(1).max(14),receipt_sha256:sha}).strict().superRefine((r,ctx)=>{
 const {receipt_sha256,...body}=r;if(canonicalSha256(body)!==receipt_sha256)ctx.addIssue({code:'custom',message:'SOURCE_INTAKE_UPLOAD_RECEIPT_HASH'});
 if(new Set(r.files.map(f=>f.version_id)).size!==r.files.length||new Set(r.files.map(f=>f.document_id)).size!==r.files.length)ctx.addIssue({code:'custom',message:'SOURCE_INTAKE_UPLOAD_DUPLICATE_VERSION'});
});
export type SourceIntakeUploadReceipt=z.infer<typeof sourceIntakeUploadReceiptSchema>;
export function buildSourceIntakeUploadReceipt(input:{scope:SourceIntakeUploadScope;case_id:string;batch_id:string;received_at:string;
 files:z.infer<typeof sourceIntakeUploadFileSchema>[];existing_source_hashes:readonly string[]}){
 const scope=sourceIntakeUploadScopeSchema.parse(input.scope),t=scope.target;if(t.case_id!==input.case_id)throw Error('UPLOAD_FORBIDDEN');
 const files=input.files.map(f=>sourceIntakeUploadFileSchema.parse(f)),prior=new Set(input.existing_source_hashes);
 const body={schema_version:'legacy-source-intake-upload-receipt-v1' as const,case_id:t.case_id,request_id:scope.request_id,target_sha256:t.target_sha256,
 order_id:t.order_id,order_origin:t.order_origin,order_receipt_sha256:t.order_receipt_sha256,purchased_topics:t.purchased_topics,month:t.month,batch_id:input.batch_id,received_at:input.received_at,
 state:'received_pending_reading' as const,information_satisfied:false as const,files:files.map(f=>({...f,duplicate_content:f.duplicate_content||prior.has(f.source_sha256)
  ||files.filter(other=>other.source_sha256===f.source_sha256).length!==1})).sort((a,b)=>a.version_id.localeCompare(b.version_id))};
 return deepFreeze(sourceIntakeUploadReceiptSchema.parse({...body,receipt_sha256:canonicalSha256(body)}));
}
export const sourceIntakeUploadReasons=['submitted_source_replaced','duplicate_content','source_reading_required','source_reading_unresolved','complete_month_not_identified','source_period_identified'] as const;
/** Intake satisfaction is a source-reading result, never a financial analysis
 * or a claim that the nine purchased topics have been evaluated. */
export function assessSourceIntakeUpload(input:{scope:SourceIntakeUploadScope;receipt:SourceIntakeUploadReceipt;journalContext:unknown}){
 const scope=sourceIntakeUploadScopeSchema.parse(input.scope),r=sourceIntakeUploadReceiptSchema.parse(input.receipt),t=scope.target,saved=savedLegacySourceIntake(input.journalContext);
 if(r.case_id!==t.case_id||saved.case_id!==r.case_id||r.request_id!==scope.request_id||r.target_sha256!==t.target_sha256||r.order_id!==t.order_id
  ||r.order_receipt_sha256!==t.order_receipt_sha256||r.month!==t.month||canonicalSha256(r.purchased_topics)!==canonicalSha256(t.purchased_topics))throw Error('SOURCE_INTAKE_UPLOAD_SCOPE');
 const actualScope=saved.scopes.find(s=>s.id===r.order_id&&s.receipt_sha256===r.order_receipt_sha256);
 if(!actualScope)throw Error('SOURCE_INTAKE_UPLOAD_SCOPE');
 const pins=r.files.map(f=>({case_id:r.case_id,document_id:f.document_id,version_id:f.version_id,source_sha256:f.source_sha256}));
 const result=(state:'received_pending_reading'|'insufficient'|'satisfied'|'stale',reason:typeof sourceIntakeUploadReasons[number],readingHashes:string[]=[],verifiedPins:typeof pins=[])=>{
  const body={schema_version:'legacy-source-intake-upload-assessment-v1' as const,case_id:r.case_id,request_id:r.request_id,receipt_sha256:r.receipt_sha256,target_sha256:r.target_sha256,
   source_revision:saved.revision,source_input_sha256:saved.head.input_sha256,source_journal_sha256:saved.head.journal_sha256,state,reason,information_satisfied:state==='satisfied',
   reading_sha256s:readingHashes,verified_source_pins:state==='satisfied'?verifiedPins:[],financial_analysis_completed:false as const};
  return deepFreeze({...body,assessment_sha256:canonicalSha256(body)});
 };
 if(r.files.some(f=>!saved.documents.some(d=>d.id===f.document_id&&d.version_id===f.version_id&&d.sha256===f.source_sha256&&d.type===f.document_kind&&d.page_count===f.page_count)))return result('stale','submitted_source_replaced');
 if(r.files.some(f=>f.duplicate_content))return result('insufficient','duplicate_content');
 const readings=saved.readings.filter(reading=>reading.target.order_id===r.order_id&&reading.target.order_receipt_sha256===r.order_receipt_sha256
  &&r.files.some(f=>f.document_id===reading.target.product_document_id&&f.version_id===reading.target.version_id&&f.source_sha256===reading.target.source_sha256));
 if(!readings.length)return result('received_pending_reading','source_reading_required');
 if(readings.some(reading=>reading.answer.action!=='correct'))return result('insufficient','source_reading_unresolved');
 const effective=effectiveLegacySourcePeriods(actualScope,saved),accepted=effective.periods.filter(p=>readings.some(r=>r.reading_sha256===p.reading_sha256)
  &&(t.month===null||p.source_document_kind==='payslip'&&sourceIntakeFullMonths(p.period).includes(t.month)));
 if(effective.conflicts.some(v=>r.files.some(f=>f.version_id===v))||!accepted.length)return result('insufficient','complete_month_not_identified');
 return result('satisfied','source_period_identified',accepted.map(p=>p.reading_sha256).sort(),pins.filter(pin=>accepted.some(p=>p.source_pins.some(v=>canonicalSha256(v)===canonicalSha256(pin)))));
}
export const sourceIntakeUploadStateSchema=z.object({request_id:z.uuid(),state:z.enum(['requested','received_pending_reading','insufficient','satisfied','stale']),source_current:z.boolean(),
 information_satisfied:z.boolean(),reason:z.enum(sourceIntakeUploadReasons).nullable(),reading_request_ids:z.array(z.uuid()).max(14)}).strict().superRefine((r,ctx)=>{
 if(r.information_satisfied!==(r.state==='satisfied')||r.information_satisfied&&(!r.source_current||r.reason!=='source_period_identified'))ctx.addIssue({code:'custom',message:'SOURCE_INTAKE_UPLOAD_STATE'});
 if(r.state==='requested'&&r.reason!==null||new Set(r.reading_request_ids).size!==r.reading_request_ids.length)ctx.addIssue({code:'custom',message:'SOURCE_INTAKE_UPLOAD_STATE'});
});
export type SourceIntakeUploadState=Omit<z.infer<typeof sourceIntakeUploadStateSchema>,'request_id'|'source_current'>;
export const sourceIntakeUploadContextSchema=z.object({scope:sourceIntakeUploadScopeSchema,receipt:sourceIntakeUploadReceiptSchema.nullable(),journalContext:z.unknown(),reading_request_ids:z.array(z.uuid()).max(14)}).strict();
/** Read-only projection and worker persistence use this same replay result.
 * A server context is required even before the first upload. */
export function projectSourceIntakeUploadContext(raw:unknown,caseId:string){
 const input=sourceIntakeUploadContextSchema.parse(raw),t=input.scope.target,context=sourceIntakeJournalInputSchema.parse(input.journalContext);
 if(t.case_id!==caseId||context.caseId!==caseId)throw Error('SOURCE_INTAKE_UPLOAD_SCOPE');
 const saved=savedLegacySourceIntake(context),scope=saved.scopes.find(s=>s.id===t.order_id&&s.receipt_sha256===t.order_receipt_sha256);
 const anchor=z.array(sourceIntakeAnchorSchema).parse(context.sourceAnchors).find(a=>a.revision===t.source_revision&&a.input_sha256===t.source_input_sha256&&a.journal_sha256===t.source_journal_sha256);
 if(!anchor||anchor.revision>saved.revision)throw Error('SOURCE_INTAKE_UPLOAD_ANCHOR');
 if(scope&&legacySourceDocumentNeedTarget({scope,anchor,...(t.month?{month:t.month}:{})}).target_sha256!==t.target_sha256)throw Error('SOURCE_INTAKE_UPLOAD_TARGET');
 const assessment=scope&&input.receipt?assessSourceIntakeUpload({scope:input.scope,receipt:input.receipt,journalContext:context}):null;
 const current=!!scope&&assessment?.state!=='stale';
 const state=sourceIntakeUploadStateSchema.parse({request_id:input.scope.request_id,state:current?assessment?.state??'requested':'stale',source_current:current,
  information_satisfied:assessment?.information_satisfied??false,reason:current?assessment?.reason??null:'submitted_source_replaced',reading_request_ids:current?input.reading_request_ids:[]});
 return deepFreeze({state,assessment});
}
