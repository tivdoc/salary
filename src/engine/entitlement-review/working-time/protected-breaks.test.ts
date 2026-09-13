import {expect,it} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview,replayDocumentReviewCalculation} from '../../document-review/calculations.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../../document-review/service.ts';
import {composeEntitlementReview} from '../compose.ts';
import {workingTimeProductReview} from '../working-time-product.ts';
import {singleDay,weekInput,source,operand,fact} from './working-time.fixture.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeEntitlementInput,type WorkingTimeWorkday} from './contracts.ts';
import {resolveWorkingTimeEntitlement} from './resolve.ts';
import {evaluateWorkingTimeCaseRecipe} from './product-decisions.ts';
import {enableWorkingTimeProtectedBreaks} from './product-facts.ts';
import {WORKING_TIME_PROTECTED_BREAK_POLICY,workingTimeBreakTarget,assertWorkingTimeBreakAnswer} from './protected-breaks.ts';
import {productFlowFixture,uuid,clause,literalRows} from './product-flow.fixture.ts';
import {workingTimeProductFactsV2Schema} from './product-fact-contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {applyAiReleaseDecisionRecipes} from '../../ai-release-decisions/apply.ts';

type Break=WorkingTimeWorkday['intervals'][number]['break_type'];
function split(input:WorkingTimeEntitlementInput,kind?:NonNullable<Break>['value'],night=false){
 const d=input.workdays[0],base=d.intervals[0];
 const row=(id:string,start:string,end:string,duration:string,classification:'worked'|'free_break')=>({...base,id,start_at:start,end_at:end,
  printed_duration:{...base.printed_duration,id,observation_id:'observation.'+id,printed_value:duration,source:{...base.clock_source,locator:id}},
  clock_source:{...base.clock_source,locator:id},classification:{...base.classification,value:classification}});
 d.intervals=night?[
  row('interval.before','2026-06-07T14:00:00+03:00','2026-06-07T22:00:00+03:00','8:00','worked'),
  row('interval.break','2026-06-07T22:00:00+03:00','2026-06-07T23:00:00+03:00','1:00','free_break'),
  row('interval.after','2026-06-07T23:00:00+03:00','2026-06-08T00:00:00+03:00','1:00','worked')]:[
  row('interval.before','2026-06-07T08:00:00+03:00','2026-06-07T12:00:00+03:00','4:00','worked'),
  row('interval.break','2026-06-07T12:00:00+03:00','2026-06-07T13:00:00+03:00','1:00','free_break'),
  row('interval.after','2026-06-07T13:00:00+03:00','2026-06-07T18:00:00+03:00','5:00','worked')];
 if(kind!==undefined)d.intervals[1].break_type={...base.classification,value:kind};return input;
}
function current(kind?:NonNullable<Break>['value'],night=false){return split({...singleDay(),protected_break_policy:WORKING_TIME_PROTECTED_BREAK_POLICY},kind,night);}
const calculate=(input:WorkingTimeEntitlementInput)=>calculateDocumentReview(resolveWorkingTimeEntitlement(input).checks[0].calculation);
const identified=(input:WorkingTimeEntitlementInput)=>workingTimeEntitlementInputSchema.parse(JSON.parse(JSON.stringify(input).replaceAll('"ai_document_review"','"identified_document_reading"')));
it('preserves historical free-break arithmetic and refuses a new break fact without an explicit policy',()=>{
 const old=split(singleDay()),before=canonicalSha256(old);expect(calculate(old)).toMatchObject({expected:{minor_units:37000}});
 expect(workingTimeEntitlementInputSchema.parse(old)).toEqual(old);expect(canonicalSha256(old)).toBe(before);
 old.workdays[0].intervals[1].break_type=fact('toilet');expect(()=>workingTimeEntitlementInputSchema.parse(old)).toThrow('WORKING_TIME_BREAK_POLICY_REQUIRED');
});
it('requires clarification of an old ambiguous free break only on the current policy',()=>{
 const input=current(),r=resolveWorkingTimeEntitlement(input);expect(r.checks).toEqual([]);
 expect(r.missing).toContainEqual(expect.objectContaining({input_path:'workdays.0.intervals.1.break_type',state:'missing',customer_declaration_allowed:true,dependent_check_ids:['working.synthetic.day.0']}));
 expect(evaluateWorkingTimeCaseRecipe('wt.worked_time.day.0',identified(input)).reason).toBe('protected_break_recipe_required');
 expect(evaluateWorkingTimeCaseRecipe('wt.worked_time.day.0',identified(split(singleDay())),{protected_breaks:true}).reason).toBe('protected_break_policy_not_selected');
});
it.each(['missing','unknown','unreadable','conflict','stale','expired'] as const)('keeps %s protected break unresolved without applying the presence assumption',state=>{
 const input=current();input.workdays[0].intervals[1].break_type={state,value:null,source:source()};input.mode='explicit_presence_scenario';input.conditional_assumptions=[{decision_id:'wt.worked_time.day.0',explanation:'Synthetic counterfactual cannot resolve protected break classification.'}];
 expect(resolveWorkingTimeEntitlement(input).checks).toEqual([]);expect(resolveWorkingTimeEntitlement(input).missing.some(m=>m.input_path.endsWith('.break_type')&&m.state===state)).toBe(true);
});
it.each([['toilet',42000],['ordinary_meal_or_rest',37000]] as const)('uses %s consistently for the expected amount, signed comparison and replay', (kind,expected)=>{
 const input=current(kind);expect(calculate(input)).toMatchObject({state:'calculated',expected:{minor_units:expected},difference:{minor_units:expected-40000}});
 input.workdays[0].recorded_pay=operand('paid.exact',String(expected/100),'money');expect(calculate(input)).toMatchObject({difference:{minor_units:0}});
 input.workdays[0].recorded_pay=operand('paid.more',String(expected/100+10),'money');const r=calculate(input);expect(r).toMatchObject({difference:{minor_units:-1000}});expect(replayDocumentReviewCalculation(r)).toEqual(r);
});
it('counts an agreed fifteen-minute refreshment break, while a short ordinary meal break requires separate assessment',()=>{
 const input=current('short_refreshment');input.workdays[0].intervals[1].end_at='2026-06-07T12:15:00+03:00';input.workdays[0].intervals[1].printed_duration.printed_value='0:15';input.workdays[0].intervals[2].start_at='2026-06-07T12:15:00+03:00';input.workdays[0].intervals[2].printed_duration.printed_value='5:45';
 expect(calculate(input)).toMatchObject({expected:{minor_units:42000}});input.workdays[0].intervals[1].break_type!.value='ordinary_meal_or_rest';
 const r=resolveWorkingTimeEntitlement(input);expect(r.checks).toEqual([]);expect(r.missing.some(m=>m.input_path.endsWith('.break_type')&&m.state==='unsupported'&&m.kind==='applicability')).toBe(true);
});
it('includes protected time in the two-hour night threshold and the exact weekly-rest overlap',()=>{
 const input=current('toilet',true);input.rest_window=fact({start_at:'2026-06-07T22:00:00+03:00',end_at:'2026-06-09T10:00:00+03:00'});
 // Ten hours: seven regular + two at125% + one at150% =440; two rest hours add40.
 expect(calculate(input)).toMatchObject({expected:{minor_units:48000}});
 input.workdays[0].intervals[1].break_type!.value='ordinary_meal_or_rest';
 // Nine eligible hours, only one after22:00: eight regular + one at125%, rest20.
 expect(calculate(input)).toMatchObject({expected:{minor_units:39000}});
});
it('keeps unrelated daily outputs when one day becomes unknown and does not silently complete the weekly prefix',()=>{
 const input=split({...weekInput(),protected_break_policy:WORKING_TIME_PROTECTED_BREAK_POLICY},'toilet');
 expect(resolveWorkingTimeEntitlement(input).allocation_receipt.weekly_inventory_complete).toBe(true);
 input.workdays[0].intervals[1].break_type={state:'unknown',value:null,source:source()};const r=resolveWorkingTimeEntitlement(input);
 expect(r.checks).toHaveLength(5);expect(r.checks.some(c=>c.check_id.endsWith('day.0'))).toBe(false);expect(r.allocation_receipt.weekly_inventory_complete).toBe(false);
 expect(calculateDocumentReview(r.checks[0].calculation)).toMatchObject({expected:{minor_units:42000}});
});
it('uses protected minutes in source-backed payroll allocation and rejects contradictory ordinary-break facts',()=>{
 const input=identified(current('toilet')),d=input.workdays[0];input.applicability=[];d.recorded_pay=null;
 d.payroll_allocations=[{id:'pay.full',hours:operand('pay.hours','10:00'),hourly_rate:input.regular_hourly_wage,percentage:null}];d.payroll_allocations[0].hours.source=input.regular_hourly_wage.source;
 expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input,{protected_breaks:true}).allowed).toBe(true);
 d.intervals[1].break_type!.value='ordinary_meal_or_rest';expect(evaluateWorkingTimeCaseRecipe('wt.payroll_allocation',input,{protected_breaks:true}).reason).toContain('conflict');
 d.intervals[1].classification.value='worked';expect(resolveWorkingTimeEntitlement(input).missing.some(m=>m.input_path.endsWith('.break_type')&&m.state==='conflict')).toBe(true);
});
it('composes one ordinary factual question, preserves answers/history, and rejects a borrowed interval or changed source clock',()=>{
 const f=productFlowFixture([...literalRows(),clause('משמרת אחת בתאריך 2026-06-07: 2026-06-07 08:00 עד 2026-06-07 12:00; 2026-06-07 12:00 עד 2026-06-07 13:00; 2026-06-07 13:00 עד 2026-06-07 18:00','assignment')]);f.identify();const w=enableWorkingTimeProtectedBreaks(split(f.input));
 const p=workingTimeProductFactsV2Schema.parse(w.product_facts),s=w.regular_hourly_wage.source;
 const known=<T>(value:T)=>({state:'observed' as const,value,source:s});
 Object.assign(p,{birth_date:known('1990-01-01'),employment_relationship:known('employee'),workplace_sector:known('private'),salary_basis:known('hourly'),
  job_duties:known('Synthetic packing under a supervisor'),occupation_group:known('ordinary'),company_policy_authority:known(false),employer_personal_proxy:known(false),hours_trackable:known(true),other_hours_terms_known:known(false)});w.product_facts=p;
 const raw=documentReviewInputSchema.parse({...f.review(),entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:w.case_id,order_id:f.review().purchased_scope.order_id,
  receipt_sha256:f.review().purchased_scope.receipt_sha256,period:w.period,working_time:[w]}}),sourceInput=composeEntitlementReview(raw);
 const path='workdays.0.intervals.1.break_type',target=workingTimeProductReview(sourceInput,[w]).answer_targets.find(t=>t.input_path===path)!;
 const question=runDocumentReview(sourceInput,'synthetic.break.question').completions.customer_requests.find(r=>r.target.fact_key===target.fact_key)!;
 expect(question.target.required_evidence_kind).toBe('customer_declaration');expect(question.target.options).toContain('שימוש בשירותים');
 const actor={case_id:w.case_id,identity_id:uuid(910)},answer={request_id:uuid(911),revision:1,answered_at:'2026-09-12T00:01:00Z',state:'provided' as const,value:'שימוש בשירותים'};
 const answered=applyDocumentReviewAnswer(sourceInput,{request:question,actor,answer}).input;
 const effective=(input:DocumentReviewInput)=>workingTimeEntitlementInputSchema.parse((input.entitlement_composition!.evidence.working_time as unknown[])[0]);
 const e=effective(answered);expect(e.workdays[0].intervals[1].break_type).toMatchObject({state:'declared',value:'toilet'});
 expect(evaluateWorkingTimeCaseRecipe('wt.worked_time.day.0',e,{review:answered,protected_breaks:true}).allowed).toBe(true);
 expect(runDocumentReview(answered,'synthetic.break.done').completions.customer_requests.some(q=>q.target.fact_key===target.fact_key)).toBe(false);
 const methods=['wt.coverage','wt.regular_wage','wt.arrangement','wt.workday_assignment','wt.payroll_allocation','wt.worked_time','wt.rounding'].map(id=>{
  const protectedConsumer=['wt.arrangement','wt.payroll_allocation','wt.worked_time'].includes(id);
  const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id===id&&(!protectedConsumer||r.recipe_id.endsWith('.protected-breaks-v1')))!;
  return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
   interpretation_receipt_sha256:canonicalSha256({synthetic_protected_break_method:r.recipe_id}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic_source:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
 });
 const applied=applyAiReleaseDecisionRecipes({source:answered,methods,at:'2026-09-12T12:00:00Z'});expect(applied.unresolved).toEqual([]);expect(applied.receipts).toHaveLength(7);
 expect(applied.receipts.filter(r=>r.recipe_id.endsWith('.protected-breaks-v1'))).toHaveLength(3);
 const result=runDocumentReview(applied.source,'synthetic.break.replay');expect(replayDocumentReview(result)).toEqual(result);
 expect(result.checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:42000});
 expect(result.checks.find(c=>!c.check_id.endsWith('.expected'))?.calculation.difference).toMatchObject({minor_units:2000});
 const corrected=applyDocumentReviewAnswer(applied.source,{request:question,actor,answer:{...answer,revision:2,state:'unknown',value:null}}).input;
 expect(corrected.answer_history).toHaveLength(2);expect(effective(corrected).workdays[0].intervals[1].break_type).toMatchObject({state:'unknown',value:null});
 expect(evaluateWorkingTimeCaseRecipe('wt.worked_time.day.0',effective(corrected),{review:corrected,protected_breaks:true}).allowed).toBe(false);
 expect(effective(corrected).applicability.find(d=>d.decision_id==='wt.worked_time.day.0')?.state).toBe('stale');
 expect(()=>evaluateWorkingTimeCaseRecipe('wt.worked_time.day.0',e,{review:corrected,protected_breaks:true})).toThrow('WT_CASE_CURRENT_DECLARATION');
 const moved=structuredClone(e);moved.workdays[0].intervals[1].clock_source.locator='Different source row';expect(workingTimeBreakTarget(answered,moved,path).fact_key).not.toBe(target.fact_key);
 expect(()=>assertWorkingTimeBreakAnswer(answered,moved,path,moved.workdays[0].intervals[1])).toThrow('WT_BREAK_ANSWER_TARGET');
},20000);
