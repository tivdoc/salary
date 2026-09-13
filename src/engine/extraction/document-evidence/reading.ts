import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {documentEvidenceSchema,documentEvidenceSha,documentEvidenceValueSchema,normalizedDocumentObservationSchema,documentEvidenceNormalizationPolicy} from './contracts.ts';
import {normalizeDocumentObservation} from './normalization.ts';

const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
export const documentEvidenceReadingTargetSchema=z.object({
 schema_version:z.literal('document-evidence-reading-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:documentEvidenceSha,checkpoint_sha256:documentEvidenceSha,normalized_sha256:documentEvidenceSha,
 policy_version:z.string().min(1).max(100),month,observation:normalizedDocumentObservationSchema,target_sha256:documentEvidenceSha,
 normalization_policy:documentEvidenceNormalizationPolicy.optional(),
}).strict().superRefine((target,ctx)=>{
 const {target_sha256,...body}=target;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_TARGET_HASH'});
});
export function createDocumentEvidenceReadingTarget(input:{normalized:unknown;productDocumentId:string;checkpointSha256:string;policyVersion:string;month:string;observationId:string}){
 const normalized=documentEvidenceSchema.parse(input.normalized),matches=normalized.observations.filter(o=>o.observation_id===input.observationId);
 if(matches.length!==1)throw Error('DOCUMENT_EVIDENCE_OBSERVATION_REQUIRED');
 const body={schema_version:'document-evidence-reading-v1' as const,case_id:normalized.case_id,product_document_id:input.productDocumentId,
  version_id:normalized.document_id,source_sha256:normalized.source_sha256,checkpoint_sha256:input.checkpointSha256,
  normalized_sha256:canonicalSha256(normalized),policy_version:input.policyVersion,month:input.month,observation:matches[0],
  ...(normalized.normalization_policy==='document-evidence-normalization-v1'?{}:{normalization_policy:normalized.normalization_policy})};
 return deepFreeze(documentEvidenceReadingTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export const documentEvidenceReadingAnswerSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('confirm')}).strict(),
 z.object({action:z.literal('correct'),corrected_raw_value:z.string().trim().min(1).max(1600),basis:z.string().trim().min(1).max(160)}).strict(),
 z.object({action:z.literal('unknown')}).strict(),z.object({action:z.literal('unreadable')}).strict(),
]);
export const documentEvidenceIdentifiedReadingSchema=z.object({
 schema_version:z.literal('document-evidence-identified-reading-v1'),target:documentEvidenceReadingTargetSchema,
 request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),
 answer:documentEvidenceReadingAnswerSchema,value:documentEvidenceValueSchema.nullable(),
 state:z.enum(['identified_reading','unknown','unreadable']),verification_sha256:documentEvidenceSha,
}).strict();
export function validateDocumentEvidenceReadingAnswer(targetInput:unknown,answerInput:unknown){
 const target=documentEvidenceReadingTargetSchema.parse(targetInput),answer=documentEvidenceReadingAnswerSchema.parse(answerInput);
 if(JSON.stringify(answer).length>1900)throw Error('DOCUMENT_EVIDENCE_READING_ANSWER_LIMIT');
 if(answer.action==='unknown'||answer.action==='unreadable')return {answer,value:null,state:answer.action};
 if(answer.action==='confirm'&&(target.observation.original.state!=='present'||target.observation.state!=='candidate'||target.observation.issues.length))throw Error('DOCUMENT_EVIDENCE_CONFIRM_UNAVAILABLE');
 const value=normalizeDocumentObservation(target.observation.original,answer.action==='correct'?answer.corrected_raw_value:undefined,
  target.normalization_policy??'document-evidence-normalization-v1');
 if(!value)throw Error('DOCUMENT_EVIDENCE_READING_VALUE_INVALID');
 return {answer,value,state:'identified_reading' as const};
}
/** Only an authenticated journal reader supplies actor/revision. This pure
 * layer binds it to the exact original observation; it is not an auth grant. */
export function resolveDocumentEvidenceReading(input:{target:unknown;currentTarget:unknown;answer:unknown;caseId:string;
 requestId:string;answerRevision:number;identityId:string;answeredAt:string}){
 const target=documentEvidenceReadingTargetSchema.parse(input.target),current=documentEvidenceReadingTargetSchema.parse(input.currentTarget);
 if(target.case_id!==input.caseId||current.case_id!==input.caseId)throw Error('DOCUMENT_EVIDENCE_READING_CASE');
 if(target.target_sha256!==current.target_sha256)return {state:'stale' as const};
 const result=validateDocumentEvidenceReadingAnswer(target,input.answer);
 const body={schema_version:'document-evidence-identified-reading-v1' as const,target,request_id:input.requestId,answer_revision:input.answerRevision,
  identity_id:input.identityId,answered_at:input.answeredAt,...result};
 return {state:'current' as const,reading:deepFreeze(documentEvidenceIdentifiedReadingSchema.parse({...body,verification_sha256:canonicalSha256(body)}))};
}
export function parseDocumentEvidenceIdentifiedReading(input:unknown){
 const parsed=documentEvidenceIdentifiedReadingSchema.parse(input),{verification_sha256,...body}=parsed;
 if(canonicalSha256(body)!==verification_sha256)throw Error('DOCUMENT_EVIDENCE_READING_HASH');
 const result=validateDocumentEvidenceReadingAnswer(parsed.target,parsed.answer);
 if(canonicalSha256(result.value)!==canonicalSha256(parsed.value)||result.state!==parsed.state)throw Error('DOCUMENT_EVIDENCE_READING_CHANGED');
 return deepFreeze(parsed);
}
