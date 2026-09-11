import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {DOCUMENT_REVIEW_COVERAGE_POLICY,documentReviewInputSchema,type DocumentReviewInput,type DocumentReviewCheckResult,type DocumentReviewCoverageInventory} from './contracts.ts';
import {normalizeSourceTranscriptionValue} from '../extraction/reading-resolution.ts';

/** Add a new immutable review revision; callers supply authenticated purchase
 * evidence. Source periods are never promoted to purchase periods here. */
export function attachDocumentReviewCoverage(candidate:unknown,purchasePeriod?:DocumentReviewInput['purchased_scope']['purchase_period_evidence']):DocumentReviewInput{
 const input=documentReviewInputSchema.parse(candidate);
 if(input.purchased_scope.purchase_period_evidence&&purchasePeriod
  &&canonicalSha256(input.purchased_scope.purchase_period_evidence)!==canonicalSha256(purchasePeriod))throw Error('REVIEW_PURCHASE_PERIOD_REPLACEMENT');
 return documentReviewInputSchema.parse({...input,coverage_policy:DOCUMENT_REVIEW_COVERAGE_POLICY,
  purchased_scope:{...input.purchased_scope,...(purchasePeriod?{purchase_period_evidence:purchasePeriod}:{})}});
}

/** Purchased topics, source periods and executed checks are different scopes.
 * None of them alone establishes complete legal or financial coverage. */
export function documentReviewCoverageInventory(input:DocumentReviewInput,checks:readonly DocumentReviewCheckResult[]):DocumentReviewCoverageInventory|undefined{
 if(input.coverage_policy!==DOCUMENT_REVIEW_COVERAGE_POLICY)return undefined;
 const projection=input.period_projection;
 if(projection){
  const {projection_sha256,...body}=projection;
  if(canonicalSha256(body)!==projection_sha256||canonicalSha256(projection.selected_period)!==canonicalSha256(input.period))throw Error('REVIEW_PROJECTION_BINDING');
  if(new Set(projection.excluded_checks.map(c=>c.check_id)).size!==projection.excluded_checks.length)throw Error('REVIEW_PROJECTION_DUPLICATE');
  for(const row of projection.excluded_checks){
   const outside=row.period.to<input.period.from||row.period.from>input.period.to;
   if(row.period.from>=input.period.from&&row.period.to<=input.period.to
    ||row.reason!==(outside?'outside_month':'cross_month')
    ||row.period.from<projection.source_period.from||row.period.to>projection.source_period.to
    ||checks.some(c=>c.check_id===row.check_id)
    ||!input.coverage_gaps.some(g=>g.check_id===row.check_id&&g.topic===row.topic))throw Error('REVIEW_PROJECTION_EXCLUDED_SCOPE');
  }
 }
 const balances:DocumentReviewCoverageInventory['source_balance_observations']=(input.source_observation_inventory??[]).flatMap(i=>i.observations.flatMap(o=>{
  if(o.field!=='vacation_balance'&&o.field!=='sick_balance')return [];
  const readings=i.unit_readings?.filter(r=>r.subject.kind==='balance_unit'&&r.subject.original_candidate.candidate_id===o.candidate_id)??[];
  if(readings.length>1)throw Error('REVIEW_BALANCE_READING_DUPLICATE');
  const reading=readings[0],value=reading?normalizeSourceTranscriptionValue(reading.subject,reading.transcription.raw_value):null;
  if(reading&&(reading.subject.kind!=='balance_unit'||canonicalSha256(reading.subject.original_candidate)!==canonicalSha256(o)
   ||reading.subject.first_pass_extraction_sha256!==i.original_pass_sha256||reading.case_id!==input.case_id||reading.document_id!==i.document_id
   ||reading.source_sha256!==i.source_sha256||reading.normalized_extraction_sha256!==i.machine_extraction_sha256
   ||reading.extraction_result_sha256!==i.checkpoint_result_sha256||!value||value.kind!=='balance_unit'
   ||canonicalSha256(value)!==canonicalSha256(reading.transcription.normalized_value)))throw Error('REVIEW_BALANCE_READING_BINDING');
  return [{document_id:i.document_id,version_id:i.version_id,field:o.field,candidate_id:o.candidate_id,raw_value:o.raw_value,
   unit:value?.kind==='balance_unit'?value.unit:null,page:o.source.page,reading_status:reading?'identified_unit_reading' as const:'unit_unresolved' as const,amount_verified:false as const}];
 }));
 return {schema_version:DOCUMENT_REVIEW_COVERAGE_POLICY,review_period:input.period,
  purchased_topics:input.purchased_scope.topics,
  purchase_period_evidence:input.purchased_scope.purchase_period_evidence??{state:'not_provided',periods:[]},
  source_periods:input.documents.map(d=>({document_id:d.document_id,version_id:d.version_id,kind:d.kind,period:d.period})),
  ...(projection?{period_projection:projection}:{}),
  unresolved_source_observations:balances.flatMap(o=>o.unit===null?[{document_id:o.document_id,version_id:o.version_id,field:o.field,candidate_id:o.candidate_id,raw_value:o.raw_value,unit:null,page:o.page}]:[]),
  source_balance_observations:balances,
  topics:input.purchased_scope.topics.map(topic=>{
   const selected=checks.filter(c=>c.topic===topic),gaps=input.coverage_gaps.filter(g=>g.topic===topic);
   return {topic,calculated_check_ids:selected.filter(c=>c.calculation.state==='calculated').map(c=>c.check_id),
    blocked_check_ids:selected.filter(c=>c.calculation.state!=='calculated').map(c=>c.check_id),
    excluded_check_ids:projection?.excluded_checks.filter(c=>c.topic===topic).map(c=>c.check_id)??[],gap_ids:gaps.map(g=>g.check_id),
    coverage:selected.length?'partial' as const:'not_evaluated' as const};
  }),legal_coverage_complete:false};
}
