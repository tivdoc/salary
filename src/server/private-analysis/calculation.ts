import {canonicalSha256,deepFreeze} from '../../engine/rule-runtime/canonical.ts';
import {createRuleSpecPackage,executeRuleSpec,type RuleSpecInputValue,type RuleSpecDraft} from '../../engine/legal-operations/rulespec.ts';
import {privateCalculationInputSchema,type PrivateCalculationInput,type PrivateCalculationOperand} from './calculation-contracts.ts';

/** Private source arithmetic, using the product's existing interpreter. This
 * adapter grants no canonical fact confirmation, legal admission or Finding.
 * `working_time` is solely the interpreter's required routing namespace. */
export const PRIVATE_ARITHMETIC_POLICY={schema_version:'private-document-arithmetic-policy-v1',
 authority:'document_arithmetic_only',engine_routing_topic:'working_time',topic_coverage_claim:false,
 legal_entitlement_assessed:false,publication_allowed:false,pricing_allowed:false,human_attestation:null} as const;

function decimal(raw:string){
 // Group separators are accepted only in unambiguous three-digit groups.
 // The receipt always retains the original printed string unchanged.
 if(raw.includes(',')&&!/^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,8})?$/u.test(raw))throw Error('PRIVATE_ARITHMETIC_PRINTED_VALUE');
 const m=/^(-?)(0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/u.exec(raw.replaceAll(',',''));
 if(!m)throw Error('PRIVATE_ARITHMETIC_PRINTED_VALUE');
 return {numerator:BigInt((m[1]||'')+m[2]+(m[3]??'')),denominator:BigInt(10)**BigInt(m[3]?.length??0)};
}
function value(operand:PrivateCalculationOperand):RuleSpecInputValue['value']{
 if(operand.state!=='observed'||operand.printed_value===null)throw Error('PRIVATE_ARITHMETIC_OBSERVATION_REQUIRED');
 const raw=operand.printed_value;
 if(operand.representation==='money_ils'){
  if(operand.quantity_unit!==null||!/^(-?)(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/u.test(raw.replaceAll(',','')))throw Error('PRIVATE_ARITHMETIC_MONEY');
  const d=decimal(raw),minor=d.numerator*BigInt(100)/d.denominator;
  if(minor>BigInt(Number.MAX_SAFE_INTEGER)||minor<BigInt(Number.MIN_SAFE_INTEGER))throw Error('PRIVATE_ARITHMETIC_MONEY_BOUNDS');
  return {kind:'money',currency:'ILS',minor_units:Number(minor)};
 }
 if(operand.representation==='hours_minutes'){
  const m=/^(0|[1-9]\d{0,6}):([0-5]\d)$/u.exec(raw);
  if(!m||operand.quantity_unit!=='hours')throw Error('PRIVATE_ARITHMETIC_HOURS_MINUTES');
  return {kind:'rational',numerator:(BigInt(m[1])*BigInt(60)+BigInt(m[2])).toString(),denominator:'60',unit:'hours'};
 }
 const d=decimal(raw);
 if(operand.representation==='percent'){
  if(operand.quantity_unit!=='ratio')throw Error('PRIVATE_ARITHMETIC_PERCENT_UNIT');
  return {kind:'rational',numerator:d.numerator.toString(),denominator:(d.denominator*BigInt(100)).toString(),unit:'ratio'};
 }
 if(!operand.quantity_unit)throw Error('PRIVATE_ARITHMETIC_QUANTITY_UNIT');
 return {kind:'rational',numerator:d.numerator.toString(),denominator:d.denominator.toString(),unit:operand.quantity_unit};
}
function refs(input:PrivateCalculationInput){
 const op=input.operation;
 return op.kind==='product'?[op.money_ref,...op.factor_refs,op.recorded_ref]:[...op.add_refs,...op.subtract_refs,op.recorded_ref];
}
function validate(input:PrivateCalculationInput){
 if(input.period.to<input.period.from)throw Error('PRIVATE_ARITHMETIC_PERIOD');
 if(new Set(input.operands.map(o=>o.id)).size!==input.operands.length)throw Error('PRIVATE_ARITHMETIC_DUPLICATE_OPERAND');
 if(new Set(input.source_manifest.map(s=>`${s.document_id}:${s.version_id}`)).size!==input.source_manifest.length)throw Error('PRIVATE_ARITHMETIC_DUPLICATE_SOURCE');
 const used=refs(input);
 if(new Set(used).size!==used.length||used.length!==input.operands.length||used.some(id=>!input.operands.some(o=>o.id===id)))throw Error('PRIVATE_ARITHMETIC_OPERAND_SET');
 for(const o of input.operands){
  const matches=input.source_manifest.filter(s=>s.document_id===o.source.document_id&&s.version_id===o.source.version_id);
  if(matches.length!==1||matches[0].file_sha256!==o.source.file_sha256||o.source.page>matches[0].page_count)throw Error('PRIVATE_ARITHMETIC_SOURCE_BINDING');
  if(o.state==='observed'&&o.printed_value===null)throw Error('PRIVATE_ARITHMETIC_OBSERVATION_REQUIRED');
 }
}
export function calculatePrivateDocumentArithmetic(candidate:unknown){
 const input=privateCalculationInputSchema.parse(candidate);validate(input);
 const blocked=input.operands.filter(o=>o.state!=='observed').map(o=>({operand_id:o.id,state:o.state,source:o.source}));
 if(input.operation.kind==='reconciliation'&&!input.operation.inventory_complete)blocked.push({operand_id:'inventory.complete',state:'missing',source:input.operands[0].source});
 const input_sha256=canonicalSha256(input);
 if(blocked.length)return deepFreeze({...PRIVATE_ARITHMETIC_POLICY,state:'blocked' as const,input,input_sha256,blockers:blocked,execution:null});
 const facts=input.operands.map(o=>({ref_id:`fact.${o.id}`,value:value(o)}));
 const get=(id:string)=>facts.find(f=>f.ref_id===`fact.${id}`)!.value;
 const nodes:RuleSpecDraft['nodes'][number][]=[];
 const op=input.operation;
 if(op.kind==='product'){
  if(get(op.money_ref).kind!=='money'||get(op.recorded_ref).kind!=='money')throw Error('PRIVATE_ARITHMETIC_PRODUCT_MONEY');
  const factors=op.factor_refs.map((id,index)=>{
   const v=get(id);if(v.kind!=='rational')throw Error('PRIVATE_ARITHMETIC_PRODUCT_FACTOR');
   // Unit cancellation is an explicit interpreter step, never an inferred
   // quantity: the money is the document's rate per ONE displayed unit.
   if(v.unit==='ratio')return `fact.${id}`;
   nodes.push({node_id:`unit.factor.${index}`,operation:'constant.rational',value:'1',unit:v.unit},
    {node_id:`ratio.factor.${index}`,operation:'divide',left_ref:`fact.${id}`,right_ref:`unit.factor.${index}`});
   return `ratio.factor.${index}`;
  });
  if(factors.length===2)nodes.push({node_id:'ratio.combined',operation:'multiply',left_ref:factors[0],right_ref:factors[1]});
  nodes.push({node_id:'arithmetic.expected',operation:'money.scale',money_ref:`fact.${op.money_ref}`,rational_ref:factors.length===2?'ratio.combined':factors[0],rounding:op.rounding});
 }else{
  const added=op.add_refs.map(id=>`fact.${id}`),subtracted=op.subtract_refs.map(id=>`fact.${id}`);
  nodes.push({node_id:'arithmetic.added',operation:'aggregate.bounded',refs:added});
  if(subtracted.length){
   nodes.push({node_id:'arithmetic.subtracted',operation:'aggregate.bounded',refs:subtracted},
    {node_id:'arithmetic.expected',operation:'subtract',left_ref:'arithmetic.added',right_ref:'arithmetic.subtracted'});
  }else nodes.push({node_id:'arithmetic.expected',operation:'aggregate.bounded',refs:['arithmetic.added']});
 }
 nodes.push({node_id:'arithmetic.difference',operation:'subtract',left_ref:'arithmetic.expected',right_ref:`fact.${op.recorded_ref}`});
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:`private.document.arithmetic.${op.kind}.${input_sha256.slice(0,24)}`,rule_spec_version:'1.0.0',
  topic:'working_time',catalog_boundary:'real_inactive',source_version_ids:[...new Set(input.source_manifest.map(s=>`private.document.${s.file_sha256}`))],
  effective_period:input.period,sectors:['private.document.arithmetic'],populations:['private.document.arithmetic'],
  facts:facts.map(f=>({ref_id:f.ref_id,value_kind:f.value.kind,unit:f.value.kind==='money'?'currency.ils':f.value.kind==='rational'||f.value.kind==='integer'?f.value.unit:null})),
  parameters:[],nodes,output_ref:'arithmetic.difference',golden_case_set_sha256:canonicalSha256({policy:PRIVATE_ARITHMETIC_POLICY,independent_legal_goldens:false}),
  resource_policy:{max_steps:16,max_depth:16,max_aggregate_items:32,max_integer_digits:64}});
 const execution=executeRuleSpec({rule,facts,parameters:[]});
 const expected=execution.trace.find(s=>s.step_id==='arithmetic.expected')!.result;
 const seed={...PRIVATE_ARITHMETIC_POLICY,state:'calculated' as const,input,input_sha256,rule,facts,execution,
  expected,recorded:get(op.recorded_ref),difference:execution.output,
  rounding_interpretation:op.kind==='product'?'explicit_candidate_not_payroll_policy_proof':'exact_reconciliation',
  precision_warning:input.operands.some(o=>o.precision==='printed_precision')?'printed_precision_may_hide_source_precision':null};
 return deepFreeze({...seed,result_sha256:canonicalSha256(seed)});
}
/** Recompute from source-bound printed operands; a matching outer hash alone
 * does not establish that a saved result or its labels were not altered. */
export function replayPrivateDocumentArithmetic(result:unknown){
 if(!result||typeof result!=='object'||!('input' in result))throw Error('PRIVATE_ARITHMETIC_RECEIPT');
 const replayed=calculatePrivateDocumentArithmetic(result.input);
 if(canonicalSha256(result)!==canonicalSha256(replayed))throw Error('PRIVATE_ARITHMETIC_REPLAY_MISMATCH');
 return replayed;
}
