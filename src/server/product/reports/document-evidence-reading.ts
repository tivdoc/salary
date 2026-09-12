import {z} from 'zod';
import type {ImmutableDocument} from '@/engine/domain/documents';
import {DOCUMENT_EVIDENCE_POLICY} from '@/engine/extraction/document-evidence/contracts';
import {createDocumentEvidenceReadingTarget,documentEvidenceReadingTargetSchema,resolveDocumentEvidenceReading,
 validateDocumentEvidenceReadingAnswer} from '@/engine/extraction/document-evidence/reading';
import {validateSavedDocumentEvidence} from '@/server/engine/extraction/saved-document-evidence-contract';
import {parseDocumentFieldAnswer} from './reading-verification';
import {DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from './document-field-confirmation';
import type {DocumentReadingDisplay} from '@/lib/document-reading-display';

export {documentEvidenceReadingTargetSchema};
export type DocumentEvidenceReadingTarget=z.infer<typeof documentEvidenceReadingTargetSchema>;
export type DocumentEvidenceTargetSource={checkpoint:unknown;document:ImmutableDocument;productDocumentId:string;month:string};
export function documentEvidenceTarget(input:DocumentEvidenceTargetSource&{observationId:string}){
 z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).parse(input.month);
 // Purchased execution month is authenticated by the opener/answer boundary.
 // A full-source contract extraction does not assert its effective period.
 const checkpoint=validateSavedDocumentEvidence({...input,requiredMonths:[]});
 if(checkpoint.run.result.status!=='completed'||!checkpoint.run.result.normalized)throw Error('DOCUMENT_EVIDENCE_READING_NOT_AVAILABLE');
 return createDocumentEvidenceReadingTarget({normalized:checkpoint.run.result.normalized,productDocumentId:input.productDocumentId,
  checkpointSha256:checkpoint.result_sha256,policyVersion:DOCUMENT_EVIDENCE_POLICY,month:input.month,observationId:input.observationId});
}
export function documentEvidenceQuestion(input:unknown){
 const target=documentEvidenceReadingTargetSchema.parse(input),o=target.observation.original;
 const state=target.observation.state==='conflict'?'נשמרו קריאות סותרות של אותו תא. ':target.observation.normalized_value===null?'לא התקבל ערך שניתן להשתמש בו. ':'';
 return {code:`document_field:${target.target_sha256}`,question:`${state}בעמוד ${o.page}, בשדה "${o.source_label||o.cell_id}", יש להשוות את הקריאה למקור. האימות מתייחס לתא או לקטע הזה בלבד, ללא אישור זכאות או תנאי ההסכם.`,
  answer_kind:'choice' as const,options:[...DOCUMENT_FIELD_CONFIRMATION_ANSWERS],field_crop:`document_evidence.${o.semantic}`,blocking:false};
}
export function documentEvidenceReadingDisplay(input:unknown):DocumentReadingDisplay&{can_confirm:boolean;source:{document_id:string;page:number;locator:string}}{
 const target=documentEvidenceReadingTargetSchema.parse(input),o=target.observation.original;
 let canConfirm=false;try{validateDocumentEvidenceReadingAnswer(target,{action:'confirm'});canConfirm=true;}catch{/* Explicit correction/unknown remain available. */}
 return {question:documentEvidenceQuestion(target).question,field:`document_evidence.${o.semantic}`,raw_value:o.raw_value,page:o.page,
  text_fragment:o.text_fragment||null,bounding_box:null,can_confirm:canConfirm,source:{document_id:target.version_id,page:o.page,locator:o.locator}};
}
/** The historical/v2 parser remains the one wire decoder. The fixed basis is
 * the action's source-reading context, not a fabricated user's free text. */
export function validateDocumentEvidenceAnswer(target:unknown,wireAnswer:unknown){
 const answer=parseDocumentFieldAnswer(wireAnswer);
 const readingAnswer=answer.action==='correct'?{action:answer.action,corrected_raw_value:answer.corrected_raw_value,basis:'system_action_context:identified_source_correction'}:{action:answer.action};
 return validateDocumentEvidenceReadingAnswer(target,readingAnswer);
}
export function resolveDocumentEvidenceAnswer(input:DocumentEvidenceTargetSource&{target:unknown;caseId:string;requestId:string;
 answerRevision:number;identityId:string;answeredAt:string;answer:unknown}){
 const target=documentEvidenceReadingTargetSchema.parse(input.target);
 if(target.case_id!==input.caseId||input.document.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 const normalized=validateDocumentEvidenceAnswer(target,input.answer);
 let current:DocumentEvidenceReadingTarget;
 try{current=documentEvidenceTarget({...input,observationId:target.observation.observation_id});}catch{return {state:'stale' as const};}
 return resolveDocumentEvidenceReading({target,currentTarget:current,answer:normalized.answer,caseId:input.caseId,
  requestId:input.requestId,answerRevision:input.answerRevision,identityId:input.identityId,answeredAt:input.answeredAt});
}
