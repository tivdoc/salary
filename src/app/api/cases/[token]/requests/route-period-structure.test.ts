import {beforeEach,it,expect,vi} from 'vitest';
import type {CaseAccessDb} from '@/server/product/case-access/db';
const state=vi.hoisted(()=>({db:null as CaseAccessDb|null,identityId:'',caseId:'',session:true}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'synthetic-session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:state.identityId}:null,listIdentityCases:async()=>[{case_id:state.caseId,public_id:'TV-SYNTH001'}]}));
vi.mock('@/server/product/case-access/db',async original=>({...await original<typeof import('@/server/product/case-access/db')>(),resolveCaseAccessDb:async()=>state.db}));
vi.mock('@/server/product/reports/private-document-review',()=>({privateDocumentReviewReports:async()=>[]}));
import {POST} from './route';
import {requestSourcePeriodFixture} from '@/server/product/reports/request-source-period-context.fixture';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

function fixture(){
 const f=requestSourcePeriodFixture(),calls:{name:string;args:Readonly<Record<string,unknown>>}[]=[];
 const row={id:f.requestId,case_id:f.caseId,code:`document_field:${f.target.target_sha256}`,question:'Synthetic source relationship',answer_kind:'choice',options:[],field_crop:null,
  blocking:false,opened_at:'2025-02-02T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',answered_at:null,answer_text:null};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_field_reading_targets:[{request_id:f.requestId,target:f.target}],
  case_request_field_states:[{request_id:f.requestId,source_current:true}],case_request_source_period_context:[{value:f.context}],case_request_answer_identified:[{...row,answered_at:'2026-09-12T12:00:00Z',answer_text:f.answer}],case_request_edit:[{value:2}]};
 state.caseId=f.caseId;state.identityId=f.identityId;state.session=true;
 state.db={provider:'fake',async rpc<T>(name:string,args:Readonly<Record<string,unknown>>){calls.push({name,args});if(!(name in responses))throw Error('UNEXPECTED_RPC:'+name);return responses[name] as T[];}};
 const request=(extra:Record<string,unknown>={})=>new Request('https://test/api',{method:'POST',headers:{origin:'https://test','content-type':'application/json'},
  body:JSON.stringify({requestId:f.requestId,answer:f.answer,...extra})});
 const run=(extra:Record<string,unknown>={},token='TV-SYNTH001')=>POST(request(extra),{params:Promise.resolve({token})});
 return {...f,calls,responses,row,run};
}
beforeEach(()=>vi.restoreAllMocks());
it.each(['answer','correction','draft'])('actual %s route authenticates and replays current period prerequisites before its existing writer',async action=>{
 const f=fixture(),response=await f.run({action,expectedRevision:1,caseId:'foreign',identityId:'foreign',source_journal:{answers:[]},periodReadings:{forged:true}});
 expect(response.status).toBe(200);expect(f.context.source_input_sha256).not.toBe(f.context.source_journal_sha256);
 const lookup=f.calls.find(c=>c.name==='case_request_source_period_context');expect(lookup?.args).toEqual({target_case:f.caseId,target_identity:f.identityId,target_request:f.requestId});
 const writer=f.calls.find(c=>c.name===(action==='answer'?'case_request_answer_identified':'case_request_edit'));
 expect(writer?.args).toMatchObject({target_case:f.caseId,target_identity:f.identityId,target_request:f.requestId,target_answer:f.answer});
 expect(f.calls.indexOf(lookup!)).toBeLessThan(f.calls.indexOf(writer!));
 const output=await response.text();for(const secret of ['source_journal','period_witness',f.context.source_input_sha256,f.context.checkpoint.input_sha256])expect(output).not.toContain(secret);
});
it.each(['absent','unknown','unreadable','changed_revision'])('actual route rejects %s prerequisite with 409 before writing',async kind=>{
 const f=fixture();
 if(kind==='absent')f.responses.case_request_source_period_context=[{value:null}];
 else{f.periodEntry.answer_revision=2;if(kind!=='changed_revision')f.periodEntry.answer=JSON.stringify({schema_version:'document-field-answer-v3',action:kind});f.context.source_journal_sha256=canonicalSha256(f.context.source_journal);}
 const response=await f.run();expect(response.status).toBe(409);expect((await response.json()).code).toBe('request_edit_conflict');
 expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it.each(['journal_hash','input_hash_format','foreign_case','foreign_request','checkpoint','ambiguous','revision'])('corrupt authenticated %s context fails without accepting an answer or leaking internals',async kind=>{
 const f=fixture();vi.spyOn(console,'error').mockImplementation(()=>{});
 if(kind==='journal_hash')f.context.source_journal_sha256='f'.repeat(64);
 if(kind==='input_hash_format')f.context.source_input_sha256='invalid';
 if(kind==='foreign_case')f.context.case_id=f.identityId;
 if(kind==='foreign_request')f.context.request_id=f.identityId;
 if(kind==='checkpoint')f.context.checkpoint.result_sha256='f'.repeat(64);
 if(kind==='revision')f.context.source_revision=1.5;
 if(kind==='ambiguous')f.responses.case_request_source_period_context.push({value:f.context});
 const response=await f.run(),body=await response.text();expect(response.status).toBe(503);expect(body).not.toContain('CONTEXT');expect(body).not.toContain(f.identityId);
 expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it('preserves the legacy v1 answer path without requesting the new context',async()=>{
 const f=fixture(),answer=JSON.stringify(f.periodAnswer);f.row.code='document_field:'+f.periodTarget.target_sha256;
 f.responses.case_request_field_reading_targets=[{request_id:f.requestId,target:f.periodTarget}];
 expect((await f.run({answer})).status).toBe(200);expect(f.calls.some(c=>c.name==='case_request_source_period_context')).toBe(false);
});
it('rejects a foreign session case before any source journal lookup',async()=>{
 const f=fixture();expect((await f.run({},'TV-FOREIGN1')).status).toBe(404);state.session=false;expect((await f.run()).status).toBe(401);expect(f.calls).toEqual([]);
});
