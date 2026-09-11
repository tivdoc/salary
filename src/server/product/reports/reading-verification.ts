import {z} from 'zod';
import {rawCandidateFieldSchema} from '@/engine/extraction/contracts';
import {normalizePayslipFieldValue} from '@/engine/extraction/normalization';
import {normalizedCandidateFieldSchema} from '@/engine/extraction/payslip';
import {customerDocumentReadingSchema,type CustomerDocumentReading} from '@/engine/extraction/customer-reading';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_FIELD_CONFIRMATION_ANSWERS,documentFieldQuestion,documentFieldTargetSchema,resolveDocumentFieldReading} from './document-field-confirmation';

/** A reading decision about ONE immutable source candidate. This neither
 * attests to a person reviewing the file nor establishes legal applicability. */
export const documentFieldAnswerV2Schema=z.discriminatedUnion('action',[
 z.object({schema_version:z.literal('document-field-answer-v2'),action:z.literal('confirm')}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v2'),action:z.literal('correct'),corrected_raw_value:z.string().trim().min(1).max(500)}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v2'),action:z.literal('unreadable')}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v2'),action:z.literal('unknown')}).strict(),
]);
export type DocumentFieldAnswerV2=z.infer<typeof documentFieldAnswerV2Schema>;
export const READING_VERIFICATION_POLICY='document-field-identified-reading-v2' as const;

export function parseDocumentFieldAnswer(input:unknown):DocumentFieldAnswerV2 {
 if(typeof input==='string'){
  const legacy=DOCUMENT_FIELD_CONFIRMATION_ANSWERS.indexOf(input as typeof DOCUMENT_FIELD_CONFIRMATION_ANSWERS[number]);
  if(legacy===0)return {schema_version:'document-field-answer-v2',action:'confirm'};
  if(legacy===2)return {schema_version:'document-field-answer-v2',action:'unreadable'};
  if(legacy===3)return {schema_version:'document-field-answer-v2',action:'unknown'};
  // The historic "different" answer has no corrected value. Keep it unknown;
  // do not infer a number or treat it as a new affirmative reading.
  if(legacy===1)return {schema_version:'document-field-answer-v2',action:'unknown'};
  try{return documentFieldAnswerV2Schema.parse(JSON.parse(input));}catch{throw Error('REQUEST_ANSWER_INVALID');}
 }
 const parsed=documentFieldAnswerV2Schema.safeParse(input);
 if(!parsed.success)throw Error('REQUEST_ANSWER_INVALID');
 return parsed.data;
}

type ResolveInput=Omit<Parameters<typeof resolveDocumentFieldReading>[0],'answer'>&{answer:unknown};
export function resolveDocumentFieldVerification(input:ResolveInput){
 const answer=parseDocumentFieldAnswer(input.answer),target=documentFieldTargetSchema.parse(input.target);
 // Reuse the existing exact checkpoint/case/version/hash/month/policy fences.
 // The affirmative token here only evaluates those fences; no affirmative
 // receipt is returned for unknown or unreadable answers.
 const binding=resolveDocumentFieldReading({...input,answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]});
 if(binding.state!=='confirmed_reading')return deepFreeze({state:'stale' as const});
 const authority={actor_kind:'identified_account' as const,identity_id:input.identityId,request_id:input.requestId,
  answer_revision:input.answerRevision,answered_at:input.answeredAt};
 const base={policy_version:READING_VERIFICATION_POLICY,scope:'source_cell_reading_only' as const,target,answer,authority,
  original_candidate:target.candidate,original_candidate_sha256:canonicalSha256(target.candidate)};
 if(answer.action==='unknown'||answer.action==='unreadable'){
  const body={...base,state:answer.action,effective_value:null};
  return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
 }
 let effectiveValue=target.candidate.normalized_value;
 if(answer.action==='correct'){
  const {normalized_value:originalValue,...originalRaw}=target.candidate;
  void originalValue;
  const correctedRaw=rawCandidateFieldSchema.parse({...originalRaw,raw_value:answer.corrected_raw_value});
  effectiveValue=normalizedCandidateFieldSchema.parse({...correctedRaw,normalized_value:normalizePayslipFieldValue(correctedRaw)}).normalized_value;
  if(effectiveValue===null)throw Error('REQUEST_ANSWER_INVALID');
  // Keep the same parser and per-field type as provider normalization. A
  // correction is separate evidence; no candidate, warning or confidence is
  // rewritten, and source conflicts remain available to the resolver.
  normalizedCandidateFieldSchema.parse({...correctedRaw,normalized_value:effectiveValue});
  if(typeof effectiveValue==='object'&&'currency' in effectiveValue&&effectiveValue.currency!=='ILS')throw Error('REQUEST_ANSWER_INVALID');
  if(typeof effectiveValue==='object'&&'year' in effectiveValue&&`${effectiveValue.year}-${String(effectiveValue.month).padStart(2,'0')}`!==target.month)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
 }
 const body={...base,state:answer.action==='confirm'?'confirmed_reading' as const:'corrected_reading' as const,
  effective_value:effectiveValue,value_origin:answer.action==='confirm'?'provider_candidate_confirmed' as const:'identified_source_transcription' as const};
 return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
}
export type DocumentFieldVerification=ReturnType<typeof resolveDocumentFieldVerification>;

/** Server journal adapter. Pass the exact original normalized extraction hash,
 * not an effective/corrected view. Negative answers intentionally emit no
 * reading, so the latest journal revision revokes its earlier confirmation. */
export function materializeDocumentFieldVerification(verification:DocumentFieldVerification,normalizedExtractionSha256:string):CustomerDocumentReading|null {
 if(verification.state!=='confirmed_reading'&&verification.state!=='corrected_reading')return null;
 const {target,authority}=verification;
 return customerDocumentReadingSchema.parse({actor_kind:'customer',case_id:target.case_id,document_id:target.version_id,candidate_id:target.candidate.candidate_id,
  source_sha256:target.source_sha256,normalized_extraction_sha256:normalizedExtractionSha256,candidate_sha256:verification.original_candidate_sha256,
  extraction_result_sha256:target.extraction_result_sha256,target_sha256:target.target_sha256,month:target.month,
  request_id:authority.request_id,answer_revision:authority.answer_revision,identity_id:authority.identity_id,confirmed_at:authority.answered_at,
  ...(verification.state==='corrected_reading'&&verification.answer.action==='correct'?{correction:{schema_version:'document-field-correction-v1',
   raw_value:verification.answer.corrected_raw_value,normalized_value:verification.effective_value,verification_sha256:verification.receipt_sha256}}:{}),
 });
}

export function documentFieldVerificationDisplay(input:unknown){
 const target=documentFieldTargetSchema.parse(input),legacy=documentFieldQuestion(target);
 return {question:legacy.question,field:target.candidate.field,raw_value:target.candidate.raw_value,
  source:{version_id:target.version_id,source_sha256:target.source_sha256,page:target.candidate.source.page,
   text_fragment:target.candidate.source.text_fragment??null,region:target.candidate.source.region??null,source_scope:target.candidate.source.source_scope??null,bounding_box:target.candidate.source.bounding_box??null},
  target_sha256:target.target_sha256,actions:['confirm','correct','unreadable','unknown'] as const,
  scope:'source_cell_reading_only' as const};
}
