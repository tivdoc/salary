import 'server-only';
import {extractionResultSchema,type ExtractionResult,type RawAdditionalComponent} from '@/engine/extraction/contracts';
import {normalizeMoney} from '@/engine/extraction/normalization';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

export const OPENAI_V2_AGGREGATE_TOTAL_POLICY='payslip-explicit-aggregate-total-v1' as const;
type TotalField='gross_salary'|'total_deductions'|'net_salary';
// Exact aggregate labels only, never substring guesses such as "net bonus".
const labels:Readonly<Record<TotalField,readonly string[]>>={
 gross_salary:['gross salary','gross salary (ils)','gross total','ברוטו','שכר ברוטו','סה"כ ברוטו','סה״כ ברוטו','סך תשלומים'],
 total_deductions:['total deductions','total deductions (ils)','deductions total','סה"כ ניכויים','סה״כ ניכויים','סך ניכויים'],
 net_salary:['net salary','net salary (ils)','net total','נטו','שכר נטו','נטו לתשלום'],
};
const totalField=(row:RawAdditionalComponent)=>(Object.keys(labels) as TotalField[])
 .find(field=>labels[field].includes(row.source_label.trim().toLowerCase()));

/** Separates only a uniquely linked duplicate of an explicit aggregate total.
 * No amount is inferred, no raw observation is discarded, and a genuine or
 * ambiguous unknown row stays in earnings for the existing uncertainty gates. */
export function classifyOpenAiV2AggregateTotalRows(input:ExtractionResult):ExtractionResult{
 const extraction=extractionResultSchema.parse(input);
 const observations=[...(extraction.aggregate_total_observations??[])],classified=new Set<string>();
 for(const field of Object.keys(labels) as TotalField[]){
  if(observations.some(observation=>observation.total_field===field))continue;
  const candidates=extraction.fields.filter(candidate=>candidate.field===field);
  const matchingRows=extraction.additional_components.filter(row=>totalField(row)===field);
  if(candidates.length!==1||matchingRows.length!==1)continue;
  const candidate=candidates[0],row=matchingRows[0];
  if(!['unknown','other'].includes(row.semantic_kind)||row.quantity_raw!==null||row.rate_raw!==null||row.percentage_raw!==null
   ||row.amount_raw===null||row.amount_raw.trim()!==candidate.raw_value.trim()
   ||row.source.document_id!==candidate.source.document_id||row.source.page!==candidate.source.page
   ||row.source.text_fragment!==row.source_label
   ||candidate.source.text_fragment!==`${row.source_label}: ${candidate.raw_value}`
   ||canonicalSha256(row.source.bounding_box??null)!==canonicalSha256(candidate.source.bounding_box??null)
   ||row.confidence<.94||candidate.confidence<.94||row.warning_flags.length||candidate.warning_flags.length
   ||normalizeMoney(row.amount_raw)===null)continue;
  classified.add(row.component_id);observations.push({policy_version:OPENAI_V2_AGGREGATE_TOTAL_POLICY,total_field:field,
   total_candidate_id:candidate.candidate_id,total_candidate:candidate,row});
 }
 if(!classified.size)return extraction;
 return extractionResultSchema.parse({...extraction,
  additional_components:extraction.additional_components.filter(row=>!classified.has(row.component_id)),
  aggregate_total_observations:observations,warnings:[...new Set([...extraction.warnings,'aggregate_total_rows_classified'])]});
}
