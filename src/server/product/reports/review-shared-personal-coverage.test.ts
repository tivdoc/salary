import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const protectedPorts=vi.hoisted(()=>({reports:vi.fn(),artifact:vi.fn()}));
vi.mock('./private-document-review',()=>({privateDocumentReviewReports:protectedPorts.reports,privateDocumentReviewArtifact:protectedPorts.artifact}));
import {listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {nineTopicRuntimeSource} from '@/engine/ai-release-runtime/runtime.fixture';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {composeEntitlementReview} from '@/engine/entitlement-review/compose';
import {minimumWageEntitlementInputSchema} from '@/engine/entitlement-review/minimum-wage/contracts';
import {minimumWagePersonalFacts} from '@/engine/entitlement-review/minimum-wage/product-facts';
import {pensionEntitlementInputSchema} from '@/engine/entitlement-review/pension/contracts';
import {pensionProductFacts} from '@/engine/entitlement-review/pension/product-facts';
import {enableSharedPersonalFacts} from '@/engine/entitlement-review/shared-product-facts';
import {reviewSharedPersonalRequestProjection,type SharedPersonalRequest} from './review-shared-personal-coverage';

function raw(shared=true){const input=nineTopicRuntimeSource(),e=input.entitlement_evidence!,m=minimumWageEntitlementInputSchema.parse(e.minimum_wage),p=pensionEntitlementInputSchema.parse(e.pension);
 m.product_facts=minimumWagePersonalFacts();m.population={state:'missing',value:null,source:null};m.employment={state:'missing',value:null,source:null};
 p.product_facts=pensionProductFacts();for(const key of ['aged_21_or_more','under_60'] as const)p.facts[key]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 p.applicability=p.applicability.filter(d=>d.decision_id!=='pension.general_coverage');
 const ids=new Set([...m.source_manifest,...p.source_manifest].map(s=>s.document_id));input.documents=input.documents.filter(d=>ids.has(d.document_id));
 input.completion_input={...parseReviewCompletionInput(input.completion_input),documents:parseReviewCompletionInput(input.completion_input).documents.filter(d=>ids.has(d.pin.document_id))};
 const packet={schema_version:'entitlement-source-evidence-v1' as const,case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,minimum_wage:m,pension:p};
 input.entitlement_evidence=shared?enableSharedPersonalFacts(packet):packet;return input;
}

const nowMs=Date.parse('2026-09-12T13:00:00Z');
function fixture(){
 const old=runDocumentReview(composeEntitlementReview(raw(false)),'before.shared');
 const review=runDocumentReview(composeEntitlementReview(raw()),'after.shared');
 const requests:SharedPersonalRequest[]=old.completions.customer_requests.map((r,i)=>({request_id:`77777777-7777-4777-8777-${String(i).padStart(12,'0')}`,
  code:r.code,target:r.target,source_current:true,answered_at:null,expires_at:'2026-09-13T00:00:00Z'}));
 return {review,requests,nowMs};
}
describe('shared personal question presentation uses the ordinary replayed report',()=>{
 it('shows three canonical actions for six old questions and retains their history',()=>{
  const f=fixture(),before=canonicalSha256(f),matches=reviewSharedPersonalRequestProjection(f);
  expect(matches).toHaveLength(3);expect(new Set(matches.map(m=>m.replacement_request_id)).size).toBe(3);
  expect(canonicalSha256(f)).toBe(before);
 });
 it('keeps a duplicate visible when the canonical action is missing, expired, or stale',()=>{
  const f=fixture(),first=reviewSharedPersonalRequestProjection(f)[0];
  for(const kind of ['missing','expired','stale'] as const){
   const requests=f.requests.flatMap(r=>r.request_id!==first.replacement_request_id?[r]:kind==='missing'?[]:[{...r,...(kind==='expired'?{expires_at:'invalid'}:{source_current:false})}]);
   expect(reviewSharedPersonalRequestProjection({...f,requests}).some(m=>m.request_id===first.request_id)).toBe(false);
  }
 });
 it('retains answered aliases and rejects forged or foreign source targets',()=>{
  const f=fixture(),first=reviewSharedPersonalRequestProjection(f)[0];
  for(const kind of ['answered','foreign','tampered'] as const){
   const requests=f.requests.map(r=>r.request_id!==first.request_id?r:kind==='answered'?{...r,answered_at:'2026-09-12T12:59:00Z'}:
    {...r,target:{...r.target,...(kind==='foreign'?{case_id:'foreign-case'}:{fact_key:'entitlement.pension.forged'})}});
   expect(reviewSharedPersonalRequestProjection({...f,requests}).some(m=>m.request_id===first.request_id)).toBe(false);
  }
 });
 it('keeps an unknown answer as the single correction route without claiming it was supplied',()=>{
  const f=fixture(),first=reviewSharedPersonalRequestProjection(f)[0],row=f.requests.find(r=>r.request_id===first.replacement_request_id)!;
  const request=f.review.completions.customer_requests.find(r=>r.target.target_sha256===row.target.target_sha256)!;
  const answered=applyDocumentReviewAnswer(f.review.input,{request,actor:{case_id:f.review.case_id,identity_id:'22222222-2222-4222-8222-222222222222'},answer:{
   request_id:row.request_id,revision:1,answered_at:'2026-09-12T12:00:00Z',state:'unknown',value:null}});
  const review=runDocumentReview(answered.input,'after.unknown'),requests=f.requests.map(r=>r.request_id===row.request_id?{...r,answered_at:'2026-09-12T12:00:00Z'}:r);
  expect(reviewSharedPersonalRequestProjection({...f,review,requests})).toContainEqual(first);
  expect(review.input.entitlement_composition!.shared_personal_facts!.groups.some(g=>g.state==='unknown')).toBe(true);
  expect(reviewSharedPersonalRequestProjection({...f,requests}).some(m=>m.request_id===first.request_id)).toBe(false);
 });
 it('refuses a changed replay manifest and preserves historical unmarked reports',()=>{
  const f=fixture(),forged=structuredClone(f.review);forged.input.entitlement_composition!.shared_personal_facts!.groups[0].state='provided';
  expect(()=>reviewSharedPersonalRequestProjection({...f,review:forged})).toThrow();
  expect(reviewSharedPersonalRequestProjection({...f,review:runDocumentReview(composeEntitlementReview(raw(false)),'historical')})).toEqual([]);
 });
});

it('projects aliases through the protected case request list and exposes none for a stale report',async()=>{
 const f=fixture(),rows=f.requests.map(r=>({id:r.request_id,case_id:r.target.case_id,code:r.code,question:r.target.question,answer_kind:'text',options:null,
  field_crop:null,blocking:true,opened_at:'2026-09-12T00:00:00Z',expires_at:r.expires_at,answered_at:null,answer_text:null}));
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string){
  const responses:Record<string,unknown[]>={case_request_list:rows,case_request_revision_list:[],case_request_review_states:f.requests.map(r=>({request_id:r.request_id,target:r.target,source_current:true}))};
  if(!(fn in responses))throw Error('UNEXPECTED_RPC:'+fn);return responses[fn] as T[];
 }};
 const clock=vi.spyOn(Date,'now').mockReturnValue(nowMs);
 try{
  protectedPorts.reports.mockResolvedValue([{report_id:'current-private-report',current:true,created_at:'2026-09-12T12:00:00Z',analysis_run_id:f.review.analysis_run_id}]);
  protectedPorts.artifact.mockResolvedValue({current:true,bundle:{analysis_run_id:f.review.analysis_run_id,document_review:f.review}});
  const result=await listCaseRequests(f.review.case_id,db,'22222222-2222-4222-8222-222222222222');
  expect(result.filter(r=>r.not_required_for_current_review)).toHaveLength(3);
  expect(result.every(r=>r.answered_at===null&&!('target'in r))).toBe(true);
  expect(result.filter(r=>r.not_required_for_current_review).every(r=>result.some(other=>other.id===r.replacement_review_request_id&&!other.not_required_for_current_review))).toBe(true);
  protectedPorts.artifact.mockResolvedValue({current:false,bundle:{analysis_run_id:f.review.analysis_run_id,document_review:f.review}});
  expect((await listCaseRequests(f.review.case_id,db,'22222222-2222-4222-8222-222222222222')).some(r=>r.not_required_for_current_review)).toBe(false);
 }finally{clock.mockRestore();}
});
