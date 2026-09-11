import {describe,it,expect, vi } from 'vitest';
// Server adapter marker is mocked only in this hermetic test module.
vi.mock('server-only',()=>({}));
import {answerCaseRequest,editCaseRequest,listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentFieldTarget} from './document-field-confirmation';

const caseId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',identityId='33333333-3333-4333-8333-333333333333';
function setup(){
 const row={id:requestId,case_id:caseId,code:'regular_day_hours_unknown',question:'How many hours?',answer_kind:'number',options:null,field_crop:null,blocking:true,opened_at:'2020-01-01T00:00:00Z',expires_at:'2020-01-11T00:00:00Z',answered_at:'2020-01-02T00:00:00Z',answer_text:'8'};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_answer:[row],case_request_edit:[{value:2}]};
 const calls:{fn:string;args:Readonly<Record<string,unknown>>}[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){calls.push({fn,args});if(!(fn in responses))throw new Error('UNEXPECTED_RPC');return responses[fn] as T[];}};
 return {db,row,responses,calls};
}
function bindSourceReading(s:ReturnType<typeof setup>){
 const fixture=buildSyntheticCaseFixture({fixture_id:'request-retry-source-cell',mode:'real'}),document=fixture.stored.documents[0],extraction=fixture.stored.extractions[0];
 const candidate=extraction.fields.find(f=>f.field==='regular_hours');if(!candidate)throw Error('HOURS_FIXTURE_REQUIRED');
 const result={final_extraction:extraction};
 const target=documentFieldTarget({checkpoint:{schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:identityId,version_id:document.document_id,
  input_sha256:document.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}},policyVersion:'retry-test-v1',candidateId:candidate.candidate_id});
 s.row.code='document_field:'+target.target_sha256;
 s.responses.case_request_field_reading_targets=[{request_id:requestId,target}];return target;
}
describe('request retry service receipts',()=>{
 it('reads exact identified current-source state while retaining historical answers',async()=>{
  const s=setup(),target=bindSourceReading(s);
  s.responses.case_request_field_states=[{request_id:requestId,source_current:false}];
  expect((await listCaseRequests(caseId,s.db,identityId))[0]).toMatchObject({source_current:false,answer_text:'8',reading_display:{field:'regular_hours',raw_value:target.candidate.raw_value,page:target.candidate.source.page}});
  expect(s.calls.slice(-2)).toEqual(['case_request_field_states','case_request_field_reading_targets'].map(fn=>({fn,args:{target_case:caseId,target_identity:identityId}})));
 });
 it('refuses incomplete, foreign, duplicate or malformed source state instead of treating it as current',async()=>{
  const s=setup();bindSourceReading(s);
  for(const rows of [[],[{request_id:identityId,source_current:true}],[{request_id:requestId,source_current:'false'}],[{request_id:requestId,source_current:true},{request_id:requestId,source_current:false}]]){
   s.responses.case_request_field_states=rows;await expect(listCaseRequests(caseId,s.db,identityId)).rejects.toThrow('REQUEST_FIELD_STATE_UNAVAILABLE');
  }
 });
 it('requires and forwards the authenticated actor for a bound document confirmation',async()=>{
  const s=setup();bindSourceReading(s);
  const answer='כן, בדקתי במסמך והערך נכון';
  const row={...s.row,answer_kind:'choice',options:[answer],answer_text:answer};
  s.responses.case_request_list=[row];s.responses.case_request_answer_identified=[row];
  await expect(answerCaseRequest({caseId,requestId,answer},s.db)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await answerCaseRequest({caseId,requestId,answer,identityId},s.db);
  expect(s.calls.at(-1)).toEqual({fn:'case_request_answer_identified',args:{target_request:requestId,target_case:caseId,target_answer:answer,target_identity:identityId}});
 });
 it('answers saved DEV financial hours through the identified RPC',async()=>{
  const s=setup();s.row.code='dev_financial_hours:'+ 'b'.repeat(64);s.row.answer_text='100';
  s.responses.case_request_answer_identified=[s.row];
  expect((await answerCaseRequest({caseId,requestId,answer:' 100 ',identityId},s.db))?.answer_text).toBe('100');
  expect(s.calls.at(-1)).toEqual({fn:'case_request_answer_identified',args:{target_request:requestId,target_case:caseId,target_answer:'100',target_identity:identityId}});
  expect(s.calls.some(c=>c.fn==='case_request_answer')).toBe(false);
 });
 it('refuses DEV financial hours without an identity before either answer RPC',async()=>{
  const s=setup();s.row.code='dev_financial_hours:'+ 'b'.repeat(64);
  await expect(answerCaseRequest({caseId,requestId,answer:'100'},s.db)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  expect(s.calls.map(c=>c.fn)).toEqual(['case_request_list','case_request_revision_list']);
 });
 it('does not query document-field source states for DEV financial hours',async()=>{
  const s=setup();s.row.code='dev_financial_hours:'+ 'b'.repeat(64);
  expect((await listCaseRequests(caseId,s.db,identityId))[0].code).toBe(s.row.code);
  expect(s.calls.map(c=>c.fn)).toEqual(['case_request_list','case_request_revision_list']);
 });
 it.each(['regular_day_hours_unknown','dev_financial_hours_other'])('retains the ordinary answer RPC for %s even with an identity',async code=>{
  const s=setup();s.row.code=code;
  await answerCaseRequest({caseId,requestId,answer:'8',identityId},s.db);
  expect(s.calls.at(-1)).toEqual({fn:'case_request_answer',args:{target_request:requestId,target_case:caseId,target_answer:'8'}});
 });
 it('lets authoritative SQL acknowledge an original answer after response loss, including after expiry',async()=>{
  const s=setup();expect((await answerCaseRequest({caseId,requestId,answer:' 8 '},s.db))?.answer_text).toBe('8');
  expect(s.calls.at(-1)).toEqual({fn:'case_request_answer',args:{target_request:requestId,target_case:caseId,target_answer:'8'}});
 });
 it('never forwards a foreign request or invalid numeric answer',async()=>{
  const s=setup();expect(await answerCaseRequest({caseId,requestId:identityId,answer:'8'},s.db)).toBeNull();
  await expect(answerCaseRequest({caseId,requestId,answer:'25'},s.db)).rejects.toThrow('REQUEST_ANSWER_INVALID');
  expect(s.calls.some(c=>c.fn==='case_request_answer')).toBe(false);
 });
 it('only acknowledges the expected durable correction revision',async()=>{
  const s=setup(),input={caseId,requestId,identityId,answer:'9',expectedRevision:1,kind:'correction' as const};
  expect(await editCaseRequest(input,s.db)).toBe(2);
  for(const response of [[],[{value:0}],[{value:3}],[{value:2},{value:2}]]){
   s.responses.case_request_edit=response;await expect(editCaseRequest(input,s.db)).rejects.toThrow('REQUEST_EDIT_RECEIPT_MISSING');
  }
 });
 it('applies receipt validation to drafts without promoting unfinished text to an answer',async()=>{
  const s=setup();s.responses.case_request_edit=[];
  await expect(editCaseRequest({caseId,requestId,identityId,answer:'unfinished',expectedRevision:1,kind:'draft'},s.db)).rejects.toThrow('REQUEST_EDIT_RECEIPT_MISSING');
  expect(s.calls.map(c=>c.fn)).toEqual(['case_request_list','case_request_revision_list','case_request_edit']);
 });
});
