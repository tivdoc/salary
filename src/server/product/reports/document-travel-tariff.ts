import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {travelTariffDocumentSchema,travelTariffGroupSchema,travelTariffTargetSchema,travelTariffTarget,travelTariffAnswerSchema,
 validateTravelTariffAnswer,resolveTravelTariffReading,type TravelTariffTarget,type TravelTariffJournalEntry} from '@/engine/entitlement-review/travel/tariff-contracts';
import {tariffQuestion} from '@/engine/entitlement-review/travel/tariff-source';
import type {TravelTariffContext} from '@/lib/travel-tariff-display';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const DOCUMENT_TRAVEL_TARIFF_POLICY='document-travel-tariff-identified-v1' as const;
/** This is a source snapshot supplied by the authenticated purpose loader.
 * Parsing a self-hashed client object is never authority to construct a request.
 * The opener and answer SQL must independently check the persisted purpose,
 * exact current version, purchased travel month and authenticated case access. */
export const documentTravelTariffSourceSchema=z.object({document:travelTariffDocumentSchema,group:travelTariffGroupSchema}).strict();
export type DocumentTravelTariffSource=z.infer<typeof documentTravelTariffSourceSchema>;
export const documentTravelTariffTargetSchema=z.object({schema_version:z.literal('document-travel-tariff-transcription-v1'),
 case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,month:z.string().regex(/^2026-(05|06|07)$/u),
 policy_version:z.literal(DOCUMENT_TRAVEL_TARIFF_POLICY),purpose_sha256:sha,tariff:travelTariffTargetSchema,target_sha256:sha,
}).strict().superRefine((target,ctx)=>{
 const d=target.tariff.document;
 if(target.case_id!==d.case_id||target.product_document_id!==d.document_id||target.version_id!==d.version_id
  ||target.source_sha256!==d.file_sha256||target.month!==d.month||target.purpose_sha256!==d.purpose_sha256)
  ctx.addIssue({code:'custom',message:'TRAVEL_TARIFF_WRAPPER_SOURCE'});
 const {target_sha256,...body}=target;
 if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'TRAVEL_TARIFF_WRAPPER_HASH'});
});
export type DocumentTravelTariffTarget=z.infer<typeof documentTravelTariffTargetSchema>;
export function documentTravelTariffTarget(input:{source:DocumentTravelTariffSource;subject:TravelTariffTarget['subject']}):DocumentTravelTariffTarget{
 const source=documentTravelTariffSourceSchema.parse(input.source),d=source.document,tariff=travelTariffTarget(d,source.group,input.subject);
 const body={schema_version:'document-travel-tariff-transcription-v1' as const,case_id:d.case_id,product_document_id:d.document_id,version_id:d.version_id,
  source_sha256:d.file_sha256,month:d.month,policy_version:DOCUMENT_TRAVEL_TARIFF_POLICY,purpose_sha256:d.purpose_sha256,tariff};
 return deepFreeze(documentTravelTariffTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function parseTravelTariffWireAnswer(input:unknown){
 let value:unknown=input;
 if(typeof value==='string'){
  if(value.length>2000)throw Error('REQUEST_ANSWER_INVALID');
  try{value=JSON.parse(value);}catch{throw Error('REQUEST_ANSWER_INVALID');}
 }
 const parsed=travelTariffAnswerSchema.safeParse(value);if(!parsed.success)throw Error('REQUEST_ANSWER_INVALID');return parsed.data;
}
export function validateDocumentTravelTariffAnswer(targetInput:unknown,answerInput:unknown){
 const target=documentTravelTariffTargetSchema.parse(targetInput);
 try{return validateTravelTariffAnswer(target.tariff,parseTravelTariffWireAnswer(answerInput));}catch{throw Error('REQUEST_ANSWER_INVALID');}
}
export function documentTravelTariffQuestion(input:unknown){
 const target=documentTravelTariffTargetSchema.parse(input);
 return {code:`document_field:${target.target_sha256}`,question:tariffQuestion(target.tariff.subject),answer_kind:'choice' as const,
  options:['העתקת הפרט מהמקור','לא ניתן לקרוא את השדה','לא יודע/ת'],field_crop:`travel_tariff.${target.tariff.subject}`,blocking:false};
}
export function documentTravelTariffDisplay(input:unknown){
 const target=documentTravelTariffTargetSchema.parse(input),group=target.tariff.group;
 const tariff_context:TravelTariffContext={subject:target.tariff.subject,page:group.page,locator:group.locator};
 return {question:documentTravelTariffQuestion(target).question,field:`travel_tariff.${target.tariff.subject}`,raw_value:null,
  source:{version_id:target.version_id,source_sha256:target.source_sha256,page:group.page,text_fragment:null,region:group.locator,source_scope:null,bounding_box:null},
  target_sha256:target.target_sha256,actions:['correct','unreadable','unknown'] as const,scope:'source_tariff_reading_only' as const,tariff_context};
}
export type ResolveDocumentTravelTariffInput={target:unknown;source:DocumentTravelTariffSource;caseId:string;month:string;policyVersion:string;
 requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:unknown};
/** Rebuild from the authenticated journal row and independently loaded current
 * purpose. No browser identity, revision, receipt or prepared value is accepted.
 * Unknown/unreadable produce negative receipts, never an affirmative value. */
export function resolveDocumentTravelTariffVerification(input:ResolveDocumentTravelTariffInput){
 const target=documentTravelTariffTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);
 z.iso.datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(target.month!==input.month||target.policy_version!==input.policyVersion)return {state:'stale' as const};
 let current:DocumentTravelTariffTarget;
 try{current=documentTravelTariffTarget({source:input.source,subject:target.tariff.subject});}catch{return {state:'stale' as const};}
 if(current.target_sha256!==target.target_sha256)return {state:'stale' as const};
 const answer=validateDocumentTravelTariffAnswer(target,input.answer);
 const entry:TravelTariffJournalEntry={target:target.tariff,request_id:input.requestId,answer_revision:input.answerRevision,identity_id:input.identityId,
  answered_at:new Date(input.answeredAt).toISOString(),answer};
 const reading=resolveTravelTariffReading(input.source.document,entry);
 return deepFreeze({state:'tariff_current' as const,target,entry,reading});
}
