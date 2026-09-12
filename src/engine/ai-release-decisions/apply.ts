import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../document-review/calculations.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {parseReviewCompletionInput} from '../document-review/completions.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {travelEntitlementInputSchema} from '../entitlement-review/travel/contracts.ts';
import {vacationEntitlementInputSchema} from '../entitlement-review/vacation/contracts.ts';
import {minimumWageEntitlementInputSchema} from '../entitlement-review/minimum-wage/contracts.ts';
import {workingTimeEntitlementInputSchema} from '../entitlement-review/working-time/contracts.ts';
import {convalescenceEntitlementInputSchema} from '../entitlement-review/convalescence/contracts.ts';
import {aiReleaseDecisionInputSchema,type AiReleaseDecisionInput,type AiReleaseDecisionMethod} from './contracts.ts';
import {AI_RELEASE_DECISION_RECIPES,type AiReleaseDecisionRecipe,type DecisionBranch} from './catalog.ts';
import {evaluateMinimumWageCaseRecipe,materializeMinimumWageCaseFacts,minimumWageCaseBinding,minimumWageCaseConsumed} from './minimum-wage-case.ts';
import {evaluatePensionCaseRecipe,replayPensionProductFacts,pensionCaseBinding} from '../entitlement-review/pension/product-facts.ts';

const schemas={pension:pensionEntitlementInputSchema,travel:travelEntitlementInputSchema,vacation:vacationEntitlementInputSchema,
 minimum_wage:minimumWageEntitlementInputSchema,working_time:workingTimeEntitlementInputSchema,convalescence:convalescenceEntitlementInputSchema};
const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function atPath(value:unknown,path:string):unknown{
 let current=value;for(const key of path.split('.')){if(!record(current)||!Object.hasOwn(current,key))return null;current=current[key];}return current;
}
function usable(value:unknown){return record(value)&&['known','observed','declared','derived'].includes(String(value.state))
 &&sourceSchema.safeParse(value.source).success&&('value'in value?value.value!==null:'printed_value'in value&&value.printed_value!==null);}
function valueAt(branch:unknown,path:string):unknown{const f=atPath(branch,path);return usable(f)&&record(f)?f.value:null;}
function numberAt(branch:unknown,path:string,representation?:string){const f=atPath(branch,path);return usable(f)&&record(f)
 &&typeof f.printed_value==='string'&&/^\d+(?:\.\d+)?$/u.test(f.printed_value)&&(!representation||f.representation===representation);}
function sourcesIn(value:unknown):DocumentReviewSource[]{
 const result:DocumentReviewSource[]=[];let count=0;
 function visit(v:unknown):void{if(++count>20000)throw Error('AI_DECISION_INPUT_BOUNDS');if(!v||typeof v!=='object')return;
  const source=sourceSchema.safeParse(v);if(source.success){result.push(source.data);return;}
  for(const nested of Object.values(v))visit(nested);
 }visit(value);return [...new Map(result.map(s=>[canonicalSha256(s),s])).values()];
}
function completeSegments(branch:unknown){const segments=atPath(branch,'segments');return Array.isArray(segments)&&segments.length>0&&segments.every(s=>usable(atPath(s,'period'))&&usable(atPath(s,'fte')));}
function methodAllowed(recipe:AiReleaseDecisionRecipe,branch:unknown){
 const method=valueAt(branch,'method'),employment=valueAt(branch,'employment');
 switch(recipe.decision_id){
  case 'pension.rounding':return valueAt(branch,'facts.aged_21_or_more')===true&&valueAt(branch,'facts.under_60')===true&&numberAt(branch,'pensionable_wage','money_ils');
  case 'travel.rounding':return numberAt(branch,'commute_days')&&numberAt(branch,'discounted_daily_fare','money_ils');
  case 'vacation.pay_rounding':return atPath(branch,'leave_pay.mode')==='hourly_quarter'&&numberAt(branch,'leave_pay.wage','money_ils')&&numberAt(branch,'leave_pay.leave_calendar_days');
  case 'mw.method':case 'mw.rounding':return ((method==='published_hourly_182'||method==='monthly_exact_div182')&&employment==='hourly_182')||(method==='full_monthly'&&employment==='full_monthly_42');
  case 'wt.rounding':return ['adult_hourly_five_day_42','adult_hourly_six_day_42'].includes(String(valueAt(branch,'arrangement')))&&numberAt(branch,'regular_hourly_wage','money_ils');
  case 'wt.weekly_aggregation':{
   const days=atPath(branch,'workdays'),start=atPath(branch,'week_start');
   return ['adult_hourly_five_day_42','adult_hourly_six_day_42'].includes(String(valueAt(branch,'arrangement')))
    &&valueAt(branch,'week_inventory')==='complete'&&typeof start==='string'&&Array.isArray(days)&&days.length===7
    &&days.every((d,i)=>record(d)&&d.date===new Date(Date.parse(start+'T00:00:00Z')+i*86400000).toISOString().slice(0,10)
     &&['complete_work','no_work'].includes(String(valueAt(d,'inventory')))
     &&(valueAt(d,'inventory')!=='no_work'||valueAt(d,'no_work_credit')==='no_credit'));
  }
  case 'wt.rest_additive':{
   const window=valueAt(branch,'rest_window'),days=atPath(branch,'workdays');
   return ['adult_hourly_five_day_42','adult_hourly_six_day_42'].includes(String(valueAt(branch,'arrangement')))&&record(window)
    &&typeof window.start_at==='string'&&typeof window.end_at==='string'&&Date.parse(window.end_at)-Date.parse(window.start_at)>=36*3600000
    &&Array.isArray(days)&&days.length>0&&days.every(d=>['ordinary','pre_rest'].includes(String(valueAt(d,'kind'))));
  }
  case 'cv.rate_2026':return valueAt(branch,'population')==='adult_private_general_21_59'&&valueAt(branch,'benefit_year')===2026;
  case 'cv.proration':return usable(atPath(branch,'employment_start'))&&valueAt(branch,'qualifying_service')==='continuous_no_excluded_absence'&&completeSegments(branch);
  case 'cv.rounding':return valueAt(branch,'population')==='adult_private_general_21_59'&&valueAt(branch,'benefit_year')===2026&&completeSegments(branch);
  default:return false;
 }
}
function matches(method:AiReleaseDecisionMethod,recipe:AiReleaseDecisionRecipe,at:string){
 if(method.recipe_version!==recipe.recipe_version||method.recipe_sha256!==recipe.recipe_sha256||method.source_policy_sha256!==recipe.source_policy_sha256)return 'method_pin_mismatch';
 if(Date.parse(method.issued_at)>Date.parse(at)||Date.parse(method.expires_at)<=Date.parse(at)||Date.parse(method.issued_at)>=Date.parse(method.expires_at))return 'method_not_current';
 if(recipe.legal_sources.some(s=>!method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))return 'legal_source_receipt_mismatch';
 return null;
}
type Unresolved={branch:string;branch_index:number|null;decision_id:string;reason:string};

/** Caller verifies method receipt provenance/revocation against its current
 * registry. This pure factory independently pins recipe/source bytes and
 * requires source-bound typed facts; it never activates the whole family. */
export function applyAiReleaseDecisionRecipes(candidate:AiReleaseDecisionInput){
 const input=aiReleaseDecisionInputSchema.parse(candidate),receipts:ReturnType<typeof makeReceipt>[]=[],unresolved:Unresolved[]=[];
 if(input.methods.length===0)return deepFreeze({source:candidate.source,receipts,unresolved});
 const base=composeEntitlementReview(input.source),effective=base.entitlement_composition?.evidence;
 if(!effective||!base.entitlement_evidence)return deepFreeze({source:candidate.source,receipts,unresolved:[{branch:'none',branch_index:null,decision_id:'source_packet',reason:'source_packet_missing'}]});
 const packet=structuredClone(base.entitlement_evidence);
 // New case recipes establish only their narrowly derived facts. Run them in
 // compiled order before the historical method-only recipes; caller ordering
 // must not select a different arithmetic policy or result.
 const caseOrder=['ai-case.mw.population','ai-case.mw.ordinary_scope','ai-case.mw.eligible_components','ai-case.mw.allocation','ai-case.pension.general_coverage','ai-case.pension.pension_fund'];
 const methods=[...input.methods.filter(m=>caseOrder.includes(m.recipe_id)).sort((a,b)=>caseOrder.indexOf(a.recipe_id)-caseOrder.indexOf(b.recipe_id)),...input.methods.filter(m=>!caseOrder.includes(m.recipe_id))];
 for(const method of methods){
  const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===method.recipe_id);
  if(!recipe){unresolved.push({branch:'unknown',branch_index:null,decision_id:method.recipe_id,reason:'recipe_not_supported'});continue;}
  const duplicate=input.methods.filter(m=>m.recipe_id===method.recipe_id).length!==1;
  const raw=effective[recipe.branch],original=packet[recipe.branch];
  if(raw===undefined||original===undefined){unresolved.push({branch:recipe.branch,branch_index:null,decision_id:recipe.decision_id,reason:'branch_missing'});continue;}
  const effectiveEntries=recipe.branch==='working_time'&&Array.isArray(raw)?raw:[raw];
  const originalEntries=recipe.branch==='working_time'&&Array.isArray(original)?original:[original];
  for(const [index,entry] of effectiveEntries.entries()){
   let b=schemas[recipe.branch].parse(entry);const output=schemas[recipe.branch].parse(originalEntries[index]);
   if(recipe.branch==='minimum_wage'){
    const original=minimumWageEntitlementInputSchema.parse(output);
    b=materializeMinimumWageCaseFacts({...minimumWageEntitlementInputSchema.parse(entry),applicability:original.applicability,case_recipe_bindings:original.case_recipe_bindings},original,base);
   }
   if(recipe.branch==='pension'){
    const original=pensionEntitlementInputSchema.parse(output);
    if(original.case_recipe_bindings?.length)b=replayPensionProductFacts({...pensionEntitlementInputSchema.parse(entry),applicability:original.applicability,case_recipe_bindings:original.case_recipe_bindings},original,base);
   }
   const target={branch:recipe.branch,branch_index:recipe.branch==='working_time'?index:null,decision_id:recipe.decision_id};
   const current=b.applicability.find(d=>d.decision_id===recipe.decision_id);
   // Reusing our output could retain an earlier fact-bound decision after a
   // correction. Rebuild the original packet with current authenticated answers.
   if(current?.basis==='ai_source_assessment'){
    let previous:unknown;try{previous=JSON.parse(current.explanation);}catch{previous=null;}
    if(record(previous)&&previous.schema_version==='ai-release-method-basis-v1')throw Error('AI_DECISION_REBUILD_BASE_REQUIRED');
   }
   const mwCase=recipe.recipe_id.startsWith('ai-case.mw.');
   const caseReady=mwCase?evaluateMinimumWageCaseRecipe(recipe.decision_id,minimumWageEntitlementInputSchema.parse(b),base)
    :recipe.recipe_id.startsWith('ai-case.pension.')?evaluatePensionCaseRecipe(recipe.decision_id,pensionEntitlementInputSchema.parse(b),base):null;
   const issue=duplicate?'duplicate_method':matches(method,recipe,input.at)
    ??(current&&current.state!=='missing'?'existing_decision_preserved':null)
    ??(b.period.from<recipe.supported_period.from||b.period.to>recipe.supported_period.to?'period_not_supported':null)
    ??(caseReady?caseReady.allowed?null:caseReady.reason:!methodAllowed(recipe,b)?'required_source_fact_missing_or_incompatible':null);
   if(issue){unresolved.push({...target,reason:issue});continue;}
   const consumed=caseReady&&mwCase?minimumWageCaseConsumed(minimumWageEntitlementInputSchema.parse(b),caseReady.consumed_paths,base):(caseReady?.consumed_paths??recipe.consumed_paths).map(path=>{
    const value=atPath(b,path),sources=sourcesIn(value);
    return {path:'entitlement_evidence.'+recipe.branch+(target.branch_index===null?'':'.'+index)+'.'+path,
     state:record(value)&&'state'in value?String(value.state):value===null?'missing':'structural',value_sha256:canonicalSha256(value),
     source_sha256s:sources.map(s=>canonicalSha256(s))};
   });
   const basis={schema_version:'ai-release-method-basis-v1',recipe_id:recipe.recipe_id,recipe_sha256:recipe.recipe_sha256,
    interpretation_receipt_sha256:method.interpretation_receipt_sha256,consumed_sha256:canonicalSha256(consumed)};
   const decision={decision_id:recipe.decision_id,state:'accepted' as const,basis:'ai_source_assessment' as const,
    explanation:JSON.stringify(basis),sources:recipe.legal_sources.map(s=>({...s})),valid_until:method.expires_at};
   for(const law of recipe.legal_sources){
    const document=base.documents.find(d=>d.document_id===law.document_id&&d.version_id===law.version_id&&d.file_sha256===law.file_sha256);
    if(!document||document.page_count===null)throw Error('AI_DECISION_LEGAL_MANIFEST_REQUIRED');
    const pin={document_id:law.document_id,version_id:law.version_id,file_sha256:law.file_sha256,page_count:document.page_count,kind:'legal_source' as const,case_id:null};
    const existing=output.source_manifest.find(p=>p.document_id===law.document_id);
    if(existing&&canonicalSha256(existing)!==canonicalSha256(pin))throw Error('AI_DECISION_LEGAL_MANIFEST_MISMATCH');
    if(!existing)output.source_manifest.push(pin);
   }
   output.applicability=output.applicability.filter(d=>d.decision_id!==recipe.decision_id);output.applicability.push(decision);
   if(caseReady&&mwCase){const m=minimumWageEntitlementInputSchema.parse(output);m.case_recipe_bindings=[...(m.case_recipe_bindings??[]),minimumWageCaseBinding(method,input.at)];packet.minimum_wage=m;}
   else if(caseReady){const p=pensionEntitlementInputSchema.parse(output);p.case_recipe_bindings=[...(p.case_recipe_bindings??[]),pensionCaseBinding(method,input.at)];packet.pension=p;}
   else if(recipe.branch==='working_time'){originalEntries[index]=output;packet.working_time=originalEntries;}else packet[recipe.branch]=output;
   receipts.push(makeReceipt({case_id:base.case_id,period:b.period,...target,method,recipe,consumed,decision,at:input.at}));
  }
 }
 // Retire only the validated composer's derived projection before changing its
 // source packet. Keeping the old composition hash would falsely bind the new
 // decisions to old outputs. Answer history and source documents are untouched.
 const prior=base.entitlement_composition,checks=new Set(prior?.selections.flatMap(s=>s.generated_check_ids)??[]),
  gaps=new Set(prior?.selections.flatMap(s=>s.generated_gap_ids)??[]),facts=new Set(prior?.generated_fact_keys??[]);
 const completion=parseReviewCompletionInput(base.completion_input);
 const source=receipts.length?composeEntitlementReview({...base,entitlement_evidence:packet,entitlement_composition:undefined,
  checks:base.checks.filter(c=>!checks.has(c.check_id)),coverage_gaps:base.coverage_gaps.filter(g=>!gaps.has(g.check_id)),
  answer_bindings:base.answer_bindings.filter(b=>!checks.has(b.check_id)),completion_input:{...completion,needs:completion.needs.filter(n=>!facts.has(n.fact_key))}}):candidate.source;
 return deepFreeze({source,receipts,unresolved});
}
function makeReceipt(input:{case_id:string;period:{from:string;to:string};branch:DecisionBranch;branch_index:number|null;decision_id:string;
 method:AiReleaseDecisionMethod;recipe:AiReleaseDecisionRecipe;consumed:{path:string;state:string;value_sha256:string;source_sha256s:string[]}[];
 decision:{decision_id:string;state:'accepted';basis:'ai_source_assessment';explanation:string;sources:DocumentReviewSource[];valid_until:string};at:string}){
 const body={schema_version:'ai-release-decision-receipt-v1' as const,case_id:input.case_id,period:input.period,branch:input.branch,
  branch_index:input.branch_index,decision_id:input.decision_id,recipe_id:input.recipe.recipe_id,recipe_version:input.recipe.recipe_version,
  recipe_sha256:input.recipe.recipe_sha256,source_policy_sha256:input.recipe.source_policy_sha256,
  interpretation_receipt_sha256:input.method.interpretation_receipt_sha256,method_descriptor_sha256:canonicalSha256(input.method),
  consumed:input.consumed,decision:input.decision,evaluated_at:input.at,expires_at:input.method.expires_at,actor_kind:'ai_reviewer' as const,human_attestation:null};
 return deepFreeze({...body,sha256:canonicalSha256(body)});
}
export type AiReleaseDecisionResult=ReturnType<typeof applyAiReleaseDecisionRecipes>;
export type {DocumentReviewInput};
