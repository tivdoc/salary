import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^2026-(05|06|07)$/u);
export const TRAVEL_TARIFF_POLICY=deepFreeze({schema_version:'travel-tariff-source-policy-v1',purpose:'travel_tariff',physical_document_type:'other',provider_proposal:false,
 subjects:['context','daily_fare','ticket_inventory','monthly_pass_cost'],source_reading_only:true,legal_applicability_approved:false,latest_authenticated_answer_only:true});
export const TRAVEL_TARIFF_POLICY_SHA256=canonicalSha256(TRAVEL_TARIFF_POLICY);
/** The caller obtains this snapshot from the ordinary current document journal,
 * including its persisted purpose. No tariff is inferred from a payslip amount. */
export const travelTariffDocumentSchema=z.object({case_id:z.uuid(),document_id:z.uuid(),version_id:z.uuid(),file_sha256:hash,page_count:z.number().int().min(1).max(100),
 month,evidence_purpose:z.literal('travel_tariff'),document_type:z.literal('other'),purpose_sha256:hash}).strict();
export const travelTariffGroupSchema=z.object({page:z.number().int().min(1).max(100),locator:z.string().trim().min(1).max(120)}).strict();
export const travelTariffSubjectSchema=z.enum(['context','daily_fare','ticket_inventory','monthly_pass_cost']);
export const travelTariffTargetSchema=z.object({schema_version:z.literal('travel-tariff-transcription-v1'),document:travelTariffDocumentSchema,group:travelTariffGroupSchema,
 subject:travelTariffSubjectSchema,policy_sha256:z.literal(TRAVEL_TARIFF_POLICY_SHA256),source_group_sha256:hash,target_sha256:hash}).strict().superRefine((v,ctx)=>{
 const {target_sha256,...body}=v;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'TRAVEL_TARIFF_TARGET_HASH'});
 if(v.source_group_sha256!==canonicalSha256({schema_version:'travel-tariff-source-group-v1',document:v.document,group:v.group,policy_sha256:v.policy_sha256})||v.group.page>v.document.page_count)ctx.addIssue({code:'custom',message:'TRAVEL_TARIFF_GROUP_SCOPE'});
});
export type TravelTariffDocument=z.infer<typeof travelTariffDocumentSchema>;
export type TravelTariffTarget=z.infer<typeof travelTariffTargetSchema>;
export function travelTariffTarget(document:TravelTariffDocument,group:z.infer<typeof travelTariffGroupSchema>,subject:z.infer<typeof travelTariffSubjectSchema>):TravelTariffTarget{
 const d=travelTariffDocumentSchema.parse(document),g=travelTariffGroupSchema.parse(group),body={schema_version:'travel-tariff-transcription-v1' as const,document:d,group:g,subject,policy_sha256:TRAVEL_TARIFF_POLICY_SHA256,
 source_group_sha256:canonicalSha256({schema_version:'travel-tariff-source-group-v1',document:d,group:g,policy_sha256:TRAVEL_TARIFF_POLICY_SHA256})};
 return deepFreeze(travelTariffTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
const basis=z.object({page:z.number().int().min(1).max(100),locator:z.string().trim().min(1).max(120),text:z.string().trim().min(1).max(160)}).strict();
const money=z.string().regex(/^(0|[1-9]\d{0,8})(?:\.\d{1,2})?$/u);
const context=z.object({route_reference:z.string().trim().min(1).max(200),discount_profile:z.enum(['standard_adult','special_discount']),effective_period:z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to),directions:z.enum(['both','outbound','return'])}).strict();
const inventory=z.object({ticket_inventory:z.enum(['complete','partial']),monthly_pass_availability:z.enum(['available','unavailable'])}).strict();
const structured=z.discriminatedUnion('subject',[
 z.object({kind:z.literal('travel_tariff'),subject:z.literal('context'),value:context,basis}).strict(),
 z.object({kind:z.literal('travel_tariff'),subject:z.literal('daily_fare'),value:money,basis}).strict(),
 z.object({kind:z.literal('travel_tariff'),subject:z.literal('ticket_inventory'),value:inventory,basis}).strict(),
 z.object({kind:z.literal('travel_tariff'),subject:z.literal('monthly_pass_cost'),value:money,basis}).strict(),
]);
// Uses the ordinary document_field v3 answer envelope. The dispatcher adds this
// structured kind; this module creates neither a second store nor an identity.
export const travelTariffAnswerSchema=z.discriminatedUnion('action',[
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('correct'),structured_value:structured}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('unknown')}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('unreadable')}).strict(),
]).refine(a=>JSON.stringify(a).length<=2000,'TRAVEL_TARIFF_ANSWER_LENGTH');
export type TravelTariffAnswer=z.infer<typeof travelTariffAnswerSchema>;
export function validateTravelTariffAnswer(target:TravelTariffTarget,candidate:unknown):TravelTariffAnswer{
 const t=travelTariffTargetSchema.parse(target),answer=travelTariffAnswerSchema.parse(candidate);
 if(answer.action==='correct'&&(answer.structured_value.subject!==t.subject||answer.structured_value.basis.page!==t.group.page))throw Error('TRAVEL_TARIFF_ANSWER_TARGET');
 return answer;
}
/** Only records already authenticated by the ordinary request/answer journal
 * may be supplied. Runtime receipt hashes are reconstructed, never accepted as
 * proof of authentication merely because a caller provides a matching hash. */
export const travelTariffJournalEntrySchema=z.object({target:travelTariffTargetSchema,request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),answered_at:z.iso.datetime(),answer:travelTariffAnswerSchema}).strict();
export type TravelTariffJournalEntry=z.infer<typeof travelTariffJournalEntrySchema>;
export function resolveTravelTariffReading(current:TravelTariffDocument,entry:TravelTariffJournalEntry){
 const e=travelTariffJournalEntrySchema.parse(entry),answer=validateTravelTariffAnswer(e.target,e.answer),d=travelTariffDocumentSchema.parse(current);
 if(canonicalSha256(d)!==canonicalSha256(e.target.document))throw Error('TRAVEL_TARIFF_CURRENT_SOURCE');
 const body={schema_version:'travel-tariff-reading-receipt-v1' as const,case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,
  source_group_sha256:e.target.source_group_sha256,target_sha256:e.target.target_sha256,subject:e.target.subject,request_id:e.request_id,answer_revision:e.answer_revision,identity_id:e.identity_id,answered_at:e.answered_at,
  state:answer.action==='correct'?'identified' as const:answer.action,value:answer.action==='correct'?answer.structured_value:null,policy_sha256:TRAVEL_TARIFF_POLICY_SHA256};
 return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
}
export type TravelTariffReading=ReturnType<typeof resolveTravelTariffReading>;
export const travelTariffSourceLocatorSchema=z.object({schema_version:z.literal('travel-tariff-source-locator-v1'),source_group_sha256:hash,target_sha256:hash,receipt_sha256:hash,subject:travelTariffSubjectSchema,locator:z.string().min(1).max(120)}).strict();
