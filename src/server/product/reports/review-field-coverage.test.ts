import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {reviewRequestsCoveredByFieldReadings,reviewFieldReadingCheckLabels,reviewFieldRequestsNotRequired} from './review-field-coverage';
import {documentFieldTarget} from './document-field-confirmation';
import {reviewFieldCoverageFixture,reviewRowCellCoverageFixture,reviewSourceScopeCoverageFixture,reviewSourceTranscriptionFixture,reviewUnusedFieldFixture} from './review-field-coverage.fixture';
import {documentRowCellTarget} from './document-row-cell-confirmation';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
vi.mock('server-only',()=>({}));
const nowMs=Date.parse('2026-09-11T00:00:00Z');
it('projects an unused salary-type action only for the explicitly versioned current arithmetic review',()=>{
 const f=reviewUnusedFieldFixture(),before=canonicalSha256(f.review),requestBefore=canonicalSha256(f.fieldRequest);
 expect(reviewFieldRequestsNotRequired({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,reason:'no_current_check_dependency'}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(canonicalSha256(f.fieldRequest)).toBe(requestBefore);
});
it.each(['legacy_policy','missing_period','no_checks','unknown_need','unexplained_gap','bad_locator','used_field','stale_request','expired_request','foreign_source']as const)('keeps the action visible when non-dependency cannot be proved: %s',change=>{
 const f=reviewUnusedFieldFixture();let review=f.review,request=f.fieldRequest;
 if(change==='stale_request')request={...request,source_current:false};
 else if(change==='expired_request')request={...request,expires_at:'2025-02-01T00:00:00Z'};
 else if(change==='foreign_source'){
  const target=documentFieldTarget({checkpoint:{...f.checkpoint,input_sha256:'f'.repeat(64)},policyVersion:request.target.policy_version,candidateId:request.target.candidate.candidate_id});
  request={...request,target,code:`document_field:${target.target_sha256}`};
 }else{
  const input=structuredClone(f.input);
  if(change==='legacy_policy')delete input.coverage_policy;
  if(change==='missing_period')input.documents[0].period=null;
  if(change==='no_checks'){input.checks=[];input.answer_bindings=[];input.completion_input={...input.completion_input as object,needs:[]};}
  if(change==='unknown_need'){
   const completion=input.completion_input as {needs:{fact_key:string}[]};completion.needs.push({...completion.needs[0],fact_key:'unmapped.need'});
  }
  if(change==='unexplained_gap')input.coverage_gaps.push({check_id:'unexplained',topic:'working_time',kind:'missing_fact',detail:'מידע חסר',next_step:'יש לברר את המקור'});
  if(change==='bad_locator'||change==='used_field'){
   const old=documentReviewCalculationInputSchema.parse(input.checks[0].calculation);
   input.checks[0].calculation={...old,operands:old.operands.map(o=>({...o,source:{...o.source,locator:change==='bad_locator'?'{truncated':JSON.stringify({schema_version:'document-review-source-locator-v2',field:request.target.candidate.field,candidate_ids:[request.target.candidate.candidate_id],candidate_sha256:[canonicalSha256(request.target.candidate)],raw_values:[request.target.candidate.raw_value]})}}))};
  }
  review=runDocumentReview(input,'conservative-projection');
 }
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[request],nowMs})).toEqual([]);
});
it.each(['reported_work_hours','balance_unit']as const)('does not hide an existing observation request behind a missing %s transcription',kind=>{
 const f=reviewSourceTranscriptionFixture(kind),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,check_titles:[]}]);
 expect(canonicalSha256(f.review)).toBe(before);
});
it.each([false,true])('covers only the same existing field action; row=%s',row=>{
 const f=reviewFieldCoverageFixture(row),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,candidate_id:f.candidate.candidate_id}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(f.review.checks[0].calculation.state).toBe('blocked');
});

it('covers an unmapped row cell by exact component and cell without inventing a scalar candidate',()=>{
 const f=reviewRowCellCoverageFixture(),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{
  target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,component_id:f.component.component_id,cell:'quantity'}]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,check_titles:['כמות בשורת המקור']}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(f.review.checks[0].calculation.state).toBe('blocked');
});
it.each(['cell','same_label_other_id','foreign_source','merged_components','changed_raw']as const)('does not consolidate an unmapped row from %s',change=>{
 const f=reviewRowCellCoverageFixture();let review=f.review,request=f.fieldRequest;
 if(change==='cell'){const target=documentRowCellTarget({checkpoint:f.checkpoint,policyVersion:request.target.policy_version,componentId:f.component.component_id,cell:'rate'});request={...request,target,code:`document_field:${target.target_sha256}`};}
 else{
  const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),operand=old.operands[0],locator=JSON.parse(operand.source.locator);
  if(change==='same_label_other_id')locator.component_ids=['99999999-9999-4999-8999-999999999999'];
  if(change==='merged_components')locator.component_ids.push('99999999-9999-4999-8999-999999999999');
  if(change==='changed_raw')locator.original_raw='3';
  const changed={...operand,source:{...operand.source,locator:JSON.stringify(locator),...(change==='foreign_source'?{file_sha256:'f'.repeat(64)}:{})}};
  // Foreign source cannot enter a valid review; changing the target instead
  // exercises coverage's source fence without weakening review validation.
  if(change==='foreign_source'){
   const checkpoint={...f.checkpoint,input_sha256:'f'.repeat(64)},target=documentRowCellTarget({checkpoint,policyVersion:request.target.policy_version,componentId:f.component.component_id,cell:'quantity'});
   request={...request,target,code:`document_field:${target.target_sha256}`};
  }else review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[changed,old.operands[1]]}}]},'different-row-review');
 }
 expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[request],nowMs})).toEqual([]);
 expect(reviewFieldReadingCheckLabels({review,fieldRequests:[request],nowMs})[0].check_titles).toEqual([]);
});

it('matches the new versioned row locator and rejects a mismatched original-row hash',()=>{
 const f=reviewRowCellCoverageFixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 for(const matching of [true,false]){
  const locator={schema_version:'document-review-source-locator-v2',component_ids:[f.component.component_id],cell:'quantity',
   original_component_sha256:[matching?canonicalSha256(f.component):'f'.repeat(64)],raw_values:[f.component.quantity_raw]};
  const operand={...old.operands[0],source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]]}}]},'versioned-row-review');
  expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(matching?1:0);
 }
});
it('reuses an exact mapped scalar reading from a versioned row without matching only the numeric value',()=>{
 const f=reviewFieldCoverageFixture(true),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),row=JSON.parse(old.operands[0].source.locator);
 for(const exact of [true,false]){
  const locator={schema_version:'document-review-source-locator-v2',component_ids:row.component_ids,cell:'quantity',original_component_sha256:['a'.repeat(64)],raw_values:[f.candidate.raw_value],
   mapped_candidate:{candidate_id:f.candidate.candidate_id,candidate_sha256:exact?canonicalSha256(f.candidate):'f'.repeat(64)}};
  const operand={...old.operands[0],source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]]}}]},'mapped-scalar-review');
  expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(exact?1:0);
 }
});
it('covers only the exact missing reported-hours consumer while preserving its meaning and target pins',()=>{
 const f=reviewSourceTranscriptionFixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 for(const same of [true,false]){
  const locator={schema_version:'document-review-source-locator-v2',transcription_kind:'reported_work_hours',page:1,meaning:'document_reported_total_hours',
   ...(same?{}:{target_sha256:'f'.repeat(64)})};
  const operand={...old.operands[0],id:'reported.hours',state:'missing',printed_value:null,source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const operation={...old.operation,kind:'quantity_comparison',left_ref:'reported.hours',right_ref:'comparison',interpretation:'same_measure'};
  const input={...f.input,answer_bindings:[{fact_key:'source.cell',check_id:'source.check',operand_id:'reported.hours'}],
   checks:[{...f.input.checks[0],title:'השוואה לסך השעות המדווחות',calculation:{...old,operands:[operand,old.operands[1]],operation}}]};
  const review=runDocumentReview(input,'missing-source-hours');
  const covered=reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs});
  expect(covered).toHaveLength(same?1:0);if(same)expect(covered[0]).toMatchObject({transcription_kind:'reported_work_hours'});
  expect(reviewFieldReadingCheckLabels({review,fieldRequests:[f.fieldRequest],nowMs})[0].check_titles).toEqual(same?['השוואה לסך השעות המדווחות']:[]);
 }
});
it('links a source-scope action only to the exact original observation and current check',()=>{
 const f=reviewSourceScopeCoverageFixture();
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{
  target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,
  candidate_id:f.observation.candidate.candidate_id,source_scope:'final_payable'}]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})[0].check_titles).toEqual(['התאמת הסכום הסופי לתשלום']);
 for(const change of ['scope','hash','raw','candidate']as const){
  const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),locator=JSON.parse(old.operands[0].source.locator);
  if(change==='scope')locator.scope='voluntary_deduction';if(change==='hash')locator.scope_observation_sha256=['f'.repeat(64)];
  if(change==='raw')locator.raw_values=['96.1'];if(change==='candidate')locator.candidate_ids=['99999999-9999-4999-8999-999999999999'];
  const operand={...old.operands[0],source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]]}}]},'changed-scope');
  expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
 }
});
it.each(['expired','answered','unknown_answer','stale','different_candidate','different_source'] as const)('does not cover %s',change=>{
 const f=reviewFieldCoverageFixture();
 if(change==='expired')f.fieldRequest.expires_at='2026-01-01T00:00:00Z';
 if(change==='answered'||change==='unknown_answer')f.fieldRequest.answered_at='2026-09-10T00:00:00Z';
 if(change==='stale')f.fieldRequest.source_current=false;
 if(change==='different_candidate'||change==='different_source'){
  const checkpoint=structuredClone(f.checkpoint);
  if(change==='different_source')checkpoint.input_sha256='f'.repeat(64);
  else checkpoint.run.result.final_extraction.fields.find(c=>c.candidate_id===f.candidate.candidate_id)!.candidate_id='99999999-9999-4999-8999-999999999999';
  checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
  const target=documentFieldTarget({checkpoint,policyVersion:f.fieldRequest.target.policy_version,candidateId:change==='different_candidate'?'99999999-9999-4999-8999-999999999999':f.candidate.candidate_id});
  f.fieldRequest.target=target;f.fieldRequest.code=`document_field:${target.target_sha256}`;
 }
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
});
it('does not cover an unmapped row cell or a malformed/truncated locator',()=>{
 for(const change of ['unmapped_semantic','locator']){
  const f=reviewFieldCoverageFixture(true),input=structuredClone(f.input),calculation=input.checks[0].calculation as {operands:{id:string;source:{locator:string}}[]};
  if(change==='unmapped_semantic'){const locator=JSON.parse(calculation.operands[0].source.locator);locator.semantic_kind='bonus';calculation.operands[0].source.locator=JSON.stringify(locator);}else calculation.operands[0].source.locator='{truncated';
  expect(reviewRequestsCoveredByFieldReadings({review:runDocumentReview(input,'changed-source-review'),fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
 }
});
it('does not consolidate an arbitrary declaration or multiple competing current field targets',()=>{
 const f=reviewFieldCoverageFixture();
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest,{...f.fieldRequest,request_id:'11111111-1111-4111-8111-111111111111'}],nowMs})).toEqual([]);
 const input=structuredClone(f.input),completion=input.completion_input as {needs:{required_evidence_kind:string}[]};completion.needs[0].required_evidence_kind='customer_declaration';
 expect(reviewRequestsCoveredByFieldReadings({review:runDocumentReview(input,'declaration'),fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
});

it('links an answered numeric declaration using its preserved original source, without promoting it to a reading',()=>{
 const f=reviewFieldCoverageFixture(),request=f.review.completions.customer_requests[0];
 const applied=applyDocumentReviewAnswer(f.input,{request,actor:{case_id:f.review.case_id,identity_id:'11111111-1111-4111-8111-111111111111'},
  answer:{request_id:'22222222-2222-4222-8222-222222222222',revision:1,answered_at:'2026-09-11T00:00:00Z',state:'provided',value:100}});
 const review=runDocumentReview(applied.input,'answered-declaration');
 expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(1);
 expect(review.checks[0].calculation.state).toBe('blocked');
});
