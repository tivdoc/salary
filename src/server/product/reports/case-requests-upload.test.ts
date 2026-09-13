import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {generateReviewCompletions} from '@/engine/document-review/completions';
import {listCaseRequests,caseSlaPaused,documentRequestSatisfied,expiredRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
const caseId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',identityId='33333333-3333-4333-8333-333333333333';
function fixture(){
 const target=generateReviewCompletions({case_id:caseId,period:{from:'2026-06-01',to:'2026-06-30'},documents:[],evidence:[],needs:[{
  fact_key:'payslip.full',kind:'document',reason:'missing',required_evidence_kind:'document',question:'נא לצרף תלוש מלא לחודש יוני.',
  answer_kind:'document',document_kind:'payslip',source_pins:[],dependent_check_ids:['payroll.check'],general_question:false}]}).customer_requests[0].target;
 const row={id:requestId,case_id:caseId,code:'document_review:'+target.target_sha256,question:target.question,answer_kind:'document',options:null,field_crop:null,blocking:true,
  opened_at:'2026-09-11T00:00:00Z',expires_at:'2099-09-21T00:00:00Z',answered_at:null,answer_text:null};
 const source={request_id:requestId,source_current:true,target};
 const state={request_id:requestId,state:'received_pending_review',source_current:true,information_satisfied:false,analysis_run_id:null as string|null,reason:null as string|null};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_review_states:[source],case_request_review_upload_states:[state]};
 const calls:{fn:string;args:Readonly<Record<string,unknown>>}[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});if(!(fn in responses))throw Error('UNEXPECTED_RPC');return responses[fn] as T[];}};
 return {row,source,state,responses,calls,db};
}
it('loads received-pending status via identified RPC without writing an answer, changing source state or exposing source payloads',async()=>{
 const f=fixture(),result=(await listCaseRequests(caseId,f.db,identityId))[0];
 expect(result).toMatchObject({answered_at:null,answer_text:null,source_current:true,document_upload_state:{state:'received_pending_review',information_satisfied:false,analysis_run_id:null,reason:null}});
 expect(result).not.toHaveProperty('target');expect(result.document_upload_state).not.toHaveProperty('receipt_sha256');
 expect(f.calls.at(-1)).toEqual({fn:'case_request_review_upload_states',args:{target_case:caseId,target_identity:identityId}});
 expect(documentRequestSatisfied(result)).toBe(false);expect(caseSlaPaused([result])).toBe(true);
 expect(f.row.answered_at).toBeNull();
});
it('derives satisfaction separately from customer answers and removes only that request from SLA and expiry counts',async()=>{
 const f=fixture();Object.assign(f.state,{state:'satisfied',information_satisfied:true,analysis_run_id:'saved-analysis',reason:'target_specific_observed_source'});
 const result=(await listCaseRequests(caseId,f.db,identityId))[0];
 expect(result.answered_at).toBeNull();expect(result.answer_text).toBeNull();expect(result.source_current).toBe(true);
 expect(documentRequestSatisfied(result)).toBe(true);expect(caseSlaPaused([result])).toBe(false);expect(expiredRequests([result],new Date('2100-01-01'))).toEqual([]);
 expect(caseSlaPaused([{...result,id:identityId,document_upload_state:undefined}])).toBe(true);
});
it('keeps insufficient and stale information explicit without altering existing source-current history',async()=>{
 const f=fixture();Object.assign(f.state,{state:'insufficient',reason:'duplicate_content',analysis_run_id:'saved-analysis'});
 expect((await listCaseRequests(caseId,f.db,identityId))[0]).toMatchObject({answered_at:null,source_current:true,document_upload_state:{state:'insufficient',information_satisfied:false,reason:'duplicate_content'}});
 f.source.source_current=false;f.state.source_current=false;Object.assign(f.state,{state:'stale',reason:'submitted_source_replaced'});
 const result=(await listCaseRequests(caseId,f.db,identityId))[0];expect(result.source_current).toBe(false);expect(result.document_upload_state?.state).toBe('stale');
});
it.each(['foreign','missing','duplicate','contradiction','source_race','extra','unverified_positive','missing_run'] as const)('refuses %s upload state rather than silently hiding a document request',async mode=>{
 const f=fixture();
 if(mode==='foreign')f.state.request_id=identityId;
 if(mode==='missing')f.responses.case_request_review_upload_states=[];
 if(mode==='duplicate')f.responses.case_request_review_upload_states=[f.state,f.state];
 if(mode==='contradiction')f.state.information_satisfied=true;
 if(mode==='source_race')f.state.source_current=false;
 if(mode==='extra')f.responses.case_request_review_upload_states=[{...f.state,secret_source:'must not pass'}];
 if(mode==='unverified_positive')Object.assign(f.state,{state:'satisfied',information_satisfied:true,source_current:false,analysis_run_id:'run',reason:'target_specific_observed_source'});
 if(mode==='missing_run')Object.assign(f.state,{state:'satisfied',information_satisfied:true,reason:'target_specific_observed_source'});
 await expect(listCaseRequests(caseId,f.db,identityId)).rejects.toThrow();
});
it('does not request identified upload metadata without an identity',async()=>{
 const f=fixture();const result=(await listCaseRequests(caseId,f.db))[0];expect(result.document_upload_state).toBeUndefined();
 expect(f.calls.map(c=>c.fn)).toEqual(['case_request_list','case_request_revision_list']);
});
