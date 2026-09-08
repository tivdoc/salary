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

/** A comparison must be the interpreter's explicit final subtraction, not a
 * caller relabelling an entitlement/subtotal as an unpaid gap. Recorded money
 * must originate in a documented fact, never a legal parameter or an estimate.
 * Legal applicability, economic overlap and actual settlement remain separate. */
function operands(trace:SourceCalculationTrace,expectedRef:string,recordedRef:string){
 const final=trace.rule_package.nodes.find(n=>n.node_id===trace.rule_package.output_ref);
 if(final?.operation!=='subtract'||final.left_ref!==expectedRef||final.right_ref!==recordedRef
  ||expectedRef===recordedRef)throw Error('COMPARISON_REQUIRES_EXPLICIT_SUBTRACTION');
 const expectedStep=trace.steps.find(s=>s.step_id===expectedRef);
 const recorded=trace.inputs.find(i=>i.input_id===recordedRef);
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

function validate(value:ComparisonShape){
 const derived=operands(value.trace,value.expected_ref,value.recorded_ref);
 if(canonicalSha256(derived)!==canonicalSha256({expected:value.expected,recorded:value.recorded,signed_difference:value.signed_difference}))throw Error('COMPARISON_OPERAND_MISMATCH');
 const {sha256,...seed}=value;if(canonicalSha256(seed)!==sha256)throw Error('COMPARISON_HASH_MISMATCH');
}
export const sourceMonetaryComparisonSchema=shape.superRefine((value,ctx)=>{
 try{validate(value);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'COMPARISON_INVALID'});}
});
export type SourceMonetaryComparison=z.infer<typeof sourceMonetaryComparisonSchema>;

export function createSourceMonetaryComparison(input:{trace:SourceCalculationTrace;expectedRef:string;recordedRef:string}):SourceMonetaryComparison{
 const trace=sourceCalculationTraceSchema.parse(input.trace),values=operands(trace,input.expectedRef,input.recordedRef);
 const seed={schema_version:'tivdoc-source-monetary-comparison-v1' as const,authority:'arithmetic_provenance_only' as const,output_semantics:'expected_minus_recorded' as const,
  is_finding:false as const,pricing_allowed:false as const,trace,expected_ref:input.expectedRef,recorded_ref:input.recordedRef,...values,source_semantics:'recorded_document_amount_is_not_payment_settlement' as const};
 return deepFreeze(sourceMonetaryComparisonSchema.parse({...seed,sha256:canonicalSha256(seed)}));
}
