import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../../document-review/contracts.ts';
import {calculateDocumentReview} from '../../document-review/calculations.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeEntitlementInput,type WorkingTimeWorkday} from './contracts.ts';
import {singleDay,weekInput} from './working-time.fixture.ts';
import {resolveWorkingTimeEntitlement} from './resolve.ts';
import {evaluateWorkingTimeCaseRecipe,workingTimeAssignmentIntervalSha256,workingTimeCaseConsumed,workingTimeProductFactsSchema,WORKING_TIME_COVERAGE_FACT_REQUIREMENTS,type WorkingTimeProductFacts} from './product-decisions.ts';

function identified(input:WorkingTimeEntitlementInput){return workingTimeEntitlementInputSchema.parse(JSON.parse(JSON.stringify(input).replaceAll('"ai_document_review"','"identified_document_reading"')));}
function fixture(night=false){const input=identified(singleDay(night));input.calculation_policy='working-time-separated-expected-v2';input.applicability=[];return input;}
function review(input:WorkingTimeEntitlementInput){const s=input.regular_hourly_wage.source;return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:input.case_id,period:input.period,purchased_scope:{order_id:'synthetic-order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics:['working_time','rest_day']},documents:[{case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:1,kind:'attendance',label:'Synthetic source only',period:input.period,reading_origin:'identified_document_reading',reading_sha256:s.reading_receipt_sha256}],checks:[],completion_input:{}});}
function wageFacts(input:WorkingTimeEntitlementInput):WorkingTimeProductFacts{return workingTimeProductFactsSchema.parse({schema_version:'working-time-product-facts-v1',regular_wage_basis:{state:'observed',value:{period:input.period,hourly_wage_operand_sha256:canonicalSha256(input.regular_hourly_wage),composition:'total_rate_including_all_regular_supplements'},source:input.regular_hourly_wage.source}});}
function segment(input:WorkingTimeEntitlementInput,id:string,start:string,end:string,duration:string,classification:WorkingTimeWorkday['intervals'][number]['classification']['value']='worked'){
 const original=input.workdays[0].intervals[0],source={...original.clock_source,locator:'Synthetic cell '+id};return {...structuredClone(original),id,start_at:start,end_at:end,clock_source:source,printed_duration:{...original.printed_duration,id:'duration.'+id,observation_id:'observation.'+id,printed_value:duration,source},classification:{...original.classification,value:classification}};
}
function split(input:WorkingTimeEntitlementInput){input.workdays[0].intervals=[segment(input,'segment.first','2026-06-07T08:00:00+03:00','2026-06-07T12:00:00+03:00','4:00'),segment(input,'segment.second','2026-06-07T12:00:00+03:00','2026-06-07T18:00:00+03:00','6:00')];}
function assignment(input:WorkingTimeEntitlementInput){return workingTimeProductFactsSchema.parse({schema_version:'working-time-product-facts-v1',assignment_witnesses:[{day_id:input.workdays[0].id,fact:{state:'observed',value:{assigned_date:input.workdays[0].date,assignment:'same_workday',intervals:input.workdays[0].intervals.map(interval=>({interval_id:interval.id,source_interval_sha256:workingTimeAssignmentIntervalSha256(interval)}))},source:input.workdays[0].intervals[0].clock_source}}]});}
function declaration(input:WorkingTimeEntitlementInput){const source={...input.regular_hourly_wage.source,document_id:'synthetic.answer',version_id:'synthetic.answer.v1',reading:'customer_declaration' as const};input.source_manifest.push({document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,case_id:input.case_id,kind:'customer_answer'});return source;}
const worked='wt.worked_time.day.0';

describe('working-time case evidence predicates',()=>{
 it.each(['wt.workday_assignment','wt.arrangement','wt.regular_wage','wt.payroll_allocation',worked])('allows identified bounded evidence for %s without changing inputs or granting authority',id=>{
  const input=fixture(),facts=wageFacts(input),before=canonicalSha256({input,facts}),r=evaluateWorkingTimeCaseRecipe(id,input,{review:review(input),product_facts:facts});
  expect(r).toMatchObject({allowed:true,reason:null,missing:[],publication_authority:false});expect(r.source_sha256s.length).toBeGreaterThan(0);
  expect(r.consumed_sha256).toBe(canonicalSha256(workingTimeCaseConsumed(input,r.consumed_paths,facts)));expect(canonicalSha256({input,facts})).toBe(before);expect(input.applicability).toEqual([]);
 });
 it('keeps expected readiness independent of recorded payment and binds only comparison to allocation',()=>{
  const input=fixture(),facts=wageFacts(input),ids=['wt.arrangement','wt.regular_wage',worked],before=ids.map(id=>evaluateWorkingTimeCaseRecipe(id,input,{product_facts:facts}));input.workdays[0].recorded_pay=null;input.workdays[0].payment_allocation={state:'missing',value:null,source:null};
  expect(ids.map(id=>evaluateWorkingTimeCaseRecipe(id,input,{product_facts:facts}))).toEqual(before);
  expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input)).toMatchObject({allowed:false,dependent_check_ids:['working.synthetic.day.0']});expect(before[0].dependent_check_ids).toEqual(['working.synthetic.day.0.expected','working.synthetic.day.0']);
  delete input.calculation_policy;expect(evaluateWorkingTimeCaseRecipe(worked,input).dependent_check_ids).toEqual(['working.synthetic.day.0']);
 });
 it.each(['missing','unknown','conflict','stale','expired','unreadable'] as const)('keeps %s classification unresolved, including a named presence scenario',state=>{
  const input=fixture();input.workdays[0].intervals[0].classification={state,value:null,source:null};input.mode='explicit_presence_scenario';input.conditional_assumptions=[{decision_id:worked,explanation:'Synthetic explicit counterfactual only'}];
  expect(evaluateWorkingTimeCaseRecipe(worked,input)).toMatchObject({allowed:false,reason:'workdays.0.intervals.0.classification:'+state});
 });
 it('accepts an identified factual break declaration as a declaration, not a source reading or legal decision',()=>{
  const input=fixture();split(input);const s=declaration(input);input.workdays[0].intervals[0].classification={state:'declared',value:'free_break',source:s};
  expect(evaluateWorkingTimeCaseRecipe(worked,input).allowed).toBe(true);expect(input.workdays[0].intervals[0].classification.state).toBe('declared');input.workdays[0].intervals[0].classification.state='observed';expect(evaluateWorkingTimeCaseRecipe(worked,input).allowed).toBe(false);
 });
 it('does not promote provider confidence or a declaration of the numeric clock into an identified clock',()=>{
  const input=fixture();input.workdays[0].intervals[0].clock_source.reading='provider_extraction';expect(evaluateWorkingTimeCaseRecipe(worked,input).allowed).toBe(false);
  input.workdays[0].intervals[0].clock_source.reading='identified_document_reading';input.workdays[0].intervals[0].printed_duration.state='declared';expect(evaluateWorkingTimeCaseRecipe(worked,input).allowed).toBe(false);
 });
 it('requires complete dated day inventory without requiring a complete week',()=>{
  const input=fixture();expect(input.week_inventory.value).toBe('partial');expect(evaluateWorkingTimeCaseRecipe(worked,input).allowed).toBe(true);input.workdays[0].inventory.value='incomplete';const r=evaluateWorkingTimeCaseRecipe(worked,input);expect(r.allowed).toBe(false);expect(r.reason).toContain('inventory:incomplete');
 });
 it('does not turn all free breaks or an explicit no-work day into paid time or a zero payment',()=>{
  const input=fixture();input.workdays[0].intervals[0].classification.value='free_break';expect(evaluateWorkingTimeCaseRecipe(worked,input).reason).toContain('no_work_not_paid_time');input.workdays[0].inventory.value='no_work';expect(evaluateWorkingTimeCaseRecipe(worked,input).reason).toContain('conflict');input.workdays[0].intervals=[];expect(evaluateWorkingTimeCaseRecipe(worked,input).reason).toContain('no_work_not_paid_time');
 });
 it('isolates a per-day worked-time fingerprint from other days, payment, and unused legal answers',()=>{
  const input=identified(weekInput()),before=evaluateWorkingTimeCaseRecipe(worked,input);input.workdays[1].intervals[0].classification.value='required_presence';input.workdays[1].recorded_pay!.printed_value='999.99';input.workdays[0].recorded_pay!.printed_value='0';input.applicability=[];
  expect(evaluateWorkingTimeCaseRecipe(worked,input)).toEqual(before);input.workdays[0].intervals[0].classification.value='required_presence';expect(evaluateWorkingTimeCaseRecipe(worked,input).consumed_sha256).not.toBe(before.consumed_sha256);
 });
 it('allows day-scoped assignment and arrangement when an independent day is incomplete',()=>{
  const input=identified(weekInput()),ids=['wt.workday_assignment','wt.arrangement'],before=ids.map(id=>evaluateWorkingTimeCaseRecipe(id,input,{day_id:'day.0'}));input.workdays[1].inventory={state:'unknown',value:null,source:null};
  expect(ids.map(id=>evaluateWorkingTimeCaseRecipe(id,input,{day_id:'day.0'}))).toEqual(before);expect(ids.map(id=>evaluateWorkingTimeCaseRecipe(id,input).allowed)).toEqual([false,false]);
 });
 it('rejects duplicate and overlapping source intervals without counting them twice',()=>{
  const input=fixture();input.workdays[0].intervals.push(structuredClone(input.workdays[0].intervals[0]));expect(evaluateWorkingTimeCaseRecipe(worked,input).reason).toContain('conflict');
  input.workdays[0].intervals[1]=segment(input,'segment.overlap','2026-06-07T17:00:00+03:00','2026-06-07T18:00:00+03:00','1:00');expect(evaluateWorkingTimeCaseRecipe(worked,input).reason).toContain('conflict');
 });
 it('uses the existing reader to reject a clock-duration mismatch and an invented midnight rollover',()=>{
  const input=fixture(true);input.workdays[0].intervals[0].printed_duration.printed_value='9:59';expect(()=>evaluateWorkingTimeCaseRecipe(worked,input)).toThrow('WORKING_TIME_CLOCK_DURATION_MISMATCH');input.workdays[0].intervals[0].printed_duration.printed_value='10:00';input.workdays[0].intervals[0].end_at='2026-06-07T08:00:00+03:00';expect(()=>evaluateWorkingTimeCaseRecipe(worked,input)).toThrow('WORKING_TIME_CLOCK_DURATION_MISMATCH');
 });
 it('accepts an explicit cross-midnight source interval, with night readiness independent of missing ordinary limit',()=>{
  const input=fixture(true);input.workdays[0].ordinary_limit.state='missing';input.workdays[0].ordinary_limit.printed_value=null;
  expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input).allowed).toBe(true);expect(evaluateWorkingTimeCaseRecipe(worked,input).allowed).toBe(true);expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',input).allowed).toBe(true);
 });
 it('does not count a free break towards the two-hour night condition',()=>{
  const input=fixture();input.workdays[0].intervals=[segment(input,'segment.work','2026-06-07T20:00:00+03:00','2026-06-07T22:00:00+03:00','2:00'),segment(input,'segment.break','2026-06-07T22:00:00+03:00','2026-06-08T00:00:00+03:00','2:00','free_break')];input.workdays[0].ordinary_limit.state='missing';input.workdays[0].ordinary_limit.printed_value=null;
  expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',input)).toMatchObject({allowed:false,reason:'workdays.0.ordinary_limit:missing'});
 });
 it('requires a separate source association for multiple intervals instead of merging shifts by their short break',()=>{
  const input=fixture();split(input);const missing=evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input);expect(missing).toMatchObject({allowed:false,producer_gaps:['identified_workday_assignment_association']});const facts=assignment(input);expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input,{product_facts:facts}).allowed).toBe(true);
  facts.assignment_witnesses![0].fact.value!.assignment='separate_workdays';expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input,{product_facts:facts}).reason).toContain('conflict');
 });
 it('binds the assignment witness to every ordered source interval and preserves classification independence',()=>{
  const input=fixture();split(input);const facts=assignment(input),before=evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input,{product_facts:facts});input.workdays[0].intervals[0].classification.value='free_break';expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input,{product_facts:facts})).toEqual(before);
  input.workdays[0].intervals[0].clock_source.locator+=' corrected';expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input,{product_facts:facts}).reason).toContain('conflict');
 });
 it.each(['missing_interval','wrong_date','duplicate_witness','declaration'] as const)('rejects %s in assignment evidence',kind=>{
  const input=fixture();split(input);const facts=assignment(input),w=facts.assignment_witnesses![0];if(kind==='missing_interval')w.fact.value!.intervals.pop();if(kind==='wrong_date')w.fact.value!.assigned_date='2026-06-08';if(kind==='duplicate_witness')facts.assignment_witnesses!.push(structuredClone(w));if(kind==='declaration'){w.fact.state='declared';w.fact.source=declaration(input);}expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment',input,{product_facts:facts}).allowed).toBe(false);
 });
 it('cannot infer a five-day daily limit from 42 divided by five or treat a night conflict as missing',()=>{
  const input=fixture();input.arrangement.value='adult_hourly_five_day_42';input.scheduled_weekdays.value=[0,1,2,3,4];input.workdays[0].ordinary_limit.state='missing';input.workdays[0].ordinary_limit.printed_value=null;expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',input).allowed).toBe(false);
  const night=fixture(true);night.workdays[0].ordinary_limit.state='conflict';expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',night).reason).toContain('conflict');
 });
 it('rejects unsupported arrangement, duplicate schedule days, and an ordinary limit outside its bounded arrangement',()=>{
  const input=fixture();input.arrangement.value='unsupported';expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',input).allowed).toBe(false);input.arrangement.value='adult_hourly_six_day_42';input.scheduled_weekdays.value=[0,0,1,2,3,4];expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',input).reason).toContain('conflict');input.scheduled_weekdays.value=[0,1,2,3,4,5];input.workdays[0].ordinary_limit.printed_value='12:00';expect(evaluateWorkingTimeCaseRecipe('wt.arrangement',input).reason).toContain('unsupported');
 });
 it('requires identified composition rather than declaring that any printed base rate is the regular wage',()=>{
  const input=fixture();expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',input)).toMatchObject({allowed:false,producer_gaps:['identified_regular_wage_basis_association']});const facts=wageFacts(input);facts.regular_wage_basis!.value!.composition='base_rate_only';expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',input,{product_facts:facts}).reason).toContain('incomplete_composition');
  facts.regular_wage_basis!.value!.composition='single_rate_no_regular_supplements';facts.regular_wage_basis!.state='declared';facts.regular_wage_basis!.source=declaration(input);expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',input,{product_facts:facts}).allowed).toBe(false);
 });
 it.each(['period','operand','zero'] as const)('rejects a %s mismatch in exact regular-wage basis',kind=>{
  const input=fixture(),facts=wageFacts(input);if(kind==='period')facts.regular_wage_basis!.value!.period.to='2026-06-29';if(kind==='operand')input.regular_hourly_wage.printed_value='40.01';if(kind==='zero')input.regular_hourly_wage.printed_value='0';expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',input,{product_facts:facts}).allowed).toBe(false);
 });
 it('preserves an explicit identified allocated zero without replacing a missing row with zero',()=>{
  const input=fixture();input.workdays[0].recorded_pay!.printed_value='0.00';expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).allowed).toBe(true);input.workdays[0].recorded_pay=null;expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).reason).toBe('workdays.0.recorded_pay:missing');
 });
 it.each(['partial','declared','other_page'] as const)('rejects %s payment-allocation evidence',kind=>{
  const input=fixture();if(kind==='partial')input.workdays[0].payment_allocation.value='partial';if(kind==='declared'){input.workdays[0].payment_allocation.state='declared';input.workdays[0].payment_allocation.source=declaration(input);}if(kind==='other_page'){input.source_manifest[0].page_count=2;input.workdays[0].payment_allocation.source!.page=2;}expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).allowed).toBe(false);
 });
 it('supports complete recorded-payment bands but rejects excess hours, premium-only payment and duplicate quantities',()=>{
  const input=fixture(),day=input.workdays[0];day.recorded_pay=null;day.payroll_allocations=[{id:'band.full',hours:{...day.intervals[0].printed_duration,id:'paid.hours',observation_id:'paid.hours'},hourly_rate:input.regular_hourly_wage,percentage:null}];
  expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).allowed).toBe(true);day.payroll_allocations[0].hours.printed_value='11:00';expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).reason).toContain('conflict');day.payroll_allocations[0].hours.printed_value='10:00';day.payroll_allocations[0].percentage={...input.regular_hourly_wage,id:'paid.percentage',observation_id:'paid.percentage',printed_value:'25',representation:'percent',quantity_unit:'ratio'};expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).reason).toContain('premium_only');day.payroll_allocations[0].percentage=null;day.payroll_allocations.push({...structuredClone(day.payroll_allocations[0]),id:'band.duplicate'});expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).reason).toContain('conflict');
 });
 it('allows fewer paid hours only with complete identified inventory and exposes the shortfall through the ordinary executor',()=>{
  const input=fixture(),day=input.workdays[0];input.applicability=identified(singleDay()).applicability;day.recorded_pay=null;day.payroll_allocations=[{id:'band.documented',hours:{...day.intervals[0].printed_duration,id:'paid.hours',observation_id:'paid.hours',printed_value:'9:00'},hourly_rate:input.regular_hourly_wage,percentage:null}];
  expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).allowed).toBe(true);
  const comparison=resolveWorkingTimeEntitlement(input).checks.find(c=>c.check_id==='working.synthetic.day.0')!;
  // Independent oracle: 8*40 + 2*50 = 420 required; 9*40 = 360 recorded.
  expect(calculateDocumentReview(comparison.calculation)).toMatchObject({state:'calculated',expected:{minor_units:42000},recorded:{minor_units:36000},difference:{minor_units:6000}});
  day.payment_allocation.value='partial';expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).allowed).toBe(false);
 });
 it('refuses one payment observation allocated to two days',()=>{
  const input=identified(weekInput());input.workdays=input.workdays.slice(0,2);input.workdays[1].recorded_pay=structuredClone(input.workdays[0].recorded_pay);expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input).reason).toContain('conflict');
 });
 it('changes a dependent fingerprint on an identified source correction and rejects stale current-document pins',()=>{
  const input=fixture(),current=review(input),before=evaluateWorkingTimeCaseRecipe(worked,input,{review:current});const s=input.workdays[0].intervals[0];s.clock_source.reading_receipt_sha256='c'.repeat(64);s.printed_duration.source.reading_receipt_sha256='c'.repeat(64);
  expect(()=>evaluateWorkingTimeCaseRecipe(worked,input,{review:current})).toThrow('WT_CASE_CURRENT_SOURCE');current.documents[0].accepted_reading_sha256=['c'.repeat(64)];expect(evaluateWorkingTimeCaseRecipe(worked,input,{review:current}).consumed_sha256).not.toBe(before.consumed_sha256);
 });
 it.each(['foreign_case','foreign_file','duplicate_manifest','questionnaire_disguise'] as const)('rejects %s without weakening source trust',kind=>{
  const input=fixture();if(kind==='foreign_case')input.source_manifest[0].case_id='foreign';if(kind==='foreign_file')input.workdays[0].intervals[0].classification.source!.file_sha256='d'.repeat(64);if(kind==='duplicate_manifest')input.source_manifest.push(structuredClone(input.source_manifest[0]));if(kind==='questionnaire_disguise')input.workdays[0].intervals[0].classification.source!.reading='questionnaire_declaration';expect(()=>evaluateWorkingTimeCaseRecipe(worked,input)).toThrow();
 });
 it('keeps unsupported dates and coverage facts separate from a completed scheduling packet',()=>{
  const input=fixture();input.period.from='2026-04-01';expect(evaluateWorkingTimeCaseRecipe(worked,input).reason).toBe('unsupported_source_period');input.period.from='2026-06-01';const r=evaluateWorkingTimeCaseRecipe('wt.coverage',input);expect(r).toMatchObject({allowed:false,producer_gaps:['working_time_coverage_facts_and_assessment'],publication_authority:false});expect(WORKING_TIME_COVERAGE_FACT_REQUIREMENTS.map(f=>f.fact_key)).toContain('hours_tracking');expect(WORKING_TIME_COVERAGE_FACT_REQUIREMENTS.every(f=>!f.question.includes('סעיף 30'))).toBe(true);
 });
 it('does not silently accept an unknown recipe or mismatched dynamic day selection',()=>{
  const input=fixture();expect(evaluateWorkingTimeCaseRecipe('wt.unimplemented',input).allowed).toBe(false);expect(()=>evaluateWorkingTimeCaseRecipe(worked,input,{day_id:'day.1'})).toThrow('WT_CASE_DAY_BINDING');expect(evaluateWorkingTimeCaseRecipe('wt.worked_time.day.9',input).allowed).toBe(false);
 });
});
