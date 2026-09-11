import {z} from 'zod';
import {rawCandidateFieldSchema} from '@/engine/extraction/contracts';
import {normalizePayslipFieldValue} from '@/engine/extraction/normalization';
import {normalizedCandidateFieldSchema} from '@/engine/extraction/payslip';
import {customerDocumentReadingSchema,customerDocumentRowCellReadingSchema,customerDocumentScopeReadingSchema,customerSourceTranscriptionSchema,type CustomerDocumentReading} from '@/engine/extraction/customer-reading';
import {documentSourceTranscriptionTargetSchema,documentSourceTranscriptionQuestion,documentSourceTranscriptionCurrent} from './document-source-transcription';
import {documentSourceScopeTargetSchema,documentSourceScopeQuestion,documentSourceScopeCurrent} from './document-source-scope-confirmation';
import {normalizeDocumentRowCellValue,normalizeDocumentScopeObservationValue,normalizeSourceTranscriptionValue} from '@/engine/extraction/reading-resolution';
import {documentRowCellTargetSchema,documentRowCellQuestion,documentRowCellCurrent} from './document-row-cell-confirmation';
import {documentReadingTargetSchema} from './document-field-confirmation';
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


type AffirmativeReadingAnswer=Extract<DocumentFieldAnswerV2,{action:'confirm'|'correct'}>;
function scalarAnswerValue(target:z.infer<typeof documentFieldTargetSchema>,answer:AffirmativeReadingAnswer){
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
 return effectiveValue;
}
function rowAnswerValue(target:z.infer<typeof documentRowCellTargetSchema>,answer:AffirmativeReadingAnswer){
 const original=target.original_component[target.cell];
 // Currency classification is a separate source fact. Do not turn a saved XTS
 // amount into ILS just because a decimal correction can be parsed as shekels.
 if(original!==null&&typeof original==='object'&&'currency' in original&&original.currency!=='ILS')throw Error('REQUEST_ANSWER_INVALID');
 const raw=answer.action==='correct'?answer.corrected_raw_value:target.original_component[`${target.cell}_raw`];
 const value=normalizeDocumentRowCellValue(target.cell,raw);
 if(value===null||typeof value==='object'&&'currency' in value&&value.currency!=='ILS'
  ||answer.action==='confirm'&&(original===null||canonicalSha256(value)!==canonicalSha256(original)))throw Error('REQUEST_ANSWER_INVALID');
 return value;
}
function scopeAnswerValue(target:z.infer<typeof documentSourceScopeTargetSchema>,answer:AffirmativeReadingAnswer){
 const originalValue=normalizePayslipFieldValue(target.original_observation.candidate);
 if(originalValue!==null&&typeof originalValue==='object'&&'currency' in originalValue&&originalValue.currency!=='ILS')throw Error('REQUEST_ANSWER_INVALID');
 const raw=answer.action==='correct'?answer.corrected_raw_value:target.original_observation.candidate.raw_value;
 const value=normalizeDocumentScopeObservationValue(target.original_observation,raw);if(value===null)throw Error('REQUEST_ANSWER_INVALID');
 return value;
}
function transcriptionAnswerValue(target:z.infer<typeof documentSourceTranscriptionTargetSchema>,answer:AffirmativeReadingAnswer){
 if(answer.action!=='correct')throw Error('REQUEST_ANSWER_INVALID');
 const value=normalizeSourceTranscriptionValue(target.subject,answer.corrected_raw_value);
 if(value===null)throw Error('REQUEST_ANSWER_INVALID');
 return value;
}
/** Validate an answer against its authenticated stored target before persisting
 * a journal revision. This checks value semantics only: callers must still
 * enforce request authorization/currentness, and the worker replays all pins. */
export function validateDocumentReadingAnswerForTarget(targetInput:unknown,answerInput:unknown):DocumentFieldAnswerV2 {
 const target=documentReadingTargetSchema.parse(targetInput),answer=parseDocumentFieldAnswer(answerInput);
 if(answer.action==='unknown'||answer.action==='unreadable')return answer;
 switch(target.schema_version){
  case 'document-field-confirmation-v1':scalarAnswerValue(target,answer);break;
  case 'document-row-cell-confirmation-v1':rowAnswerValue(target,answer);break;
  case 'document-source-scope-confirmation-v1':scopeAnswerValue(target,answer);break;
  case 'document-source-transcription-v1':transcriptionAnswerValue(target,answer);break;
 }
 return answer;
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
 const effectiveValue=scalarAnswerValue(target,answer);
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
 const parsed=documentReadingTargetSchema.parse(input);
 if(parsed.schema_version==='document-row-cell-confirmation-v1'){
  const row=parsed.original_component,question=documentRowCellQuestion(parsed);
  return {question:question.question,field:`row_cell.${parsed.cell}`,raw_value:row[`${parsed.cell}_raw`],
   source:{version_id:parsed.version_id,source_sha256:parsed.source_sha256,page:row.source.page,text_fragment:row.source.text_fragment??null,
    region:row.source.region??null,source_scope:row.source.source_scope??null,bounding_box:row.source.bounding_box??null},target_sha256:parsed.target_sha256,
   actions:['confirm','correct','unreadable','unknown'] as const,scope:'source_cell_reading_only' as const};
 }
 if(parsed.schema_version==='document-source-scope-confirmation-v1'){
  const observation=parsed.original_observation,candidate=observation.candidate,question=documentSourceScopeQuestion(parsed);
  return {question:question.question,field:`source_scope.${observation.scope}`,raw_value:candidate.raw_value,
   source:{version_id:parsed.version_id,source_sha256:parsed.source_sha256,page:candidate.source.page,text_fragment:candidate.source.text_fragment??null,
    region:candidate.source.region??null,source_scope:candidate.source.source_scope??null,bounding_box:candidate.source.bounding_box??null},target_sha256:parsed.target_sha256,
   actions:['confirm','correct','unreadable','unknown'] as const,scope:'source_cell_reading_only' as const};
 }
 if(parsed.schema_version==='document-source-transcription-v1'){
  const subject=parsed.subject,candidate=subject.kind==='balance_unit'?subject.original_candidate:null;
  const question=documentSourceTranscriptionQuestion(parsed),page=subject.kind==='reported_work_hours'?subject.page:subject.original_candidate.source.page;
  return {question:question.question,field:`source_transcription.${subject.kind}`,raw_value:candidate?.raw_value??null,
   source:{version_id:parsed.version_id,source_sha256:parsed.source_sha256,page,text_fragment:candidate?.source.text_fragment??null,region:candidate?.source.region??null,
    source_scope:candidate?.source.source_scope??null,bounding_box:candidate?.source.bounding_box??null},target_sha256:parsed.target_sha256,
   actions:['correct','unreadable','unknown'] as const,scope:'source_cell_reading_only' as const};
 }
 const target=parsed,legacy=documentFieldQuestion(target);
 return {question:legacy.question,field:target.candidate.field,raw_value:target.candidate.raw_value,
  source:{version_id:target.version_id,source_sha256:target.source_sha256,page:target.candidate.source.page,
   text_fragment:target.candidate.source.text_fragment??null,region:target.candidate.source.region??null,source_scope:target.candidate.source.source_scope??null,bounding_box:target.candidate.source.bounding_box??null},
  target_sha256:target.target_sha256,actions:['confirm','correct','unreadable','unknown'] as const,
  scope:'source_cell_reading_only' as const};
}

/** Row variant uses the same identified answer journal and actions. It never
 * projects the row into a scalar field or changes its semantic classification. */
function resolveDocumentRowCellVerification(input:ResolveInput){
 const answer=parseDocumentFieldAnswer(input.answer),target=documentRowCellTargetSchema.parse(input.target);
 if(!documentRowCellCurrent({...input,target}))return deepFreeze({state:'stale' as const});
 const authority={actor_kind:'identified_account' as const,identity_id:input.identityId,request_id:input.requestId,answer_revision:input.answerRevision,answered_at:input.answeredAt};
 const base={policy_version:'document-row-cell-identified-reading-v1' as const,scope:'source_cell_reading_only' as const,target,answer,authority,
  original_component:target.original_component,original_component_sha256:canonicalSha256(target.original_component)};
 if(answer.action==='unknown'||answer.action==='unreadable'){
  const body={...base,state:answer.action,effective_value:null};return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
 }
 const value=rowAnswerValue(target,answer);
 const body={...base,state:answer.action==='confirm'?'confirmed_reading' as const:'corrected_reading' as const,effective_value:value,
  value_origin:answer.action==='confirm'?'provider_component_cell_confirmed' as const:'identified_source_transcription' as const};
 return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
}
function resolveDocumentScopeVerification(input:ResolveInput){
 const answer=parseDocumentFieldAnswer(input.answer),target=documentSourceScopeTargetSchema.parse(input.target);
 if(!documentSourceScopeCurrent({...input,target}))return deepFreeze({state:'stale' as const});
 const authority={actor_kind:'identified_account' as const,identity_id:input.identityId,request_id:input.requestId,answer_revision:input.answerRevision,answered_at:input.answeredAt};
 const base={policy_version:'document-source-scope-identified-reading-v1' as const,scope:'source_cell_reading_only' as const,target,answer,authority,
  original_observation:target.original_observation,original_observation_sha256:canonicalSha256(target.original_observation),classification_verified:false as const};
 if(answer.action==='unknown'||answer.action==='unreadable'){
  const body={...base,state:answer.action,effective_value:null};return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
 }
 const value=scopeAnswerValue(target,answer);
 const body={...base,state:answer.action==='confirm'?'confirmed_reading' as const:'corrected_reading' as const,effective_value:value,
  value_origin:answer.action==='confirm'?'provider_scope_observation_confirmed' as const:'identified_source_transcription' as const};
 return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
}
function resolveDocumentSourceTranscriptionVerification(input:ResolveInput){
 const answer=parseDocumentFieldAnswer(input.answer),target=documentSourceTranscriptionTargetSchema.parse(input.target);
 if(!documentSourceTranscriptionCurrent({...input,target}))return deepFreeze({state:'stale' as const});
 if(answer.action==='confirm')throw Error('REQUEST_ANSWER_INVALID');
 const authority={actor_kind:'identified_account' as const,identity_id:input.identityId,request_id:input.requestId,answer_revision:input.answerRevision,answered_at:input.answeredAt};
 const base={policy_version:'document-source-transcription-identified-v1' as const,scope:'source_cell_reading_only' as const,target,answer,authority,
  source_transcription_subject:target.subject,classification_verified:false as const};
 if(answer.action==='unknown'||answer.action==='unreadable'){
  const body={...base,state:answer.action,effective_value:null};return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
 }
 const value=transcriptionAnswerValue(target,answer);
 const body={...base,state:'corrected_reading' as const,effective_value:value,value_origin:'identified_source_transcription' as const};
 return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
}
export function resolveDocumentReadingVerification(input:ResolveInput){
 const target=documentReadingTargetSchema.parse(input.target);
 if(target.schema_version==='document-field-confirmation-v1')return resolveDocumentFieldVerification({...input,target});
 if(target.schema_version==='document-row-cell-confirmation-v1')return resolveDocumentRowCellVerification({...input,target});
 return target.schema_version==='document-source-scope-confirmation-v1'?resolveDocumentScopeVerification({...input,target}):resolveDocumentSourceTranscriptionVerification({...input,target});
}
export type DocumentReadingVerification=ReturnType<typeof resolveDocumentReadingVerification>;
export function materializeDocumentVerification(verification:DocumentReadingVerification,normalizedExtractionSha256:string){
 if(verification.state!=='confirmed_reading'&&verification.state!=='corrected_reading')return null;
 if('original_candidate' in verification){
  const reading=materializeDocumentFieldVerification(verification,normalizedExtractionSha256);
  return reading?{kind:'scalar' as const,reading}:null;
 }
 if('source_transcription_subject' in verification){
  const {target,authority}=verification;
  if(verification.answer.action!=='correct')throw Error('REQUEST_ANSWER_INVALID');
  const reading=customerSourceTranscriptionSchema.parse({schema_version:'document-source-transcription-reading-v1',actor_kind:'customer',case_id:target.case_id,document_id:target.version_id,
   source_sha256:target.source_sha256,normalized_extraction_sha256:normalizedExtractionSha256,extraction_result_sha256:target.extraction_result_sha256,target_sha256:target.target_sha256,
   subject:target.subject,month:target.month,request_id:authority.request_id,answer_revision:authority.answer_revision,identity_id:authority.identity_id,confirmed_at:authority.answered_at,
   transcription:{raw_value:verification.answer.corrected_raw_value,normalized_value:verification.effective_value,verification_sha256:verification.receipt_sha256},
  });return {kind:'source_transcription' as const,reading};
 }
 if('original_observation' in verification){
  const {target,authority}=verification;
  const reading=customerDocumentScopeReadingSchema.parse({schema_version:'document-source-scope-reading-v1',actor_kind:'customer',case_id:target.case_id,document_id:target.version_id,
   candidate_id:target.original_observation.candidate.candidate_id,source_sha256:target.source_sha256,normalized_extraction_sha256:normalizedExtractionSha256,
   original_observation_sha256:verification.original_observation_sha256,extraction_result_sha256:target.extraction_result_sha256,target_sha256:target.target_sha256,month:target.month,
   request_id:authority.request_id,answer_revision:authority.answer_revision,identity_id:authority.identity_id,confirmed_at:authority.answered_at,
   ...(verification.state==='corrected_reading'&&verification.answer.action==='correct'?{correction:{schema_version:'document-source-scope-correction-v1',raw_value:verification.answer.corrected_raw_value,
    normalized_value:verification.effective_value,verification_sha256:verification.receipt_sha256}}:{}),
  });return {kind:'source_scope' as const,reading};
 }
 const {target,authority}=verification;
 const reading=customerDocumentRowCellReadingSchema.parse({schema_version:'document-row-cell-reading-v1',actor_kind:'customer',
  case_id:target.case_id,document_id:target.version_id,component_id:target.original_component.component_id,cell:target.cell,
  source_sha256:target.source_sha256,normalized_extraction_sha256:normalizedExtractionSha256,original_component_sha256:verification.original_component_sha256,
  extraction_result_sha256:target.extraction_result_sha256,target_sha256:target.target_sha256,month:target.month,
  request_id:authority.request_id,answer_revision:authority.answer_revision,identity_id:authority.identity_id,confirmed_at:authority.answered_at,
  ...(verification.state==='corrected_reading'&&verification.answer.action==='correct'?{correction:{schema_version:'document-row-cell-correction-v1',
   raw_value:verification.answer.corrected_raw_value,normalized_value:verification.effective_value,verification_sha256:verification.receipt_sha256}}:{}),
 });
 return {kind:'row_cell' as const,reading};
}
