import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import type {CustomerDocumentReading,CustomerDocumentRowCellReading,CustomerDocumentScopeReading,CustomerSourceTranscription} from '@/engine/extraction/customer-reading';
import {hasPayslipReadingAnnotations} from '@/engine/extraction/reading-resolution';
import type {CustomerSourceStructureReading} from '@/engine/extraction/source-structure';
import {sourceStructureSubjectKey} from '@/engine/extraction/source-structure-resolution';
import {documentReadingTargetSchema} from '../reports/document-field-confirmation';
import {resolveDocumentReadingVerification,materializeDocumentVerification} from '../reports/reading-verification';
const answerSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string(),code:z.string(),answer_kind:z.literal('choice'),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.string().datetime({offset:true}),field_target:documentReadingTargetSchema});
type SavedReadingInput={caseId:string;month:string;policyVersion:string;journal:unknown;checkpoint:unknown};

export function savedDocumentFieldReadings(input:{caseId:string;month:string;policyVersion:string;journal:unknown;checkpoint:unknown}):readonly CustomerDocumentReading[]{
 return savedDocumentReadings(input).scalar;
}

/** All variants use the same immutable authenticated answer journal. Unknown
 * and unreadable revoke only their own active reading; provider bytes stay intact. */
export function savedDocumentReadings(input:SavedReadingInput){return readSavedDocumentReadings(input,false);}
/** The caller supplies the exact authenticated source journal. Only its current
 * v1 period answers enter this map; embedded v2 witnesses are never a source. */
export function savedSourcePeriodReadings(input:SavedReadingInput):ReadonlyMap<string,CustomerSourceStructureReading>{
 return new Map(readSavedDocumentReadings(input,true).source_structure.map(r=>[sourceStructureSubjectKey(r.subject),r]));
}
function readSavedDocumentReadings(input:SavedReadingInput,periodOnly:boolean){
 const {answers=[]}=z.object({answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(input.journal);
 const checkpoint=z.object({version_id:z.uuid(),run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(input.checkpoint);
 const extraction=checkpoint.run.result.final_extraction;
 if(hasPayslipReadingAnnotations(extraction))throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 const readings:{scalar:CustomerDocumentReading[];row_cell:CustomerDocumentRowCellReading[];source_scope:CustomerDocumentScopeReading[];source_transcription:CustomerSourceTranscription[];source_structure:CustomerSourceStructureReading[]}={scalar:[],row_cell:[],source_scope:[],source_transcription:[],source_structure:[]},seen=new Set<string>();
 const selected=[];
 for(const value of answers){
  if(typeof value.code!=='string'||!value.code.startsWith('document_field:'))continue;
  const answer=answerSchema.parse(value);
  if(answer.case_id!==input.caseId||answer.field_target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
  if(seen.has(answer.id))throw Error('SAVED_REQUEST_ID_AMBIGUOUS');seen.add(answer.id);
  if(answer.code!==`document_field:${answer.field_target.target_sha256}`)throw Error('REQUEST_FIELD_TARGET_INVALID');
  if(answer.field_target.version_id!==checkpoint.version_id||answer.scope_month!==input.month)continue;
  if(periodOnly&&answer.field_target.schema_version!=='document-source-period-association-v1')continue;
  selected.push(answer);
 }
 // Input journal ordering cannot decide current period authority: replay all
 // independent v1 decisions before any dependent relationship/group v2.
 selected.sort((a,b)=>Number('period_witness' in a.field_target)-Number('period_witness' in b.field_target));
 for(const answer of selected){
  const periodReadings=new Map(readings.source_structure.filter(r=>r.subject.kind==='period_association').map(r=>[sourceStructureSubjectKey(r.subject),r]));
  const result=resolveDocumentReadingVerification({target:answer.field_target,currentCheckpoint:input.checkpoint,policyVersion:input.policyVersion,
   caseId:input.caseId,month:input.month,requestId:answer.id,answerRevision:answer.answer_revision,identityId:answer.answer_identity_id,answeredAt:answer.answer_created_at,answer:answer.answer,
   ...('period_witness' in answer.field_target?{periodReadings}:{})});
  const reading=materializeDocumentVerification(result,canonicalSha256(extraction));
  if(reading?.kind==='scalar')readings.scalar.push(reading.reading);
  else if(reading?.kind==='row_cell')readings.row_cell.push(reading.reading);
  else if(reading?.kind==='source_scope')readings.source_scope.push(reading.reading);
  else if(reading?.kind==='source_transcription')readings.source_transcription.push(reading.reading);
  else if(reading?.kind==='source_structure')readings.source_structure.push(reading.reading);
 }
 if(new Set(readings.scalar.map(r=>r.candidate_id)).size!==readings.scalar.length
  ||new Set(readings.row_cell.map(r=>`${r.component_id}:${r.cell}`)).size!==readings.row_cell.length
  ||new Set(readings.source_scope.map(r=>r.candidate_id)).size!==readings.source_scope.length
  ||new Set(readings.source_transcription.map(r=>r.subject.kind==='balance_unit'?`balance_unit:${r.subject.original_candidate.candidate_id}`:r.subject.kind)).size!==readings.source_transcription.length
  ||new Set(readings.source_structure.map(r=>sourceStructureSubjectKey(r.subject))).size!==readings.source_structure.length)throw Error('REQUEST_FIELD_READING_AMBIGUOUS');
 return readings;
}
