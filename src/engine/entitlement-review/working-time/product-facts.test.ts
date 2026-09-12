import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../../document-review/service.ts';
import {composeEntitlementReview} from '../compose.ts';
import {enableTypedEntitlementPersonalFacts} from '../typed-product-facts.ts';
import {workingTimeProductReview} from '../working-time-product.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeEntitlementInput} from './contracts.ts';
import {workingTimeProductFactsV2Schema} from './product-fact-contracts.ts';
import {evaluateWorkingTimeCaseRecipe} from './product-decisions.ts';
import {materializeWorkingTimeProductFacts,workingTimeProductFactKey,workingTimeProductFactQuestions,assertWorkingTimeRestDerivation} from './product-facts.ts';
import {attachWorkingTimeSourceFacts} from './source-facts.ts';
import {productFlowFixture,uuid,literalRows} from './product-flow.fixture.ts';
import {singleDay} from './working-time.fixture.ts';
import {parseReviewCompletionInput} from '../../document-review/completions.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {applyAiReleaseDecisionRecipes} from '../../ai-release-decisions/apply.ts';
import {workingTimeCaseBinding,replayWorkingTimeProductFacts} from './product-facts.ts';
import {workingTimeCaseConsumed} from './product-decisions.ts';

function sourcePacket(input:DocumentReviewInput,weeks:WorkingTimeEntitlementInput[]){return documentReviewInputSchema.parse({...input,entitlement_evidence:enableTypedEntitlementPersonalFacts({schema_version:'entitlement-source-evidence-v1',case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,working_time:weeks},{working_time:true})});}
const effective=(input:DocumentReviewInput,index=0)=>workingTimeEntitlementInputSchema.parse((input.entitlement_composition!.evidence.working_time as unknown[])[index]);
function answerFact(input:DocumentReviewInput,path:string,value:string|number|boolean|null,revision=1){
 const raw=workingTimeEntitlementInputSchema.parse((input.entitlement_evidence!.working_time as unknown[])[0]);
 const result=runDocumentReview(input,'synthetic.working.answers'),key=workingTimeProductFactKey(input,raw,path);
 const current=result.completions.customer_requests.find(r=>r.target.fact_key===key),old=input.answer_history.find(h=>h.request.target.fact_key===key),request=current??old?.request;
 if(!request)throw Error('Synthetic request missing '+path);
 const label=request.target.value_mapping?.entries.find(e=>e.value===value)?.label??value;
 const answer={request_id:old?.receipt.request_id??uuid(500+input.answer_history.length),revision,answered_at:'2026-09-12T00:01:00Z',state:value===null?'unknown' as const:'provided' as const,value:value===null?null:label};
 return applyDocumentReviewAnswer(input,{request,actor:{case_id:input.case_id,identity_id:uuid(990)},answer}).input;
}
function ordinaryCoverage(input:WorkingTimeEntitlementInput){
 const p=workingTimeProductFactsV2Schema.parse(input.product_facts),source=input.regular_hourly_wage.source;
 const f=<T>(value:T)=>({state:'observed' as const,value,source});
 p.birth_date=f('1990-01-01');p.employment_relationship=f('employee');p.workplace_sector=f('private');p.salary_basis=f('hourly');p.job_duties=f('Synthetic packing work under a supervisor');p.occupation_group=f('ordinary');p.company_policy_authority=f(false);p.employer_personal_proxy=f(false);p.hours_trackable=f(true);p.other_hours_terms_known=f(false);input.product_facts=p;return p;
}
const caseIds=['wt.coverage','wt.regular_wage','wt.arrangement','wt.workday_assignment','wt.payroll_allocation','wt.worked_time'];
function method(id:string){const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id===id)!;return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,interpretation_receipt_sha256:canonicalSha256({synthetic_working_method:id}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic_source:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
const applyMethods=(source:DocumentReviewInput,ids=[...caseIds,'wt.rounding'])=>applyAiReleaseDecisionRecipes({source,methods:ids.map(method),at:'2026-09-12T12:00:00Z'});
describe('working-time ordinary factual answers and materialization',()=>{
 it('keeps historical packets exact and only adds typed facts on explicit opt-in',()=>{
  const old=singleDay(),hash=canonicalSha256(old),f=productFlowFixture(),review=sourcePacket(f.review(),[old]);
  expect(workingTimeEntitlementInputSchema.parse(old)).toEqual(old);expect(canonicalSha256(old)).toBe(hash);
  expect(workingTimeEntitlementInputSchema.parse((review.entitlement_evidence!.working_time as unknown[])[0]).product_facts?.schema_version).toBe('working-time-product-facts-v2');
 });
 it('allows bounded private employee facts but never turns them into an applicability decision',()=>{
  const f=productFlowFixture();ordinaryCoverage(f.input);const r=evaluateWorkingTimeCaseRecipe('wt.coverage',f.input,{review:f.review()});expect(r.allowed).toBe(true);expect(r.publication_authority).toBe(false);expect(f.input.applicability).toEqual([]);
 });
 it.each([
  ['2006-06-01','outside_release_population_21_59'],['2005-06-15','outside_release_population_21_59'],['1966-06-30','outside_release_population_21_59'],['2010-01-01','minor_population'],
 ])('distinguishes statutory adult and frozen full-period 21–59 population: %s',(birth,reason)=>{
  const f=productFlowFixture(),p=ordinaryCoverage(f.input);p.birth_date.value=birth;expect(evaluateWorkingTimeCaseRecipe('wt.coverage',f.input).reason).toContain(reason);
 });
 it.each(['police_prison','live_in_care','other'] as const)('holds special occupation %s for a separate assessment',occupation=>{
  const f=productFlowFixture(),p=ordinaryCoverage(f.input);p.occupation_group.value=occupation;expect(evaluateWorkingTimeCaseRecipe('wt.coverage',f.input).reason).toContain('special_occupation');
 });
 it('keeps duties, tracking and authority facts material and binds only consumed fields',()=>{
  const f=productFlowFixture(),p=ordinaryCoverage(f.input),before=evaluateWorkingTimeCaseRecipe('wt.coverage',f.input);p.rest_start_time.value='14:00';expect(evaluateWorkingTimeCaseRecipe('wt.coverage',f.input)).toEqual(before);
  p.hours_trackable.value=false;expect(evaluateWorkingTimeCaseRecipe('wt.coverage',f.input).reason).toContain('tracking');p.hours_trackable.value=true;p.company_policy_authority.value=true;expect(evaluateWorkingTimeCaseRecipe('wt.coverage',f.input).reason).toContain('responsibilities');p.company_policy_authority.value=false;p.job_duties={state:'unknown',value:null,source:null};expect(evaluateWorkingTimeCaseRecipe('wt.coverage',f.input).reason).toContain('job_duties:unknown');
 });
 it('takes four exact ordinary answers into a declared +03:00 window with unchanged source facts',()=>{
  const f=productFlowFixture();f.identify();const w=attachWorkingTimeSourceFacts(f.input,f.review()).input;w.rest_window={state:'missing',value:null,source:null};
  let input=composeEntitlementReview(sourcePacket(f.review(),[w]));const original=canonicalSha256(input.entitlement_evidence);
  for(const [key,value]of [['rest_start_date','2026-06-12'],['rest_start_time','16:00'],['rest_end_date','2026-06-14'],['rest_end_time','04:00']])input=answerFact(input,'product_facts.'+key,value);
  const r=runDocumentReview(input,'synthetic.rest.answered'),e=effective(r.input);
  expect(e.rest_window).toMatchObject({state:'declared',value:{start_at:'2026-06-12T16:00:00+03:00',end_at:'2026-06-14T04:00:00+03:00'},source:{reading:'customer_declaration'}});
  expect(assertWorkingTimeRestDerivation(e,e.rest_window)).toBe(true);expect(canonicalSha256(r.input.entitlement_evidence)).toBe(original);expect(r.input.answer_history).toHaveLength(4);expect(replayDocumentReview(r)).toEqual(r);
  const changed=answerFact(input,'product_facts.rest_end_time',null,2),unknown=effective(runDocumentReview(changed,'synthetic.rest.unknown').input);expect(unknown.rest_window).toMatchObject({state:'unknown',value:null});expect(changed.answer_history).toHaveLength(5);
 });
 it.each(['25:00','9:00','09:61','09:00:00'])('rejects malformed clock %s before a receipt can enter the engine',clock=>{
  const f=productFlowFixture();f.input.rest_window={state:'missing',value:null,source:null};const input=composeEntitlementReview(sourcePacket(f.review(),[f.input]));expect(()=>answerFact(input,'product_facts.rest_start_time',clock)).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');
 });
 it.each(['unknown','unreadable','stale','expired','conflict'] as const)('preserves %s rest parts without converting them to a fresh missing answer',state=>{
  const f=productFlowFixture();f.input.rest_window={state:'missing',value:null,source:null};const p=workingTimeProductFactsV2Schema.parse(f.input.product_facts);p.rest_end_time={state,value:null,source:null};f.input.product_facts=p;
  expect(materializeWorkingTimeProductFacts(f.input).rest_window.state).toBe(state);
 });
 it('never overwrites an adverse independent source rest window with unanswered personal facts',()=>{
  const f=productFlowFixture();f.input.rest_window={state:'conflict',value:null,source:f.input.regular_hourly_wage.source};expect(materializeWorkingTimeProductFacts(f.input).rest_window).toEqual(f.input.rest_window);
 });
 it('fans one personal answer into two ordinary week packets and retains both dependencies',()=>{
  const f=productFlowFixture(),second=structuredClone(f.input);second.check_id_prefix='working.second';second.week_start='2026-06-14';second.workdays[0].date='2026-06-14';second.workdays[0].intervals[0].start_at='2026-06-14T08:00:00+03:00';second.workdays[0].intervals[0].end_at='2026-06-14T18:00:00+03:00';
  const original=sourcePacket(f.review(),[f.input,second]),branch=workingTimeProductReview(original,[f.input,second]),key=workingTimeProductFactKey(original,f.input,'product_facts.birth_date');
  expect(branch.needs.filter(n=>n.fact_key===key)).toHaveLength(1);expect(branch.answer_targets.filter(t=>t.fact_key===key).map(t=>t.index)).toEqual([0,1]);
  const input=answerFact(composeEntitlementReview(original),'product_facts.birth_date','1990-01-01'),result=runDocumentReview(input,'synthetic.two.weeks');
  expect(effective(result.input,0).product_facts).toMatchObject({birth_date:{state:'declared',value:'1990-01-01'}});expect(effective(result.input,1).product_facts).toMatchObject({birth_date:{state:'declared',value:'1990-01-01'}});expect(input.answer_history).toHaveLength(1);
 });
 it('resumes source association through the ordinary temporal answer without writing it into original evidence',()=>{
  const f=productFlowFixture(literalRows().filter(o=>!['effective_from','effective_to'].includes(o.semantic)));f.identify();const w=attachWorkingTimeSourceFacts(f.input,f.review()).input;
  const before=composeEntitlementReview(sourcePacket(f.review(),[w])),changed=answerFact(before,'product_facts.contract_terms_current',true),result=runDocumentReview(changed,'synthetic.contract.current');
  expect(effective(result.input).product_facts?.regular_wage_basis?.state).toBe('observed');expect((workingTimeEntitlementInputSchema.parse((result.input.entitlement_evidence!.working_time as unknown[])[0])).product_facts?.regular_wage_basis?.state).toBe('missing');
  expect(effective(result.input).applicability).toEqual([]);expect(workingTimeProductFactQuestions(f.input,f.review()).every(q=>!q.question.includes('סעיף 30'))).toBe(true);
 });
 it('allows the bounded expanded decision inventory only for opted-in packets',()=>{
  const old=singleDay(),one=old.applicability[0];old.applicability=Array.from({length:33},(_,i)=>({...one,decision_id:'synthetic.decision.'+i}));expect(()=>workingTimeEntitlementInputSchema.parse(old)).toThrow('WORKING_TIME_LEGACY_DECISION_LIMIT');
  const f=productFlowFixture();f.input.applicability=old.applicability;expect(workingTimeEntitlementInputSchema.parse(f.input).applicability).toHaveLength(33);
 });
 it('takes actual factual answers through catalog decisions and the existing expected and comparison RuleSpecs',()=>{
  const f=productFlowFixture();f.identify();const w=attachWorkingTimeSourceFacts(f.input,f.review()).input;
  let source=composeEntitlementReview(sourcePacket(f.review(),[w]));
  for(const [path,value]of Object.entries({birth_date:'1990-01-01',employment_relationship:'employee',workplace_sector:'private',salary_basis:'hourly',job_duties:'Synthetic packing work with no authority to bind the employer',occupation_group:'ordinary',company_policy_authority:false,employer_personal_proxy:false,hours_trackable:true,other_hours_terms_known:false}))source=answerFact(source,'product_facts.'+path,value);
  const history=canonicalSha256(source.answer_history),applied=applyMethods(source),result=runDocumentReview(applied.source,'synthetic.working.rules'),e=effective(result.input);
  expect(applied.unresolved).toEqual([]);expect(applied.receipts).toHaveLength(7);expect(result.checks).toHaveLength(2);
  expect(result.checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:42000});
  expect(result.checks.find(c=>!c.check_id.endsWith('.expected'))?.calculation.difference).toMatchObject({minor_units:2000});
  expect(e.product_facts).toMatchObject({birth_date:{state:'declared',value:'1990-01-01'}});expect(canonicalSha256(applied.source.answer_history)).toBe(history);expect(replayDocumentReview(result)).toEqual(result);
  for(const receipt of applied.receipts.filter(r=>r.recipe_id.startsWith('ai-case.wt.')))expect(receipt.consumed).toEqual(workingTimeCaseConsumed(e,evaluateWorkingTimeCaseRecipe(receipt.decision_id,e).consumed_paths));
 },20000);
 it.each([['360.00',6000],['420.00',0],['450.00',-3000]] as const)('preserves independent expected 420 versus identified full payment inventory %s',(paid,difference)=>{
  const f=productFlowFixture();f.identify();ordinaryCoverage(f.input);f.input.workdays[0].recorded_pay!.printed_value=paid;
  const w=attachWorkingTimeSourceFacts(f.input,f.review()).input,applied=applyMethods(sourcePacket(f.review(),[w])),r=runDocumentReview(applied.source,'synthetic.working.oracle');
  expect(applied.unresolved).toEqual([]);expect(r.checks.find(c=>!c.check_id.endsWith('.expected'))?.calculation).toMatchObject({state:'calculated',expected:{minor_units:42000},difference:{minor_units:difference}});
 });
 it('keeps expected RuleSpec calculation after payment disappears and never assumes payment zero',()=>{
  const f=productFlowFixture();f.identify();ordinaryCoverage(f.input);f.input.workdays[0].recorded_pay=null;f.input.workdays[0].payment_allocation={state:'missing',value:null,source:null};
  const w=attachWorkingTimeSourceFacts(f.input,f.review()).input,a=applyMethods(sourcePacket(f.review(),[w])),r=runDocumentReview(a.source,'synthetic.working.expected');
  expect(a.unresolved).toContainEqual(expect.objectContaining({decision_id:'wt.payroll_allocation.day.0'}));expect(r.checks).toHaveLength(1);expect(r.checks[0].calculation).toMatchObject({state:'calculated',expected:{minor_units:42000},recorded:null});
 });
 it('expands one static method to exact day IDs and stales only the changed day receipt',()=>{
  const f=productFlowFixture();f.identify();ordinaryCoverage(f.input);const second=structuredClone(f.input.workdays[0]);second.id='day.1';second.date='2026-06-08';
  second.intervals[0].id='interval.1';second.intervals[0].start_at='2026-06-08T08:00:00+03:00';second.intervals[0].end_at='2026-06-08T18:00:00+03:00';second.intervals[0].printed_duration.observation_id='observation.day.1';second.intervals[0].classification={state:'missing',value:null,source:null};
  second.ordinary_limit={...second.ordinary_limit,state:'observed',printed_value:'08:00'};second.recorded_pay=null;second.payment_allocation={state:'missing',value:null,source:null};f.input.workdays.push(second);
  const w=attachWorkingTimeSourceFacts(f.input,f.review()).input,source=composeEntitlementReview(sourcePacket(f.review(),[w])),branch=workingTimeProductReview(source,[w]),target=branch.answer_targets.find(t=>t.input_path==='workdays.1.intervals.0.classification')!;
  const q=runDocumentReview(source,'synthetic.working.day-question').completions.customer_requests.find(r=>r.target.fact_key===target.fact_key)!;
  const answer={request_id:uuid(888),revision:1,answered_at:'2026-09-12T00:01:00Z',state:'provided' as const,value:'worked'},actor={case_id:source.case_id,identity_id:uuid(990)};
  const answered=applyDocumentReviewAnswer(source,{request:q,actor,answer}).input,a=applyMethods(answered,['wt.worked_time']);
  expect(a.receipts.map(r=>r.decision_id)).toEqual(['wt.worked_time.day.0','wt.worked_time.day.1']);expect(a.receipts.every(r=>r.recipe_id==='ai-case.wt.worked_time')).toBe(true);
  const corrected=applyDocumentReviewAnswer(a.source,{request:q,actor,answer:{...answer,revision:2,state:'unknown',value:null}}).input,e=effective(corrected);
  expect(e.applicability.find(d=>d.decision_id==='wt.worked_time.day.0')?.state).toBe('accepted');expect(e.applicability.find(d=>d.decision_id==='wt.worked_time.day.1')?.state).toBe('stale');expect(corrected.answer_history).toHaveLength(2);
  expect(parseReviewCompletionInput(corrected.completion_input).needs.filter(n=>n.fact_key===q.target.fact_key)).toHaveLength(1);
  expect(runDocumentReview(corrected,'synthetic.working.unknown').completions.customer_requests.filter(r=>r.target.fact_key===q.target.fact_key)).toHaveLength(0);
  const original=workingTimeEntitlementInputSchema.parse((a.source.entitlement_evidence!.working_time as unknown[])[0]),tampered=structuredClone(original),b=tampered.case_recipe_bindings![0];
  expect(()=>replayWorkingTimeProductFacts(effective(a.source),original,corrected)).toThrow('WT_CASE_CURRENT_DECLARATION');
  tampered.case_recipe_bindings![0]=workingTimeCaseBinding(b.method,b.evaluated_at,b.decision_id,'day.1');expect(()=>replayWorkingTimeProductFacts(e,tampered,a.source)).toThrow('WT_CASE_BINDING_DAY');
 });
});
