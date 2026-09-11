import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {calculateDocumentReview,replayDocumentReviewCalculation} from '../document-review/calculations.ts';
import {resolveDocumentReviewNightEntitlement,type NightEntitlementInput} from './document-review-entitlement-night-work.ts';
import {NIGHT_ENTITLEMENT_CATALOG,NIGHT_ENTITLEMENT_SOURCE_REVIEW} from './document-review-entitlement-source-policy.ts';
import {syntheticNightInput,operand} from './document-review-entitlement-night-work.fixture.ts';

function run(input:NightEntitlementInput){const r=resolveDocumentReviewNightEntitlement(input);if(!r.check)throw Error('fixture expected candidate');return calculateDocumentReview(r.check.calculation);}
function hypothetical():NightEntitlementInput{
 const i=syntheticNightInput();
 return {...i,mode:'all_presence_is_work_scenario',intervals:[{...i.intervals[0],classification:'unresolved_rest'}],
  applicability:i.applicability.map(d=>d.decision_id==='night.breaks'?{...d,state:'unknown',explanation:'The source says rest; duty freedom is unknown.'}:d),
  conditional_assumptions:[{decision_id:'night.breaks',explanation:'Only if the complete presence interval was work; this has not been established.'}]};
}
describe('night-work entitlement: independently specified synthetic oracles',()=>{
 it('derives tiers from worked hours and a positive required-versus-recorded difference',()=>{
  // Independent arithmetic: (7 + 2*1.25 + 1*1.5)*40 =440, printed10*40=400.
  const r=run(syntheticNightInput());expect(r.state).toBe('calculated');if(r.state!=='calculated')return;
  expect(r.expected).toEqual({kind:'money',currency:'ILS',minor_units:44000});expect(r.recorded).toMatchObject({minor_units:40000});expect(r.difference).toMatchObject({minor_units:4000});
  expect(r.execution.trace.find(n=>n.step_id==='night.first.hours')?.result).toMatchObject({numerator:'2',denominator:'1',unit:'hours'});
  expect(r.execution.trace.find(n=>n.step_id==='night.qualifies')?.result).toEqual({kind:'boolean',value:true});
  expect(r.real_activation_allowed).toBe(false);expect(r.human_attestation).toBeNull();expect(r.comparison_basis).toBe('document_allocation');
  expect(replayDocumentReviewCalculation(r)).toEqual(r);
 });
 it('proves a no-gap day using separate ordinary/125/150 source rows',()=>{
  const i=syntheticNightInput();const r=run({...i,payroll_allocations:[
   {id:'regular',hours:operand('regular','7:00'),hourly_rate:i.hourly_wage,percentage:null},
   {id:'first',hours:operand('first','2:00'),hourly_rate:i.hourly_wage,percentage:operand('first.rate','125','percent')},
   {id:'later',hours:operand('later','1:00'),hourly_rate:i.hourly_wage,percentage:operand('later.rate','150','percent')}]});
  expect(r).toMatchObject({state:'calculated',expected:{minor_units:44000},recorded:{minor_units:44000},difference:{minor_units:0}});
 });
 it('uses exact minutes in fractional overtime without floor or invented hidden precision',()=>{
  const i=syntheticNightInput();const r=run({...i,intervals:[{...i.intervals[0],end_time:'08:01',printed_presence:operand('presence','10:01')}],payroll_allocations:[{...i.payroll_allocations[0],hours:operand('ordinary','10:01')}]});
  expect(r).toMatchObject({state:'calculated',expected:{minor_units:44100},recorded:{minor_units:40067},difference:{minor_units:4033}});
 });
 it('accepts exactly two hours of actual night work; ordinary portion stays actual duration',()=>{
  const i=syntheticNightInput();expect(run({...i,intervals:[{...i.intervals[0],start_time:'20:00',end_time:'00:00',printed_presence:operand('presence','4:00')}],payroll_allocations:[{...i.payroll_allocations[0],hours:operand('ordinary','4:00')}]})).toMatchObject({state:'calculated',expected:{minor_units:16000},difference:{minor_units:0}});
 });
 it('returns a precise missing-attendance dependency instead of using a monthly total',()=>{
  const r=resolveDocumentReviewNightEntitlement({...syntheticNightInput(),intervals:[]});expect(r).toMatchObject({state:'missing_source',check:null});expect(r.missing).toContainEqual(expect.objectContaining({dependency_id:'night.dated_attendance',state:'missing'}));
 });
 it('blocks 119 night minutes rather than pretending the seven-hour threshold applies',()=>{
  const i=syntheticNightInput();const r=resolveDocumentReviewNightEntitlement({...i,intervals:[{...i.intervals[0],start_time:'20:01',end_time:'23:59',printed_presence:operand('presence','3:58')}]});expect(r.check).toBeNull();expect(r.missing.map(x=>x.dependency_id)).toContain('night.two_hours');
 });
 it('keeps counterfactual rest separate from the unresolved source and binds replay',()=>{
  const i=hypothetical(),before=canonicalSha256(i);const r=run(i);expect(r).toMatchObject({state:'calculated',counterfactual_only:true,unresolved_conditions:[{decision:{state:'unknown'}}],difference:{minor_units:4000}});
  expect(canonicalSha256(i)).toBe(before);if(r.state!=='calculated')return;
  expect(r.conditional_trace_binding?.execution_trace_sha256).toBe(r.execution.trace_sha256);expect(replayDocumentReviewCalculation(r)).toEqual(r);
  const edited=structuredClone(r);edited.unresolved_conditions![0].assumption='Pretend established';expect(()=>replayDocumentReviewCalculation(edited)).toThrow('DOCUMENT_REVIEW_REPLAY_MISMATCH');
 });
 it('does not calculate unresolved rest without the explicit hypothesis',()=>{
  const i=hypothetical();expect(resolveDocumentReviewNightEntitlement({...i,mode:'source_classified',conditional_assumptions:undefined})).toMatchObject({state:'missing_source',check:null});
  expect(()=>resolveDocumentReviewNightEntitlement({...i,conditional_assumptions:undefined})).toThrow('NIGHT_ENTITLEMENT_EXPLICIT_REST_HYPOTHESIS_REQUIRED');
 });
 it.each(['conflict','stale','expired'] as const)('never assumes a %s applicability decision',state=>{
  const i=hypothetical();expect(()=>run({...i,applicability:i.applicability.map(d=>d.decision_id==='night.breaks'?{...d,state}:d)})).toThrow('DOCUMENT_REVIEW_ASSUMPTION_NOT_UNRESOLVED_SOURCED_DECISION');
 });
 it('missing actual rate cannot be supplied by a conditional assumption',()=>{expect(run({...hypothetical(),hourly_wage:operand('wage',null,'money'),payroll_allocations:[{...syntheticNightInput().payroll_allocations[0],hourly_rate:operand('wage',null,'money')}]})).toMatchObject({state:'blocked',expected:null,difference:null});});
 it('rejects a hypothetical with unknown applicability silently promoted to accepted',()=>{
  const i=hypothetical();expect(()=>run({...i,applicability:i.applicability.map(d=>({...d,state:'accepted'}))})).toThrow('NIGHT_ENTITLEMENT_REST_CLASSIFICATION_UNRESOLVED');
 });
});
describe('source dates, disjointness, comparison and version fences',()=>{
 it('requires the printed duration to reconcile both clock readings',()=>{const i=syntheticNightInput();expect(()=>run({...i,intervals:[{...i.intervals[0],end_time:'09:00'}]})).toThrow('NIGHT_ENTITLEMENT_CLOCK_DURATION_MISMATCH');});
 it('does not infer date rollover when printed duration is missing',()=>{const i=syntheticNightInput();const r=resolveDocumentReviewNightEntitlement({...i,intervals:[{...i.intervals[0],printed_presence:operand('presence',null)}]});expect(r.check).toBeNull();expect(r.missing.map(m=>m.dependency_id)).toContain('night.interval_duration');});
 it('rejects overlapping intervals, even with different row IDs',()=>{const i=syntheticNightInput();expect(()=>run({...i,intervals:[i.intervals[0],{...i.intervals[0],id:'another'}]})).toThrow('NIGHT_ENTITLEMENT_INTERVAL_OVERLAP');});
 it('rejects paid hours beyond source presence and a separate50% overlapping premium',()=>{
  const i=syntheticNightInput();expect(()=>run({...i,payroll_allocations:[{...i.payroll_allocations[0],hours:operand('ordinary','11:00')}]})).toThrow('NIGHT_ENTITLEMENT_ALLOCATED_HOURS_OVERLAP');
  expect(()=>run({...i,payroll_allocations:[{...i.payroll_allocations[0],percentage:operand('premium','50','percent')}]})).toThrow('NIGHT_ENTITLEMENT_OVERLAPPING_PREMIUM_NOT_FULL_PAY');
 });
 it('rejects the same paid observation inserted a second time with a different row ID',()=>{const i=syntheticNightInput();expect(()=>run({...i,payroll_allocations:[i.payroll_allocations[0],{...i.payroll_allocations[0],id:'duplicate'}]})).toThrow('NIGHT_ENTITLEMENT_ALLOCATION_DUPLICATE_SOURCE');});
 it('rejects foreign case, changed legal pins and unsupported researched period',()=>{
  const i=syntheticNightInput();expect(()=>run({...i,source_manifest:[{...i.source_manifest[0],case_id:'foreign.case'}]})).toThrow('DOCUMENT_REVIEW_FOREIGN_CASE');
  expect(()=>run({...i,period:{from:'2025-06-01',to:'2025-06-30'}})).toThrow('NIGHT_ENTITLEMENT_RESEARCH_PERIOD');
  expect(NIGHT_ENTITLEMENT_CATALOG.catalog_boundary).toBe('real_inactive');expect(NIGHT_ENTITLEMENT_SOURCE_REVIEW.human_attestation).toBeNull();
 });
 it('retains a signed negative difference and never labels it debt',()=>{const i=syntheticNightInput();expect(run({...i,payroll_allocations:[{...i.payroll_allocations[0],hourly_rate:operand('higher.rate','50.00','money')}]})).toMatchObject({difference:{minor_units:-6000},legal_requirement_status:'conditional_not_real_approval'});});
 it('compares only exact direct expected-minus-recorded trace refs',()=>{
  const r=resolveDocumentReviewNightEntitlement(syntheticNightInput());if(!r.check)throw Error('expected check');
  const input=structuredClone(r.check.calculation);if(input.operation.kind!=='candidate_rule'||!input.operation.comparison)throw Error('expected comparison');
  input.operation.comparison.recorded_ref='fact.wage';expect(()=>calculateDocumentReview(input)).toThrow('DOCUMENT_REVIEW_COMPARISON_BINDING');
 });
 it('enforces the night predicate during ordinary calculation replay, not only construction',()=>{
  const r=resolveDocumentReviewNightEntitlement(syntheticNightInput());if(!r.check)throw Error('expected check');
  const input=structuredClone(r.check.calculation);input.operands.find(o=>o.id==='night.overlap.0')!.printed_value='1:59';
  expect(calculateDocumentReview(input)).toMatchObject({state:'blocked',expected:null,difference:null,execution:null,blockers:[{dependency_id:'night.qualifies',reason:'rule_execution_precondition_false'}]});
 });
});
