import {immutableDocumentSchema} from '../domain/documents.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {rawCandidateFieldSchema} from './contracts.ts';
import {normalizedCandidateFieldSchema,normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema,type NormalizedCandidateField,type NormalizedPayslipExtraction} from './payslip.ts';
import {normalizePayslipFieldValue,normalizeMoney,normalizeDecimal,normalizePercentage} from './normalization.ts';
import type {CustomerDocumentReading} from './customer-reading.ts';

type Row=NormalizedPayslipExtraction['additional_components'][number];
export type MappedRowCell='quantity'|'rate'|'amount'|'percentage';
const mappedRowFields:Partial<Record<Row['semantic_kind'],Partial<Record<MappedRowCell,string>>>>={
 hourly_base:{quantity:'regular_hours',rate:'hourly_rate',amount:'base_monthly_salary'},base_salary:{amount:'base_monthly_salary'},
 overtime_125:{quantity:'overtime_125_hours'},overtime_150:{quantity:'overtime_150_hours'},travel:{amount:'travel_amount'},convalescence:{amount:'convalescence_amount'},
};
/** Scalar projection and row observation describe the SAME printed cell only
 * with this exact binding. No similarity, arithmetic fit or nearest label. */
export function identifiedMappedRowCell(input:{original:NormalizedPayslipExtraction;effective:NormalizedPayslipExtraction;readings:ReadonlyMap<string,CustomerDocumentReading>;row:Row;cell:MappedRowCell}):NormalizedCandidateField|null {
 const {row,cell}=input,field=mappedRowFields[row.semantic_kind]?.[cell],raw=row[`${cell}_raw`];
 if(!field||raw===null||row.source.text_fragment!==row.source_label)return null;
 const sameSource=(candidate:NormalizedCandidateField)=>candidate.source.document_id===row.source.document_id&&candidate.source.page===row.source.page
  &&candidate.source.text_fragment===`${row.source_label}: ${raw}`
  &&canonicalSha256(candidate.source.bounding_box??null)===canonicalSha256(row.source.bounding_box??null)
  &&canonicalSha256(candidate.source.region??null)===canonicalSha256(row.source.region??null)
  &&canonicalSha256(candidate.source.source_scope??null)===canonicalSha256(row.source.source_scope??null);
 const candidates=input.original.fields.filter(c=>c.field===field&&c.raw_value===raw&&sameSource(c));
 if(candidates.length!==1||!input.readings.has(candidates[0].candidate_id))return null;
 return input.effective.fields.find(c=>c.candidate_id===candidates[0].candidate_id)??null;
}

/** Effective view only: originals and their hashes remain unchanged in the
 * saved provider checkpoint. A read correction cannot select another candidate
 * or resolve a sibling observation. Callers must retain the original snapshot. */
export function materializeValidatedPayslipReadings(input:{document:unknown;extraction:NormalizedPayslipExtraction;case_id:string;requireDistinctTargets?:boolean}){
 const document=immutableDocumentSchema.parse(input.document),original=normalizedPayslipExtractionSchema.parse(input.extraction);
 if(document.case_id!==input.case_id||document.document_id!==original.document_id)throw new TypeError('DOCUMENT_READING_BINDING_MISMATCH');
 const {customer_readings=[],...machine}=original,readings=new Map<string,CustomerDocumentReading>(),requests=new Set<string>(),targets=new Set<string>();
 for(const reading of customer_readings){
  const candidates=original.fields.filter(f=>f.candidate_id===reading.candidate_id),periods=original.fields.filter(f=>f.field==='salary_period');
  if(reading.case_id!==document.case_id||reading.document_id!==document.document_id||reading.source_sha256!==document.content_sha256
   ||reading.normalized_extraction_sha256!==canonicalSha256(machine)||candidates.length!==1||reading.candidate_sha256!==canonicalSha256(candidates[0])||readings.has(reading.candidate_id)
   ||input.requireDistinctTargets&&(requests.has(reading.request_id)||targets.has(reading.target_sha256))
   ||!periods.length||periods.some(f=>!f.normalized_value||`${f.normalized_value.year}-${String(f.normalized_value.month).padStart(2,'0')}`!==reading.month))throw new TypeError('DOCUMENT_READING_BINDING_MISMATCH');
  readings.set(reading.candidate_id,reading);requests.add(reading.request_id);targets.add(reading.target_sha256);
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
   if(!candidate||!readings.get(candidate.candidate_id)?.correction)continue;
   const value=cell==='quantity'?normalizeDecimal(candidate.raw_value):cell==='percentage'?normalizePercentage(candidate.raw_value):normalizeMoney(candidate.raw_value);
   if(value===null)continue;
   effectiveRow=normalizedAdditionalComponentSchema.parse({...effectiveRow,[`${cell}_raw`]:candidate.raw_value,[cell]:value});
  }
  return effectiveRow;
 });
 return {original,extraction:normalizedPayslipExtractionSchema.parse({...effective,additional_components}),readings,hasCorrections:customer_readings.some(r=>r.correction!==undefined)};
}
