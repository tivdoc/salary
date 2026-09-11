import {expect,it, vi } from 'vitest';
// Server adapter marker is mocked only in this hermetic test module.
vi.mock('server-only',()=>({}));
import {answerCaseRequest,listCaseRequests,editCaseRequest} from './case-requests';
import {HOURS_CONFLICT_ANSWER_VERSION,HOURS_CONFLICT_NAMESPACE} from './document-hours-conflict-answer';
import type {CaseAccessDb} from '../case-access/db';
const caseId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',identityId='33333333-3333-4333-8333-333333333333';
const answer=JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'declared',hours:'100',basis:'Synthetic attendance basis'});
function fixture(){
 const row={id:requestId,case_id:caseId,code:HOURS_CONFLICT_NAMESPACE+'a'.repeat(64),question:'Synthetic conflict',answer_kind:'text',options:null,field_crop:'regular_hours',blocking:false,
  opened_at:'2026-09-11T00:00:00Z',expires_at:'2026-09-12T00:00:00Z',answered_at:null,answer_text:null};
 const state={request_id:requestId,source_current:true,conflict_reason:'conflicting_observations',source_observations:[
  {candidate_id:'44444444-4444-4444-8444-444444444444',raw_value:'100',page:1,source_label:'Synthetic source hours'}]};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_hours_conflict_states:[state],case_request_answer_identified:[row],case_request_edit:[{value:2}]};
 const calls:{fn:string;args:Readonly<Record<string,unknown>>}[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});if(!(fn in responses))throw Error('UNEXPECTED_RPC');return responses[fn] as T[];}};
 return {row,state,responses,calls,db};
}
it('requests authenticated currentness and bounded source observations for conflict cards',async()=>{
 const f=fixture(),rows=await listCaseRequests(caseId,f.db,identityId);
 expect(rows[0]).toMatchObject({source_current:true,hours_conflict_source:{conflict_reason:f.state.conflict_reason,source_observations:f.state.source_observations}});
 expect(f.calls.at(-1)).toEqual({fn:'case_request_hours_conflict_states',args:{target_case:caseId,target_identity:identityId}});
});
it('rejects incomplete, foreign, duplicate, invalid page and oversized source state',async()=>{
 const f=fixture();for(const states of [[],[{...f.state,request_id:identityId}],[f.state,f.state],[{...f.state,source_current:'false'}],
  [{...f.state,source_observations:[{...f.state.source_observations[0],page:0}]}],[{...f.state,source_observations:Array(13).fill(f.state.source_observations[0])}]]){
  f.responses.case_request_hours_conflict_states=states;await expect(listCaseRequests(caseId,f.db,identityId)).rejects.toThrow();
 }
});
it('only submits through identified answer RPC and validates structured corrections',async()=>{
 const f=fixture();await expect(answerCaseRequest({caseId,requestId,answer},f.db)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
 await answerCaseRequest({caseId,requestId,identityId,answer},f.db);
 expect(f.calls.at(-1)).toEqual({fn:'case_request_answer_identified',args:{target_request:requestId,target_case:caseId,target_identity:identityId,target_answer:answer}});
 const count=f.calls.filter(c=>c.fn==='case_request_edit').length;
 await expect(editCaseRequest({caseId,requestId,identityId,answer:'100',expectedRevision:1,kind:'correction'},f.db)).rejects.toThrow('REQUEST_ANSWER_INVALID');
 expect(f.calls.filter(c=>c.fn==='case_request_edit')).toHaveLength(count);
 expect(await editCaseRequest({caseId,requestId,identityId,answer,expectedRevision:1,kind:'correction'},f.db)).toBe(2);
});
it('retains an unavailable historical target as stale and refuses missing metadata for a current source',async()=>{
 const f=fixture();f.responses.case_request_hours_conflict_states=[{...f.state,source_current:false,conflict_reason:null,source_observations:[]}];
 expect((await listCaseRequests(caseId,f.db,identityId))[0]).toMatchObject({source_current:false});
 f.responses.case_request_hours_conflict_states=[{...f.state,conflict_reason:null,source_observations:[]}];
 await expect(listCaseRequests(caseId,f.db,identityId)).rejects.toThrow();
});
it('sends canonical correction bytes so identified journal replay matches the exact signed declaration',async()=>{
 const f=fixture(),wire=JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'declared',hours:'100',basis:'  Synthetic attendance basis  '});
 await editCaseRequest({caseId,requestId,identityId,answer:wire,expectedRevision:1,kind:'correction'},f.db);
 expect(f.calls.at(-1)?.args.target_answer).toBe(answer);
 // A draft retains incomplete user input and cannot become a final answer.
 const draft=JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'declared',hours:'',basis:'  draft  '});
 await editCaseRequest({caseId,requestId,identityId,answer:draft,expectedRevision:1,kind:'draft'},f.db);
 expect(f.calls.at(-1)?.args.target_answer).toBe(draft);
});
