import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview,replayDocumentReviewCalculation} from '../../document-review/calculations.ts';
import {resolveWorkingTimeEntitlement} from './resolve.ts';
import {singleDay,operand,weekInput} from './working-time.fixture.ts';
import {nineTopicRuntimeSource,runtimeFixture} from '../../ai-release-runtime/runtime.fixture.ts';
import {runAiReleaseRuntime,replayAiReleaseRuntime} from '../../ai-release-runtime/runtime.ts';
import {workingTimeEntitlementInputSchema} from './contracts.ts';

function fixture(){return {...singleDay(),calculation_policy:'working-time-separated-expected-v2' as const};}
describe('working time expected wages stay independent of recorded payment in v2',()=>{
 it('computes 10h at40 with8h ordinary as420 even when no payment allocation exists',()=>{
  const i=fixture();i.workdays[0].recorded_pay=null;i.workdays[0].payment_allocation={state:'missing',value:null,source:null};
  i.applicability=i.applicability.filter(d=>d.decision_id!=='wt.payroll_allocation');
  const r=resolveWorkingTimeEntitlement(i);expect(r.checks).toHaveLength(1);expect(r.checks[0].check_id).toMatch(/\.expected$/u);
  const c=calculateDocumentReview(r.checks[0].calculation);expect(c).toMatchObject({state:'calculated',expected:{minor_units:42000}});
  expect(c.recorded).toBeNull();expect(c.difference).toBeNull();expect(replayDocumentReviewCalculation(c)).toEqual(c);
  expect(r.missing.find(m=>m.fact_key.startsWith('wt.payment.'))?.dependent_check_ids).toEqual([i.check_id_prefix+'.'+i.workdays[0].id]);
 });
 it('keeps expected calculation bytes unchanged after a payment-only correction and preserves signed gaps',()=>{
  const i=fixture(),before=resolveWorkingTimeEntitlement(i);expect(before.checks).toHaveLength(2);
  for(const [paid,gap]of [['420',0],['450',-3000]] as const){
   i.workdays[0].recorded_pay=operand('new.payment',paid,'money');const after=resolveWorkingTimeEntitlement(i);
   expect(canonicalSha256(after.checks[0])).toBe(canonicalSha256(before.checks[0]));
   expect(calculateDocumentReview(after.checks[1].calculation)).toMatchObject({difference:{minor_units:gap}});
  }
 });
 it('retains night and weekly allocation with no invented payment zero',()=>{
  const i={...singleDay(true),calculation_policy:'working-time-separated-expected-v2' as const};i.workdays[0].recorded_pay=null;
  const night=resolveWorkingTimeEntitlement(i);expect(calculateDocumentReview(night.checks[0].calculation)).toMatchObject({expected:{minor_units:44000},recorded:null,difference:null});
  const w={...weekInput(),calculation_policy:'working-time-separated-expected-v2' as const};for(const d of w.workdays)d.recorded_pay=null;
  const result=resolveWorkingTimeEntitlement(w);expect(result.checks).toHaveLength(6);expect(result.allocation_receipt.weekly_inventory_complete).toBe(true);
  expect(result.checks.map(c=>calculateDocumentReview(c.calculation).expected)).toEqual(Array(6).fill(expect.objectContaining({minor_units:42000})));
 });
 it('keeps wage and classification uncertainty blocking expected results, and preserves v1 lack of payment behavior',()=>{
  const i=fixture();i.workdays[0].recorded_pay=null;i.regular_hourly_wage={...i.regular_hourly_wage,state:'unknown',printed_value:null};
  expect(resolveWorkingTimeEntitlement(i).checks).toHaveLength(0);
  const classified=fixture();classified.workdays[0].intervals[0].classification={state:'conflict',value:null,source:null};
  expect(()=>resolveWorkingTimeEntitlement(classified)).toThrow('WORKING_TIME_UNRESOLVED_CLASSIFICATION_ACCEPTED');
  classified.applicability=classified.applicability.filter(d=>!d.decision_id.startsWith('wt.worked_time.'));
  expect(resolveWorkingTimeEntitlement(classified).checks).toHaveLength(0);
  const old=singleDay();old.workdays[0].recorded_pay=null;expect(resolveWorkingTimeEntitlement(old).checks).toHaveLength(0);
 });
});

it('uses the ordinary composer, authority fixture and Finding output without a payment finding',()=>{
 const source=nineTopicRuntimeSource(),working=workingTimeEntitlementInputSchema.parse((source.entitlement_evidence!.working_time as unknown[])[0]);
 working.calculation_policy='working-time-separated-expected-v2';
 for(const day of working.workdays){day.recorded_pay=null;day.payroll_allocations=[];day.payment_allocation={state:'missing',value:null,source:null};}
 working.applicability=working.applicability.filter(d=>d.decision_id!=='wt.payroll_allocation');source.entitlement_evidence!.working_time=[working];
 const input=runtimeFixture(source),r=runAiReleaseRuntime(input),findings=r.findings.filter(f=>f.topic==='working_time'||f.topic==='rest_day');
 expect(findings.length).toBeGreaterThan(0);expect(findings.every(f=>f.outcome==='expected_only'&&f.recorded===null&&f.difference===null&&f.analysis_run_id===input.analysis_run_id)).toBe(true);
 expect(replayAiReleaseRuntime(r,input)).toEqual(r);
});

it('isolates duplicate and conflicting payment allocations from independently supported expected wages in v2',()=>{
 const old=weekInput();old.workdays[1].recorded_pay=old.workdays[0].recorded_pay;
 expect(()=>resolveWorkingTimeEntitlement(old)).toThrow('WORKING_TIME_DUPLICATE_PAYMENT_SOURCE');
 const separated={...old,calculation_policy:'working-time-separated-expected-v2' as const},result=resolveWorkingTimeEntitlement(separated);
 expect(result.checks.filter(c=>c.check_id.endsWith('.expected'))).toHaveLength(6);
 expect(result.checks.filter(c=>!c.check_id.endsWith('.expected'))).toHaveLength(4);
 expect(result.missing.filter(m=>m.fact_key.startsWith('wt.payment.')&&m.state==='conflict')).toHaveLength(2);
 for(const reason of ['alternatives','premium_only','hours_overlap'] as const){
  const i=fixture(),day=i.workdays[0];
  day.payroll_allocations=[{id:'allocated.test',hours:operand('allocated.hours',reason==='hours_overlap'?'12:00':'10:00'),hourly_rate:operand('allocated.rate','40','money'),percentage:reason==='premium_only'?{...operand('allocated.percent','50'),representation:'percent',quantity_unit:'ratio'}:null}];
  if(reason!=='alternatives')day.recorded_pay=null;
  const r=resolveWorkingTimeEntitlement(i);expect(r.checks).toHaveLength(1);expect(calculateDocumentReview(r.checks[0].calculation)).toMatchObject({expected:{minor_units:42000},recorded:null,difference:null});
  expect(r.missing.some(m=>m.state==='conflict'&&m.fact_key.startsWith('wt.payment.'))).toBe(true);
 }
});
