import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {reviewFieldCoverageFixture} from './review-field-coverage.fixture';
import {savedReviewRequestQuestion} from '../processing/saved-review-requests';
import {documentFieldQuestion} from './document-field-confirmation';
import {listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {runDocumentReview} from '@/engine/document-review/service';
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
