import {beforeEach,expect,it,vi} from 'vitest';
import {listCaseRequests} from './case-requests';
import {reviewRowCellCoverageFixture,reviewSourceScopeCoverageFixture,reviewSourceTranscriptionFixture,reviewUnusedFieldFixture} from './review-field-coverage.fixture';
import {documentRowCellTarget} from './document-row-cell-confirmation';
import type {CaseAccessDb} from '../case-access/db';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
vi.mock('server-only',()=>({}));
const artifacts=vi.hoisted(()=>({list:vi.fn(),read:vi.fn()}));
vi.mock('./private-document-review',()=>({privateDocumentReviewReports:artifacts.list,privateDocumentReviewArtifact:artifacts.read}));
beforeEach(()=>{vi.resetAllMocks();artifacts.list.mockResolvedValue([]);});
function setup(){
 const f=reviewRowCellCoverageFixture(),targets=['quantity','rate','amount'].map(cell=>documentRowCellTarget({checkpoint:f.checkpoint,
  policyVersion:'row-case-request-v1',componentId:f.component.component_id,cell:cell as 'quantity'|'rate'|'amount'}));
 const rows=targets.map((target,i)=>({id:`11111111-1111-4111-8111-11111111111${i}`,case_id:target.case_id,code:`document_field:${target.target_sha256}`,
  question:'stored question',answer_kind:'choice',options:null,field_crop:null,blocking:false,opened_at:'2025-01-01T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',answered_at:null,answer_text:null}));
 const responses:Record<string,unknown[]>={case_request_list:rows,case_request_revision_list:[],case_request_field_states:rows.map(r=>({request_id:r.id,source_current:true})),
  case_request_field_reading_targets:targets.map((target,i)=>({request_id:rows[i].id,target}))};
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string){if(!(fn in responses))throw Error('UNEXPECTED_RPC:'+fn);return responses[fn]as T[];}};
 return {f,targets,rows,responses,db};
}
it('shows safe row-cell subjects and one opaque exact-source grouping identity, without raw targets or confidence claims',async()=>{
 const s=setup(),result=await listCaseRequests(s.f.review.case_id,s.db,'22222222-2222-4222-8222-222222222222');
 expect(result.map(r=>r.reading_display?.row_context?.cell)).toEqual(['quantity','rate','amount']);
 expect(new Set(result.map(r=>r.reading_display?.row_context?.group_id)).size).toBe(1);
 expect(result[0].reading_display?.field).toBe('row_cell.quantity');expect(result[0].question).toContain(s.f.component.source_label);
 expect(JSON.stringify(result)).not.toContain('original_component');expect(JSON.stringify(result)).not.toContain('confidence');
 expect(JSON.stringify(result)).not.toContain(s.targets[0].source_sha256);
});
it('does not group an identical row label after component identity, source version or policy changes',async()=>{
 for(const changed of ['component','source','policy']as const){
  const s=setup(),old=s.targets[1],body={...old,original_component:{...old.original_component,component_id:changed==='component'?'33333333-3333-4333-8333-333333333333':old.original_component.component_id},
   source_sha256:changed==='source'?'f'.repeat(64):old.source_sha256,policy_version:changed==='policy'?'new-policy':old.policy_version};
  const {target_sha256:ignored,...unsigned}=body;void ignored;const target={...unsigned,target_sha256:canonicalSha256(unsigned)};
  s.responses.case_request_field_reading_targets[1]={request_id:s.rows[1].id,target};s.rows[1].code=`document_field:${target.target_sha256}`;
  const result=await listCaseRequests(s.f.review.case_id,s.db,'22222222-2222-4222-8222-222222222222');
  expect(result[0].reading_display!.row_context!.group_id).not.toBe(result[1].reading_display!.row_context!.group_id);
 }
});

it('presents an existing source-scope observation without making it a row or fabricating its value',async()=>{
 const s=setup(),f=reviewSourceScopeCoverageFixture(),target=f.fieldRequest.target;
 s.responses.case_request_list=[{...s.rows[0],case_id:target.case_id,code:`document_field:${target.target_sha256}`}];
 s.responses.case_request_field_states=[{request_id:s.rows[0].id,source_current:true}];
 s.responses.case_request_field_reading_targets=[{request_id:s.rows[0].id,target}];
 const result=await listCaseRequests(target.case_id,s.db,'22222222-2222-4222-8222-222222222222');
 expect(result[0].reading_display).toMatchObject({field:'source_scope.final_payable',raw_value:target.original_observation.candidate.raw_value,page:target.original_observation.candidate.source.page});
 expect(result[0].reading_display).not.toHaveProperty('row_context');expect(result[0].reading_display).not.toHaveProperty('confidence');
});
it.each(['reported_work_hours','balance_unit']as const)('derives the %s transcription control from the server target only',async kind=>{
 const s=setup(),f=reviewSourceTranscriptionFixture(kind),target=f.fieldRequest.target;
 s.responses.case_request_list=[{...s.rows[0],case_id:target.case_id,code:`document_field:${target.target_sha256}`}];
 s.responses.case_request_field_states=[{request_id:s.rows[0].id,source_current:true}];
 s.responses.case_request_field_reading_targets=[{request_id:s.rows[0].id,target}];
 const result=await listCaseRequests(target.case_id,s.db,'22222222-2222-4222-8222-222222222222');
 expect(result[0].reading_display).toMatchObject({field:'source_transcription.'+kind,transcription_context:{kind},raw_value:kind==='balance_unit'?'7.25':null,page:1});
 expect(result[0].reading_display).not.toHaveProperty('row_context');expect(JSON.stringify(result)).not.toContain('first_pass_extraction_sha256');
 expect(JSON.stringify(result)).not.toContain('confidence');expect(JSON.stringify(result)).not.toContain(target.source_sha256);
});
it.each(['current','missing','stale','different_run']as const)('projects a deferred action only from an authenticated current report: %s',async state=>{
 const s=setup(),f=reviewUnusedFieldFixture(),target=f.fieldRequest.target;
 s.responses.case_request_list=[{...s.rows[0],case_id:target.case_id,code:`document_field:${target.target_sha256}`}];
 s.responses.case_request_field_states=[{request_id:s.rows[0].id,source_current:true}];
 s.responses.case_request_field_reading_targets=[{request_id:s.rows[0].id,target}];
 artifacts.list.mockResolvedValue([{report_id:'44444444-4444-4444-8444-444444444444',analysis_run_id:f.review.analysis_run_id,current:true,created_at:'2026-09-11T00:00:00Z'}]);
 artifacts.read.mockResolvedValue(state==='missing'?null:{current:state!=='stale',bundle:{analysis_run_id:state==='different_run'?'other-run':f.review.analysis_run_id,document_review:f.review}});
 const [request]=await listCaseRequests(target.case_id,s.db,'22222222-2222-4222-8222-222222222222');
 expect(request.not_required_for_current_review).toBe(state==='current'?true:undefined);
 expect(request.answered_at).toBeNull();expect(request.source_current).toBe(true);
});
