import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema,type DocumentReviewSource} from '../document-review/calculations.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {minimumWageCaseRecipeBindingSchema,minimumWageEntitlementInputSchema,type MinimumWageEntitlementInput} from '../entitlement-review/minimum-wage/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';
import {productAgeRangeSelection} from '../entitlement-review/product-age-range.ts';

const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
const usable=(f:Fact)=>['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
function atPath(value:unknown,path:string):unknown{let current=value;for(const key of path.split('.')){
 if(!current||typeof current!=='object'||!Object.hasOwn(current,key))return null;current=(current as Record<string,unknown>)[key];}return current;}
function sourceHashes(value:unknown):string[]{const out:string[]=[];const visit=(v:unknown):void=>{
 if(!v||typeof v!=='object')return;if(record(v)&&'reading_receipt_sha256'in v&&'file_sha256'in v){out.push(canonicalSha256(v));return;}
 Object.values(v).forEach(visit);};visit(value);return [...new Set(out)];}
function locator(s:DocumentReviewSource){try{const v:unknown=JSON.parse(s.locator);return record(v)&&v.schema_version==='document-review-source-locator-v2'?v:null;}catch{return null;}}
function scalar(s:DocumentReviewSource,field:string){const l=locator(s);return l?.field===field&&Array.isArray(l.candidate_ids)&&l.candidate_ids.length===1
 &&Array.isArray(l.candidate_sha256)&&l.candidate_sha256.length===1&&typeof l.candidate_ids[0]==='string'&&typeof l.candidate_sha256[0]==='string'&&/^[a-f0-9]{64}$/u.test(l.candidate_sha256[0]);}
function row(s:DocumentReviewSource){const l=locator(s);return l?.cell==='amount'&&Array.isArray(l.component_ids)&&l.component_ids.length===1
 &&Array.isArray(l.original_component_sha256)&&l.original_component_sha256.length===1&&Array.isArray(l.raw_values)&&l.raw_values.length===1
 &&typeof l.component_ids[0]==='string'&&typeof l.original_component_sha256[0]==='string'&&/^[a-f0-9]{64}$/u.test(l.original_component_sha256[0])&&l.raw_values[0]!==null?l:null;}
function sameDocument(a:DocumentReviewSource,b:DocumentReviewSource){return a.document_id===b.document_id&&a.version_id===b.version_id&&a.file_sha256===b.file_sha256&&a.reading_receipt_sha256===b.reading_receipt_sha256;}
function physical(s:DocumentReviewSource,input:MinimumWageEntitlementInput,source:DocumentReviewInput){
 return ['identified_document_reading','provider_extraction'].includes(s.reading)&&source.case_id===input.case_id&&same(source.period,input.period)
 &&source.documents.some(d=>d.case_id===input.case_id&&d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256
  &&d.kind==='payslip'&&same(d.period,input.period)&&d.page_count!==null&&s.page>=1&&s.page<=d.page_count
  &&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256));
}
/** Only original source checks are consumed, never this branch's calculated
 * output. This projection is identical before and after recomposition. */
function sourceContext(input:MinimumWageEntitlementInput,source:DocumentReviewInput){
 const ids=new Set([input.ordinary_hours?.source.document_id,...input.components.map(c=>c.amount.source.document_id)]);
 return {documents:source.documents.filter(d=>ids.has(d.document_id)),checks:source.checks.filter(c=>c.printed_inventory&&ids.has(c.printed_inventory.document_id))};
}
export function minimumWageCaseConsumed(input:MinimumWageEntitlementInput,paths:readonly string[],source:DocumentReviewInput){
 const context=sourceContext(input,source);return [...paths.map(path=>({path:'entitlement_evidence.minimum_wage.'+path,value:atPath(input,path)})),
  ...Object.entries(context).map(([path,value])=>({path:'source_context.'+path,value}))].map(({path,value})=>({path,
   state:record(value)&&'state'in value?String(value.state):value===null?'missing':'structural',value_sha256:canonicalSha256(value),source_sha256s:sourceHashes(value)}));
}
function singlePrintedBase(input:MinimumWageEntitlementInput,source:DocumentReviewInput):string|null{
 if(input.components.length!==1)return 'single_component_required';const c=input.components[0],s=c.amount.source,l=row(s);
 if(c.classification.state!=='observed'||c.classification.value!=='base_salary'||!c.classification.source||!same(c.classification.source,s))return 'explicit_base_source_classification_required';
 if(c.amount.state!=='observed'||c.amount.printed_value===null||c.amount.representation!=='money_ils'||!l||!physical(s,input,source))return 'exact_current_base_amount_cell_required';
 if(c.period.state!=='observed'||!same(c.period.value,input.period)||!c.period.source||!same(c.period.source,s))return 'component_period_source_required';
 const matches=sourceContext(input,source).checks.filter(check=>check.printed_inventory?.document_id===s.document_id);
 if(matches.length!==1)return 'unique_printed_inventory_required';const check=matches[0],inventory=check.printed_inventory!;
 if(inventory.version_id!==s.version_id||inventory.reading_sha256!==s.reading_receipt_sha256||!inventory.inventory_complete||!inventory.disjoint_components
  ||inventory.payable_completeness_assessed!==false||inventory.unresolved_blank_component_ids.length||!same(inventory.populated_component_ids,l.component_ids))return 'complete_single_printed_inventory_required';
 const calc=documentReviewCalculationInputSchema.parse(check.calculation),op=calc.operation;
 if(calc.case_id!==input.case_id||!same(calc.period,input.period)||op.kind!=='reconciliation'||!op.inventory_complete||!op.disjoint_components
  ||op.add_refs.length!==1||op.subtract_refs.length||op.inventory_basis!=='printed-earnings-inventory-v1:'+canonicalSha256(inventory))return 'printed_inventory_calculation_binding_required';
 const term=calc.operands.find(o=>o.id===op.add_refs[0]),gross=calc.operands.find(o=>o.id===op.recorded_ref);
 if(!term||term.state!=='observed'||term.observation_id!==c.amount.observation_id||term.printed_value!==c.amount.printed_value||!same(term.source,s)
  ||!gross||gross.state!=='observed'||!sameDocument(gross.source,s)||!physical(gross.source,input,source)||!scalar(gross.source,'gross_salary'))return 'printed_inventory_source_cells_mismatch';
 const result=calculateDocumentReview(calc);
 if(result.state!=='calculated'||!result.difference||!('minor_units'in result.difference)||result.difference.minor_units!==0)return 'printed_inventory_does_not_reconcile';
 const f=input.eligible_pay_inventory;
 if(f.state==='missing'&&f.value===null)return null;
 if(f.state==='unknown'&&f.value==='unknown'&&f.source&&sameDocument(f.source,s)&&physical(f.source,input,source))return null;
 if(f.state==='derived'&&f.value==='complete')return null;
 if(usable(f)&&f.value==='complete'&&f.source&&physical(f.source,input,source))return null;
 return 'existing_inventory_state_preserved';
}
function ordinary(input:MinimumWageEntitlementInput,source:DocumentReviewInput):string|null{
 const f=input.product_facts;if(f?.schema_version!=='minimum-wage-personal-facts-v2')return 'case_facts_v2_required';
 for(const key of ['salary_basis','weekly_schedule_hours'] as const)if(!usable(f[key]))return key+':'+f[key].state;
 if(f.salary_basis.value!=='hourly')return 'salary_basis:unsupported';if(f.weekly_schedule_hours.value!=='42')return 'weekly_schedule:unsupported';
 const h=input.ordinary_hours,p=input.ordinary_hours_period;
 if(!h||h.state!=='observed'||h.representation!=='decimal_quantity'||h.quantity_unit!=='hours'||h.printed_value===null||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(h.printed_value)
  ||Number(h.printed_value)<=0||Number(h.printed_value)>182||!physical(h.source,input,source)||!scalar(h.source,'regular_hours'))return 'exact_ordinary_hours_source_required';
 if(p.state!=='observed'||!same(p.value,input.period)||!p.source||!sameDocument(h.source,p.source)||!physical(p.source,input,source)||!scalar(p.source,'salary_period'))return 'ordinary_hours_period_source_required';
 if(!['missing','derived'].includes(input.employment.state)&&!(usable(input.employment)&&input.employment.value==='hourly_182'))return 'employment_state_preserved';
 if(!['missing','derived'].includes(input.method.state)&&!(usable(input.method)&&input.method.value==='published_hourly_182'))return 'method_state_preserved';
 return null;
}
export function evaluateMinimumWageCaseRecipe(decisionId:string,input:MinimumWageEntitlementInput,source:DocumentReviewInput,options?:{age_range:true}){
 const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.'+decisionId);let reason:string|null=null;
 if(!recipe||recipe.branch!=='minimum_wage')reason='unsupported_case_recipe';
 else if(input.case_id!==source.case_id||!same(input.period,source.period))reason='case_period_mismatch';
 else if(input.period.from<recipe.supported_period.from||input.period.to>recipe.supported_period.to)reason='period_not_supported';
 else if(decisionId==='mw.population'){
  const f=input.product_facts;
  if(f?.schema_version!=='minimum-wage-personal-facts-v2')reason='case_facts_v2_required';
  else{
   const age=options?.age_range?productAgeRangeSelection(input,f.birth_date,source):null;
   if(age?.kind==='blocked')reason=age.reason;
   for(const key of ['birth_date','employment_relationship','workplace_sector','adapted_wage_approval','special_wage_arrangement'] as const){if(key==='birth_date'&&age?.kind==='range')continue;if(!usable(f[key])){reason=reason??key+':'+f[key].state;break;}}
   if(!reason){const birth=f.birth_date.value,twentyOne=`${Number(input.period.from.slice(0,4))-21}${input.period.from.slice(4)}`,sixty=`${Number(input.period.to.slice(0,4))-60}${input.period.to.slice(4)}`;
    if(age?.kind!=='range'&&birth&&(birth>twentyOne||birth<=sixty))reason='age_outside_21_59_whole_month';
    else if(f.employment_relationship.value!=='employee')reason='employment_relationship:unsupported';
    else if(f.workplace_sector.value!=='private')reason='workplace_sector:unsupported';
    else if(f.adapted_wage_approval.value!==false)reason='adapted_wage:unsupported';
    else if(f.special_wage_arrangement.value!==false)reason='special_arrangement:source_review_required';
   }
  }
  if(!reason&&!['missing','derived'].includes(input.population.state)&&!(usable(input.population)&&input.population.value==='adult_general'))reason='population_state_preserved';
 }else if(decisionId==='mw.ordinary_scope')reason=ordinary(input,source);
 else if(decisionId==='mw.eligible_components')reason=singlePrintedBase(input,source);
 else if(decisionId==='mw.allocation'){
  reason=ordinary(input,source)??singlePrintedBase(input,source);
  if(!reason&&!sameDocument(input.ordinary_hours!.source,input.components[0].amount.source))reason='allocation_source_mismatch';
 }
 const paths=[...(recipe?.consumed_paths??[])];
 if(options?.age_range&&decisionId==='mw.population'&&input.product_facts&&input.product_age_range){
  if(productAgeRangeSelection(input,input.product_facts.birth_date,source).kind==='range'){const i=paths.indexOf('product_facts.birth_date');if(i>=0)paths.splice(i,1);}
  paths.push('product_age_range');
 }
 return {allowed:reason===null,reason,consumed_paths:paths};
}
export function minimumWageCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string){const body={schema_version:'minimum-wage-case-recipe-binding-v1' as const,method,evaluated_at};
 return minimumWageCaseRecipeBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});}
/** The raw source keeps its original facts. Only a validated, current, pinned
 * recipe may derive these four non-numeric facts after answer replay. */
export function materializeMinimumWageCaseFacts(effective:MinimumWageEntitlementInput,original:MinimumWageEntitlementInput,source:DocumentReviewInput){
 if(!original.case_recipe_bindings?.length)return effective;
 const result=minimumWageEntitlementInputSchema.parse(effective);
 result.applicability=structuredClone(original.applicability);
 for(const key of ['population','employment','method','eligible_pay_inventory'] as const){
  if(original[key].state==='derived')throw Error('MW_CASE_RAW_DERIVED_FACT');
  if(result[key].state==='derived')Object.assign(result,{[key]:structuredClone(original[key])});
 }
 if(new Set(original.case_recipe_bindings.map(b=>b.method.recipe_id)).size!==original.case_recipe_bindings.length)throw Error('MW_CASE_DUPLICATE_BINDING');
 for(const b of original.case_recipe_bindings){
  const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===b.method.recipe_id&&r.recipe_id.startsWith('ai-case.mw.'));
  if(!recipe||recipe.recipe_sha256!==b.method.recipe_sha256||recipe.recipe_version!==b.method.recipe_version||recipe.source_policy_sha256!==b.method.source_policy_sha256
   ||Date.parse(b.method.issued_at)>Date.parse(b.evaluated_at)||Date.parse(b.method.expires_at)<=Date.parse(b.evaluated_at)
   ||recipe.legal_sources.some(s=>!b.method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))throw Error('MW_CASE_RECIPE_BINDING');
  const evaluated=evaluateMinimumWageCaseRecipe(recipe.decision_id,result,source,recipe.recipe_id.endsWith('.age-range-v1')?{age_range:true}:undefined);
  const ownBasis=(d:MinimumWageEntitlementInput['applicability'][number])=>{
   if(d.decision_id!==recipe.decision_id||d.state!=='accepted'||d.basis!=='ai_source_assessment')return null;
   let basis:unknown;try{basis=JSON.parse(d.explanation);}catch{return null;}
   return record(basis)&&basis.schema_version==='ai-release-method-basis-v1'&&basis.recipe_id===recipe.recipe_id&&basis.recipe_sha256===recipe.recipe_sha256&&basis.interpretation_receipt_sha256===b.method.interpretation_receipt_sha256?basis:null;
  };
  if(!evaluated.allowed){
   result.applicability=result.applicability.map(d=>ownBasis(d)
    ?{...d,state:'stale',explanation:'Current facts no longer support this pinned case recipe: '+evaluated.reason}:d);
   continue;
  }
  const consumed=minimumWageCaseConsumed(result,evaluated.consumed_paths,source);
  result.applicability=result.applicability.map(d=>{
   const basis=ownBasis(d);if(!basis)return d;
   return basis.consumed_sha256===canonicalSha256(consumed)?d:{...d,state:'stale',explanation:'The authenticated facts changed; a fresh case-recipe receipt is required.'};
  });
  const fact=<T extends string>(value:T)=>({state:'derived' as const,value,source:recipe.legal_sources[0],derivation:{schema_version:'minimum-wage-derived-fact-v1' as const,binding_sha256:b.binding_sha256,inputs_sha256:canonicalSha256(consumed)}});
  if(recipe.decision_id==='mw.population'&&result.population.state==='missing')result.population=fact('adult_general');
  if(recipe.decision_id==='mw.ordinary_scope'){
   if(result.employment.state==='missing')result.employment=fact('hourly_182');
   if(result.method.state==='missing')result.method=fact('published_hourly_182');
  }
  if(recipe.decision_id==='mw.eligible_components'&&['missing','unknown'].includes(result.eligible_pay_inventory.state))result.eligible_pay_inventory=fact('complete');
 }
 return minimumWageEntitlementInputSchema.parse(result);
}
