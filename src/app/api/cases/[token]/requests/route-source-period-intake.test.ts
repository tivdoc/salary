import {beforeEach,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {CaseAccessDb} from '@/server/product/case-access/db';
const state=vi.hoisted(()=>({db:null as CaseAccessDb|null,identityId:'',caseId:'',session:true,download:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'synthetic-session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:state.identityId}:null,listIdentityCases:async()=>[{case_id:state.caseId,public_id:'TV-SYNTH001'}]}));
vi.mock('@/server/product/case-access/db',async original=>({...await original<typeof import('@/server/product/case-access/db')>(),resolveCaseAccessDb:async()=>state.db}));
vi.mock('@/server/product/reports/private-document-review',()=>({privateDocumentReviewReports:async()=>[]}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>({storage:{from:()=>({download:state.download})}})}));
import {GET,POST} from './route';
import {legacySourceIntakeFixture} from '@/server/product/processing/saved-legacy-source-intake.fixture';
import {documentSourcePeriodIntakeTarget} from '@/server/product/reports/document-source-period-intake';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

function fixture(){
 const f=legacySourceIntakeFixture(),bytes=Buffer.from('%PDF-1.7\nSynthetic original source; no customer data.');
 f.document.sha256=createHash('sha256').update(bytes).digest('hex');f.anchor.journal_sha256=canonicalSha256(f.anchor.input);
 const target=documentSourcePeriodIntakeTarget({scope:f.scope,source:{document:f.document,anchor:f.anchor}}),requestId=f.answerRow.id;
 const intakeContext={...f.input,journal:f.anchor.input,journalSha256:f.anchor.journal_sha256,currentDocuments:[f.document],sourceAnchors:[f.anchor]};
 const calls:{name:string;args:Readonly<Record<string,unknown>>}[]=[],row={id:requestId,case_id:f.caseId,code:`document_field:${target.target_sha256}`,question:'Synthetic period intake',answer_kind:'choice',options:[],field_crop:null,
  blocking:true,opened_at:'2026-09-01T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',answered_at:null,answer_text:null};
 const responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_field_reading_targets:[{request_id:requestId,target}],
  case_request_field_states:[{request_id:requestId,source_current:true}],case_request_answer_identified:[{...row,answered_at:'2026-09-12T12:00:00Z',answer_text:JSON.stringify(f.answer)}],case_request_edit:[{value:2}],
  case_request_source_intake_context:[{value:intakeContext}],
  case_request_document_source:[{value:{path:`cases/${f.caseId}/versions/${f.document.version_id}.pdf`,mime:'application/pdf',size:bytes.length,sha256:f.document.sha256,version:f.document.version_id,page:1}}]};
 state.caseId=f.caseId;state.identityId=f.answerRow.answer_identity_id;state.session=true;
 state.db={provider:'fake',async rpc<T>(name:string,args:Readonly<Record<string,unknown>>){calls.push({name,args});if(!(name in responses))throw Error('UNEXPECTED_RPC:'+name);return responses[name] as T[];}};
 state.download.mockResolvedValue({data:new Blob([bytes]),error:null});
 const run=(extra:Record<string,unknown>={},token='TV-SYNTH001')=>POST(new Request('https://test/api',{method:'POST',headers:{origin:'https://test','content-type':'application/json'},
  body:JSON.stringify({requestId,answer:JSON.stringify(f.answer),...extra})}),{params:Promise.resolve({token})});
 const source=(query='',token='TV-SYNTH001')=>GET(new Request(`https://test/api?source=${requestId}${query}`),{params:Promise.resolve({token})});
 return {...f,target,requestId,bytes,calls,responses,row,run,source,intakeContext};
}
beforeEach(()=>{vi.restoreAllMocks();state.download.mockReset();});
it.each(['answer','correction','draft'])('actual %s route uses the authenticated monthless target and current-state gate before the existing writer',async action=>{
 const f=fixture(),response=await f.run({action,expectedRevision:1,identityId:'foreign',caseId:'foreign',page_count:999,source_period:'guessed'});
 expect(response.status).toBe(200);expect(f.target.month).toBeNull();
 const lookup=f.calls.find(c=>c.name==='case_request_field_reading_targets'),current=f.calls.find(c=>c.name==='case_request_field_states');
 expect(lookup?.args).toEqual({target_case:f.caseId,target_identity:state.identityId});
 expect(f.calls.find(c=>c.name==='case_request_source_intake_context')?.args).toEqual({target_case:f.caseId,target_identity:state.identityId,target_request:f.requestId});
 const writer=f.calls.find(c=>c.name===(action==='answer'?'case_request_answer_identified':'case_request_edit'));
 expect(writer?.args).toMatchObject({target_case:f.caseId,target_identity:state.identityId,target_request:f.requestId,target_answer:JSON.stringify(f.answer)});
 expect(f.calls.indexOf(current!)).toBeLessThan(f.calls.indexOf(writer!));const body=await response.text();
 for(const secret of [f.target.source_sha256,f.target.source_input_sha256,'source_journal','page_count'])expect(body).not.toContain(secret);
});
it.each(['unknown','unreadable'])('retains %s as its own journal answer, without a period or confirmation',async action=>{
 const f=fixture(),answer=JSON.stringify({v:1,action});expect((await f.run({answer,action:'correction',expectedRevision:1})).status).toBe(200);
 expect(f.calls.find(c=>c.name==='case_request_edit')?.args.target_answer).toBe(answer);
});
it('accepts explicit absence of printed period independently of the unknown purchase month',async()=>{
 const f=fixture(),answer=JSON.stringify({...f.answer,value:{...f.answer.value,period:null}});expect((await f.run({answer})).status).toBe(200);
 expect(f.calls.find(c=>c.name==='case_request_answer_identified')?.args.target_answer).toBe(answer);
});
it.each(['page','reverse','invalid_date','confirm','legal_kind','forged_count'])('refuses %s without the writer',async kind=>{
 const f=fixture();let answer:unknown=f.answer;
 if(kind==='page')answer={...f.answer,value:{...f.answer.value,page:3}};
 if(kind==='reverse')answer={...f.answer,value:{...f.answer.value,period:{from:'2026-06-30',to:'2026-06-01'}}};
 if(kind==='invalid_date')answer={...f.answer,value:{...f.answer.value,period:{from:'2026-02-30',to:'2026-06-30'}}};
 if(kind==='confirm')answer={v:1,action:'confirm'};
 if(kind==='legal_kind')answer={...f.answer,value:{...f.answer.value,document_kind:'entitlement_approved'}};
 if(kind==='forged_count')answer={...f.answer,value:{...f.answer.value,page:3,page_count:999}};
 expect((await f.run({answer:JSON.stringify(answer)})).status).toBe(400);expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it('refuses stale source before writing, including negative answers',async()=>{
 const f=fixture();f.responses.case_request_field_states=[{request_id:f.requestId,source_current:false}];
 expect((await f.run({answer:JSON.stringify({v:1,action:'unknown'})})).status).toBe(409);expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it.each(['absent','opening_anchor','physical_page_count'])('refuses %s authoritative context even when the Boolean field state says current',async kind=>{
 const f=fixture();
 if(kind==='absent')f.responses.case_request_source_intake_context=[{value:null}];
 if(kind==='opening_anchor')f.intakeContext.sourceAnchors=[];
 if(kind==='physical_page_count')f.intakeContext.currentDocuments=[{...f.document,page_count:3}];
 expect((await f.run()).status).toBe(409);expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it.each(['journal_hash','case','ambiguous'])('fails closed on corrupt %s server context without exposing receipt data',async kind=>{
 const f=fixture();vi.spyOn(console,'error').mockImplementation(()=>{});
 if(kind==='journal_hash')f.intakeContext.journalSha256='f'.repeat(64);
 if(kind==='case')f.intakeContext.caseId=state.identityId;
 if(kind==='ambiguous')f.responses.case_request_source_intake_context.push({value:f.intakeContext});
 const response=await f.run(),body=await response.text();expect(response.status).toBe(503);expect(body).not.toContain(f.target.source_sha256);expect(body).not.toContain('SOURCE_INTAKE');
 expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it('refuses a borrowed target with matching-looking question text',async()=>{
 const f=fixture();f.row.code='document_field:'+'e'.repeat(64);expect((await f.run()).status).toBe(404);expect(f.calls.some(c=>c.name==='case_request_answer_identified')).toBe(false);
});
it.each(['','&view=marked'])('opens the exact original source without inventing an extraction crop (%s)',async query=>{
 const f=fixture(),response=await f.source(query);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
 expect(response.headers.get('X-Tivdoc-Source-View')).toBeNull();expect(f.calls.find(c=>c.name==='case_request_document_source')?.args).toEqual({target_case:f.caseId,target_identity:state.identityId,target_request:f.requestId});
});
it('does not expose a foreign or unknown source and never downloads it',async()=>{
 const f=fixture();expect((await f.source('','TV-FOREIGN1')).status).toBe(404);state.session=false;expect((await f.source()).status).toBe(404);expect(state.download).not.toHaveBeenCalled();expect(f.calls).toEqual([]);
});
it('refuses source-byte mismatch instead of opening altered bytes',async()=>{
 const f=fixture();state.download.mockResolvedValue({data:new Blob(['different bytes']),error:null});expect((await f.source()).status).toBe(503);
});
it('rejects a foreign answer case and missing session before the source lookup',async()=>{
 const f=fixture();expect((await f.run({},'TV-FOREIGN1')).status).toBe(404);state.session=false;expect((await f.run()).status).toBe(401);expect(f.calls).toEqual([]);
});
