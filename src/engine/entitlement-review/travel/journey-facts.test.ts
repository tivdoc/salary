import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../../ai-release-runtime/runtime.fixture.ts';
import {parseReviewCompletionInput} from '../../document-review/completions.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../../document-review/service.ts';
import {composeEntitlementReview} from '../compose.ts';
import {enableSharedPersonalFacts,SHARED_PERSONAL_FACTS_EXPANDED_POLICY} from '../shared-product-facts.ts';
import {travelEntitlementInputSchema} from './contracts.ts';
import {travelProductFacts,TRAVEL_JOURNEY_FACTS_POLICY} from './product-facts.ts';
import {travelJourneyFactKey,materializeTravelJourneyFacts} from './journey-facts.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
const at='2026-09-12T12:00:00Z',identity='22222222-2222-4222-8222-222222222222',requestId='55555555-5555-4555-8555-555555555555';
function fixture(){const i=nineTopicRuntimeSource(),t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel);t.commute_days=null;t.product_facts=travelProductFacts(TRAVEL_JOURNEY_FACTS_POLICY);
 const ids=new Set(t.source_manifest.map(m=>m.document_id));i.documents=i.documents.filter(d=>ids.has(d.document_id));const c=parseReviewCompletionInput(i.completion_input);i.completion_input={...c,documents:c.documents.filter(d=>ids.has(d.pin.document_id))};
 i.entitlement_evidence=enableSharedPersonalFacts({schema_version:'entitlement-source-evidence-v1',case_id:i.case_id,order_id:i.purchased_scope.order_id,receipt_sha256:i.purchased_scope.receipt_sha256,period:i.period,travel:t},SHARED_PERSONAL_FACTS_EXPANDED_POLICY);return i;
}
const effective=(input:DocumentReviewInput)=>travelEntitlementInputSchema.parse(input.entitlement_composition!.evidence.travel);
function setup(){const source=fixture(),input=composeEntitlementReview(source),request=runDocumentReview(input,'journey.before').completions.customer_requests.find(r=>r.target.fact_key===travelJourneyFactKey(input,effective(input)))!;expect(request).toBeDefined();return {source,input,request};}
function answer(f:ReturnType<typeof setup>,value:string|null,revision=1,input=f.input){return applyDocumentReviewAnswer(input,{request:f.request,actor:{case_id:input.case_id,identity_id:identity},answer:{request_id:requestId,revision,answered_at:at,state:value===null?'unknown':'provided',value}}).input;}
describe('ordinary declared arrivals with a separate fare source',()=>{
 it('uses one factual action, retains raw evidence, and runs the existing travel calculation',()=>{
  const f=setup(),before=canonicalSha256(f.source.entitlement_evidence),next=answer(f,'20'),e=effective(next);
  expect(f.request.target).toMatchObject({answer_kind:'text',required_evidence_kind:'customer_declaration',value_validation:{format:'calendar_days'}});
  expect(runDocumentReview(f.input,'pending').completions.customer_requests.filter(r=>r.target.question.includes('כמה ימים')||r.target.question.includes('בכמה ימים'))).toHaveLength(1);
  expect(e.commute_days).toMatchObject({state:'declared',printed_value:'20',source:{reading:'customer_declaration'}});
  expect(canonicalSha256(next.entitlement_evidence)).toBe(before);expect(next.answer_history).toHaveLength(1);
  const result=runDocumentReview(next,'journey.after');expect(result.checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:20000});expect(replayDocumentReview(result)).toEqual(result);
 });
 it('a count correction changes only dependent arithmetic and retains retry/history',()=>{
  const f=setup(),first=answer(f,'20'),next=answer(f,'10',2,first);expect(next.answer_history).toHaveLength(2);
  for(const key of ['recorded','discounted_daily_fare','monthly_pass_cost'] as const)expect(effective(next)[key]).toEqual(effective(first)[key]);
  expect(runDocumentReview(next,'journey.corrected').checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:12000});
  expect(answer(f,'10',2,next)).toEqual(next);
 });
 it('zero is explicit, while unknown never becomes zero',()=>{
  const f=setup(),zero=answer(f,'0');expect(runDocumentReview(zero,'zero').checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:0});
  const unknown=answer(f,null,2,zero);expect(effective(unknown).commute_days).toBeNull();expect(runDocumentReview(unknown,'unknown').checks.filter(c=>c.topic==='travel')).toHaveLength(0);expect(unknown.answer_history).toHaveLength(2);
 });
 it.each(['31','-1','20.5',' 20','20 days'])('rejects invalid June count %s before saving',value=>{const f=setup();expect(()=>answer(f,value)).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');expect(f.input.answer_history).toHaveLength(0);});
 it('refuses a foreign scope and an altered declared value',()=>{
  const f=setup(),next=answer(f,'20'),raw=travelEntitlementInputSchema.parse(next.entitlement_evidence!.travel),e=effective(next);
  expect(()=>materializeTravelJourneyFacts(e,raw,{...next,case_id:'foreign'})).toThrow('TRAVEL_JOURNEY_SCOPE');
  if(e.product_facts!.schema_version!==TRAVEL_JOURNEY_FACTS_POLICY)throw Error('TEST_POLICY');e.product_facts!.actual_commute_days.value=19;
  expect(()=>materializeTravelJourneyFacts(e,raw,next)).toThrow('TRAVEL_JOURNEY_CURRENT_ANSWER');
 });
 it('never overwrites an existing identified source count or adds v2 facts to a historical packet',()=>{
  const f=setup(),old=travelEntitlementInputSchema.parse(nineTopicRuntimeSource().entitlement_evidence!.travel);
  expect(materializeTravelJourneyFacts(old,old,f.input)).toEqual(old);
  const current={...old,product_facts:travelProductFacts(TRAVEL_JOURNEY_FACTS_POLICY)};expect(materializeTravelJourneyFacts(current,current,f.input).commute_days).toEqual(old.commute_days);
 });
});
