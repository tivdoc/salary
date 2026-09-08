import {z} from 'zod';
import {calculationTraceSchema,calculationValueSchema,type CalculationValue} from './contracts.ts';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '../facts/snapshot.ts';
import {createCanonicalRuleInputSnapshot} from '../rule-input/snapshot.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {legalOperationsSha256,frozen} from '../legal-operations/canonical.ts';
import {parameterCandidateSchema,legalOperationsIdSchema,type ParameterCandidate} from '../legal-operations/contracts.ts';
import {executeRuleSpec,parameterAsInput,ruleSpecPackageSchema,ruleSpecValueSchema,type RuleSpecInputValue,type RuleSpecPackage} from '../legal-operations/rulespec.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const id=legalOperationsIdSchema;
const valueSchema=ruleSpecValueSchema;
const bindingSchema=z.object({input_id:id,source:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('fact'),fact_id:z.uuid(),value_path:z.array(z.enum(['employee','employer','amount','rate_basis_points'])).max(2)}).strict(),
 z.object({kind:z.literal('parameter'),parameter_id:id,parameter_version:z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/u)}).strict(),
])}).strict();
export type CalculationSourceBinding=z.infer<typeof bindingSchema>;
const inputSchema=bindingSchema.extend({value:valueSchema,source_sha256:sha}).strict();
const shape=z.object({
 schema_version:z.literal('tivdoc-source-calculation-trace-v1'),
 authority:z.literal('arithmetic_provenance_only'),
 calculation_id:z.uuid(),case_id:z.uuid(),analysis_run_id:id,calculated_at:z.iso.datetime({offset:true}),
 rule:z.object({rule_id:id,rule_version:z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/u)}).strict(),
 rule_package:ruleSpecPackageSchema,
 facts_snapshot:employmentSnapshotSchema,facts_snapshot_sha256:sha,rule_input_sha256:sha,catalog_sha256:sha,
 parameters:z.array(parameterCandidateSchema).max(64),inputs:z.array(inputSchema).max(128),
 steps:z.array(z.object({step_id:id,operation:id,input_refs:z.array(id).max(64),result:valueSchema}).strict()).min(1).max(128),
 execution_output:valueSchema,execution_trace_sha256:sha,execution_result_sha256:sha,
 output:calculationValueSchema,trace_sha256:sha,
}).strict();
type SourceTraceShape=z.infer<typeof shape>;

/** Only lossless projections of the saved fact. Unit conversion, inferred
 * amounts, period extrapolation and business/legal applicability belong to
 * separately reviewed rules, never this provenance adapter. */
function factValue(snapshot:EmploymentSnapshot,binding:Extract<CalculationSourceBinding['source'],{kind:'fact'}>):RuleSpecInputValue['value']{
 const fact=snapshot.facts.find(f=>f.fact_id===binding.fact_id);
 if(!fact||fact.status!=='confirmed'||fact.value===null)throw Error('TRACE_FACT_NOT_CONFIRMED');
 let value:unknown=fact.value;
 for(const key of binding.value_path){if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('TRACE_FACT_VALUE_PATH');value=(value as Record<string,unknown>)[key];}
 if(value===null)throw Error('TRACE_FACT_VALUE_MISSING');
 if(typeof value==='boolean')return {kind:'boolean',value};
 if(typeof value==='object'&&value&&'currency' in value&&'minor_units' in value)return valueSchema.parse({kind:'money',...value});
 if(typeof value==='object'&&value&&'amount' in value&&'unit' in value&&typeof value.amount==='string'&&typeof value.unit==='string'){
  const match=/^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value.amount);if(!match||value.amount.length>256)throw Error('TRACE_FACT_DECIMAL');
  const digits=match[2]??'';return valueSchema.parse({kind:'rational',numerator:BigInt(match[1]+digits).toString(),denominator:(BigInt(10)**BigInt(digits.length)).toString(),unit:value.unit});
 }
 if(typeof value==='number'&&Number.isSafeInteger(value)&&binding.value_path.at(-1)==='rate_basis_points')return {kind:'rational',numerator:String(value),denominator:'10000',unit:'ratio'};
 if(typeof value==='object'&&value&&'days' in value&&typeof value.days==='number'&&Number.isSafeInteger(value.days))return {kind:'integer',value:value.days,unit:'days'};
 throw Error('TRACE_FACT_VALUE_UNSUPPORTED');
}

function materialize(snapshot:EmploymentSnapshot,parameters:readonly ParameterCandidate[],bindings:readonly CalculationSourceBinding[]){
 if(snapshot.facts.length>128)throw Error('TRACE_RESOURCE_LIMIT');
 const ids=new Set<string>();
 return bindings.map(binding=>{
  if(ids.has(binding.input_id))throw Error('TRACE_DUPLICATE_INPUT');ids.add(binding.input_id);
  if(binding.source.kind==='fact'){
   const fact=snapshot.facts.find(f=>binding.source.kind==='fact'&&f.fact_id===binding.source.fact_id);
   const value=factValue(snapshot,binding.source);return {...binding,value,source_sha256:canonicalSha256(fact)};
  }
  const source=binding.source,matching=parameters.filter(p=>p.parameter_id===source.parameter_id&&p.parameter_version===source.parameter_version);
  if(matching.length!==1)throw Error('TRACE_PARAMETER_VERSION_MISSING');
  const parameter=matching[0],{candidate_sha256,...seed}=parameter;
  if(legalOperationsSha256(seed)!==candidate_sha256)throw Error('TRACE_PARAMETER_HASH');
  return {...binding,value:parameterAsInput(binding.input_id,parameter).value,source_sha256:candidate_sha256};
 });
}

function displayOutput(value:RuleSpecInputValue['value']):CalculationValue{
 if(value.kind==='money')return {kind:'money',value:{currency:value.currency,minor_units:value.minor_units}};
 if(value.kind==='boolean')return {kind:'boolean',value:value.value};
 if(value.kind==='integer')return {kind:'integer',value:value.value};
 return {kind:'text',value:`${value.numerator}/${value.denominator} ${value.unit}`};
}

function replay(trace:Pick<SourceTraceShape,'facts_snapshot'|'parameters'|'inputs'|'rule_package'>){
 const inputs=materialize(trace.facts_snapshot,trace.parameters,trace.inputs.map(({input_id,source})=>({input_id,source})));
 const facts=inputs.filter(i=>i.source.kind==='fact').map(i=>({ref_id:i.input_id,value:i.value}));
 const parameters=inputs.filter(i=>i.source.kind==='parameter').map(i=>({ref_id:i.input_id,value:i.value}));
 const parameterKeys=trace.parameters.map(p=>`${p.parameter_id}@${p.parameter_version}`);
 if(new Set(parameterKeys).size!==parameterKeys.length||parameterKeys.length!==parameters.length)throw Error('TRACE_PARAMETER_SET_MISMATCH');
 if(trace.parameters.some(p=>p.bindings.rule_spec_sha256!==trace.rule_package.content_sha256))throw Error('TRACE_PARAMETER_RULE_HASH');
 for(const declaration of trace.rule_package.parameters){const binding=inputs.find(i=>i.input_id===declaration.ref_id)?.source;
  if(binding?.kind!=='parameter'||binding.parameter_id!==declaration.parameter_id||binding.parameter_version!==declaration.parameter_version)throw Error('TRACE_RULE_PARAMETER_BINDING');
 }
 if(trace.rule_package.facts.some(f=>inputs.find(i=>i.input_id===f.ref_id)?.source.kind!=='fact'))throw Error('TRACE_RULE_FACT_BINDING');
 return {inputs,execution:executeRuleSpec({rule:trace.rule_package,facts,parameters})};
}

function validate(trace:SourceTraceShape){
 if(trace.facts_snapshot.case_id!==trace.case_id)throw Error('TRACE_CASE_MISMATCH');
 if(trace.facts_snapshot.analysis_run_id!==trace.analysis_run_id)throw Error('TRACE_ANALYSIS_RUN_MISMATCH');
 if(canonicalSha256(trace.facts_snapshot)!==trace.facts_snapshot_sha256)throw Error('TRACE_FACT_SNAPSHOT_HASH');
 const canonical=createCanonicalRuleInputSnapshot(trace.facts_snapshot);
 if(canonicalSha256({topic:trace.rule_package.topic,canonical_rule_input:canonical.reference})!==trace.rule_input_sha256)throw Error('TRACE_RULE_INPUT_HASH');
 if(trace.rule.rule_id!==trace.rule_package.rule_spec_id||trace.rule.rule_version!==trace.rule_package.rule_spec_version)throw Error('TRACE_RULE_VERSION');
 const {inputs,execution}=replay(trace);
 if(canonicalSha256(inputs)!==canonicalSha256(trace.inputs))throw Error('TRACE_INPUT_SOURCE_MISMATCH');
 if(canonicalSha256(execution.trace)!==canonicalSha256(trace.steps)||canonicalSha256(execution.output)!==canonicalSha256(trace.execution_output)
  ||execution.trace_sha256!==trace.execution_trace_sha256||execution.result_sha256!==trace.execution_result_sha256
  ||canonicalSha256(displayOutput(execution.output))!==canonicalSha256(trace.output))throw Error('TRACE_EXECUTION_MISMATCH');
 const {trace_sha256,...seed}=trace;if(canonicalSha256(seed)!==trace_sha256)throw Error('TRACE_CONTENT_HASH');
}

/** Full saved operands and packages make every step independently replayable.
 * This proves arithmetic provenance only. It grants no legal activation,
 * certainty, unpaid-gap semantics, customer publication or pricing authority. */
export const sourceCalculationTraceSchema=z.preprocess((input,ctx)=>{
 try{if(JSON.stringify(input).length<=1_000_000)return input;}catch{}
 ctx.addIssue({code:'custom',message:'TRACE_RESOURCE_LIMIT'});return z.NEVER;
},shape.superRefine((trace,ctx)=>{try{validate(trace);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'TRACE_INVALID'});}}));
export type SourceCalculationTrace=z.infer<typeof sourceCalculationTraceSchema>;
export const persistedCalculationTraceSchema=z.union([calculationTraceSchema,sourceCalculationTraceSchema]);
export type PersistedCalculationTrace=z.infer<typeof persistedCalculationTraceSchema>;

export function createSourceCalculationTrace(input:{calculationId:string;caseId:string;analysisRunId:string;calculatedAt:string;catalogSha256:string;facts:EmploymentSnapshot;rule:RuleSpecPackage;parameters:readonly ParameterCandidate[];bindings:readonly CalculationSourceBinding[]}):SourceCalculationTrace{
 const facts=employmentSnapshotSchema.parse(input.facts),rule=ruleSpecPackageSchema.parse(input.rule),parameters=input.parameters.map(p=>parameterCandidateSchema.parse(p));
 const bindings=input.bindings.map(b=>bindingSchema.parse(b)),inputs=materialize(facts,parameters,bindings);
 const {execution}=replay({facts_snapshot:facts,rule_package:rule,parameters,inputs});
 const canonical=createCanonicalRuleInputSnapshot(facts);
 const seed={schema_version:'tivdoc-source-calculation-trace-v1' as const,authority:'arithmetic_provenance_only' as const,
  calculation_id:input.calculationId,case_id:input.caseId,analysis_run_id:input.analysisRunId,calculated_at:input.calculatedAt,catalog_sha256:input.catalogSha256,
  rule:{rule_id:rule.rule_spec_id,rule_version:rule.rule_spec_version},rule_package:rule,facts_snapshot:facts,facts_snapshot_sha256:canonicalSha256(facts),
  rule_input_sha256:canonicalSha256({topic:rule.topic,canonical_rule_input:canonical.reference}),parameters,inputs,steps:execution.trace,
  execution_output:execution.output,execution_trace_sha256:execution.trace_sha256,execution_result_sha256:execution.result_sha256,output:displayOutput(execution.output)};
 return frozen(sourceCalculationTraceSchema.parse({...seed,trace_sha256:canonicalSha256(seed)}));
}
