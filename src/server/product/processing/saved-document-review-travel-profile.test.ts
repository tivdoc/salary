import {beforeEach,describe,expect,it,vi} from 'vitest';
import {travelFloorFixture,travelFloorReview} from '@/engine/entitlement-review/travel/floor.fixture';
import {travelEntitlementInputSchema} from '@/engine/entitlement-review/travel/contracts';
import {resolveTravelEntitlement} from '@/engine/entitlement-review/travel/index';
import {calculateDocumentReview} from '@/engine/document-review/calculations';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {runDocumentReview} from '@/engine/document-review/service';
import {travelJourneyFactKey} from '@/engine/entitlement-review/travel/journey-facts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {productFlowFixture} from '@/engine/entitlement-review/working-time/product-flow.fixture';
import {workingTimeEntitlementInputSchema} from '@/engine/entitlement-review/working-time/contracts';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import {savedDocumentReviewInput} from './saved-document-review';
import type {SavedExecutionOrder} from './saved-order-scope';

const ports=vi.hoisted(()=>({source:vi.fn(),tariff:vi.fn(),reviewAnswers:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',async load=>({...await load<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
vi.mock('./saved-review-source-proof',()=>({savedReviewSourceEvidence:async()=>({proofs:[],retained:[]})}));
vi.mock('@/engine/document-review/payslip-adapter',async load=>({...await load<typeof import('@/engine/document-review/payslip-adapter')>(),reviewInputFromPayslips:ports.source}));
vi.mock('@/engine/document-review/non-payslip',()=>({attachNonPayslipInventory:(input:unknown)=>input}));
vi.mock('@/engine/entitlement-review/automatic-pension',()=>({attachAutomaticPensionEvidence:(input:unknown)=>input}));
vi.mock('@/engine/entitlement-review/automatic-payroll',()=>({attachAutomaticPayrollEvidence:(input:unknown)=>input}));
vi.mock('@/engine/entitlement-review/automatic-benefits',()=>({attachAutomaticBenefitsEvidence:(input:unknown)=>input}));
vi.mock('@/engine/entitlement-review/automatic-nonpay',()=>({attachAutomaticNonPayslipEvidence:(input:unknown)=>({input,reading_dependencies:[]})}));
vi.mock('./saved-travel-tariff-readings',async load=>({...await load<typeof import('./saved-travel-tariff-readings')>(),readSavedTravelTariffReadings:ports.tariff}));
vi.mock('./saved-review-requests',async load=>({...await load<typeof import('./saved-review-requests')>(),readSavedReviewAnswers:ports.reviewAnswers}));
beforeEach(()=>{vi.clearAllMocks();ports.tariff.mockResolvedValue({records:[],history:[]});ports.reviewAnswers.mockResolvedValue([]);});
function setup(hasDocumentReviewAnswers=false){
 const travel=travelFloorFixture();delete travel.calculation_policy;
 travel.commute_days!.printed_value='0';travel.discounted_daily_fare=null;travel.monthly_pass_cost=null;
 travel.monthly_pass={state:'unknown',value:null,source:null,basis:'ai_source_assessment'};
 const snapshot={...structuredClone(buildSyntheticCaseFixture({fixture_id:'travel-profile-boundary',mode:'real'}).stored),has_document_review_answers:hasDocumentReviewAnswers};
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:travel.case_id,revision:7,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedExecutionOrder={id:'99999999-9999-4999-8999-999999999999',kind:'full',from:'2026-06-01',to:'2026-06-01',topics:['travel'],offer_sha256:'d'.repeat(64)};
 const context:PostgresTransactionContext={transaction_id:'synthetic-profile',client:{async query(q){
  if(q.name==='review_source_read')return {rows:[{source:{state:'legacy'}}],row_count:1};
  if(q.name==='review_checkpoint_read')return {rows:[],row_count:0};
  throw Error('UNEXPECTED_PROFILE_QUERY:'+q.name);
 }}};
 ports.source.mockImplementation(()=>{const input=travelFloorReview(travel);
  input.completion_input={...parseReviewCompletionInput(input.completion_input),documents:input.documents.map(d=>({
   pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,period:d.period,review:'partial'}))};return input;});
 return {travel,snapshot,job,context,load:(automaticOnly=false)=>savedDocumentReviewInput(context,job,order,'2026-06',snapshot,automaticOnly)};
}
describe('explicit ordinary automatic travel profile without a tariff purpose',()=>{
 it.each([false,true])('selects protected breaks only in the automatic saved profile: %s',async automatic=>{
  const f=setup(),working=productFlowFixture(),original=canonicalSha256(working.input);
  ports.source.mockImplementation((argument:{purchased_scope:{order_id:string;receipt_sha256:string}})=>{
   const source=working.review();
   source.purchased_scope={...source.purchased_scope,...argument.purchased_scope};
   source.entitlement_evidence={schema_version:'entitlement-source-evidence-v1',case_id:source.case_id,
    order_id:source.purchased_scope.order_id,receipt_sha256:source.purchased_scope.receipt_sha256,
    period:source.period,working_time:[working.input]};
   return source;
  });
  const order:SavedExecutionOrder={id:'99999999-9999-4999-8999-999999999999',kind:'full',from:'2026-06-01',to:'2026-06-01',topics:['working_time'],offer_sha256:'d'.repeat(64)};
  const output=await savedDocumentReviewInput(f.context,{...f.job,case_id:working.input.case_id},order,'2026-06',f.snapshot,automatic);
  const weeks=output.entitlement_evidence!.working_time as unknown[];
  expect(workingTimeEntitlementInputSchema.parse(weeks[0]).protected_break_policy).toBe(automatic?'working-time-protected-breaks-v1':undefined);
  expect(canonicalSha256(working.input)).toBe(original);
 });
 it('selects floor v2 for source-supported zero, preserving facts and independent method evidence',async()=>{
  const f=setup(),before=canonicalSha256(f.travel),out=await f.load(true);
  expect(ports.source).toHaveBeenCalledWith(expect.objectContaining({identified_period_structure_policy:'identified-period-structures-v2'}));
  const packet=travelEntitlementInputSchema.parse(out.entitlement_evidence!.travel),resolved=resolveTravelEntitlement(packet);
  expect(packet.calculation_policy).toBe('travel-general-order-floor-v2');
  expect(packet.applicability).toEqual(f.travel.applicability);expect(packet.commute_days).toEqual(f.travel.commute_days);
  expect(packet.applicability.some(d=>d.decision_id==='travel.no_better_arrangement')).toBe(false);
  expect(calculateDocumentReview(resolved.checks[0].calculation)).toMatchObject({state:'calculated',expected:{minor_units:0},real_activation_allowed:false});
  expect(resolved.gaps.map(g=>g.dependency_id)).toEqual(['travel.complete_arrangement']);
  expect(packet.discounted_daily_fare).toBeNull();expect(packet.monthly_pass_cost).toBeNull();
  expect(canonicalSha256(f.travel)).toBe(before);expect(ports.tariff).toHaveBeenCalledTimes(2);
  for(const call of ports.tariff.mock.calls)expect(call).toEqual([f.context,f.job,'2026-06']);
 });
 it.each(['missing','expired'] as const)('does not invent or refresh %s method authority to calculate zero',async state=>{
  const f=setup();
  if(state==='missing')f.travel.applicability=f.travel.applicability.filter(d=>d.decision_id!=='travel.general_order_floor');
  else {const floor=f.travel.applicability.find(d=>d.decision_id==='travel.general_order_floor');if(!floor)throw Error('FLOOR_FIXTURE_REQUIRED');floor.valid_until=f.travel.evaluated_at;}
  const out=await f.load(true),packet=travelEntitlementInputSchema.parse(out.entitlement_evidence!.travel),resolved=resolveTravelEntitlement(packet);
  expect(packet.applicability).toEqual(f.travel.applicability);expect(resolved.checks.length).toBeGreaterThan(0);
  expect(resolved.checks.every(c=>calculateDocumentReview(c.calculation).state==='blocked')).toBe(true);
  expect(resolved.gaps.some(g=>g.dependency_id==='travel.general_order_floor')).toBe(true);
 });
 it('leaves default historical policy and its no-better blocker unchanged',async()=>{
  const f=setup();f.travel.applicability=travelFloorFixture(false).applicability.filter(d=>d.decision_id!=='travel.no_better_arrangement');
  const out=await f.load(),packet=travelEntitlementInputSchema.parse(out.entitlement_evidence!.travel);
  expect(ports.source.mock.calls.every(call=>!Object.hasOwn(call[0],'identified_period_structure_policy'))).toBe(true);
  expect(packet.calculation_policy).toBeUndefined();expect(packet.applicability).toEqual(f.travel.applicability);
  expect(resolveTravelEntitlement(packet).gaps.some(g=>g.dependency_id==='travel.no_better_arrangement')).toBe(true);
  expect(ports.tariff).not.toHaveBeenCalled();
 });
 it('projects the tariff request after authenticated arrival replay with the same immutable journal scope',async()=>{
  const f=setup(true);f.travel.commute_days=null;
  const before=canonicalSha256(f.travel),initial=await f.load(true),effective=travelEntitlementInputSchema.parse(initial.entitlement_composition!.evidence.travel);
  const request=runDocumentReview(initial,'synthetic.profile.before').completions.customer_requests.find(r=>r.target.fact_key===travelJourneyFactKey(initial,effective));
  if(!request)throw Error('TEST_ARRIVAL_TARGET');
  const actor={case_id:f.job.case_id,identity_id:'99999999-9999-4999-8999-999999999997'};
  const answer={request_id:'99999999-9999-4999-8999-999999999998',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided' as const,value:'20'};
  ports.reviewAnswers.mockResolvedValue([{request,source_current:true,answers:[{actor,answer}]}]);ports.tariff.mockClear();ports.reviewAnswers.mockClear();
  const current=await f.load(true),needs=parseReviewCompletionInput(current.completion_input).needs;
  expect(needs.filter(n=>n.fact_key==='travel.tariff_source')).toHaveLength(1);
  expect(travelEntitlementInputSchema.parse(current.entitlement_composition!.evidence.travel).commute_days).toMatchObject({state:'declared',printed_value:'20'});
  expect(travelEntitlementInputSchema.parse(current.entitlement_evidence!.travel).commute_days).toBeNull();expect(current.answer_history).toHaveLength(1);
  expect(ports.tariff).toHaveBeenCalledTimes(2);for(const call of ports.tariff.mock.calls)expect(call).toEqual([f.context,f.job,'2026-06']);
  expect(ports.tariff.mock.invocationCallOrder[0]).toBeLessThan(ports.reviewAnswers.mock.invocationCallOrder[0]);
  expect(ports.reviewAnswers.mock.invocationCallOrder[0]).toBeLessThan(ports.tariff.mock.invocationCallOrder[1]);
  expect(await f.load(true)).toEqual(current);
  ports.reviewAnswers.mockResolvedValue([{request,source_current:true,answers:[{actor,answer},{actor,answer:{...answer,revision:2,value:'0'}}]}]);
  const zero=await f.load(true);expect(parseReviewCompletionInput(zero.completion_input).needs.some(n=>n.fact_key==='travel.tariff_source')).toBe(false);
  expect(zero.answer_history).toHaveLength(2);expect(canonicalSha256(f.travel)).toBe(before);
 });
});
