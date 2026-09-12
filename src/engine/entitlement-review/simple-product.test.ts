import {convalescenceFixture,obligationsFixture} from './final-branch.fixture.ts';
import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../document-review/contracts.ts';
import {runDocumentReview,applyDocumentReviewAnswer,replayDocumentReview} from '../document-review/service.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {travelFixture,minimumFixture,vacationFixture} from './product-branch.fixture.ts';
import {composeEntitlementReview} from './compose.ts';
const caseId='11111111-1111-4111-8111-111111111111';
function product(topic:'travel'|'minimum_wage'|'vacation'|'convalescence'|'obligations',candidate:ReturnType<typeof travelFixture>|ReturnType<typeof minimumFixture>|ReturnType<typeof vacationFixture>|ReturnType<typeof convalescenceFixture>|ReturnType<typeof obligationsFixture>){
 const e=structuredClone(candidate);e.case_id=caseId;e.source_manifest=e.source_manifest.map(s=>({...s,case_id:s.kind==='legal_source'?null:caseId}));
 const sources:DocumentReviewSource[]=[];function visit(v:unknown){if(!v||typeof v!=='object')return;if('reading_receipt_sha256'in v)sources.push(v as DocumentReviewSource);for(const x of Object.values(v))visit(x);}visit(e);
 const documents=e.source_manifest.filter(s=>s.kind==='case_document').map(s=>({case_id:caseId,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'payslip',label:'Synthetic source fixture; no client',period:e.period,reading_origin:'ai_document_review',reading_sha256:sources.find(c=>c.document_id===s.document_id)!.reading_receipt_sha256}));
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period:e.period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage','working_time','rest_day','pension','travel','convalescence','vacation','bonuses','contract'],origin:'legacy_paid_receipt'},documents,checks:[],coverage_gaps:[],
  completion_input:{case_id:caseId,period:e.period,documents:documents.map(d=>({pin:{case_id:caseId,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,review:'complete',period:e.period})),needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),period:e.period,[topic]:e}});
}
describe('additional entitlement branches through ordinary composition and result replay',()=>{
 it.each(['travel','minimum_wage','vacation','convalescence','obligations'] as const)('%s selects its pinned compiled branch and retains nine purchased topics',topic=>{
  const input=product(topic,topic==='travel'?travelFixture():topic==='minimum_wage'?minimumFixture():topic==='convalescence'?convalescenceFixture():topic==='obligations'?obligationsFixture():vacationFixture()),prepared=composeEntitlementReview(input),r=runDocumentReview(prepared,'ordinary.'+topic);
  expect(r.checks.length).toBeGreaterThan(0);expect(r.checks.every(c=>c.topic===(topic==='obligations'?'bonuses':topic)&&c.calculation.state==='calculated')).toBe(true);
  expect(r.purchased_scope.topics).toHaveLength(9);expect(r.input.entitlement_composition?.selections.some(s=>s.topic===(topic==='obligations'?'bonuses':topic))).toBe(true);expect(replayDocumentReview(r)).toEqual(r);
  if(topic==='convalescence')expect(r.checks.find(c=>c.calculation.difference)?.calculation.difference).toMatchObject({minor_units:12875});
  if(topic==='obligations')expect(r.checks.find(c=>c.calculation.difference)?.calculation.difference).toMatchObject({minor_units:5000});
  if(topic==='travel')expect(r.checks.find(c=>c.calculation.difference)?.calculation.difference).toMatchObject({minor_units:1000});
  if(topic==='minimum_wage')expect(r.checks[0].calculation.difference).toMatchObject({minor_units:24000});
  if(topic==='vacation')expect(r.checks.find(c=>c.check_id.endsWith('annual.prorated'))?.calculation.expected).toMatchObject({value:6,unit:'calendar_days'});
 });
 it('keeps Hebrew choice receipts and normalized travel facts separate across correction and unknown',()=>{
  const raw=travelFixture();raw.facts.employer_transport={...raw.facts.employer_transport,state:'unknown',value:null};
  const prepared=composeEntitlementReview(product('travel',raw)),before=runDocumentReview(prepared,'before');
  const request=before.completions.customer_requests.find(r=>r.target.value_mapping?.entries.some(e=>e.value==='both'))!;expect(request).toBeDefined();
  const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'},answer={request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided' as const,value:'אין הסעה'};
  const next=applyDocumentReviewAnswer(prepared,{request,actor,answer}),r=runDocumentReview(next.input,'after');
  expect(r.checks.every(c=>c.calculation.state==='calculated')).toBe(true);expect(next.input.answer_history[0].receipt.value).toBe('אין הסעה');
  expect(next.input.entitlement_composition?.evidence.travel).toMatchObject({facts:{employer_transport:{value:'none',basis:'customer_declaration'}}});
  expect(canonicalSha256(next.input.entitlement_evidence)).toBe(canonicalSha256(prepared.entitlement_evidence));
  const unknown=applyDocumentReviewAnswer(next.input,{request,actor,answer:{...answer,revision:2,answered_at:'2026-09-12T12:01:00Z',value:'לא ידוע'}});
  expect(runDocumentReview(unknown.input,'unknown').checks).toHaveLength(0);expect(unknown.input.answer_history).toHaveLength(2);
 });
});

it('a sourced condition answer changes only its obligation and preserves a nonmonetary outcome',()=>{
 const e=obligationsFixture();e.obligations[0].conditions[0].fact={...e.obligations[0].conditions[0].fact,state:'unknown',value:null};
 const prepared=composeEntitlementReview(product('obligations',e)),before=runDocumentReview(prepared,'condition.before');
 const request=before.completions.customer_requests.find(r=>r.target.answer_kind==='boolean')!;expect(request).toBeDefined();
 const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'};
 const answer={request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided' as const,value:false};
 const no=applyDocumentReviewAnswer(prepared,{request,actor,answer}),r=runDocumentReview(no.input,'condition.no');
 expect(r.checks).toHaveLength(0);expect(r.input.entitlement_composition?.nonmonetary_outcomes).toMatchObject([{state:'condition_not_fulfilled'}]);
 expect(r.completions.customer_requests).toHaveLength(0);expect(replayDocumentReview(r)).toEqual(r);
 const yes=applyDocumentReviewAnswer(no.input,{request,actor,answer:{...answer,revision:2,value:true}}),changed=runDocumentReview(yes.input,'condition.yes');
 expect(changed.checks).toHaveLength(2);expect(changed.checks.every(c=>c.calculation.state==='calculated')).toBe(true);
 expect(changed.input.answer_history).toHaveLength(2);expect(changed.input.entitlement_composition?.nonmonetary_outcomes).toBeUndefined();
 expect(canonicalSha256(changed.input.entitlement_evidence)).toBe(canonicalSha256(prepared.entitlement_evidence));
});
