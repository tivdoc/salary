import {z} from 'zod';
import {sourceCalculationTraceSchema,type SourceCalculationTrace} from '../calculations/source-trace.ts';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {moneySchema,nonNegativeMoneySchema,domainCodeSchema} from '../domain/primitives.ts';

const shape=z.object({
 schema_version:z.literal('tivdoc-source-monetary-comparison-v1'),
 authority:z.literal('arithmetic_provenance_only'),
 output_semantics:z.literal('expected_minus_recorded'),
 is_finding:z.literal(false),pricing_allowed:z.literal(false),
 trace:sourceCalculationTraceSchema,
 expected_ref:domainCodeSchema,recorded_ref:domainCodeSchema,
 expected:nonNegativeMoneySchema,recorded:nonNegativeMoneySchema,signed_difference:moneySchema,
 source_semantics:z.literal('recorded_document_amount_is_not_payment_settlement'),
 sha256:z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
type ComparisonShape=z.infer<typeof shape>;

const boundedBindingSchema=z.object({
 kind:z.literal('bounded_single_documented_fact'),
 aggregate_ref:domainCodeSchema,input_ref:domainCodeSchema,
 source:z.object({kind:z.literal('fact'),fact_id:z.uuid(),value_path:z.array(z.enum(['employee','employer','amount','rate_basis_points'])).max(2)}).strict(),
 source_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 value:nonNegativeMoneySchema,
}).strict();
const boundedShape=shape.extend({
 schema_version:z.literal('tivdoc-source-monetary-comparison-v2'),
 recorded_binding:boundedBindingSchema,
}).strict();
type BoundedComparisonShape=z.infer<typeof boundedShape>;

/** A comparison must be the interpreter's explicit final subtraction, not a
 * caller relabelling an entitlement/subtotal as an unpaid gap. Recorded money
 * must originate in a documented fact, never a legal parameter or an estimate.
 * Legal applicability, economic overlap and actual settlement remain separate. */
function operands(trace:SourceCalculationTrace,expectedRef:string,recordedRef:string,recordedInputRef=recordedRef){
 const final=trace.rule_package.nodes.find(n=>n.node_id===trace.rule_package.output_ref);
 if(final?.operation!=='subtract'||final.left_ref!==expectedRef||final.right_ref!==recordedRef
  ||expectedRef===recordedRef)throw Error('COMPARISON_REQUIRES_EXPLICIT_SUBTRACTION');
 const expectedStep=trace.steps.find(s=>s.step_id===expectedRef);
 const recorded=trace.inputs.find(i=>i.input_id===recordedInputRef);
 if(!expectedStep||recorded?.source.kind!=='fact')throw Error('COMPARISON_OPERAND_SOURCE');
 const source=recorded.source,fact=trace.facts_snapshot.facts.find(f=>f.fact_id===source.fact_id);
 if(!fact||!fact.provenance.some(p=>p.source_type==='documented'))throw Error('COMPARISON_RECORDED_DOCUMENT_REQUIRED');
 const allowedDirect=new Set(['compensation.base_monthly_salary','compensation.gross_salary','compensation.overtime_pay','compensation.weekly_rest_pay','travel.reimbursement','convalescence.payment','pension.severance_contribution']);
 const direct=allowedDirect.has(fact.path)&&source.value_path.length===0;
 const pension=fact.path==='pension.contributions'&&source.value_path.length===2
  &&['employee','employer'].includes(source.value_path[0])&&source.value_path[1]==='amount';
 if(!direct&&!pension)throw Error('COMPARISON_RECORDED_COMPONENT_REQUIRED');
 if(expectedStep.result.kind!=='money'||recorded.value.kind!=='money'||trace.execution_output.kind!=='money')throw Error('COMPARISON_MONEY_REQUIRED');
 const money=(value:{currency:string;minor_units:number})=>({currency:value.currency,minor_units:value.minor_units});
 const expected=nonNegativeMoneySchema.parse(money(expectedStep.result));
 const paid=nonNegativeMoneySchema.parse(money(recorded.value));
 const difference=moneySchema.parse(money(trace.execution_output));
 if(expected.currency!==paid.currency||difference.currency!==expected.currency)throw Error('COMPARISON_CURRENCY_MISMATCH');
 return {expected,recorded:paid,signed_difference:difference};
}

/** A one-item bounded aggregate is a lossless reference to its direct operand.
 * Do not flatten nested aggregates or infer a legally eligible component set.
 * The original package, source fact and replayed step remain in the trace. */
function boundedOperands(trace:SourceCalculationTrace,expectedRef:string,recordedRef:string){
 const aggregate=trace.rule_package.nodes.find(n=>n.node_id===recordedRef);
 if(aggregate?.operation!=='aggregate.bounded'||aggregate.refs.length!==1)throw Error('COMPARISON_BOUNDED_SINGLE_INPUT_REQUIRED');
 const recorded=trace.inputs.find(i=>i.input_id===aggregate.refs[0]);
 if(recorded?.source.kind!=='fact')throw Error('COMPARISON_BOUNDED_DIRECT_FACT_REQUIRED');
 const values=operands(trace,expectedRef,recordedRef,recorded.input_id);
 const step=trace.steps.find(s=>s.step_id===recordedRef);
 if(!step||step.operation!=='aggregate.bounded'||canonicalSha256(step.input_refs)!==canonicalSha256([recorded.input_id])
  ||canonicalSha256(step.result)!==canonicalSha256(recorded.value))throw Error('COMPARISON_BOUNDED_VALUE_MISMATCH');
 const recorded_binding={kind:'bounded_single_documented_fact' as const,aggregate_ref:recordedRef,input_ref:recorded.input_id,
  source:recorded.source,source_sha256:recorded.source_sha256,value:values.recorded};
 return {...values,recorded_binding};
}

function validate(value:ComparisonShape){
 const derived=operands(value.trace,value.expected_ref,value.recorded_ref);
 if(canonicalSha256(derived)!==canonicalSha256({expected:value.expected,recorded:value.recorded,signed_difference:value.signed_difference}))throw Error('COMPARISON_OPERAND_MISMATCH');
 const {sha256,...seed}=value;if(canonicalSha256(seed)!==sha256)throw Error('COMPARISON_HASH_MISMATCH');
}
export const sourceMonetaryComparisonV1Schema=shape.superRefine((value,ctx)=>{
 try{validate(value);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'COMPARISON_INVALID'});}
});
function validateBounded(value:BoundedComparisonShape){
 const derived=boundedOperands(value.trace,value.expected_ref,value.recorded_ref);
 if(canonicalSha256(derived)!==canonicalSha256({expected:value.expected,recorded:value.recorded,signed_difference:value.signed_difference,recorded_binding:value.recorded_binding}))throw Error('COMPARISON_OPERAND_MISMATCH');
 const {sha256,...seed}=value;if(canonicalSha256(seed)!==sha256)throw Error('COMPARISON_HASH_MISMATCH');
}
export const sourceMonetaryComparisonV2Schema=boundedShape.superRefine((value,ctx)=>{
 try{validateBounded(value);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'COMPARISON_INVALID'});}
});
export const sourceMonetaryComparisonSchema=z.discriminatedUnion('schema_version',[sourceMonetaryComparisonV1Schema,sourceMonetaryComparisonV2Schema]);
export type SourceMonetaryComparisonV1=z.infer<typeof sourceMonetaryComparisonV1Schema>;
export type SourceMonetaryComparisonV2=z.infer<typeof sourceMonetaryComparisonV2Schema>;
export type SourceMonetaryComparison=z.infer<typeof sourceMonetaryComparisonSchema>;

export function createSourceMonetaryComparison(input:{trace:SourceCalculationTrace;expectedRef:string;recordedRef:string}):SourceMonetaryComparison{
 const trace=sourceCalculationTraceSchema.parse(input.trace);
 if(trace.rule_package.nodes.find(n=>n.node_id===input.recordedRef)?.operation==='aggregate.bounded'){
  const values=boundedOperands(trace,input.expectedRef,input.recordedRef);
  const seed={schema_version:'tivdoc-source-monetary-comparison-v2' as const,authority:'arithmetic_provenance_only' as const,output_semantics:'expected_minus_recorded' as const,
   is_finding:false as const,pricing_allowed:false as const,trace,expected_ref:input.expectedRef,recorded_ref:input.recordedRef,...values,source_semantics:'recorded_document_amount_is_not_payment_settlement' as const};
  return deepFreeze(sourceMonetaryComparisonV2Schema.parse({...seed,sha256:canonicalSha256(seed)}));
 }
 const values=operands(trace,input.expectedRef,input.recordedRef);
 const seed={schema_version:'tivdoc-source-monetary-comparison-v1' as const,authority:'arithmetic_provenance_only' as const,output_semantics:'expected_minus_recorded' as const,
  is_finding:false as const,pricing_allowed:false as const,trace,expected_ref:input.expectedRef,recorded_ref:input.recordedRef,...values,source_semantics:'recorded_document_amount_is_not_payment_settlement' as const};
 return deepFreeze(sourceMonetaryComparisonSchema.parse({...seed,sha256:canonicalSha256(seed)}));
}
