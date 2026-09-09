import {describe,it,expect,vi} from 'vitest';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '../facts/snapshot.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';
import {sourceCalculationTraceSchema} from './source-trace.ts';
import {sourceMonetaryComparisonSchema} from '../findings/source-comparison.ts';
import {calculateDevMinimumWage,DEV_MINIMUM_WAGE_PARAMETER,DEV_MINIMUM_WAGE_POLICY,DEV_MINIMUM_WAGE_RULE} from './dev-minimum-wage.ts';

// A production-reachable engineering calculator must not load reference-tenant
// sensitivity packages, including indirectly through an inherited manifest.
vi.mock('../legal-quality/sensitivity-rulespecs.ts',()=>{throw Error('REFERENCE_TENANT_RUNTIME_MUST_NOT_LOAD');});

// Independently constructed synthetic source readings. No legal fixture
// catalog, precomputed finding, report or human attestation is injected.
const caseId='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const documentId='33333333-3333-4333-8333-333333333333';
const now='2026-09-09T12:00:00Z';
function fixture(hours='100',recorded=330000):EmploymentSnapshot{
 const common={case_id:caseId,status:'confirmed',confidence:0.99,conflicting_fact_ids:[],resolution:null,created_at:now,
  provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:documentId,locator:{page:1,text_span:'SYNTHETIC QA INPUT'}},read_by:'machine',verified:false}]};
 return employmentSnapshotSchema.parse({snapshot_id:'44444444-4444-4444-8444-444444444444',case_id:caseId,analysis_run_id:runId,schema_version:'1.0.0',created_at:now,facts:[
  {...common,fact_id:'55555555-5555-4555-8555-555555555555',path:'work.regular_hours',value:{amount:hours,unit:'hours_per_month'}},
  {...common,fact_id:'66666666-6666-4666-8666-666666666666',path:'compensation.base_monthly_salary',value:{currency:'ILS',minor_units:recorded}},
 ]});
}
function calculate(facts=fixture()){return calculateDevMinimumWage({facts,month:'2026-06',calculatedAt:now});}
function calculated(facts=fixture()){
 const result=calculate(facts);if(result.state!=='calculated')throw Error('EXPECTED_CALCULATION');return result;
}

describe('one-month DEV minimum-wage comparison',()=>{
 it('derives the independent 100 × 3540 − 330000 = 24000 oracle through source trace and explicit subtraction',()=>{
  const facts=fixture(),result=calculated(facts);
  expect([result.expectedMinor,result.recordedMinor,result.gapMinor]).toEqual([354000,330000,24000]);
  expect(result.trace.facts_snapshot).toEqual(facts);
  expect(result.trace.analysis_run_id).toBe(runId);
  expect(result.trace.inputs.find(value=>value.input_id==='fact.regular.hours')?.value).toEqual({kind:'rational',numerator:'100',denominator:'1',unit:'hours_per_month'});
  expect(result.trace.steps.find(step=>step.step_id==='regular.hours.multiplier')?.result).toEqual({kind:'rational',numerator:'100',denominator:'1',unit:'ratio'});
  expect(result.trace.steps.at(-1)?.operation).toBe('subtract');
  expect(sourceCalculationTraceSchema.parse(result.trace)).toEqual(result.trace);
  expect(sourceMonetaryComparisonSchema.parse(result.comparison)).toEqual(result.comparison);
 });

 it.each([
  ['0.5',0,1770,1770],['100.25',330000,354885,24885],['0.0005',0,2,2],
  ['182',0,644280,644280],['100',354000,354000,0],['100',360000,354000,-6000],
 ])('keeps exact fractional input and signed result for hours %s recorded %i',(hours,recorded,expected,gap)=>{
  const result=calculated(fixture(hours,recorded));
  expect([result.expectedMinor,result.gapMinor]).toEqual([expected,gap]);
 });

 it('keeps the hourly result separate from the monthly published floor',()=>{
  expect(calculated(fixture('182',0)).expectedMinor).not.toBe(644385);
 });

 it.each(['missing','needs_confirmation','candidate','rejected','conflicted'] as const)('requests an essential %s fact without treating it as zero',status=>{
  const facts=fixture();const hours=facts.facts[0];
  const changed={...facts,facts:[{...hours,status,value:status==='missing'||status==='conflicted'?null:hours.value,
   conflicting_fact_ids:status==='conflicted'?['77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888']:[]},facts.facts[1]]} as EmploymentSnapshot;
  expect(calculate(changed)).toEqual({state:'missing_input',fields:['work.regular_hours']});
 });

 it('lists both absent essential inputs in deterministic order',()=>{
  expect(calculate({...fixture(),facts:[]})).toEqual({state:'missing_input',fields:['work.regular_hours','compensation.base_monthly_salary']});
 });

 it('accepts a request-revision reading only as supplied by the engineering coordinator',()=>{
  const facts=fixture();const changed={...facts,facts:[{...facts.facts[0],provenance:[{source_type:'declared' as const,
   source_reference:{kind:'case_request_answer' as const,request_id:'77777777-7777-4777-8777-777777777777',answer_revision:2}}]},facts.facts[1]]};
  expect(calculated(changed).gapMinor).toBe(24000);
  expect(calculated(changed).trace.facts_snapshot.facts[0].provenance).toEqual(changed.facts[0].provenance);
 });

 it('does not use generic declared input for hours or any declaration as documented base pay',()=>{
  for(const index of [0,1]){
   const facts=fixture();const changed={...facts,facts:facts.facts.map((fact,i)=>i===index?{...fact,provenance:[{source_type:'declared' as const,
    source_reference:{kind:'questionnaire_response' as const,response_id:'77777777-7777-4777-8777-777777777777'}}]}:fact)};
   expect(()=>calculate(changed)).toThrow('DEV_WAGE_FACT_SOURCE_REQUIRED');
  }
 });

 it('requires a documented page locator rather than a bare document assertion',()=>{
  const facts=fixture();const changed={...facts,facts:facts.facts.map(fact=>({...fact,provenance:[{source_type:'documented' as const,source_reference:{kind:'document' as const,document_id:documentId}}]}))};
  expect(()=>calculate(changed)).toThrow('DEV_WAGE_FACT_SOURCE_REQUIRED');
 });

 it.each(['0','182.0001','183','999','0.00001'])('refuses hours outside the bounded QA scenario: %s',hours=>{
  expect(()=>calculate(fixture(hours))).toThrow();
 });

 it.each(['2026-05','2026-07','2025-06','2026-06-01'])('refuses a different period: %s',month=>{
  expect(()=>calculateDevMinimumWage({facts:fixture(),month,calculatedAt:now})).toThrow('DEV_WAGE_MONTH_UNSUPPORTED');
 });

 it('refuses another currency, negative base and a foreign case fact',()=>{
  const facts=fixture();
  expect(()=>calculate({...facts,facts:[facts.facts[0],{...facts.facts[1],value:{currency:'USD',minor_units:330000}}]} as EmploymentSnapshot)).toThrow();
  expect(()=>calculate({...facts,facts:[facts.facts[0],{...facts.facts[1],value:{currency:'ILS',minor_units:-1}}]} as EmploymentSnapshot)).toThrow();
  expect(()=>calculate({...facts,facts:[{...facts.facts[0],case_id:'77777777-7777-4777-8777-777777777777'},facts.facts[1]]})).toThrow();
 });

 it('changes result and provenance hashes when the recorded source amount changes, and replays identically',()=>{
  const first=calculated(),replayed=calculated(),changed=calculated(fixture('100',340000));
  expect(replayed).toEqual(first);expect(changed.gapMinor).toBe(14000);
  expect(changed.trace.trace_sha256).not.toBe(first.trace.trace_sha256);
  expect(changed.trace.calculation_id).not.toBe(first.trace.calculation_id);
 });

 it('refuses tampered saved operands, step output, source fact and run identity through the existing trace parser',()=>{
  const {trace,comparison}=calculated();
  const mutations=[
   {...trace,analysis_run_id:'77777777-7777-4777-8777-777777777777'},
   {...trace,inputs:trace.inputs.map((value,index)=>index===0?{...value,value:{kind:'rational',numerator:'101',denominator:'1',unit:'hours_per_month'}}:value)},
   {...trace,output:{kind:'money',value:{currency:'ILS',minor_units:99999}}},
   {...trace,facts_snapshot:fixture('101')},
  ];
  for(const mutation of mutations)expect(sourceCalculationTraceSchema.safeParse(mutation).success).toBe(false);
  const {sha256,...seed}=comparison;void sha256;
  const falseSeed={...seed,signed_difference:{currency:'ILS',minor_units:99999}};
  expect(sourceMonetaryComparisonSchema.safeParse({...falseSeed,sha256:canonicalSha256(falseSeed)}).success).toBe(false);
 });

 it('keeps a standalone engineering manifest with pinned parent provenance only',()=>{
  expect(DEV_MINIMUM_WAGE_RULE.rule_spec_version).toBe('1.1.0');
  expect(DEV_MINIMUM_WAGE_RULE.source_version_ids).toEqual([DEV_MINIMUM_WAGE_POLICY.source.sourceVersionId]);
  expect(DEV_MINIMUM_WAGE_RULE.effective_period).toEqual({from:'2026-06-01',to:'2026-06-30'});
  expect(DEV_MINIMUM_WAGE_POLICY.parentRule).toEqual({
   id:'il.rulespec.minimum.wage.hourly.entitlement',version:'1.0.0',
   sha256:'182e85ff6de7d2e12260878bd25f3dc2bae39d5e4f5f7eaf25b5b9df8a9d48ce',
   relationship:'historical_arithmetic_reference_only',
  });
  expect(DEV_MINIMUM_WAGE_RULE.content_sha256).not.toBe(DEV_MINIMUM_WAGE_POLICY.parentRule.sha256);
  expect(DEV_MINIMUM_WAGE_PARAMETER.decision_id).toBe('tivdoc.dev.engineering.decision.minimum_wage_hourly_182');
  expect(DEV_MINIMUM_WAGE_POLICY.engineeringDecision).toMatchObject({authority:'synthetic_scenario_selection_only',humanApproval:false});
  expect(DEV_MINIMUM_WAGE_RULE.golden_case_set_sha256).toBe(legalOperationsSha256(DEV_MINIMUM_WAGE_POLICY.validationBinding));
  expect(DEV_MINIMUM_WAGE_POLICY.validationBinding).toMatchObject({authority:'engineering_tests_only',approvedLegalGoldenSet:false,approvedLegalGoldenCaseIds:[]});
  expect(JSON.stringify(calculated())).not.toContain('legal.reference.il');
 });

 it('pins the historical parent identity and content hash accurately without a production import',async()=>{
  // Explicitly load the historical package only inside this provenance test.
  // The hoisted throwing mock still guards imports made by the calculator.
  const {MINIMUM_WAGE_HOURLY_SPEC:parent}=await vi.importActual<typeof import('../legal-quality/sensitivity-rulespecs.ts')>('../legal-quality/sensitivity-rulespecs.ts');
  expect(DEV_MINIMUM_WAGE_POLICY.parentRule).toMatchObject({id:parent.rule_spec_id,version:parent.rule_spec_version,sha256:parent.content_sha256});
 });

 it('preserves inactive/source-only authority without creating activation or legal approval',()=>{
  expect(DEV_MINIMUM_WAGE_RULE.catalog_boundary).toBe('real_inactive');
  expect(DEV_MINIMUM_WAGE_PARAMETER.support_roles).toEqual(['official_implementation']);
  expect(DEV_MINIMUM_WAGE_PARAMETER.bindings.rule_spec_sha256).toBe(DEV_MINIMUM_WAGE_RULE.content_sha256);
  expect(DEV_MINIMUM_WAGE_POLICY.activationAllowed).toBe(false);
  expect(DEV_MINIMUM_WAGE_POLICY.humanAttestations).toEqual([]);
  expect(calculated().comparison.is_finding).toBe(false);
  expect(calculated().comparison.pricing_allowed).toBe(false);
  expect(Object.isFrozen(DEV_MINIMUM_WAGE_POLICY.source)).toBe(true);
 });
});
