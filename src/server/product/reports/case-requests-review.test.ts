import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {generateReviewCompletions,type ReviewCompletionNeed} from '@/engine/document-review/completions';
import {savedReviewRequestQuestion} from '../processing/saved-review-requests';
import {answerCaseRequest,editCaseRequest,listCaseRequests} from './case-requests';
import {RequestAnswerError} from './request-answer';
import type {CaseAccessDb} from '../case-access/db';

const caseId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',identityId='33333333-3333-4333-8333-333333333333';
function fixture(change:Partial<ReviewCompletionNeed>={}){
 const target=generateReviewCompletions({case_id:caseId,period:{from:'2026-06-01',to:'2026-06-30'},documents:[],evidence:[],needs:[{
  fact_key:'hours.quantity',kind:'factual',reason:'unknown',required_evidence_kind:'customer_declaration',question:'כמה שעות עבודה היו בתקופה המסומנת?',
  answer_kind:'number',source_pins:[],dependent_check_ids:['hours.check'],general_question:false,...change}]}).customer_requests[0].target;
 const row={id:requestId,case_id:caseId,code:'document_review:'+target.target_sha256,question:savedReviewRequestQuestion(target),answer_kind:'text',options:null,field_crop:null,blocking:false,
  opened_at:'2026-09-11T00:00:00Z',expires_at:'2026-09-21T00:00:00Z',answered_at:null,answer_text:null};
 const state={request_id:requestId,source_current:true,target};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_review_states:[state],case_request_answer_identified:[row],case_request_edit:[{value:2}]};
 const calls:{fn:string;args:Readonly<Record<string,unknown>>}[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});if(!(fn in responses))throw Error('UNEXPECTED_RPC');return responses[fn] as T[];}};
 return {target,row,state,responses,calls,db};
}

it('loads current source state and history without exposing the server target or hashes',async()=>{
 const f=fixture();f.state.source_current=false;f.responses.case_request_revision_list=[{request_id:requestId,answer_revision:2,latest_answer:'100',draft_revision:1,draft_text:'101'}];
 const result=(await listCaseRequests(caseId,f.db,identityId))[0];
 expect(result).toMatchObject({source_current:false,answer_revision:2,answer_text:'100',draft_revision:1,draft_text:'101'});
 expect(result).not.toHaveProperty('target');expect(result).not.toHaveProperty('source_pins');
 expect(f.calls.at(-1)).toEqual({fn:'case_request_review_states',args:{target_case:caseId,target_identity:identityId}});
});
it('requires identity and uses the existing identified RPC for plain numeric, unknown and conflict declarations',async()=>{
 const f=fixture();await expect(answerCaseRequest({caseId,requestId,answer:'100'},f.db)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
 for(const answer of [' 100.25 ','לא יודע','יש סתירה']){
  await answerCaseRequest({caseId,requestId,identityId,answer},f.db);
  expect(f.calls.at(-1)).toEqual({fn:'case_request_answer_identified',args:{target_case:caseId,target_request:requestId,target_identity:identityId,target_answer:answer.trim()}});
 }
 expect(f.calls.some(c=>c.fn==='case_request_answer')).toBe(false);
});
it('validates true boolean/choice targets through the existing generic text UI',async()=>{
 const boolean=fixture({answer_kind:'boolean'});await answerCaseRequest({caseId,requestId,identityId,answer:'כן'},boolean.db);
 await expect(answerCaseRequest({caseId,requestId,identityId,answer:'true'},boolean.db)).rejects.toBeInstanceOf(RequestAnswerError);
 const choice=fixture({answer_kind:'choice',options:['אפשר לצאת','צריך להישאר']});await answerCaseRequest({caseId,requestId,identityId,answer:'צריך להישאר'},choice.db);
 await expect(answerCaseRequest({caseId,requestId,identityId,answer:'אחר'},choice.db)).rejects.toBeInstanceOf(RequestAnswerError);
});
it.each(['answer','correction','draft'] as const)('refuses stale sources and malformed text before the %s write',async kind=>{
 const f=fixture();
 const submit=(answer:string)=>kind==='answer'?answerCaseRequest({caseId,requestId,identityId,answer},f.db):editCaseRequest({caseId,requestId,identityId,answer,expectedRevision:1,kind},f.db);
 f.state.source_current=false;await expect(submit('100')).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
 f.state.source_current=true;await expect(submit('1e2')).rejects.toBeInstanceOf(RequestAnswerError);
 expect(f.calls.some(c=>['case_request_answer_identified','case_request_edit'].includes(c.fn))).toBe(false);
});
it('keeps draft text separate and sends an exact correction revision with the authenticated identity',async()=>{
 const f=fixture();expect(await editCaseRequest({caseId,requestId,identityId,answer:' 100 ',expectedRevision:1,kind:'draft'},f.db)).toBe(2);
 expect(f.calls.at(-1)?.args.target_answer).toBe(' 100 ');
 expect(await editCaseRequest({caseId,requestId,identityId,answer:' 101 ',expectedRevision:1,kind:'correction'},f.db)).toBe(2);
 expect(f.calls.at(-1)).toEqual({fn:'case_request_edit',args:{target_case:caseId,target_request:requestId,target_identity:identityId,target_answer:'101',expected_revision:1,edit_kind:'correction'}});
});
it('does not trust a foreign, duplicate, missing or tampered source target',async()=>{
 for(const variant of ['foreign','duplicate','missing','tampered','question'] as const){
  const f=fixture();
  if(variant==='foreign')f.responses.case_request_review_states=[{...f.state,request_id:identityId}];
  if(variant==='duplicate')f.responses.case_request_review_states=[f.state,f.state];
  if(variant==='missing')f.responses.case_request_review_states=[];
  if(variant==='tampered')f.responses.case_request_review_states=[{...f.state,target:{...f.target,question:'שאלה שהוחלפה'}}];
  if(variant==='question')f.row.question='שאלה שהוחלפה';
  await expect(answerCaseRequest({caseId,requestId,identityId,answer:'100'},f.db)).rejects.toThrow();
  expect(f.calls.some(c=>c.fn==='case_request_answer_identified')).toBe(false);
 }
});
it('keeps an unavailable historical target visible as stale without creating a current target',async()=>{
 const f=fixture();f.responses.case_request_review_states=[{request_id:requestId,source_current:false,target:null}];
 expect((await listCaseRequests(caseId,f.db,identityId))[0]).toMatchObject({source_current:false});
 await expect(answerCaseRequest({caseId,requestId,identityId,answer:'100'},f.db)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
it('never accepts a document target through text and never opens a request in the API adapter',async()=>{
 const f=fixture({kind:'document',answer_kind:'document',document_kind:'attendance',required_evidence_kind:'document'});
 f.row.answer_kind='document';await expect(answerCaseRequest({caseId,requestId,identityId,answer:'המסמך צורף לתיק'},f.db)).rejects.toThrow();
 expect(f.calls.some(c=>c.fn.includes('open')||c.fn.includes('answer_identified'))).toBe(false);
});
