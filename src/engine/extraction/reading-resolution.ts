import {assertSourceStructureSubject,normalizeSourceStructureValue,sourceStructureSubjectKey,parseSourceStructureReadingValue} from './source-structure-resolution.ts';
import {assertSourceStructurePeriodWitness,sourceStructureRefs} from './source-structure-period.ts';
import type {CustomerSourceStructureReading,SourceStructureSubject} from './source-structure.ts';
import {immutableDocumentSchema} from '../domain/documents.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {rawCandidateFieldSchema} from './contracts.ts';
import {normalizedCandidateFieldSchema,normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema,type NormalizedCandidateField,type NormalizedPayslipExtraction} from './payslip.ts';
import {normalizePayslipFieldValue,normalizeMoney,normalizeDecimal,normalizePercentage} from './normalization.ts';
import type {CustomerDocumentReading,CustomerDocumentRowCellReading,CustomerDocumentScopeReading,CustomerSourceTranscription,SourceTranscriptionSubject,RowReadingCell} from './customer-reading.ts';

type Row=NormalizedPayslipExtraction['additional_components'][number];
type ScopeObservation=NonNullable<NormalizedPayslipExtraction['source_scope_observations']>[number];
export type MappedRowCell='quantity'|'rate'|'amount'|'percentage';
const mappedRowFields:Partial<Record<Row['semantic_kind'],Partial<Record<MappedRowCell,string>>>>={
 hourly_base:{quantity:'regular_hours',rate:'hourly_rate',amount:'base_monthly_salary'},base_salary:{amount:'base_monthly_salary'},
 overtime_125:{quantity:'overtime_125_hours'},overtime_150:{quantity:'overtime_150_hours'},travel:{amount:'travel_amount'},convalescence:{amount:'convalescence_amount'},
};
/** Scalar projection and row observation describe the SAME printed cell only
 * with this exact binding. No similarity, arithmetic fit or nearest label. */
export function mappedRowCellCandidate(input:{fields:readonly NormalizedCandidateField[];row:Pick<Row,'semantic_kind'|'source_label'|'source'|'quantity_raw'|'rate_raw'|'amount_raw'|'percentage_raw'>;cell:MappedRowCell}):NormalizedCandidateField|null {
 const {row,cell}=input,field=mappedRowFields[row.semantic_kind]?.[cell],raw=row[`${cell}_raw`];
 if(!field||raw===null||row.source.text_fragment!==row.source_label)return null;
 const sameSource=(candidate:NormalizedCandidateField)=>candidate.source.document_id===row.source.document_id&&candidate.source.page===row.source.page
  &&candidate.source.text_fragment===`${row.source_label}: ${raw}`
  &&canonicalSha256(candidate.source.bounding_box??null)===canonicalSha256(row.source.bounding_box??null)
  &&canonicalSha256(candidate.source.region??null)===canonicalSha256(row.source.region??null)
  &&canonicalSha256(candidate.source.source_scope??null)===canonicalSha256(row.source.source_scope??null);
 const candidates=input.fields.filter(c=>c.field===field&&c.raw_value===raw&&sameSource(c));
 return candidates.length===1?candidates[0]:null;
}
/** Matching a source cell is not permission to use its value. Identified reading
 * remains a separate required gate, unchanged by request consolidation. */
export function identifiedMappedRowCell(input:{original:NormalizedPayslipExtraction;effective:NormalizedPayslipExtraction;readings:ReadonlyMap<string,CustomerDocumentReading>;row:Row;cell:MappedRowCell}):NormalizedCandidateField|null {
 const candidate=mappedRowCellCandidate({fields:input.original.fields,row:input.row,cell:input.cell});
 if(!candidate||!input.readings.has(candidate.candidate_id))return null;
 return input.effective.fields.find(c=>c.candidate_id===candidate.candidate_id)??null;
}

/** Schema parsing validates annotation shape. Call materialize for source trust
 * before using a reading; hashing by itself does not admit any annotation. */
export function payslipMachineExtraction(input:unknown):NormalizedPayslipExtraction {
 const {customer_readings:scalar,customer_row_readings:rows,customer_scope_readings:scopes,customer_source_transcriptions:transcriptions,customer_source_structures:structures,source_reading_context:context,...machine}=normalizedPayslipExtractionSchema.parse(input);
 void scalar;void rows;void scopes;void transcriptions;void structures;void context;return machine;
}
export function payslipMachineExtractionSha256(input:unknown):string{return canonicalSha256(payslipMachineExtraction(input));}
export function rowCellReadingKey(componentId:string,cell:RowReadingCell):string{return `${componentId}:${cell}`;}
export function normalizeDocumentRowCellValue(cell:RowReadingCell,raw:string|null){
 if(raw===null)return null;
 return cell==='quantity'?normalizeDecimal(raw):cell==='percentage'?normalizePercentage(raw):normalizeMoney(raw);
}
function usableRowValue(cell:RowReadingCell,raw:string|null,value:Row[RowReadingCell]):boolean {
 const parsed=normalizeDocumentRowCellValue(cell,raw);
 return raw!==null&&raw.trim().length>0&&parsed!==null&&value!==null&&canonicalSha256(parsed)===canonicalSha256(value)
  &&(!(typeof value==='object'&&'currency' in value)||value.currency==='ILS');
}
/** Only a numeric reading is resolved here; scope metadata is untouched. */
export const documentScopeReadingFields=['base_monthly_salary','hourly_rate','gross_salary','total_deductions','net_salary','travel_amount','convalescence_amount',
  'pension_employee_contribution','pension_employer_contribution','severance_contribution','pension_base','regular_hours','overtime_125_hours','overtime_150_hours',
  'pension_employee_rate','pension_employer_rate','severance_rate'] as const;
export function normalizeDocumentScopeObservationValue(observation:ScopeObservation,raw:string){
 if(!documentScopeReadingFields.some(field=>field===observation.candidate.field))return null;
 const candidate=rawCandidateFieldSchema.parse({...observation.candidate,raw_value:raw}),value=normalizePayslipFieldValue(candidate);
 if(value===null||typeof value!=='object'||'currency' in value&&value.currency!=='ILS')return null;
 if('minor_units' in value||'basis_points' in value||'amount' in value)return value;
 return null;
}
export function identifiedScopeObservation(input:{original:NormalizedPayslipExtraction;effective:NormalizedPayslipExtraction;scopeReadings:ReadonlyMap<string,CustomerDocumentScopeReading>;observation:ScopeObservation}){
 const id=input.observation.candidate.candidate_id,reading=input.scopeReadings.get(id);if(!reading)return null;
 const originals=input.original.source_scope_observations?.filter(o=>o.candidate.candidate_id===id)??[],effective=input.effective.source_scope_observations?.filter(o=>o.candidate.candidate_id===id)??[];
 if(originals.length!==1||effective.length!==1||canonicalSha256(originals[0])!==canonicalSha256(input.observation)||reading.candidate_id!==id
  ||reading.original_observation_sha256!==canonicalSha256(input.observation)||reading.document_id!==input.original.document_id
  ||input.original.document_id!==input.effective.document_id||reading.normalized_extraction_sha256!==payslipMachineExtractionSha256(input.original))throw new TypeError('DOCUMENT_SCOPE_READING_BINDING_MISMATCH');
 const raw=effective[0].candidate.raw_value,expectedRaw=reading.correction?.raw_value??input.observation.candidate.raw_value;
 const expected={...input.observation,candidate:{...input.observation.candidate,raw_value:expectedRaw}};
 if(raw!==expectedRaw||canonicalSha256(effective[0])!==canonicalSha256(expected))throw new TypeError('DOCUMENT_SCOPE_READING_EFFECTIVE_MISMATCH');
 const normalized=normalizeDocumentScopeObservationValue(input.observation,raw);if(normalized===null)return null;
 return {observation:input.observation,reading,raw_value:raw,normalized_value:normalized};
}

export function hasPayslipReadingAnnotations(extraction:NormalizedPayslipExtraction):boolean {
 return extraction.customer_readings!==undefined||extraction.customer_row_readings!==undefined||extraction.customer_scope_readings!==undefined
  ||extraction.customer_source_transcriptions!==undefined||extraction.customer_source_structures!==undefined||extraction.source_reading_context!==undefined;
}
/** Decimal reported totals remain distinct from paid regular hours. Balance
 * answers resolve only the unit, never replace the original printed number. */
export function normalizeSourceTranscriptionValue(subject:SourceTranscriptionSubject,raw:string){
 if(subject.kind==='reported_work_hours'){
  // This subject fixes the unit as hours; the generic decimal parser also
  // accepts day suffixes, which must not silently become hours here.
  if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw.trim()))return null;
  const amount=normalizeDecimal(raw);return amount===null||amount.startsWith('-')?null:{kind:'reported_work_hours' as const,meaning:subject.meaning,amount,unit:'hours' as const};
 }
 const units:Readonly<Record<string,'days'|'hours'>>={days:'days',day:'days','ימים':'days','יום':'days',hours:'hours',hour:'hours','שעות':'hours','שעה':'hours'};
 const unit=units[raw.trim().toLowerCase()],amount=normalizeDecimal(subject.original_candidate.raw_value);
 return !unit||amount===null?null:{kind:'balance_unit' as const,candidate_id:subject.original_candidate.candidate_id,field:subject.original_candidate.field,amount,unit,amount_verified:false as const,unit_verified:true as const};
}
export function identifiedSourceTranscription(input:{original:NormalizedPayslipExtraction;sourceTranscriptions:ReadonlyMap<string,CustomerSourceTranscription>;subjectKind:SourceTranscriptionSubject['kind'];candidateId?:string}){
 const matching=[...input.sourceTranscriptions.values()].filter(r=>r.subject.kind===input.subjectKind&&(r.subject.kind!=='balance_unit'||r.subject.original_candidate.candidate_id===input.candidateId));
 if(matching.length!==1)return null;
 const reading=matching[0];
 if(reading.document_id!==input.original.document_id||reading.normalized_extraction_sha256!==payslipMachineExtractionSha256(input.original))throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_BINDING_MISMATCH');
 const value=normalizeSourceTranscriptionValue(reading.subject,reading.transcription.raw_value);
 if(value===null||canonicalSha256(value)!==canonicalSha256(reading.transcription.normalized_value))throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_VALUE_INVALID');
 return {reading,subject:reading.subject,raw_value:reading.transcription.raw_value,normalized_value:value};
}

/** A receipt confirms one row cell, not its semantic classification or peers.
 * The caller still applies source quality, period, scope and conflict gates. */
export function identifiedDirectRowCell(input:{original:NormalizedPayslipExtraction;effective:NormalizedPayslipExtraction;rowReadings:ReadonlyMap<string,CustomerDocumentRowCellReading>;row:Row;cell:RowReadingCell}){
 const reading=input.rowReadings.get(rowCellReadingKey(input.row.component_id,input.cell));
 if(!reading)return null;
 const originals=input.original.additional_components.filter(r=>r.component_id===input.row.component_id),effective=input.effective.additional_components.filter(r=>r.component_id===input.row.component_id);
 if(originals.length!==1||effective.length!==1||canonicalSha256(originals[0])!==canonicalSha256(input.row)
  ||reading.component_id!==input.row.component_id||reading.cell!==input.cell||reading.original_component_sha256!==canonicalSha256(input.row)||reading.document_id!==input.original.document_id
  ||input.original.document_id!==input.effective.document_id||reading.normalized_extraction_sha256!==payslipMachineExtractionSha256(input.original))throw new TypeError('DOCUMENT_ROW_READING_BINDING_MISMATCH');
 const row=effective[0],raw=row[`${input.cell}_raw`],value=row[input.cell];
 const expectedRaw=reading.correction?.raw_value??input.row[`${input.cell}_raw`],expectedValue=normalizeDocumentRowCellValue(input.cell,expectedRaw);
 if(raw!==expectedRaw||canonicalSha256(value)!==canonicalSha256(expectedValue))throw new TypeError('DOCUMENT_ROW_READING_EFFECTIVE_MISMATCH');
 if(!usableRowValue(input.cell,raw,value)||raw===null||value===null)return null;
 return {row:input.row,reading,raw_value:raw,normalized_value:value};
}

/** Effective view only: originals and their hashes remain unchanged in the
 * saved provider checkpoint. A read correction cannot select another candidate
 * or resolve a sibling observation. Callers must retain the original snapshot. */
export function materializeValidatedPayslipReadings(input:{document:unknown;extraction:NormalizedPayslipExtraction;case_id:string;requireDistinctTargets?:boolean}){
 const document=immutableDocumentSchema.parse(input.document),original=normalizedPayslipExtractionSchema.parse(input.extraction);
 if(document.case_id!==input.case_id||document.document_id!==original.document_id)throw new TypeError('DOCUMENT_READING_BINDING_MISMATCH');
 const {customer_readings=[],customer_row_readings=[],customer_scope_readings=[],customer_source_transcriptions=[],customer_source_structures=[],source_reading_context}=original,machine=payslipMachineExtraction(original),readings=new Map<string,CustomerDocumentReading>(),rowReadings=new Map<string,CustomerDocumentRowCellReading>(),scopeReadings=new Map<string,CustomerDocumentScopeReading>(),sourceTranscriptions=new Map<string,CustomerSourceTranscription>(),structureReadings=new Map<string,CustomerSourceStructureReading>(),requests=new Set<string>(),targets=new Set<string>();
 for(const reading of customer_readings){
  const candidates=original.fields.filter(f=>f.candidate_id===reading.candidate_id),periods=original.fields.filter(f=>f.field==='salary_period');
  if(reading.case_id!==document.case_id||reading.document_id!==document.document_id||reading.source_sha256!==document.content_sha256
   ||reading.normalized_extraction_sha256!==canonicalSha256(machine)||candidates.length!==1||reading.candidate_sha256!==canonicalSha256(candidates[0])||readings.has(reading.candidate_id)
   ||input.requireDistinctTargets&&(requests.has(reading.request_id)||targets.has(reading.target_sha256))
   ||!periods.length||periods.some(f=>!f.normalized_value||`${f.normalized_value.year}-${String(f.normalized_value.month).padStart(2,'0')}`!==reading.month))throw new TypeError('DOCUMENT_READING_BINDING_MISMATCH');
  readings.set(reading.candidate_id,reading);requests.add(reading.request_id);targets.add(reading.target_sha256);
 }
 for(const reading of customer_row_readings){
  const rows=original.additional_components.filter(r=>r.component_id===reading.component_id),periods=original.fields.filter(f=>f.field==='salary_period'),key=rowCellReadingKey(reading.component_id,reading.cell);
  if(reading.case_id!==document.case_id||reading.document_id!==document.document_id||reading.source_sha256!==document.content_sha256
   ||reading.normalized_extraction_sha256!==canonicalSha256(machine)||rows.length!==1||rows[0].source.document_id!==document.document_id
   ||reading.original_component_sha256!==canonicalSha256(rows[0])||original.fields.some(f=>f.candidate_id===reading.component_id)
   ||original.source_scope_observations?.some(o=>o.candidate.candidate_id===reading.component_id)||rowReadings.has(key)||requests.has(reading.request_id)||targets.has(reading.target_sha256)
   ||!periods.length||periods.some(f=>!f.normalized_value||`${f.normalized_value.year}-${String(f.normalized_value.month).padStart(2,'0')}`!==reading.month))throw new TypeError('DOCUMENT_ROW_READING_BINDING_MISMATCH');
  const row=rows[0],raw=row[`${reading.cell}_raw`];
  if(raw===null||!raw.trim())throw new TypeError('DOCUMENT_ROW_READING_BLANK_SOURCE');
  const originalValue=row[reading.cell];
  if(typeof originalValue==='object'&&originalValue!==null&&'currency' in originalValue&&originalValue.currency!=='ILS')throw new TypeError('DOCUMENT_ROW_READING_CURRENCY');
  const correction=reading.correction,value=normalizeDocumentRowCellValue(reading.cell,correction?.raw_value??raw);
  if(correction){if(value===null||!usableRowValue(reading.cell,correction.raw_value,value)||canonicalSha256(value)!==canonicalSha256(correction.normalized_value))throw new TypeError('DOCUMENT_ROW_READING_CORRECTION_INVALID');}
  else if(!usableRowValue(reading.cell,raw,originalValue))throw new TypeError('DOCUMENT_ROW_READING_VALUE_INVALID');
  rowReadings.set(key,reading);requests.add(reading.request_id);targets.add(reading.target_sha256);
 }
 for(const reading of customer_scope_readings){
  const observations=original.source_scope_observations?.filter(o=>o.candidate.candidate_id===reading.candidate_id)??[],periods=original.fields.filter(f=>f.field==='salary_period');
  if(reading.case_id!==document.case_id||reading.document_id!==document.document_id||reading.source_sha256!==document.content_sha256
   ||reading.normalized_extraction_sha256!==canonicalSha256(machine)||observations.length!==1||observations[0].candidate.source.document_id!==document.document_id
   ||reading.original_observation_sha256!==canonicalSha256(observations[0])||scopeReadings.has(reading.candidate_id)||readings.has(reading.candidate_id)
   ||original.fields.some(f=>f.candidate_id===reading.candidate_id)||original.additional_components.some(r=>r.component_id===reading.candidate_id)
   ||requests.has(reading.request_id)||targets.has(reading.target_sha256)||!periods.length
   ||periods.some(f=>!f.normalized_value||`${f.normalized_value.year}-${String(f.normalized_value.month).padStart(2,'0')}`!==reading.month))throw new TypeError('DOCUMENT_SCOPE_READING_BINDING_MISMATCH');
  const observation=observations[0],raw=reading.correction?.raw_value??observation.candidate.raw_value;
  const value=normalizeDocumentScopeObservationValue(observation,raw);
  if(value===null||reading.correction&&canonicalSha256(value)!==canonicalSha256(reading.correction.normalized_value))throw new TypeError('DOCUMENT_SCOPE_READING_VALUE_INVALID');
  const originalValue=normalizePayslipFieldValue(observation.candidate);
  if(originalValue!==null&&typeof originalValue==='object'&&'currency' in originalValue&&originalValue.currency!=='ILS')throw new TypeError('DOCUMENT_SCOPE_READING_CURRENCY');
  scopeReadings.set(reading.candidate_id,reading);requests.add(reading.request_id);targets.add(reading.target_sha256);
 }
 if(source_reading_context!==undefined&&original.customer_source_transcriptions===undefined&&original.customer_source_structures===undefined)throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_CONTEXT_ORPHAN');
 if(customer_source_transcriptions.length){
  if(!source_reading_context)throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_CONTEXT_REQUIRED');
  const firstPass=normalizedPayslipExtractionSchema.parse(source_reading_context.first_pass);
  if(hasPayslipReadingAnnotations(firstPass)||firstPass.document_id!==document.document_id)throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_CONTEXT_INVALID');
  const subjects=new Set<string>();
  for(const reading of customer_source_transcriptions){
   const periods=original.fields.filter(f=>f.field==='salary_period'),subject=reading.subject,key=subject.kind==='reported_work_hours'?'reported_work_hours':`balance_unit:${subject.original_candidate.candidate_id}`;
   if(reading.case_id!==document.case_id||reading.document_id!==document.document_id||reading.source_sha256!==document.content_sha256
    ||reading.normalized_extraction_sha256!==canonicalSha256(machine)||reading.extraction_result_sha256!==source_reading_context.checkpoint_result_sha256
    ||subjects.has(key)||requests.has(reading.request_id)||targets.has(reading.target_sha256)||!periods.length
    ||periods.some(f=>!f.normalized_value||`${f.normalized_value.year}-${String(f.normalized_value.month).padStart(2,'0')}`!==reading.month))throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_BINDING_MISMATCH');
   if(subject.kind==='reported_work_hours'){
    if(subject.page>original.quality_metrics.page_count||subject.page>firstPass.quality_metrics.page_count
     ||[...(original.source_scope_observations??[]),...(firstPass.source_scope_observations??[])].some(o=>o.scope==='attendance_total'))throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_PRESENT_SOURCE');
   }else{
    const field=subject.original_candidate,found=firstPass.fields.filter(f=>f.candidate_id===field.candidate_id);
    if(subject.first_pass_extraction_sha256!==canonicalSha256(firstPass)||found.length!==1||canonicalSha256(found[0])!==canonicalSha256(field)
     ||field.source.document_id!==document.document_id||field.source.page>firstPass.quality_metrics.page_count||field.source.page>original.quality_metrics.page_count
     ||original.fields.some(f=>f.field===field.field)||normalizeDecimal(field.raw_value)===null)throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_RETAINED_SOURCE');
   }
   const value=normalizeSourceTranscriptionValue(subject,reading.transcription.raw_value);
   if(value===null||canonicalSha256(value)!==canonicalSha256(reading.transcription.normalized_value))throw new TypeError('DOCUMENT_SOURCE_TRANSCRIPTION_VALUE_INVALID');
   sourceTranscriptions.set(reading.target_sha256,reading);subjects.add(key);requests.add(reading.request_id);targets.add(reading.target_sha256);
  }
 }
 if(customer_source_structures.length){
  if(!source_reading_context)throw new TypeError('DOCUMENT_SOURCE_STRUCTURE_CONTEXT_REQUIRED');
  // V2 consumers must compare prerequisite receipts with the independently
  // admitted current period map, irrespective of annotation array order.
  const ordered=[...customer_source_structures.filter(r=>r.schema_version==='document-source-structure-reading-v1'),...customer_source_structures.filter(r=>r.schema_version==='document-source-structure-reading-v2')];
  for(const reading of ordered){
   const periodWitness=reading.schema_version==='document-source-structure-reading-v2'?reading.period_witness:undefined;
   const first=assertSourceStructureSubject({subject:reading.subject,extraction:machine,firstPass:source_reading_context.first_pass,...(periodWitness?{period_witness:periodWitness}:{})});
   const periods=machine.fields.filter(f=>f.field==='salary_period'),key=sourceStructureSubjectKey(reading.subject);
   if(hasPayslipReadingAnnotations(first)||reading.case_id!==document.case_id||reading.document_id!==document.document_id||reading.source_sha256!==document.content_sha256
    ||reading.normalized_extraction_sha256!==canonicalSha256(machine)||reading.first_pass_extraction_sha256!==canonicalSha256(first)
    ||reading.extraction_result_sha256!==source_reading_context.checkpoint_result_sha256||structureReadings.has(key)||requests.has(reading.request_id)||targets.has(reading.target_sha256)
    ||!periods.length||periods.some(f=>!f.normalized_value||`${f.normalized_value.year}-${String(f.normalized_value.month).padStart(2,'0')}`!==reading.month))throw new TypeError('DOCUMENT_SOURCE_STRUCTURE_BINDING_MISMATCH');
   const {normalized_value:value}=parseSourceStructureReadingValue(reading);
   if(canonicalSha256(value)!==canonicalSha256(reading.value))throw new TypeError('DOCUMENT_SOURCE_STRUCTURE_VALUE_INVALID');
   if(periodWitness)assertSourceStructurePeriodWitness({witness:periodWitness,refs:sourceStructureRefs(reading.subject),period:periodWitness.period,currentReadings:structureReadings,
    pins:{case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,normalized_extraction_sha256:canonicalSha256(machine),
     first_pass_extraction_sha256:canonicalSha256(first),extraction_result_sha256:source_reading_context.checkpoint_result_sha256,month:reading.month,policy_version:reading.policy_version}});
   structureReadings.set(key,reading);requests.add(reading.request_id);targets.add(reading.target_sha256);
  }
 }
 const fields=original.fields.map(field=>{
  const correction=readings.get(field.candidate_id)?.correction;if(!correction)return field;
  const {normalized_value:previous,...raw}=field;void previous;
  const candidate=rawCandidateFieldSchema.parse({...raw,raw_value:correction.raw_value}),value=normalizePayslipFieldValue(candidate);
  if(value===null||canonicalSha256(value)!==canonicalSha256(correction.normalized_value))throw new TypeError('DOCUMENT_READING_CORRECTION_INVALID');
  if(typeof value==='object'&&'currency' in value&&value.currency!=='ILS')throw new TypeError('DOCUMENT_READING_CORRECTION_INVALID');
  if(typeof value==='object'&&'year' in value&&`${value.year}-${String(value.month).padStart(2,'0')}`!==readings.get(field.candidate_id)!.month)throw new TypeError('DOCUMENT_READING_CORRECTION_INVALID');
  return normalizedCandidateFieldSchema.parse({...candidate,normalized_value:value});
 });
 const effective=normalizedPayslipExtractionSchema.parse({...original,fields});
 const additional_components=original.additional_components.map(row=>{
  let effectiveRow=row;
  for(const cell of ['quantity','rate','amount','percentage'] as const){
   const candidate=identifiedMappedRowCell({original,effective,readings,row,cell});
   if(candidate&&readings.get(candidate.candidate_id)?.correction){
    const value=normalizeDocumentRowCellValue(cell,candidate.raw_value);
    if(value!==null)effectiveRow=normalizedAdditionalComponentSchema.parse({...effectiveRow,[`${cell}_raw`]:candidate.raw_value,[cell]:value});
   }
   const direct=rowReadings.get(rowCellReadingKey(row.component_id,cell));
   if(!direct)continue;
   const raw=direct.correction?.raw_value??row[`${cell}_raw`],value=normalizeDocumentRowCellValue(cell,raw);
   // Two different admitted readings of the same cell cannot choose a winner.
   if(candidate&&(candidate.raw_value!==raw||canonicalSha256(normalizeDocumentRowCellValue(cell,candidate.raw_value))!==canonicalSha256(value)))throw new TypeError('DOCUMENT_ROW_READING_CONFLICT');
   if(direct.correction)effectiveRow=normalizedAdditionalComponentSchema.parse({...effectiveRow,[`${cell}_raw`]:raw,[cell]:value});
  }
  return effectiveRow;
 });
 const source_scope_observations=original.source_scope_observations?.map(observation=>{
  const correction=scopeReadings.get(observation.candidate.candidate_id)?.correction;
  return correction?{...observation,candidate:{...observation.candidate,raw_value:correction.raw_value}}:observation;
 });
 return {original,extraction:normalizedPayslipExtractionSchema.parse({...effective,additional_components,...(source_scope_observations!==undefined?{source_scope_observations}:{})}),readings,rowReadings,scopeReadings,sourceTranscriptions,structureReadings,hasCorrections:customer_readings.some(r=>r.correction!==undefined)||customer_row_readings.some(r=>r.correction!==undefined)||customer_scope_readings.some(r=>r.correction!==undefined)};
}

/** Consumers must use the validated map, keeping structure evidence separate
 * from the numeric operands' own source reading receipts. */
export function identifiedSourceStructure(input:{original:NormalizedPayslipExtraction;structureReadings:ReadonlyMap<string,CustomerSourceStructureReading>;subject:SourceStructureSubject}){
 const reading=input.structureReadings.get(sourceStructureSubjectKey(input.subject));if(!reading)return null;
 if(reading.document_id!==input.original.document_id||reading.normalized_extraction_sha256!==payslipMachineExtractionSha256(input.original)
  ||canonicalSha256(reading.subject)!==canonicalSha256(input.subject))throw new TypeError('DOCUMENT_SOURCE_STRUCTURE_BINDING_MISMATCH');
 const value=normalizeSourceStructureValue(input.subject,reading.value,reading.month);
 if(canonicalSha256(value)!==canonicalSha256(reading.value))throw new TypeError('DOCUMENT_SOURCE_STRUCTURE_VALUE_INVALID');
 return {reading,subject:reading.subject,normalized_value:value};
}
