import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {reviewFieldCoverageFixture,reviewMultipleFieldCoverageFixture} from './review-field-coverage.fixture';
import {savedReviewRequestQuestion} from '../processing/saved-review-requests';
import {documentFieldQuestion} from './document-field-confirmation';
import {listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
const ports=vi.hoisted(()=>({list:vi.fn(),artifact:vi.fn(),real:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./private-document-review',()=>({privateDocumentReviewReports:ports.list,privateDocumentReviewArtifact:ports.artifact}));
vi.mock('./real-ai-service-customer',()=>({realAiServiceCustomerRequestReview:ports.real}));
beforeEach(()=>{vi.resetAllMocks();ports.list.mockResolvedValue([]);});
function fixture(plural=false,disagree=false){
 const f=plural?reviewMultipleFieldCoverageFixture(disagree?99999:undefined):reviewFieldCoverageFixture();
 const fields='fields'in f?f.fields:[f.fieldRequest],identityId=randomUUID(),sessionToken='synthetic-private-cookie',target=f.review.completions.customer_requests[0].target;
 const common={case_id:f.review.case_id,options:null,field_crop:null,blocking:false,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-10-01T00:00:00Z',answered_at:null,answer_text:null};
 const generic={...common,id:randomUUID(),code:'document_review:'+target.target_sha256,question:savedReviewRequestQuestion(target),answer_kind:'text'};
 const fieldRows=fields.map(field=>({...common,...documentFieldQuestion(field.target),id:field.request_id}));
 const responses:Record<string,unknown[]>={case_request_list:[generic,...fieldRows],case_request_revision_list:[],
  case_request_field_states:fieldRows.map(row=>({request_id:row.id,source_current:true})),
  case_request_field_reading_targets:fields.map(field=>({request_id:field.request_id,target:field.target})),
  case_request_review_states:[{request_id:generic.id,source_current:true,target}]};
 const db:CaseAccessDb={provider:'fake',async rpc<T>(name:string){if(!(name in responses))throw Error('UNEXPECTED_RPC '+name);return responses[name] as T[];}};
 ports.real.mockResolvedValue(f.review);
 return {...f,fields,fieldRows,generic,responses,identityId,sessionToken,db,run:()=>listCaseRequests(f.review.case_id,db,identityId,sessionToken)};
}
it.each([false,true])('projects exact authenticated REAL coverage, retaining every answer and only exposing action links: plural=%s',async plural=>{
 const f=fixture(plural),rows=await f.run(),generic=rows.find(row=>row.id===f.generic.id)!;
 expect(plural?generic.covered_by_field_request_ids:[generic.covered_by_field_request_id]).toEqual(f.fields.map(field=>field.request_id));
 expect(generic.answered_at).toBeNull();expect(generic).not.toHaveProperty('covered_by_confirmed_reading');
 expect(ports.real).toHaveBeenCalledExactlyOnceWith({caseId:f.review.case_id,identityId:f.identityId,sessionToken:f.sessionToken});
 for(const key of ['target','document_review','configuration','service_decision','ai_release'])expect(generic).not.toHaveProperty(key);
 expect(JSON.stringify(rows)).not.toContain(f.sessionToken);expect(rows.every(row=>row.answered_at===null)).toBe(true);
});
it.each(['absent','foreign','expired','revoked','unpublished','failed'] as const)('preserves existing questions when REAL evidence is %s',async reason=>{
 const f=fixture(true);if(reason==='absent')ports.real.mockResolvedValue(null);else ports.real.mockRejectedValue(Error(reason));
 const generic=(await f.run()).find(row=>row.id===f.generic.id)!;
 expect(generic).not.toHaveProperty('covered_by_field_request_ids');expect(generic).not.toHaveProperty('covered_by_field_request_id');expect(generic.answered_at).toBeNull();
});
it('does not use an optional REAL projection without the server session cookie',async()=>{
 const f=fixture();await listCaseRequests(f.review.case_id,f.db,f.identityId);expect(ports.real).not.toHaveBeenCalled();
});
it('preserves the existing current owner artifact path without consulting REAL',async()=>{
 const f=fixture(),reportId=randomUUID();ports.list.mockResolvedValue([{report_id:reportId,analysis_run_id:f.review.analysis_run_id,current:true,created_at:'2026-09-12T00:00:00Z'}]);
 ports.artifact.mockResolvedValue({current:true,bundle:{analysis_run_id:f.review.analysis_run_id,document_review:f.review}});
 expect((await f.run()).find(row=>row.id===f.generic.id)?.covered_by_field_request_id).toBe(f.fieldRequest.request_id);expect(ports.real).not.toHaveBeenCalled();
});
it('keeps a disagreeing multi-observation generic action visible',async()=>{
 const f=fixture(true,true),generic=(await f.run()).find(row=>row.id===f.generic.id)!;
 expect(generic).not.toHaveProperty('covered_by_field_request_ids');expect(generic.answered_at).toBeNull();
});
it('keeps unknown reading history and correction links without declaring the generic question answered',async()=>{
 const f=fixture(true),answer_text=JSON.stringify({schema_version:'document-field-answer-v2',action:'unknown'});
 f.responses.case_request_list=[f.generic,{...f.fieldRows[0],answered_at:'2026-09-12T00:00:00Z',answer_text},f.fieldRows[1]];
 const rows=await f.run(),generic=rows.find(row=>row.id===f.generic.id)!;
 expect(generic.covered_by_field_request_ids).toEqual(f.fields.map(field=>field.request_id));expect(generic.answered_at).toBeNull();expect(generic).not.toHaveProperty('covered_by_confirmed_reading');
 expect(rows.find(row=>row.id===f.fieldRows[0].id)?.answer_text).toBe(answer_text);
});
