import {describe,expect,it} from 'vitest';
import {sourceComparisonFixture} from './source-comparison.fixtures.ts';
import {sourceTraceFixture} from '../calculations/source-trace.fixtures.ts';
import {createSourceCalculationTrace,type CalculationSourceBinding,type SourceCalculationTrace} from '../calculations/source-trace.ts';
import {createSourceMonetaryComparison,sourceMonetaryComparisonSchema,sourceMonetaryComparisonV1Schema,sourceMonetaryComparisonV2Schema} from './source-comparison.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {findingSchema} from './contracts.ts';
import {createJune2026MinimumWageCandidate,componentInputId} from '../minimum-wage-june2026/candidate.ts';
import {createRuleSpecPackage,type RuleSpecPackage} from '../legal-operations/rulespec.ts';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';
const rehash=(value:ReturnType<typeof sourceComparisonFixture>['comparison'])=>{const {sha256,...seed}=value;void sha256;return {...seed,sha256:canonicalSha256(seed)};};

describe('source-bound expected versus recorded monetary comparison',()=>{
 it('preserves the exact v1 wire shape and hash for a direct recorded operand',()=>{
  const {trace,comparison}=sourceComparisonFixture();
  // Written in the historical v1 property order, independently of the factory.
  const seed={schema_version:'tivdoc-source-monetary-comparison-v1',authority:'arithmetic_provenance_only',output_semantics:'expected_minus_recorded',
   is_finding:false,pricing_allowed:false,trace,expected_ref:'result.amount',recorded_ref:'fact.salary',
   expected:{currency:'XTS',minor_units:501},recorded:{currency:'XTS',minor_units:500},signed_difference:{currency:'XTS',minor_units:1},
   source_semantics:'recorded_document_amount_is_not_payment_settlement'};
  const historicalBytes=JSON.stringify({...seed,sha256:canonicalSha256(seed)});
  expect(JSON.stringify(comparison)).toBe(historicalBytes);
  expect(JSON.stringify(sourceMonetaryComparisonSchema.parse(JSON.parse(historicalBytes)))).toBe(historicalBytes);
  expect(sourceMonetaryComparisonV1Schema.parse(JSON.parse(historicalBytes))).toEqual(comparison);
  expect(sourceMonetaryComparisonV2Schema.safeParse(comparison).success).toBe(false);
  expect(comparison).not.toHaveProperty('recorded_binding');
 });
 it.each([['positive',501,1],['negative',499,-1],['zero',500,0]] as const)('retains %s difference from the existing interpreter without labelling it a debt or settlement', (direction,expected,difference)=>{
  const {comparison}=sourceComparisonFixture(direction);
  expect(comparison.expected).toEqual({currency:'XTS',minor_units:expected});
  expect(comparison.recorded).toEqual({currency:'XTS',minor_units:500});
  expect(comparison.signed_difference).toEqual({currency:'XTS',minor_units:difference});
  expect(comparison.pricing_allowed).toBe(false);expect(comparison.is_finding).toBe(false);
  expect(findingSchema.safeParse(comparison).success).toBe(false);
  expect(sourceMonetaryComparisonSchema.parse(JSON.parse(JSON.stringify(comparison)))).toEqual(comparison);
 });
 it('refuses an entitlement trace that a caller tries to present as a difference',()=>{
  const {trace}=sourceTraceFixture();
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})).toThrow('COMPARISON_REQUIRES_EXPLICIT_SUBTRACTION');
 });
 it.each(['expected','recorded','signed_difference','expected_ref','recorded_ref'] as const)('rejects a changed %s after outer rehash',field=>{
  const comparison=structuredClone(sourceComparisonFixture().comparison);
  if(field==='expected_ref'||field==='recorded_ref')comparison[field]='parameter.amount';
  else comparison[field]={currency:'XTS',minor_units:999};
  expect(sourceMonetaryComparisonSchema.safeParse(rehash(comparison)).success).toBe(false);
 });
 it('refuses to turn a declaration into a recorded-document payment amount',()=>{
  const {traceInput}=sourceComparisonFixture();
  const declared=sourceTraceFixture().input.facts.facts[0].provenance;
  const facts=employmentSnapshotSchema.parse({...traceInput.facts,facts:traceInput.facts.facts.map(f=>({...f,provenance:declared}))});
  const trace=createSourceCalculationTrace({...traceInput,facts});
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})).toThrow('COMPARISON_RECORDED_DOCUMENT_REQUIRED');
 });
 it('refuses to compare a whole-period entitlement to a recorded hourly rate',()=>{
  const {traceInput}=sourceComparisonFixture();
  const facts=employmentSnapshotSchema.parse({...traceInput.facts,facts:traceInput.facts.facts.map(f=>({...f,path:'compensation.hourly_rate'}))});
  const trace=createSourceCalculationTrace({...traceInput,facts});
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})).toThrow('COMPARISON_RECORDED_COMPONENT_REQUIRED');
 });
});

/** Explicitly synthetic saved facts, using the unchanged, unsigned June rule.
 * No catalog admission, human approval, finding or source OCR is fabricated. */
function juneTraceFixture(componentCount:1|2=1,options:{hours?:string;recorded?:number}={}){
 const candidate=createJune2026MinimumWageCandidate(componentCount);
 const caseId='22222222-2222-4222-8222-222222222222',analysisRunId='33333333-3333-4333-8333-333333333333';
 const createdAt='2026-09-10T14:00:00Z';
 const facts=employmentSnapshotSchema.parse({snapshot_id:'11111111-1111-4111-8111-111111111111',case_id:caseId,analysis_run_id:analysisRunId,
  schema_version:'1.0.0',created_at:createdAt,facts:[
   {fact_id:'44444444-4444-4444-8444-444444444444',path:'work.regular_hours',value:{amount:options.hours??'100',unit:'hours_per_month'}},
   {fact_id:'55555555-5555-4555-8555-555555555555',path:'compensation.base_monthly_salary',value:{currency:'ILS',minor_units:options.recorded??330000}},
   ...(componentCount===2?[{fact_id:'88888888-8888-4888-8888-888888888888',path:'compensation.overtime_pay',value:{currency:'ILS',minor_units:5000}}]:[]),
  ].map(fact=>({...fact,case_id:caseId,status:'confirmed',confidence:1,conflicting_fact_ids:[],resolution:null,created_at:createdAt,
   provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:'77777777-7777-4777-8777-777777777777',locator:{page:1}},read_by:'machine',verified:false}]}))});
 const bindings:CalculationSourceBinding[]=[{input_id:'fact.regular.hours',source:{kind:'fact',fact_id:facts.facts[0].fact_id,value_path:[]}},
  ...Array.from({length:componentCount},(_,index)=>({input_id:componentInputId(index),source:{kind:'fact' as const,fact_id:facts.facts[index+1].fact_id,value_path:[]}})),
  ...candidate.parameters.map((parameter,index)=>({input_id:index===0?'parameter.monthly.floor':'parameter.month.hours',
   source:{kind:'parameter' as const,parameter_id:parameter.parameter_id,parameter_version:parameter.parameter_version}}))];
 const input={calculationId:'66666666-6666-4666-8666-666666666666',caseId,analysisRunId,calculatedAt:createdAt,catalogSha256:'a'.repeat(64),
  facts,rule:candidate.rule,parameters:candidate.parameters,bindings};
 return {candidate,input,trace:createSourceCalculationTrace(input)};
}

function juneComparison(trace:SourceCalculationTrace){
 return sourceMonetaryComparisonV2Schema.parse(createSourceMonetaryComparison({trace,expectedRef:'expected.regular.pay',recordedRef:'recorded.eligible.pay'}));
}

/** Deliberately different test-only packages let the rejection tests reach the
 * comparison boundary with otherwise valid, fully replayed arithmetic traces. */
function traceWithNodes(input:ReturnType<typeof juneTraceFixture>['input'],nodes:RuleSpecPackage['nodes']){
 const {content_sha256,...draft}=input.rule;void content_sha256;
 const rule=createRuleSpecPackage({...draft,rule_spec_id:'test.comparison.aggregate.variant',nodes,
  resource_policy:{...draft.resource_policy,max_steps:nodes.length,max_depth:8}});
 const parameters=input.parameters.map(parameter=>{
  const {candidate_sha256,...seed}=parameter;void candidate_sha256;
  const changed={...seed,bindings:{...seed.bindings,rule_spec_sha256:rule.content_sha256}};
  return {...changed,candidate_sha256:legalOperationsSha256(changed)};
 });
 return createSourceCalculationTrace({...input,rule,parameters});
}

describe('v2 single documented input through bounded aggregation',()=>{
 it.each([
  ['100',330000,354058,24058],
  ['182',644385,644385,0],
  ['0.5',1600,1770,170],
  ['100',360000,354058,-5942],
 ] as const)('compares the unchanged June rule for %s hours and %i recorded minor units', (hours,recorded,expected,gap)=>{
  // Independent rational oracle: half-up(644385 * hours / 182) minus
  // recorded. In particular 100 hours is 354058 - 330000 = 24058, not 24000.
  const {candidate,trace}=juneTraceFixture(1,{hours,recorded}),before=JSON.stringify(trace);
  const comparison=juneComparison(trace),sourceInput=trace.inputs.find(input=>input.input_id==='fact.component.1')!;
  expect(comparison.expected).toEqual({currency:'ILS',minor_units:expected});
  expect(comparison.recorded).toEqual({currency:'ILS',minor_units:recorded});
  expect(comparison.signed_difference).toEqual({currency:'ILS',minor_units:gap});
  expect(comparison.recorded_binding).toEqual({kind:'bounded_single_documented_fact',aggregate_ref:'recorded.eligible.pay',input_ref:'fact.component.1',
   source:sourceInput.source,source_sha256:sourceInput.source_sha256,value:{currency:'ILS',minor_units:recorded}});
  expect(comparison.trace.rule_package).toEqual(candidate.rule);
  expect(comparison.trace.parameters).toEqual(candidate.parameters);
  expect(comparison.trace.facts_snapshot).toEqual(trace.facts_snapshot);
  expect(JSON.stringify(trace)).toBe(before);
  expect(candidate).toMatchObject({humanApproved:false,activationAllowed:false});
  expect(comparison).toMatchObject({authority:'arithmetic_provenance_only',is_finding:false,pricing_allowed:false});
  expect(findingSchema.safeParse(comparison).success).toBe(false);
  expect(sourceMonetaryComparisonSchema.parse(JSON.parse(JSON.stringify(comparison)))).toEqual(comparison);
  expect(sourceMonetaryComparisonV1Schema.safeParse(comparison).success).toBe(false);
 });

 it('does not relabel a v2 aggregate as a historical direct-input v1 comparison',()=>{
  const comparison=juneComparison(juneTraceFixture().trace),{recorded_binding,...withoutBinding}=comparison;void recorded_binding;
  expect(sourceMonetaryComparisonSchema.safeParse(rehash({...withoutBinding,schema_version:'tivdoc-source-monetary-comparison-v1'})).success).toBe(false);
 });

 it('refuses two independently documented inputs rather than choosing or silently adding components',()=>{
  const {trace}=juneTraceFixture(2);
  expect(trace.execution_output).toEqual({kind:'money',currency:'ILS',minor_units:19058});
  expect(()=>juneComparison(trace)).toThrow('COMPARISON_BOUNDED_SINGLE_INPUT_REQUIRED');
 });

 it('refuses a valid nested single-input aggregate even when its arithmetic is identical',()=>{
  const {input}=juneTraceFixture();
  const trace=traceWithNodes(input,[...input.rule.nodes.slice(0,2),
   {node_id:'recorded.inner',operation:'aggregate.bounded',refs:['fact.component.1']},
   {node_id:'recorded.eligible.pay',operation:'aggregate.bounded',refs:['recorded.inner']},input.rule.nodes[3]]);
  expect(trace.execution_output).toEqual({kind:'money',currency:'ILS',minor_units:24058});
  expect(()=>juneComparison(trace)).toThrow('COMPARISON_BOUNDED_DIRECT_FACT_REQUIRED');
 });

 it('refuses a valid single-input parameter aggregate as a recorded-document amount',()=>{
  const {input}=juneTraceFixture();
  const trace=traceWithNodes(input,input.rule.nodes.map(node=>node.node_id==='recorded.eligible.pay'
   ?{node_id:node.node_id,operation:'aggregate.bounded' as const,refs:['parameter.monthly.floor']}:node));
  expect(trace.execution_output).toEqual({kind:'money',currency:'ILS',minor_units:-290327});
  expect(()=>juneComparison(trace)).toThrow('COMPARISON_BOUNDED_DIRECT_FACT_REQUIRED');
 });

 it('requires documented whole-period component provenance, not a declaration or hourly rate',()=>{
  const {input}=juneTraceFixture(),base=input.facts.facts[1];
  const declaration=sourceTraceFixture().input.facts.facts[0].provenance;
  for(const [changed,error] of [
   [{...base,provenance:declaration},'COMPARISON_RECORDED_DOCUMENT_REQUIRED'],
   [{...base,path:'compensation.hourly_rate'},'COMPARISON_RECORDED_COMPONENT_REQUIRED'],
  ] as const){
   const facts=employmentSnapshotSchema.parse({...input.facts,facts:[input.facts.facts[0],changed]});
   expect(()=>juneComparison(createSourceCalculationTrace({...input,facts}))).toThrow(error);
  }
 });

 it.each(['aggregate_ref','input_ref','fact_id','value_path','source_sha256','value'] as const)('rejects edited recorded binding %s after outer rehash',field=>{
  const comparison=structuredClone(juneComparison(juneTraceFixture().trace)),binding=comparison.recorded_binding;
  if(field==='aggregate_ref'||field==='input_ref')binding[field]='expected.regular.pay';
  else if(field==='fact_id')binding.source.fact_id=comparison.trace.facts_snapshot.facts[0].fact_id;
  else if(field==='value_path')binding.source.value_path=['employee','amount'];
  else if(field==='source_sha256')binding.source_sha256='f'.repeat(64);
  else binding.value={currency:'ILS',minor_units:330001};
  expect(sourceMonetaryComparisonSchema.safeParse(rehash(comparison)).success).toBe(false);
 });

 it.each(['step_value','step_refs','missing_input','fact_id','source_sha256','nested_rule'] as const)('replays and rejects edited trace %s even after trace and comparison rehash',field=>{
  const comparison=structuredClone(juneComparison(juneTraceFixture().trace)),trace=comparison.trace;
  const index=trace.inputs.findIndex(input=>input.input_id==='fact.component.1');
  if(field==='step_value')trace.steps[2]={...trace.steps[2],result:{kind:'money',currency:'ILS',minor_units:330001}};
  else if(field==='step_refs')trace.steps[2]={...trace.steps[2],input_refs:['parameter.monthly.floor']};
  else if(field==='missing_input')trace.inputs.splice(index,1);
  else if(field==='fact_id')trace.inputs[index].source={kind:'fact',fact_id:'99999999-9999-4999-8999-999999999999',value_path:[]};
  else if(field==='source_sha256')trace.inputs[index].source_sha256='f'.repeat(64);
  else trace.rule_package={...trace.rule_package,nodes:trace.rule_package.nodes.map(node=>node.node_id==='recorded.eligible.pay'
   ?{node_id:node.node_id,operation:'aggregate.bounded',refs:['expected.regular.pay']}:node)};
  const {trace_sha256,...traceSeed}=trace;void trace_sha256;trace.trace_sha256=canonicalSha256(traceSeed);
  expect(sourceMonetaryComparisonSchema.safeParse(rehash(comparison)).success).toBe(false);
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'expected.regular.pay',recordedRef:'recorded.eligible.pay'})).toThrow();
 });
});
