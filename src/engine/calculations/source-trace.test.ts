import {describe,it,expect} from 'vitest';
import {calculationTraceSchema} from './contracts.ts';
import {createSourceCalculationTrace,persistedCalculationTraceSchema,sourceCalculationTraceSchema} from './source-trace.ts';
import {sourceTraceFixture} from './source-trace.fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {createRuleSpecPackage} from '../legal-operations/rulespec.ts';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';

const rehash=(trace:ReturnType<typeof sourceTraceFixture>['trace'])=>{const {trace_sha256,...seed}=trace;void trace_sha256;return {...seed,trace_sha256:canonicalSha256(seed)};};
describe('source-bound calculation trace',()=>{
 it('reproduces the legacy contract refusing a legal parameter unless it is mislabelled as a fact',()=>{
  const {trace}=sourceTraceFixture();
  const legacy={calculation_id:trace.calculation_id,formula_id:'synthetic.formula',formula_version:'1',rule:trace.rule,engine_version:'1',inputs:[{input_id:'parameter.amount',parameter_id:'syn.parameter.minimum_wage',parameter_version:'1.0.0',value:{kind:'money',value:{currency:'XTS',minor_units:1}}}],steps:[{step_id:'result.amount',operation:'add',input_refs:['parameter.amount'],result:trace.output,explanation:'Synthetic only'}],output:trace.output,calculated_at:trace.calculated_at};
  expect(calculationTraceSchema.safeParse(legacy).success).toBe(false);
  expect(calculationTraceSchema.safeParse({...legacy,inputs:[{input_id:'parameter.amount',fact_id:trace.facts_snapshot.facts[0].fact_id,fact_path:'compensation.base_monthly_salary',value:{kind:'money',value:{currency:'XTS',minor_units:1}}}]}).success).toBe(true);
 });
 it('retains distinct actual fact and parameter pins and recomputes the existing interpreter result',()=>{
  const {input,trace}=sourceTraceFixture();expect(trace.output).toEqual({kind:'money',value:{currency:'XTS',minor_units:501}});
  expect(trace.inputs[0].source).toMatchObject({kind:'fact',fact_id:input.facts.facts[0].fact_id});
  expect(trace.inputs[1].source).toEqual({kind:'parameter',parameter_id:input.parameters[0].parameter_id,parameter_version:'1.0.0'});
  expect(trace.inputs[1].source).not.toHaveProperty('fact_id');expect(trace.authority).toBe('arithmetic_provenance_only');
  expect(persistedCalculationTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);expect(createSourceCalculationTrace(input)).toEqual(trace);
 });
 it.each(['value','source','step','output','parameter','snapshot','rule_input','rule_version','case','duplicate'] as const)('refuses %s substitution even after a caller recomputes the outer hash',defect=>{
  const t=structuredClone(sourceTraceFixture().trace);
  if(defect==='value')t.inputs[0].value={kind:'money',currency:'XTS',minor_units:999};
  if(defect==='source')t.inputs[0].source_sha256='b'.repeat(64);
  if(defect==='step')t.steps[0].result={kind:'money',currency:'XTS',minor_units:999};
  if(defect==='output')t.output={kind:'money',value:{currency:'XTS',minor_units:999}};
  if(defect==='parameter')t.parameters[0]={...t.parameters[0],value:{kind:'money',value:{currency:'XTS',minor_units:999}}};
  if(defect==='snapshot')t.facts_snapshot_sha256='b'.repeat(64);
  if(defect==='rule_input')t.rule_input_sha256='b'.repeat(64);
  if(defect==='rule_version')t.rule.rule_version='2';
  if(defect==='case')t.case_id=t.calculation_id;
  if(defect==='duplicate')t.inputs.push(t.inputs[0]);
  expect(sourceCalculationTraceSchema.safeParse(rehash(t)).success).toBe(false);
 });
 it('refuses a missing or unconfirmed source instead of inserting zero',()=>{
  const {input}=sourceTraceFixture();const facts=structuredClone(input.facts);facts.facts[0]={...facts.facts[0],status:'needs_confirmation'};
  expect(()=>createSourceCalculationTrace({...input,facts})).toThrow('TRACE_FACT_NOT_CONFIRMED');
  expect(()=>createSourceCalculationTrace({...input,bindings:[{...input.bindings[0],source:{kind:'fact',fact_id:input.calculationId,value_path:[]}},input.bindings[1]]})).toThrow('TRACE_FACT_NOT_CONFIRMED');
 });
 it('refuses a parameter impersonating a fact or an unsupported unit conversion',()=>{
  const {input}=sourceTraceFixture();expect(()=>createSourceCalculationTrace({...input,bindings:[input.bindings[0],{input_id:'parameter.amount',source:{kind:'fact',fact_id:input.facts.facts[0].fact_id,value_path:[]}}]})).toThrow('TRACE_PARAMETER_SET_MISMATCH');
  expect(()=>createSourceCalculationTrace({...input,bindings:[{...input.bindings[0],source:{kind:'fact',fact_id:input.facts.facts[0].fact_id,value_path:['amount']}},input.bindings[1]]})).toThrow('TRACE_FACT_VALUE_PATH');
 });
 it('limits oversized and circular untrusted JSON before arithmetic replay',()=>{
  expect(sourceCalculationTraceSchema.safeParse({payload:'x'.repeat(1_000_001)}).success).toBe(false);
  const cycle:{self?:unknown}={};cycle.self=cycle;expect(sourceCalculationTraceSchema.safeParse(cycle).success).toBe(false);
 });
 it('rejects a validly rehashed parameter pinned to a different rule and facts from another analysis',()=>{
  const {input}=sourceTraceFixture(),{candidate_sha256,...seed}=input.parameters[0];void candidate_sha256;
  const changed={...seed,bindings:{...seed.bindings,rule_spec_sha256:'b'.repeat(64)}};
  expect(()=>createSourceCalculationTrace({...input,parameters:[{...changed,candidate_sha256:legalOperationsSha256(changed)}]})).toThrow('TRACE_PARAMETER_RULE_HASH');
  expect(()=>createSourceCalculationTrace({...input,analysisRunId:input.calculationId})).toThrow('TRACE_ANALYSIS_RUN_MISMATCH');
 });
 it.each(['hours','pension_rate','pension_amount'] as const)('projects %s losslessly from an exact saved fact path',kind=>{
  const {input}=sourceTraceFixture();
  const fact=kind==='hours'?{...input.facts.facts[0],path:'work.regular_hours',value:{amount:'42.25',unit:'hours_per_pay_period'}}:
   {...input.facts.facts[0],path:'pension.contributions',value:{employee:{amount:{currency:'XTS',minor_units:655},rate_basis_points:650},employer:null,period:{start_date:'2040-01-01',end_date:'2040-01-31'}}};
  const facts=employmentSnapshotSchema.parse({...input.facts,facts:[fact]});
  const {content_sha256,...seed}=input.rule;void content_sha256;
  const rule=createRuleSpecPackage({...seed,facts:[{ref_id:'fact.source',value_kind:kind==='pension_amount'?'money':'rational',unit:kind==='hours'?'hours_per_pay_period':kind==='pension_rate'?'ratio':'currency.xts'}],parameters:[],nodes:[{node_id:'result.source',operation:'aggregate.bounded',refs:['fact.source']}],output_ref:'result.source'});
  const value_path=kind==='hours'?[]:kind==='pension_rate'?['employee','rate_basis_points'] as const:['employee','amount'] as const;
  const trace=createSourceCalculationTrace({...input,facts,rule,parameters:[],bindings:[{input_id:'fact.source',source:{kind:'fact',fact_id:fact.fact_id,value_path:[...value_path]}}]});
  expect(trace.execution_output).toEqual(kind==='hours'?{kind:'rational',numerator:'169',denominator:'4',unit:'hours_per_pay_period'}:kind==='pension_rate'?{kind:'rational',numerator:'13',denominator:'200',unit:'ratio'}:{kind:'money',currency:'XTS',minor_units:655});
  expect(sourceCalculationTraceSchema.parse(JSON.parse(JSON.stringify(trace)))).toEqual(trace);
 });
});
