import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema,replayDocumentReviewCalculation} from '../../document-review/calculations.ts';
import {resolveWorkingTimeEntitlement} from './resolve.ts';
import {WORKING_TIME_CATALOG,WORKING_TIME_SOURCE_REVIEW} from './source-policy.ts';
import {fact,operand,singleDay,weekInput,source} from './working-time.fixture.ts';
import type {WorkingTimeEntitlementInput} from './contracts.ts';

function calculate(i:WorkingTimeEntitlementInput,index=0){const r=resolveWorkingTimeEntitlement(i);if(!r.checks[index])throw Error('fixture expected check');return calculateDocumentReview(r.checks[index].calculation);}
describe('working time: independent required-versus-paid oracles',()=>{
 it('computes daily gap, zero and signed overpayment using existing RuleSpec',()=>{
  const i=singleDay();expect(calculate(i)).toMatchObject({state:'calculated',expected:{minor_units:42000},recorded:{minor_units:40000},difference:{minor_units:2000},real_activation_allowed:false,human_attestation:null});
  i.workdays[0].recorded_pay=operand('pay.exact','420','money');expect(calculate(i)).toMatchObject({difference:{minor_units:0}});
  i.workdays[0].recorded_pay=operand('pay.excess','450','money');expect(calculate(i)).toMatchObject({difference:{minor_units:-3000}});
 });
 it('excludes daily OT from weekly42 and allocates first2 per day: ordinary42+12*1.25+4*1.5 at40 =2520',()=>{
  const r=resolveWorkingTimeEntitlement(weekInput()),calculated=r.checks.map(c=>calculateDocumentReview(c.calculation));
  expect(r.allocation_receipt.weekly_inventory_complete).toBe(true);expect(calculated).toHaveLength(6);
  expect(calculated.map(c=>c.state==='calculated'&&c.expected?.kind==='money'?c.expected.minor_units:null)).toEqual([42000,42000,42000,42000,42000,42000]);
  const last=calculated[5];expect(last).toMatchObject({expected:{minor_units:42000},recorded:{minor_units:32000},difference:{minor_units:10000}});
  if(last.state!=='calculated')return;
  expect(last.execution.trace.find(t=>t.step_id==='wt.regular')?.result).toMatchObject({numerator:'2',denominator:'1'});
  expect(last.execution.trace.find(t=>t.step_id==='wt.first')?.result).toMatchObject({numerator:'2',denominator:'1'});
  expect(last.execution.trace.find(t=>t.step_id==='wt.later')?.result).toMatchObject({numerator:'4',denominator:'1'});
  expect(replayDocumentReviewCalculation(last)).toEqual(last);
 });
 it('daily evidence survives partial week, missing prior pay and a scheduled paid absence',()=>{
  const one=resolveWorkingTimeEntitlement(singleDay());expect(one.checks).toHaveLength(1);expect(one.missing.some(m=>m.fact_key==='wt.week_inventory')).toBe(true);
  const i=weekInput();i.workdays[0].recorded_pay=null;const r=resolveWorkingTimeEntitlement(i);expect(r.checks).toHaveLength(5);expect(r.allocation_receipt.weekly_inventory_complete).toBe(true);
  const absence=weekInput([0,10,10,10,10,8,0]);absence.workdays[0].no_work_credit=fact('paid_absence');const blockedWeekly=resolveWorkingTimeEntitlement(absence);
  expect(blockedWeekly.checks).toHaveLength(5);expect(blockedWeekly.allocation_receipt.weekly_inventory_complete).toBe(false);
 });
 it('uses explicit5day limits, preserving a shorter contractual day rather than42/5',()=>{
  const i=singleDay();i.arrangement=fact('adult_hourly_five_day_42');i.scheduled_weekdays=fact([0,1,2,3,4]);i.workdays[0].ordinary_limit=operand('limit.five','8:36');
  expect(calculate(i)).toMatchObject({expected:{minor_units:41400},difference:{minor_units:1400}});
  i.workdays[0].ordinary_limit=operand('limit.short','6:00');expect(calculate(i)).toMatchObject({expected:{minor_units:46000}});
 });
 it('uses seven-hour overnight threshold and preserves exact minute rounding',()=>{
  const i=singleDay(true);expect(calculate(i)).toMatchObject({expected:{minor_units:44000},difference:{minor_units:4000}});
  i.workdays[0].intervals[0].end_at='2026-06-08T08:01:00+03:00';i.workdays[0].intervals[0].printed_duration=operand('duration.0','10:01');
  expect(calculate(i)).toMatchObject({expected:{minor_units:44100}});
 });
 it('seven-hour night branch does not require an invented ordinary five-day threshold',()=>{
  const i=singleDay(true);i.workdays[0].ordinary_limit=operand('unknown.limit',null);expect(calculate(i)).toMatchObject({expected:{minor_units:44000}});
  const day=singleDay();day.workdays[0].ordinary_limit=operand('unknown.limit',null);expect(resolveWorkingTimeEntitlement(day).checks).toEqual([]);
 });
 it('combines statutory rest and overtime additively:7*150%+2*175%+1*200%=640 at40',()=>{
  const i=singleDay(true);i.rest_window=fact({start_at:'2026-06-07T00:00:00+03:00',end_at:'2026-06-08T12:00:00+03:00'});
  expect(resolveWorkingTimeEntitlement(i).checks[0].topic).toBe('rest_day');expect(calculate(i)).toMatchObject({expected:{minor_units:64000},difference:{minor_units:24000}});
 });
 it('adds rest only to actual window overlap, not the whole overnight shift',()=>{
  const i=singleDay(true);i.rest_window=fact({start_at:'2026-06-08T00:00:00+03:00',end_at:'2026-06-09T12:00:00+03:00'});
  // Daily440 + eight overlapping hours*40*0.5 =600.
  expect(calculate(i)).toMatchObject({expected:{minor_units:60000}});
 });
 it('uses disjoint documented payroll bands, never monthly gross',()=>{
  const i=singleDay(true),d=i.workdays[0];d.recorded_pay=null;d.payroll_allocations=[
   {id:'regular',hours:operand('paid.regular','7:00'),hourly_rate:i.regular_hourly_wage,percentage:null},
   {id:'first',hours:operand('paid.first','2:00'),hourly_rate:i.regular_hourly_wage,percentage:operand('paid125','125','percent')},
   {id:'later',hours:operand('paid.later','1:00'),hourly_rate:i.regular_hourly_wage,percentage:operand('paid150','150','percent')}];
  expect(calculate(i)).toMatchObject({expected:{minor_units:44000},recorded:{minor_units:44000},difference:{minor_units:0}});
  d.payroll_allocations[2].percentage=operand('premium','50','percent');expect(()=>calculate(i)).toThrow('WORKING_TIME_PREMIUM_ONLY_ALLOCATION');
 });
});
describe('working time: evidence and applicability remain separate',()=>{
 it('excludes a freely usable break and never treats mere attendance as proved work',()=>{
  const i=singleDay();i.workdays[0].intervals=[
   {...i.workdays[0].intervals[0],end_at:'2026-06-07T12:00:00+03:00',printed_duration:operand('first.duration','4:00'),clock_source:source('Cell first.duration')},
   {id:'break.segment',start_at:'2026-06-07T12:00:00+03:00',end_at:'2026-06-07T13:00:00+03:00',printed_duration:operand('break.duration','1:00'),clock_source:source('Cell break.duration'),classification:fact('free_break')},
   {id:'second.segment',start_at:'2026-06-07T13:00:00+03:00',end_at:'2026-06-07T18:00:00+03:00',printed_duration:operand('second.duration','5:00'),clock_source:source('Cell second.duration'),classification:fact('worked')}];
  expect(calculate(i)).toMatchObject({expected:{minor_units:37000}});
 });
 it('binds a named presence counterfactual while retaining original unknown classification',()=>{
  const i=singleDay(true);i.workdays[0].intervals[0].classification={state:'unknown',value:'unknown',source:source()};
  i.applicability=i.applicability.map(d=>d.decision_id==='wt.worked_time.day.0'?{...d,state:'unknown'}:d);
  expect(resolveWorkingTimeEntitlement(i).checks).toHaveLength(0);
  i.mode='explicit_presence_scenario';i.conditional_assumptions=[{decision_id:'wt.worked_time.day.0',explanation:'Only if all source presence counts as working time; the duty status is unknown.'}];
  const before=canonicalSha256(i),r=calculate(i);expect(r).toMatchObject({state:'calculated',counterfactual_only:true,expected:{minor_units:44000},unresolved_conditions:[{decision:{state:'unknown'}}]});expect(canonicalSha256(i)).toBe(before);
  if(r.state!=='calculated')return;const edited=structuredClone(r);edited.unresolved_conditions![0].assumption='Invented source confirmation';expect(()=>replayDocumentReviewCalculation(edited)).toThrow('DOCUMENT_REVIEW_REPLAY_MISMATCH');
 });
 it.each(['conflict','stale','expired'] as const)('does not assume %s source classification',state=>{
  const i=singleDay();i.mode='explicit_presence_scenario';i.workdays[0].intervals[0].classification={state,value:null,source:source()};
  i.applicability=i.applicability.filter(d=>d.decision_id!=='wt.worked_time.day.0');i.conditional_assumptions=[{decision_id:'wt.worked_time.day.0',explanation:'Cannot override source state.'}];
  expect(resolveWorkingTimeEntitlement(i).checks).toEqual([]);
 });
 it('unknown rest yields blocked daily candidate unless named non-rest scenario is explicit',()=>{
  const i=singleDay();i.rest_window={state:'unknown',value:null,source:source()};expect(calculate(i)).toMatchObject({state:'blocked',expected:null});
  i.conditional_assumptions=[{decision_id:'wt.non_rest_scope',explanation:'Daily comparison only if this is an ordinary non-rest workday; weekly-rest entitlement remains unresolved.'}];
  expect(calculate(i)).toMatchObject({state:'calculated',counterfactual_only:true,expected:{minor_units:42000}});
  expect(resolveWorkingTimeEntitlement(i).missing.find(m=>m.fact_key==='wt.rest_window')?.customer_declaration_allowed).toBe(false);
 });
 it('customer factual declarations cannot masquerade as accepted applicability',()=>{
  const i=singleDay();i.applicability[0]={...i.applicability[0],basis:'customer_declaration'};expect(()=>calculate(i)).toThrow('WORKING_TIME_DECLARATION_NOT_APPLICABILITY');
 });
 it('expiry is evaluated as a timestamp and never satisfied by an old date string',()=>{
  const i=singleDay();i.applicability[0]={...i.applicability[0],valid_until:'2026-09-12T03:00:00+03:00'};expect(calculate(i)).toMatchObject({state:'blocked',expected:null});
 });
 it('does not infer holiday, missing rate, missing recorded pay or unsupported arrangement',()=>{
  const h=singleDay();h.workdays[0].kind=fact('holiday');expect(resolveWorkingTimeEntitlement(h).checks).toEqual([]);
  const wage=singleDay();wage.regular_hourly_wage=operand('wage',null,'money');expect(resolveWorkingTimeEntitlement(wage).checks).toEqual([]);
  const paid=singleDay();paid.workdays[0].recorded_pay=null;expect(resolveWorkingTimeEntitlement(paid).checks).toEqual([]);
  const arrangement=singleDay();arrangement.arrangement=fact('unsupported');expect(resolveWorkingTimeEntitlement(arrangement).checks).toEqual([]);
 });
});
describe('working time: source, date and historical safety',()=>{
 it('rejects changed duration, impossible dates and date-rollover guesses',()=>{
  const i=singleDay(true);i.workdays[0].intervals[0].end_at='2026-06-08T09:00:00+03:00';expect(()=>calculate(i)).toThrow('WORKING_TIME_CLOCK_DURATION_MISMATCH');
  i.workdays[0].intervals[0].end_at='2026-06-07T08:00:00+03:00';expect(()=>calculate(i)).toThrow('WORKING_TIME_CLOCK_DURATION_MISMATCH');
  i.workdays[0].intervals[0].end_at='2026-06-31T08:00:00+03:00';expect(()=>calculate(i)).toThrow('WORKING_TIME_CLOCK_DATE');
 });
 it('rejects duplicate/overlapping time, duplicate pay allocation, source edits and foreign case',()=>{
  const i=singleDay();i.workdays[0].intervals.push({...i.workdays[0].intervals[0],id:'another'});expect(()=>calculate(i)).toThrow('WORKING_TIME_DUPLICATE_INTERVAL_SOURCE');
  i.workdays[0].intervals[1]={...i.workdays[0].intervals[1],printed_duration:operand('another.duration','10:00'),clock_source:source('Cell another.duration')};expect(()=>calculate(i)).toThrow('WORKING_TIME_INTERVAL_OVERLAP');
  const pay=weekInput();pay.workdays[1].recorded_pay=pay.workdays[0].recorded_pay;expect(()=>resolveWorkingTimeEntitlement(pay)).toThrow('WORKING_TIME_DUPLICATE_PAYMENT_SOURCE');
  const foreign=singleDay();foreign.case_id='foreign.case';expect(()=>calculate(foreign)).toThrow('WORKING_TIME_SOURCE_BINDING');
 });
 it('keeps the research window explicit and does not rewrite existing candidate versions',()=>{
  const i=singleDay();i.period.from='2026-04-01';expect(()=>resolveWorkingTimeEntitlement(i)).toThrow('WORKING_TIME_RESEARCH_PERIOD');
  expect(WORKING_TIME_CATALOG).toMatchObject({catalog_version:'1.0.0',catalog_boundary:'real_inactive',human_attestation:null});
  expect(WORKING_TIME_SOURCE_REVIEW.sources.some(s=>s.acquisition==='third_party_judgment_copy_not_court_authenticated')).toBe(true);
 });
 it('supports the same bounded night rule in May while keeping January–April outside scope',()=>{
  const i=singleDay(true);i.period={from:'2026-05-01',to:'2026-05-31'};i.week_start='2026-05-03';i.workdays[0].date='2026-05-03';
  i.workdays[0].intervals[0].start_at='2026-05-03T22:00:00+03:00';i.workdays[0].intervals[0].end_at='2026-05-04T08:00:00+03:00';
  i.rest_window=fact({start_at:'2026-05-09T00:00:00+03:00',end_at:'2026-05-10T12:00:00+03:00'});
  expect(calculate(i)).toMatchObject({expected:{minor_units:44000}});
 });
 it('isolates partial-week fingerprints and excludes prior-day pay from weekly dependencies',()=>{
  const i=weekInput();i.workdays=i.workdays.slice(0,2);i.week_inventory=fact('partial');i.applicability=i.applicability.filter(d=>!d.decision_id.startsWith('wt.worked_time.')||['wt.worked_time.day.0','wt.worked_time.day.1'].includes(d.decision_id));
  const before=resolveWorkingTimeEntitlement(i);i.workdays[1].recorded_pay=operand('new.pay','500','money');
  const after=resolveWorkingTimeEntitlement(i);expect(after.checks[0]).toEqual(before.checks[0]);expect(after.checks[1]).not.toEqual(before.checks[1]);
  const full=weekInput(),prior=resolveWorkingTimeEntitlement(full);full.workdays[0].recorded_pay=operand('new.day0.pay','500','money');
  const next=resolveWorkingTimeEntitlement(full);expect(next.checks[5]).toEqual(prior.checks[5]);expect(next.checks[0]).not.toEqual(prior.checks[0]);
 });
 it('keeps identified classification answer source in normal calculation citations',()=>{
  const i=singleDay(),s={...source('Identified answer'),document_id:'answer.doc',version_id:'answer.rev1',file_sha256:'c'.repeat(64),reading:'customer_declaration' as const};
  i.source_manifest.push({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:1,kind:'customer_answer',case_id:i.case_id});
  i.workdays[0].intervals[0].classification={state:'declared',value:'required_presence',source:s};
  const r=calculate(i);expect(r).toMatchObject({state:'calculated',human_attestation:null});
  const input=documentReviewCalculationInputSchema.parse(resolveWorkingTimeEntitlement(i).checks[0].calculation);expect(input.source_manifest).toContainEqual(expect.objectContaining({document_id:'answer.doc',kind:'customer_answer'}));
 });
 it('fails a replayed night predicate if transformed night hours are edited below two',()=>{
  const result=resolveWorkingTimeEntitlement(singleDay(true));const parsed=documentReviewCalculationInputSchema.parse(result.checks[0].calculation);
  const night=parsed.operands.find(o=>o.observation_id.startsWith('working-time.night_minutes.'));if(!night)throw Error('night fact expected');night.printed_value='1:59';
  expect(calculateDocumentReview(parsed)).toMatchObject({state:'blocked',expected:null});
 });
 it.each(['conflict','stale','expired'] as const)('does not replace %s rest/daily-limit sources with a conditional default',state=>{
  const i=singleDay(true);i.workdays[0].ordinary_limit={...i.workdays[0].ordinary_limit,state};expect(resolveWorkingTimeEntitlement(i).checks).toEqual([]);
  const r=singleDay();r.rest_window={state,value:null,source:source()};expect(calculate(r)).toMatchObject({state:'blocked'});
  r.conditional_assumptions=[{decision_id:'wt.non_rest_scope',explanation:'Cannot turn adverse evidence into a missing-data assumption.'}];
  expect(()=>calculate(r)).toThrow('DOCUMENT_REVIEW_ASSUMPTION_NOT_UNRESOLVED_SOURCED_DECISION');
 });
});
