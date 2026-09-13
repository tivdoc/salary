import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {reviewFieldCoverageFixture} from './review-field-coverage.fixture';
import {savedReviewRequestQuestion} from '../processing/saved-review-requests';
import {documentFieldQuestion,documentFieldTarget} from './document-field-confirmation';
import {listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {runDocumentReview} from '@/engine/document-review/service';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {minimumFixture} from '@/engine/entitlement-review/product-branch.fixture';
import {composeEntitlementReview} from '@/engine/entitlement-review/compose';
const artifactPort=vi.hoisted(()=>({list:vi.fn(),artifact:vi.fn()}));
vi.mock('server-only',()=>({}));
// The existing protected artifact adapter owns strict decoding and case/report
// binding; this boundary test checks its bounded use and fail-closed display.
vi.mock('./private-document-review',()=>({privateDocumentReviewReports:artifactPort.list,privateDocumentReviewArtifact:artifactPort.artifact}));
beforeEach(()=>vi.resetAllMocks());
function fixture(){
 const f=reviewFieldCoverageFixture(true),requestId=randomUUID(),identityId=randomUUID(),reportId=randomUUID();
 const target=f.review.completions.customer_requests[0].target;
 const common={case_id:f.review.case_id,options:null,field_crop:null,blocking:false,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-10-01T00:00:00Z',answered_at:null,answer_text:null};
 const numeric={...common,id:requestId,code:'document_review:'+target.target_sha256,question:savedReviewRequestQuestion(target),answer_kind:'text'};
 const field={...common,...documentFieldQuestion(f.fieldRequest.target),id:f.fieldRequest.request_id};
 const responses:Record<string,unknown[]>={case_request_list:[numeric,field],case_request_revision_list:[],case_request_field_states:[{request_id:field.id,source_current:true}],
  case_request_field_reading_targets:[{request_id:field.id,target:f.fieldRequest.target}],case_request_review_states:[{request_id:requestId,source_current:true,target}]};
 artifactPort.list.mockResolvedValue([{report_id:reportId,analysis_run_id:f.review.analysis_run_id,current:true,created_at:'2026-09-11T00:00:00Z'}]);
 artifactPort.artifact.mockResolvedValue({current:true,bundle:{analysis_run_id:f.review.analysis_run_id,document_review:f.review}});
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string){if(!(fn in responses))throw Error('UNEXPECTED_RPC '+fn);return responses[fn] as T[];}};
 return {...f,numeric,field,responses,db,identityId,reportId,run:()=>listCaseRequests(f.review.case_id,db,identityId)};
}
it('links an exact current numeric target stored as text through two bounded protected lookups without exposing hashes',async()=>{
 const f=fixture(),rows=await f.run(),numeric=rows.find(r=>r.id===f.numeric.id)!;
 expect(numeric.covered_by_field_request_id).toBe(f.field.id);expect(numeric.answered_at).toBeNull();expect(numeric.question).toBe(f.numeric.question);
 expect(numeric).not.toHaveProperty('target');expect(numeric).not.toHaveProperty('candidate_id');
 expect(artifactPort.list).toHaveBeenCalledExactlyOnceWith(f.review.case_id,f.identityId,f.db);
 expect(artifactPort.artifact).toHaveBeenCalledExactlyOnceWith(f.review.case_id,f.identityId,f.reportId,f.db);
});
it.each(['no_field','field_stale','declaration_target'] as const)('does no artifact lookups when there is no potentially covered action: %s',async change=>{
 const f=fixture();
 if(change==='no_field'){f.responses.case_request_list=[f.numeric];}
 if(change==='field_stale')f.responses.case_request_field_states=[{request_id:f.field.id,source_current:false}];
 if(change==='declaration_target')f.responses.case_request_review_states=[{request_id:f.numeric.id,source_current:false,target:null}];
 expect((await f.run()).find(r=>r.id===f.numeric.id)).not.toHaveProperty('covered_by_field_request_id');
 expect(artifactPort.list).not.toHaveBeenCalled();expect(artifactPort.artifact).not.toHaveBeenCalled();
});
it.each(['subtotal','missing_review','stale_target','grand_total','value_mismatch'] as const)('uses only current exact subtotal targets to request protected semantic evidence: %s',state=>{
 const f=fixture(),candidate={...f.candidate,field:'total_deductions' as const,raw_value:'120.00',normalized_value:{currency:'ILS' as const,minor_units:12000},
  source:{...f.candidate.source,text_fragment:state==='grand_total'?'סך ניכויים: 120.00':state==='value_mismatch'?'ניכויי חובה - מסים: 121.00':'ניכויי חובה - מסים: 120.00'}};
 const result={...f.checkpoint.run.result,final_extraction:{...f.checkpoint.run.result.final_extraction,
  fields:f.checkpoint.run.result.final_extraction.fields.map(c=>c.candidate_id===candidate.candidate_id?candidate:c)}};
 const target=documentFieldTarget({checkpoint:{...f.checkpoint,result_sha256:canonicalSha256(result),run:{result}},policyVersion:'synthetic-field-coverage',candidateId:candidate.candidate_id});
 f.responses.case_request_list=[{...f.field,...documentFieldQuestion(target)}];f.responses.case_request_review_states=[];
 f.responses.case_request_field_reading_targets=[{request_id:f.field.id,target}];
 if(state==='stale_target')f.responses.case_request_field_states=[{request_id:f.field.id,source_current:false}];
 if(state==='missing_review')artifactPort.artifact.mockResolvedValue(null);
 return f.run().then(rows=>{
  const lookup=state==='subtotal'||state==='missing_review';expect(artifactPort.list).toHaveBeenCalledTimes(lookup?1:0);
  expect(artifactPort.artifact).toHaveBeenCalledTimes(lookup?1:0);
  // Label recognition is never enough to hide an action. This old review has
  // no current scope derivation; original answer/currentness remains visible.
  expect(rows[0]).not.toHaveProperty('not_required_for_current_review');expect(rows[0].answered_at).toBeNull();
  expect(rows[0]).not.toHaveProperty('target');expect(rows[0]).not.toHaveProperty('source_semantic_derivations');
 });
});
it.each(['confirmed','unknown','not_identified']as const)('checks current evidence even when every specific reading has an answer: %s',async state=>{
 const f=fixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),completion=parseReviewCompletionInput(f.input.completion_input),fact='source.check.quantity';
 const prior=runDocumentReview({...f.input,coverage_policy:'document-review-coverage-v1',answer_bindings:[{fact_key:fact,check_id:'source.check',operand_id:'quantity'}],
  completion_input:{...completion,needs:completion.needs.map(n=>({...n,fact_key:fact}))}},'prior-source-question');
 const target=prior.completions.customer_requests[0].target,row=JSON.parse(old.operands[0].source.locator);
 const locator={schema_version:'document-review-source-locator-v2',component_ids:row.component_ids,cell:'quantity',original_component_sha256:['a'.repeat(64)],raw_values:[f.candidate.raw_value],
  mapped_candidate:{candidate_id:f.candidate.candidate_id,candidate_sha256:canonicalSha256(f.candidate)}};
 const current=runDocumentReview({...prior.input,answer_bindings:[],completion_input:{...completion,needs:[]},checks:[{...f.input.checks[0],calculation:{...old,operands:[
  {...old.operands[0],state:'observed',source:{...old.operands[0].source,reading:state==='not_identified'?'provider_extraction':'identified_document_reading',locator:JSON.stringify(locator)}},old.operands[1]]}}]},f.review.analysis_run_id);
 const answer_text=JSON.stringify({schema_version:'document-field-answer-v2',action:state==='unknown'?'unknown':'confirm'});
 f.responses.case_request_list=[{...f.numeric,code:`document_review:${target.target_sha256}`,question:savedReviewRequestQuestion(target)},
  {...f.field,answered_at:'2026-09-11T00:00:00Z',answer_text}];
 f.responses.case_request_review_states=[{request_id:f.numeric.id,source_current:true,target}];
 artifactPort.artifact.mockResolvedValue({current:true,bundle:{analysis_run_id:current.analysis_run_id,document_review:current}});
 const rows=await f.run(),generic=rows.find(r=>r.id===f.numeric.id)!;
 expect(generic.covered_by_confirmed_reading).toBe(state==='confirmed'?true:undefined);
 expect(generic.covered_by_field_request_id).toBe(state==='confirmed'?f.field.id:undefined);
 expect(generic.answered_at).toBeNull();expect(generic.source_current).toBe(true);
 expect(rows.find(r=>r.id===f.field.id)?.answer_text).toBe(answer_text);
 expect(artifactPort.list).toHaveBeenCalledTimes(1);expect(artifactPort.artifact).toHaveBeenCalledTimes(1);
});
it.each(['missing','stale','run_mismatch','no_current_summary','lookup_failure'] as const)('keeps a question actionable or surfaces the failure when protected evidence is unavailable: %s',async change=>{
 const f=fixture();
 if(change==='missing')artifactPort.artifact.mockResolvedValue(null);
 if(change==='stale')artifactPort.artifact.mockResolvedValue({current:false,bundle:{analysis_run_id:f.review.analysis_run_id,document_review:f.review}});
 if(change==='run_mismatch')artifactPort.artifact.mockResolvedValue({current:true,bundle:{analysis_run_id:randomUUID(),document_review:f.review}});
 if(change==='no_current_summary')artifactPort.list.mockResolvedValue([]);
 if(change==='lookup_failure'){artifactPort.artifact.mockRejectedValue(Error('PRIVATE_REVIEW_STORE'));await expect(f.run()).rejects.toThrow('PRIVATE_REVIEW_STORE');return;}
 expect((await f.run()).find(r=>r.id===f.numeric.id)).not.toHaveProperty('covered_by_field_request_id');
 expect(artifactPort.list).toHaveBeenCalledTimes(1);expect(artifactPort.artifact).toHaveBeenCalledTimes(change==='no_current_summary'?0:1);
});

it.each(['current','stale','wrong_run','legacy','foreign_target','answered']as const)('projects resolved MW source work from the protected current report without requiring an open cell: %s',async state=>{
 const f=fixture(),e=minimumFixture();e.case_id=f.review.case_id;e.source_manifest=e.source_manifest.map(s=>({...s,case_id:e.case_id}));
 const source=e.components[0].amount.source,documents=e.source_manifest.map(s=>({case_id:e.case_id,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'payslip',label:'Synthetic MW source',period:e.period,reading_origin:'ai_document_review',reading_sha256:source.reading_receipt_sha256}));
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:e.case_id,period:e.period,coverage_policy:'document-review-coverage-v1',
  purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage'],origin:'saved_order'},documents,checks:[],coverage_gaps:[],
  completion_input:{case_id:e.case_id,period:e.period,documents:documents.map(d=>({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:'payslip',period:d.period,review:'complete'})),needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:e.case_id,order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),period:e.period,minimum_wage:e,...(state==='legacy'?{}:{resolved_need_policy:'minimum-wage-resolved-needs-v1'})}});
 const old=structuredClone(input),missing=structuredClone(e);missing.components[0].amount.state='unknown';missing.eligible_pay_inventory={...missing.eligible_pay_inventory,state:'unknown',value:'unknown'};old.entitlement_evidence!.minimum_wage=missing;
 const before=runDocumentReview(composeEntitlementReview(old),'old-mw-work'),current=runDocumentReview(composeEntitlementReview(input),f.review.analysis_run_id);
 expect(before.completions.customer_requests).toHaveLength(3);
 const targets=before.completions.customer_requests.map(r=>{const target=structuredClone(r.target);if(state==='foreign_target')target.source_pins[0].source_sha256='c'.repeat(64);
  const {target_sha256:prior,...body}=target;void prior;return {...target,target_sha256:canonicalSha256(body)};});
 const rows=targets.map(target=>({...f.numeric,id:randomUUID(),code:'document_review:'+target.target_sha256,question:savedReviewRequestQuestion(target),answered_at:state==='answered'?'2026-09-12T12:00:00.000Z':null,answer_text:state==='answered'?'לא יודע':null}));
 f.responses.case_request_list=rows;f.responses.case_request_review_states=rows.map((r,i)=>({request_id:r.id,source_current:true,target:targets[i]}));
 artifactPort.artifact.mockResolvedValue({current:state!=='stale',bundle:{analysis_run_id:state==='wrong_run'?randomUUID():current.analysis_run_id,document_review:current}});
 const projected=await f.run();
 expect(projected.filter(r=>r.not_required_for_current_review)).toHaveLength(state==='current'?3:0);
 expect(projected.map(r=>[r.answered_at,r.answer_text])).toEqual(rows.map(r=>[r.answered_at,r.answer_text]));
 expect(projected.every(r=>!r.covered_by_confirmed_reading&&!r.covered_by_field_request_id)).toBe(true);
 expect(artifactPort.list).toHaveBeenCalledTimes(1);expect(artifactPort.artifact).toHaveBeenCalledTimes(1);
});
