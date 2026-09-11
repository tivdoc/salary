import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {reviewRequestsCoveredByFieldReadings} from './review-field-coverage';
import {documentFieldTarget} from './document-field-confirmation';
import {reviewFieldCoverageFixture} from './review-field-coverage.fixture';
vi.mock('server-only',()=>({}));
const nowMs=Date.parse('2026-09-11T00:00:00Z');
it.each([false,true])('covers only the same existing field action; row=%s',row=>{
 const f=reviewFieldCoverageFixture(row),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,candidate_id:f.candidate.candidate_id}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(f.review.checks[0].calculation.state).toBe('blocked');
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
