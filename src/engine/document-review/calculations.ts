import {z} from 'zod';
import {SOURCE_STRUCTURE_BLOCKER_POLICY,documentReviewSourceStructureSchema,validateReviewSourceStructure,reviewSourceStructureBlockers,sourceStructureEntries,balanceStructureGroupSha256} from './source-structure-evidence.ts';
import {canonicalSha256, deepFreeze} from '../rule-runtime/canonical.ts';
import {createRuleSpecPackage, executeRuleSpec, ruleSpecPackageSchema, type RuleSpecDraft, type RuleSpecInputValue} from '../legal-operations/rulespec.ts';

const id=z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/u);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const contextId=z.string().min(1).max(160);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
const state=z.enum(['observed','declared','missing','unknown','conflict','unreadable','stale','expired']);
const sourceSchema=z.object({document_id:contextId,version_id:contextId,file_sha256:hash,page:z.number().int().positive(),
 locator:z.string().min(1).max(500),label:z.string().min(1).max(300),
 reading:z.enum(['ai_document_review','provider_extraction','identified_document_reading','customer_declaration','questionnaire_declaration','source_research']),reading_receipt_sha256:hash,
}).strict();
const operandSchema=z.object({id,observation_id:contextId,state,printed_value:z.string().max(100).nullable(),
 representation:z.enum(['money_ils','decimal_quantity','hours_minutes','percent','integer','boolean']),
 quantity_unit:z.enum(['hours','hours_per_month','days','calendar_days','count','ratio','days_per_week','source_native_unknown']).nullable(),
 precision:z.enum(['printed_precision','source_exact']),source:sourceSchema,
}).strict();
const decisionSchema=z.object({decision_id:id,state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
 basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),
 explanation:z.string().min(1).max(1000),sources:z.array(sourceSchema).max(16),
 valid_until:z.iso.datetime().nullable(),
}).strict();
const productSchema=z.object({kind:z.literal('product'),money_ref:id,factor_refs:z.array(id).min(1).max(2),recorded_ref:id,
 rounding:z.enum(['exact','toward_zero','half_up','half_even']),rounding_basis:z.string().min(1).max(500)}).strict();
const reconciliationSchema=z.object({kind:z.literal('reconciliation'),add_refs:z.array(id).min(1).max(24),subtract_refs:z.array(id).max(24),
 recorded_ref:id,inventory_complete:z.boolean(),inventory_basis:z.string().min(1).max(500),
 // Premium hours may refer to hours already in ordinary/rest/overtime rows.
 disjoint_components:z.boolean(),overlap_basis:z.string().min(1).max(500),
}).strict();
const observedRatioSchema=z.object({kind:z.literal('observed_ratio'),numerator_ref:id,denominator_ref:id,
 component_identity:z.string().min(1).max(300),same_period_and_base:z.boolean(),basis:z.string().min(1).max(500)}).strict();
const comparisonSchema=z.object({kind:z.literal('quantity_comparison'),left_ref:id,right_ref:id,
 interpretation:z.enum(['same_measure','different_source_representations','unresolved_scope'])}).strict();
const candidateSchema=z.object({kind:z.literal('candidate_rule'),rule:ruleSpecPackageSchema,
 fact_bindings:z.array(z.object({ref_id:id,operand_id:id}).strict()).max(64),
 parameter_bindings:z.array(z.object({ref_id:id,operand_id:id}).strict()).max(64),
 required_decision_ids:z.array(id).min(1).max(32),decisions:z.array(decisionSchema).max(32),
 expected_output_ref:id.nullable(),recorded_ref:id.nullable(),
 // Opt-in comparison; old candidate receipts retain their exact null-difference semantics.
 comparison:z.object({schema_version:z.literal('candidate-comparison-v1'),expected_ref:id,recorded_ref:id,difference_ref:id,
  recorded_basis:z.enum(['document_amount','document_allocation','identified_answer'])}).strict().optional(),
 recorded_source_evidence:z.object({schema_version:z.literal('candidate-recorded-source-evidence-v1'),
  calculation:z.unknown(),calculation_sha256:hash,numerator_operand_id:id,recorded_operand_id:id}).strict().optional(),
 // Counterfactual conditions remain unresolved. This does not change the decision,
 // a source observation, a confidence status, or the REAL authority boundary.
 conditional_assumptions:z.array(z.object({decision_id:id,explanation:z.string().min(1).max(1000)}).strict()).min(1).max(32).optional(),
 execution_preconditions:z.array(id).min(1).max(16).optional(),
}).strict();

export const DOCUMENT_REVIEW_CALCULATION_POLICY={version:'document-review-calculation-v1',
 engine:'executeRuleSpec',human_approval_claim:false,real_authority_granted:false,
 remittance_is_independent:true,observed_ratio_is_legal_rate:false} as const;

export const documentReviewCalculationInputSchema=z.object({
 schema_version:z.literal('document-review-calculation-input-v1'),case_id:contextId,run_id:contextId,check_id:id,period,
 evaluated_at:z.iso.datetime(),
 source_manifest:z.array(z.object({document_id:contextId,version_id:contextId,file_sha256:hash,page_count:z.number().int().positive(),
   kind:z.enum(['case_document','customer_answer','questionnaire','legal_source']),case_id:contextId.nullable(),
 }).strict()).min(1).max(64),
 operands:z.array(operandSchema).min(1).max(64),
 source_structure:documentReviewSourceStructureSchema.optional(),
 input_basis_policy:z.literal('all-consumed-citations-v2').optional(),
 operation:z.discriminatedUnion('kind',[productSchema,reconciliationSchema,observedRatioSchema,comparisonSchema,candidateSchema]),
 remittance_status:z.enum(['not_assessed','missing','unverified','confirmed']).default('not_assessed'),
}).strict();
export type DocumentReviewCalculationInput=z.infer<typeof documentReviewCalculationInputSchema>;
export type DocumentReviewOperand=z.infer<typeof operandSchema>;
export type DocumentReviewSource=z.infer<typeof sourceSchema>;
type Value=RuleSpecInputValue['value'];
type Blocker={dependency_id:string;state:string;reason:string};

function decimal(raw:string){
 if(raw.includes(',')&&!/^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,8})?$/u.test(raw))throw Error('DOCUMENT_REVIEW_NUMBER_FORMAT');
 const match=/^(-?)(0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/u.exec(raw.replaceAll(',',''));
 if(!match)throw Error('DOCUMENT_REVIEW_NUMBER_FORMAT');
 return {numerator:BigInt((match[1]||'')+match[2]+(match[3]??'')),denominator:BigInt(10)**BigInt(match[3]?.length??0)};
}
function parseValue(operand:DocumentReviewOperand,input:DocumentReviewCalculationInput):Value{
 const raw=operand.printed_value;
 if(!['observed','declared'].includes(operand.state)||raw===null)throw Error('DOCUMENT_REVIEW_OBSERVATION_REQUIRED');
 if(operand.representation==='boolean'){
  if(operand.quantity_unit!==null||!['true','false'].includes(raw))throw Error('DOCUMENT_REVIEW_BOOLEAN');
  return {kind:'boolean',value:raw==='true'};
 }
 if(operand.representation==='hours_minutes'){
  // Attendance cells commonly print two hour digits (08:05 / 00:30).
  // Preserve those source bytes while parsing the same exact minute count.
  const match=/^(0?\d|[1-9]\d{1,6}):([0-5]\d)$/u.exec(raw);
  if(!match||!['hours','hours_per_month'].includes(operand.quantity_unit??''))throw Error('DOCUMENT_REVIEW_HOURS_MINUTES');
  return {kind:'rational',numerator:(BigInt(match[1])*BigInt(60)+BigInt(match[2])).toString(),denominator:'60',unit:operand.quantity_unit!};
 }
 const number=decimal(raw);
 if(operand.representation==='money_ils'){
  if(operand.quantity_unit!==null||number.denominator>BigInt(100))throw Error('DOCUMENT_REVIEW_MONEY_PRECISION');
  const minor=number.numerator*BigInt(100)/number.denominator;
  if(minor>BigInt(Number.MAX_SAFE_INTEGER)||minor<BigInt(Number.MIN_SAFE_INTEGER))throw Error('DOCUMENT_REVIEW_MONEY_BOUNDS');
  return {kind:'money',currency:'ILS',minor_units:Number(minor)};
 }
 if(!operand.quantity_unit)throw Error('DOCUMENT_REVIEW_QUANTITY_UNIT');
 if(operand.representation==='percent'){
  if(operand.quantity_unit!=='ratio')throw Error('DOCUMENT_REVIEW_PERCENT_UNIT');
  return {kind:'rational',numerator:number.numerator.toString(),denominator:(number.denominator*BigInt(100)).toString(),unit:'ratio'};
 }
 if(operand.representation==='integer'){
  if(number.denominator!==BigInt(1)||number.numerator>BigInt(Number.MAX_SAFE_INTEGER)||number.numerator<BigInt(Number.MIN_SAFE_INTEGER))throw Error('DOCUMENT_REVIEW_INTEGER');
  return {kind:'integer',value:Number(number.numerator),unit:operand.quantity_unit};
 }
 return {kind:'rational',numerator:number.numerator.toString(),denominator:number.denominator.toString(),unit:operand.quantity_unit==='source_native_unknown'?`source.balance.${balanceStructureGroupSha256(input.source_structure!)}`:operand.quantity_unit};
}
function operationRefs(input:DocumentReviewCalculationInput){
 const op=input.operation;
 switch(op.kind){
  case 'product':return [op.money_ref,...op.factor_refs,op.recorded_ref];
  case 'reconciliation':return [...op.add_refs,...op.subtract_refs,op.recorded_ref];
  case 'observed_ratio':return [op.numerator_ref,op.denominator_ref];
  case 'quantity_comparison':return [op.left_ref,op.right_ref];
  case 'candidate_rule':{
   const bound=[...op.fact_bindings,...op.parameter_bindings].map(b=>b.operand_id);
   return bound.concat(op.recorded_ref&&!bound.includes(op.recorded_ref)?[op.recorded_ref]:[]);
  }
 }
}
function assertSource(source:DocumentReviewSource,input:DocumentReviewCalculationInput){
 const manifest=input.source_manifest.filter(d=>d.document_id===source.document_id&&d.version_id===source.version_id);
 if(manifest.length!==1||manifest[0].file_sha256!==source.file_sha256||source.page>manifest[0].page_count)throw Error('DOCUMENT_REVIEW_SOURCE_BINDING');
 const document=manifest[0];
 if(document.kind==='legal_source'?document.case_id!==null:document.case_id!==input.case_id)throw Error('DOCUMENT_REVIEW_FOREIGN_CASE');
 if(source.reading==='customer_declaration'&&document.kind!=='customer_answer'||source.reading==='questionnaire_declaration'&&document.kind!=='questionnaire')throw Error('DOCUMENT_REVIEW_DECLARATION_SOURCE');
}
function validate(input:DocumentReviewCalculationInput){
 validateReviewSourceStructure(input);
 if(input.period.to<input.period.from)throw Error('DOCUMENT_REVIEW_PERIOD');
 if(new Set(input.operands.map(o=>o.id)).size!==input.operands.length)throw Error('DOCUMENT_REVIEW_DUPLICATE_OPERAND');
 if(new Set(input.source_manifest.map(d=>`${d.document_id}:${d.version_id}`)).size!==input.source_manifest.length)throw Error('DOCUMENT_REVIEW_DUPLICATE_SOURCE');
 for(const document of input.source_manifest)if(document.kind==='legal_source'?document.case_id!==null:document.case_id!==input.case_id)throw Error('DOCUMENT_REVIEW_FOREIGN_CASE');
 const refs=operationRefs(input);
 if(new Set(refs).size!==refs.length||refs.length!==input.operands.length||refs.some(ref=>!input.operands.some(o=>o.id===ref)))throw Error('DOCUMENT_REVIEW_OPERAND_SET');
 for(const operand of input.operands){
  assertSource(operand.source,input);
  if(['observed','declared'].includes(operand.state)&&operand.printed_value===null)throw Error('DOCUMENT_REVIEW_OBSERVATION_REQUIRED');
  const manifest=input.source_manifest.find(d=>d.document_id===operand.source.document_id&&d.version_id===operand.source.version_id)!;
  if(operand.state==='declared'&&!(operand.source.reading==='customer_declaration'&&manifest.kind==='customer_answer'||operand.source.reading==='questionnaire_declaration'&&manifest.kind==='questionnaire'))throw Error('DOCUMENT_REVIEW_DECLARED_SOURCE');
  if(operand.state==='observed'&&(['customer_declaration','questionnaire_declaration'].includes(operand.source.reading)||['customer_answer','questionnaire'].includes(manifest.kind)))throw Error('DOCUMENT_REVIEW_DECLARATION_NOT_DOCUMENT');
 }
 if(input.operation.kind==='candidate_rule'){
  const op=input.operation;
  if(new Set(op.required_decision_ids).size!==op.required_decision_ids.length||new Set(op.decisions.map(d=>d.decision_id)).size!==op.decisions.length)throw Error('DOCUMENT_REVIEW_DUPLICATE_DECISION');
  for(const decision of op.decisions)for(const source of decision.sources)assertSource(source,input);
  if(op.conditional_assumptions){
   if(new Set(op.conditional_assumptions.map(a=>a.decision_id)).size!==op.conditional_assumptions.length)throw Error('DOCUMENT_REVIEW_DUPLICATE_ASSUMPTION');
   for(const assumption of op.conditional_assumptions){
    const decision=op.decisions.find(d=>d.decision_id===assumption.decision_id);
    if(!op.required_decision_ids.includes(assumption.decision_id)||!decision||!['missing','unknown'].includes(decision.state)||!decision.sources.length)throw Error('DOCUMENT_REVIEW_ASSUMPTION_NOT_UNRESOLVED_SOURCED_DECISION');
    if(decision.valid_until!==null&&Date.parse(decision.valid_until)<=Date.parse(input.evaluated_at))throw Error('DOCUMENT_REVIEW_ASSUMPTION_EXPIRED');
   }
  }
  if(op.comparison){
   const c=op.comparison,node=op.rule.nodes.find(n=>n.node_id===c.difference_ref);
   if(op.expected_output_ref!==c.expected_ref||op.rule.output_ref!==c.difference_ref||op.recorded_ref!==null||!node||node.operation!=='subtract'||node.left_ref!==c.expected_ref||node.right_ref!==c.recorded_ref)throw Error('DOCUMENT_REVIEW_COMPARISON_BINDING');
   // Neither amount may be a freestanding parameter masquerading as a case result.
   const refs=new Set([...op.rule.facts.map(f=>f.ref_id),...op.rule.nodes.map(n=>n.node_id)]);
   if(!refs.has(c.expected_ref)||!refs.has(c.recorded_ref))throw Error('DOCUMENT_REVIEW_COMPARISON_BINDING');
  }
  if(op.recorded_source_evidence){
   const e=op.recorded_source_evidence,nested=documentReviewCalculationInputSchema.parse(e.calculation);
   if(canonicalSha256(nested)!==e.calculation_sha256||nested.case_id!==input.case_id
    ||canonicalSha256(nested.period)!==canonicalSha256(input.period)||nested.operation.kind!=='observed_ratio'
    ||nested.source_structure?.kind!=='source_relationship'||nested.operation.numerator_ref!==e.numerator_operand_id
    ||!op.comparison||op.fact_bindings.find(b=>b.ref_id===op.comparison!.recorded_ref)?.operand_id!==e.recorded_operand_id)
    throw Error('DOCUMENT_REVIEW_RECORDED_RELATIONSHIP_BINDING');
   // The existing relationship witness checks exact row/cell, fund/base,
   // version, month and identified reading. No recursive candidate is allowed.
   validate(nested);
   if(blockers(nested).length)throw Error('DOCUMENT_REVIEW_RECORDED_RELATIONSHIP_UNRESOLVED');
   for(const operand of nested.operands)parseValue(operand,nested);
   const original=nested.operands.find(o=>o.id===e.numerator_operand_id),recorded=input.operands.find(o=>o.id===e.recorded_operand_id);
   if(!original||!recorded||canonicalSha256({...original,id:recorded.id})!==canonicalSha256(recorded))throw Error('DOCUMENT_REVIEW_RECORDED_RELATIONSHIP_AMOUNT');
   for(const pin of nested.source_manifest)if(!input.source_manifest.some(p=>canonicalSha256(p)===canonicalSha256(pin)))throw Error('DOCUMENT_REVIEW_RECORDED_RELATIONSHIP_SOURCE');
  }
  if(op.execution_preconditions&&(new Set(op.execution_preconditions).size!==op.execution_preconditions.length||op.execution_preconditions.some(ref=>op.rule.nodes.find(n=>n.node_id===ref)?.operation!=='compare.gte')))throw Error('DOCUMENT_REVIEW_PRECONDITION_REF');
  const factRefs=op.fact_bindings.map(b=>b.ref_id),paramRefs=op.parameter_bindings.map(b=>b.ref_id);
  if(new Set(factRefs).size!==factRefs.length||new Set(paramRefs).size!==paramRefs.length)throw Error('DOCUMENT_REVIEW_DUPLICATE_BINDING');
  // A caller cannot substitute a modified rule while retaining its old hash.
  const {content_sha256,...draft}=op.rule;
  if(createRuleSpecPackage(draft).content_sha256!==content_sha256)throw Error('DOCUMENT_REVIEW_RULE_HASH');
  for(const version of op.rule.source_version_ids)if(!input.source_manifest.some(s=>s.version_id===version))throw Error('DOCUMENT_REVIEW_RULE_SOURCE_VERSION');
 }
}
function blockers(input:DocumentReviewCalculationInput):Blocker[]{
 const result:Blocker[]=[...reviewSourceStructureBlockers(input),...input.operands.filter(o=>!['observed','declared'].includes(o.state)).map(o=>({dependency_id:o.id,state:o.state,reason:'source_observation_not_usable'}))];
 const op=input.operation;
 if(op.kind==='reconciliation'){
  if(!op.inventory_complete)result.push({dependency_id:'inventory.complete',state:'missing',reason:'subtotal_inventory_incomplete'});
  if(!op.disjoint_components)result.push({dependency_id:'inventory.disjoint',state:'conflict',reason:'overlapping_components_may_double_count'});
 }
 if(op.kind==='observed_ratio'&&!op.same_period_and_base&&input.source_structure?.blocker_policy!==SOURCE_STRUCTURE_BLOCKER_POLICY)result.push({dependency_id:'ratio.base',state:'unknown',reason:'ratio_period_or_base_unresolved'});
 if(op.kind==='candidate_rule'){
  if(input.period.from<op.rule.effective_period.from||(op.rule.effective_period.to!==null&&input.period.to>op.rule.effective_period.to))result.push({dependency_id:'rule.period',state:'stale',reason:'rule_does_not_cover_calculation_period'});
  for(const required of op.required_decision_ids){
   const decision=op.decisions.find(d=>d.decision_id===required);
   if(!decision){result.push({dependency_id:required,state:'missing',reason:'required_applicability_decision_absent'});continue;}
   if(decision.state!=='accepted'&&!op.conditional_assumptions?.some(a=>a.decision_id===required))result.push({dependency_id:required,state:decision.state,reason:'applicability_not_accepted'});
   else if(!decision.sources.length)result.push({dependency_id:required,state:'missing',reason:'applicability_source_missing'});
   else if(decision.valid_until!==null&&decision.valid_until<=input.evaluated_at)result.push({dependency_id:required,state:'expired',reason:'applicability_expired'});
   else if(decision.basis==='customer_declaration')result.push({dependency_id:required,state:'unknown',reason:'declaration_alone_is_not_rule_applicability'});
  }
 }
 return result;
}

/** Source-bound review arithmetic and conditional candidates. No authority is
 * conferred; product persistence/publication must retain these qualifiers. */
export function calculateDocumentReview(candidate:unknown){
 const input=documentReviewCalculationInputSchema.parse(candidate);validate(input);
 const blocked=blockers(input);
 const op=input.operation;
 // Per-check identity is stable across worker attempts and run IDs. Evaluation
 // time only matters through a changed expiry outcome, never as a random salt.
 const {run_id: _run,evaluated_at: _time,remittance_status: _remittance,...dependencies}=input;
 void _run;void _time;void _remittance;
 const usedSources=[...input.operands.map(o=>o.source),...(op.kind==='candidate_rule'?op.decisions.flatMap(d=>d.sources):[])];
 dependencies.source_manifest=dependencies.source_manifest.filter(s=>usedSources.some(u=>u.document_id===s.document_id&&u.version_id===s.version_id)||(op.kind==='candidate_rule'&&op.rule.source_version_ids.includes(s.version_id)));
 const dependency_fingerprint=canonicalSha256({policy:DOCUMENT_REVIEW_CALCULATION_POLICY,dependencies,gate_outcomes:blocked});
 const common={schema_version:'document-review-calculation-receipt-v1' as const,policy:DOCUMENT_REVIEW_CALCULATION_POLICY,input,
  dependency_fingerprint,claim:op.kind==='candidate_rule'?'conditional_entitlement_candidate':op.kind==='observed_ratio'?'observed_ratio':'document_arithmetic',
  remittance_status:input.remittance_status,input_basis:(input.input_basis_policy==='all-consumed-citations-v2'?usedSources.some(s=>['customer_declaration','questionnaire_declaration'].includes(s.reading)):input.operands.some(o=>o.source.reading==='customer_declaration'))?'includes_customer_declaration':'document_only',legal_requirement_status:op.kind==='candidate_rule'?'conditional_not_real_approval':'not_determined',
  human_attestation:null,real_activation_allowed:false,
  ...(input.source_structure?{source_structure_qualification:{kind:input.source_structure.kind,legal_entitlement_assessed:false as const,
   ...(input.source_structure.kind==='balance_movement'?{unit:input.operands.find(o=>o.state==='observed')?.quantity_unit??null,group_sha256:balanceStructureGroupSha256(input.source_structure)}:{})}}:{}),
  ...(op.kind==='candidate_rule'&&op.conditional_assumptions?{unresolved_conditions:op.conditional_assumptions.map(a=>({decision:op.decisions.find(d=>d.decision_id===a.decision_id)!,assumption:a.explanation})),counterfactual_only:true as const}:{}),
  ...(op.kind==='candidate_rule'&&op.comparison?{comparison_basis:op.comparison.recorded_basis}:{}),
 };
 if(blocked.length)return deepFreeze({...common,state:'blocked' as const,blockers:blocked,execution:null,expected:null,recorded:null,difference:null,observed_ratio:null});
 const values=new Map(input.operands.map(o=>[o.id,parseValue(o,input)]));
 const get=(ref:string)=>values.get(ref)!;
 const transformations:{operand_id:string;kind:string;from:Value;to:Value}[]=[];
 let facts:RuleSpecInputValue[]=input.operands.map(o=>({ref_id:`fact.${o.id}`,value:get(o.id)}));
 let parameters:RuleSpecInputValue[]=[];
 let rule;
 let expectedRef:string|null='review.expected';
 let recorded:Value|null=null;
 if(op.kind==='candidate_rule'){
  facts=op.fact_bindings.map(b=>({ref_id:b.ref_id,value:get(b.operand_id)}));
  parameters=op.parameter_bindings.map(b=>({ref_id:b.ref_id,value:get(b.operand_id)}));
  rule=op.rule;expectedRef=op.expected_output_ref;recorded=op.recorded_ref?get(op.recorded_ref):null;
 }else{
  const nodes:RuleSpecDraft['nodes'][number][]=[];
  if(op.kind==='product'){
   if(get(op.money_ref).kind!=='money'||get(op.recorded_ref).kind!=='money')throw Error('DOCUMENT_REVIEW_PRODUCT_MONEY');
   const factorRefs=op.factor_refs.map((ref,index)=>{
    const v=get(ref);if(v.kind!=='rational'&&v.kind!=='integer')throw Error('DOCUMENT_REVIEW_PRODUCT_FACTOR');
    if(v.unit==='ratio'&&v.kind==='rational')return `fact.${ref}`;
    nodes.push({node_id:`review.unit.${index}`,operation:'constant.rational',value:'1',unit:v.unit},{node_id:`review.factor.${index}`,operation:'divide',left_ref:`fact.${ref}`,right_ref:`review.unit.${index}`});
    return `review.factor.${index}`;
   });
   if(factorRefs.length===2)nodes.push({node_id:'review.combined',operation:'multiply',left_ref:factorRefs[0],right_ref:factorRefs[1]});
   nodes.push({node_id:'review.expected',operation:'money.scale',money_ref:`fact.${op.money_ref}`,rational_ref:factorRefs.length===2?'review.combined':factorRefs[0],rounding:op.rounding});
   recorded=get(op.recorded_ref);nodes.push({node_id:'review.difference',operation:'subtract',left_ref:'review.expected',right_ref:`fact.${op.recorded_ref}`});
  }else if(op.kind==='reconciliation'){
   nodes.push({node_id:'review.added',operation:'aggregate.bounded',refs:op.add_refs.map(ref=>`fact.${ref}`)});
   if(op.subtract_refs.length)nodes.push({node_id:'review.subtracted',operation:'aggregate.bounded',refs:op.subtract_refs.map(ref=>`fact.${ref}`)},{node_id:'review.expected',operation:'subtract',left_ref:'review.added',right_ref:'review.subtracted'});
   else nodes.push({node_id:'review.expected',operation:'aggregate.bounded',refs:['review.added']});
   recorded=get(op.recorded_ref);nodes.push({node_id:'review.difference',operation:'subtract',left_ref:'review.expected',right_ref:`fact.${op.recorded_ref}`});
  }else if(op.kind==='quantity_comparison'){
   const left=get(op.left_ref),right=get(op.right_ref);
   if(!['rational','integer'].includes(left.kind)||!['rational','integer'].includes(right.kind))throw Error('DOCUMENT_REVIEW_QUANTITY_COMPARISON');
   nodes.push({node_id:'review.expected',operation:'aggregate.bounded',refs:[`fact.${op.left_ref}`]},{node_id:'review.difference',operation:'subtract',left_ref:'review.expected',right_ref:`fact.${op.right_ref}`});
   recorded=right;
  }else{
   for(const ref of [op.numerator_ref,op.denominator_ref]){
    const v=get(ref);
    if(v.kind!=='money')throw Error('DOCUMENT_REVIEW_RATIO_MONEY');
    // Both values are exact source amounts in ILS. The interpreter cancels
    // their currency dimension; this is not a printed or legislated rate.
    const to:Value={kind:'rational',numerator:String(v.minor_units),denominator:'100',unit:'currency.ils'};
    transformations.push({operand_id:ref,kind:'money_to_exact_rational_same_currency',from:v,to});
    facts=facts.map(f=>f.ref_id===`fact.${ref}`?{...f,value:to}:f);
   }
   const denominator=get(op.denominator_ref);
   if(denominator.kind!=='money'||denominator.minor_units<=0)throw Error('DOCUMENT_REVIEW_RATIO_DENOMINATOR');
   nodes.push({node_id:'review.expected',operation:'divide',left_ref:`fact.${op.numerator_ref}`,right_ref:`fact.${op.denominator_ref}`});
  }
  rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:`document.review.${op.kind}.${dependency_fingerprint.slice(0,24)}`,rule_spec_version:'1.0.0',
   topic:'working_time',catalog_boundary:'real_inactive',source_version_ids:[...new Set(input.source_manifest.map(s=>`review.source.${s.file_sha256}`))],effective_period:input.period,
   sectors:['document.review'],populations:['document.review'],facts:facts.map(f=>({ref_id:f.ref_id,value_kind:f.value.kind,unit:f.value.kind==='money'?'currency.ils':f.value.kind==='boolean'?null:f.value.unit})),
   parameters:[],nodes,output_ref:op.kind==='observed_ratio'?'review.expected':'review.difference',golden_case_set_sha256:canonicalSha256(DOCUMENT_REVIEW_CALCULATION_POLICY),
   resource_policy:{max_steps:20,max_depth:16,max_aggregate_items:32,max_integer_digits:64}});
 }
 const execution=executeRuleSpec({rule,facts,parameters});
 if(op.kind==='candidate_rule'&&op.execution_preconditions){
  const failed=op.execution_preconditions.filter(ref=>{const value=execution.trace.find(t=>t.step_id===ref)?.result;return value?.kind!=='boolean'||value.value!==true;});
  if(failed.length)return deepFreeze({...common,state:'blocked' as const,blockers:failed.map(dependency_id=>({dependency_id,state:'unknown',reason:'rule_execution_precondition_false'})),execution:null,expected:null,recorded:null,difference:null,observed_ratio:null});
 }
 const expected=expectedRef===null?execution.output:execution.trace.find(t=>t.step_id===expectedRef)?.result??facts.find(f=>f.ref_id===expectedRef)?.value;
 if(expected===undefined)throw Error('DOCUMENT_REVIEW_EXPECTED_REF');
 // Candidate rules own their output semantics. Never assume a candidate's
 // output is a shortfall unless its caller identifies an output comparison.
 let difference=op.kind==='observed_ratio'||op.kind==='candidate_rule'?null:execution.output;
 if(op.kind==='candidate_rule'&&op.comparison){
  recorded=execution.trace.find(t=>t.step_id===op.comparison!.recorded_ref)?.result??facts.find(f=>f.ref_id===op.comparison!.recorded_ref)?.value??null;
  difference=execution.output;
  if(expected.kind!=='money'||recorded?.kind!=='money'||difference.kind!=='money'||expected.currency!==recorded.currency||expected.currency!==difference.currency||BigInt(expected.minor_units)-BigInt(recorded.minor_units)!==BigInt(difference.minor_units))throw Error('DOCUMENT_REVIEW_COMPARISON_AMOUNTS');
 }
 const assumptionBinding=op.kind==='candidate_rule'&&op.conditional_assumptions?{schema_version:'candidate-counterfactual-trace-v1',assumptions_sha256:canonicalSha256({assumptions:op.conditional_assumptions,decisions:op.decisions}),execution_trace_sha256:execution.trace_sha256,rule_sha256:rule.content_sha256,dependency_fingerprint}:null;
 const structureBinding=input.source_structure?{schema_version:'document-review-source-structure-trace-v1',source_structure_sha256:canonicalSha256(input.source_structure),
  reading_verification_sha256:sourceStructureEntries(input.source_structure).flatMap(e=>e.reading?[e.reading.verification_sha256]:[]),
  decision_sha256:sourceStructureEntries(input.source_structure).flatMap(e=>e.reading?[e.reading.decision_sha256]:[]),
  execution_trace_sha256:execution.trace_sha256,rule_sha256:rule.content_sha256,dependency_fingerprint}:null;
 const seed={...common,state:'calculated' as const,blockers:[],rule,facts,parameters,transformations,execution,expected,recorded,difference,
  ...(structureBinding?{source_structure_trace_binding:{...structureBinding,binding_sha256:canonicalSha256(structureBinding)}}:{}),
  ...(assumptionBinding?{conditional_trace_binding:{...assumptionBinding,binding_sha256:canonicalSha256(assumptionBinding)}}:{}),
  observed_ratio:op.kind==='observed_ratio'?execution.output:null,
  precision_warning:input.operands.some(o=>o.precision==='printed_precision')?'printed_precision_not_hidden_precision':null};
 return deepFreeze({...seed,result_sha256:canonicalSha256(seed)});
}
export type DocumentReviewCalculationResult=ReturnType<typeof calculateDocumentReview>;
export function replayDocumentReviewCalculation(receipt:unknown){
 if(!receipt||typeof receipt!=='object'||!('input' in receipt))throw Error('DOCUMENT_REVIEW_RECEIPT');
 const replay=calculateDocumentReview(receipt.input);
 if(canonicalSha256(receipt)!==canonicalSha256(replay))throw Error('DOCUMENT_REVIEW_REPLAY_MISMATCH');
 return replay;
}
