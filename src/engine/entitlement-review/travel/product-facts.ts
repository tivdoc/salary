import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import type {TravelEntitlementInput} from './contracts.ts';
import {TRAVEL_SOURCE_REVIEW_SHA256,isPinnedTravelLegalSource} from './sources.ts';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY,TRAVEL_FLOOR_SOURCE_REVIEW_SHA256} from './floor-policy.ts';
import {travelTariffSourceLocatorSchema} from './tariff-contracts.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source,hash=z.string().regex(/^[a-f0-9]{64}$/u);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'TRAVEL_FARE_PERIOD');
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict()
 .refine(f=>!['observed','declared'].includes(f.state)||'value' in f&&f.value!==null&&f.source!==null,'TRAVEL_PRODUCT_FACT_SOURCE');
const travelProductFactsV1Schema=z.object({schema_version:z.literal('travel-product-facts-v1'),
 employment_relationship:fact(z.enum(['employee','self_employed','other'])),workplace_sector:fact(z.enum(['private','public','protected_workshop','other'])),
 other_travel_terms_known:fact(z.boolean()),route_reference:fact(z.string().trim().min(1).max(2000)),personal_discount_profile:fact(z.enum(['standard_adult','special_discount'])),
}).strict();
export const TRAVEL_JOURNEY_FACTS_POLICY='travel-product-facts-v2' as const;
export const travelProductFactsSchema=z.discriminatedUnion('schema_version',[
 travelProductFactsV1Schema,
 travelProductFactsV1Schema.extend({schema_version:z.literal(TRAVEL_JOURNEY_FACTS_POLICY),actual_commute_days:fact(z.number().int().min(0).max(31))}).strict(),
]);
/** Metadata are separate identified readings, not a client's classification of
 * a fare. Operand hashes bind the exact original source cells, including zero. */
const travelFareSourceContextV1Schema=z.object({schema_version:z.literal('travel-fare-source-context-v1'),
 route_reference:fact(z.string().trim().min(1).max(2000)),discount_profile:fact(z.enum(['standard_adult','special_discount'])),association:fact(z.literal('same_route_tariff_group')),
 effective_period:fact(period),directions:fact(z.enum(['both','outbound','return'])),
 ticket_inventory:fact(z.enum(['complete','partial'])),monthly_pass_availability:fact(z.enum(['available','unavailable'])),
 daily_fare_operand_sha256:hash,monthly_pass_operand_sha256:hash.nullable(),
}).strict();
export const travelFareSourceContextSchema=z.discriminatedUnion('schema_version',[travelFareSourceContextV1Schema,
 travelFareSourceContextV1Schema.extend({schema_version:z.literal('travel-fare-source-context-v2'),source_group_sha256:hash}).strict()]);
export const travelCaseRecipeBindingSchema=z.object({schema_version:z.literal('travel-case-recipe-binding-v1'),method:aiReleaseDecisionMethodSchema,evaluated_at:z.iso.datetime(),binding_sha256:hash}).strict()
 .refine(v=>{const {binding_sha256,...body}=v;return binding_sha256===canonicalSha256(body);},'TRAVEL_CASE_BINDING_HASH');
export function travelCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string){const body={schema_version:'travel-case-recipe-binding-v1' as const,method,evaluated_at};return travelCaseRecipeBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});}
export function travelProductFacts(policy?:typeof TRAVEL_JOURNEY_FACTS_POLICY){const missing={state:'missing',value:null,source:null};return travelProductFactsSchema.parse({schema_version:policy??'travel-product-facts-v1',employment_relationship:missing,workplace_sector:missing,other_travel_terms_known:missing,route_reference:missing,personal_discount_profile:missing,...(policy?{actual_commute_days:missing}:{})});}
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
const usable=(f:Fact|undefined)=>!!f&&['known','observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
function bound(s:DocumentReviewSource,input:TravelEntitlementInput,review?:DocumentReviewInput){
 const pins=input.source_manifest.filter(p=>p.document_id===s.document_id&&p.version_id===s.version_id);
 if(pins.length!==1||pins[0].case_id!==input.case_id||pins[0].file_sha256!==s.file_sha256||s.page>pins[0].page_count)throw Error('TRAVEL_PRODUCT_SOURCE_BINDING');
 if((s.reading==='customer_declaration')!==(pins[0].kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(pins[0].kind==='questionnaire'))throw Error('TRAVEL_PRODUCT_DECLARATION_BINDING');
 if(review&&(review.case_id!==input.case_id||!same(review.period,input.period)))throw Error('TRAVEL_PRODUCT_CURRENT_SCOPE');
 // The shared source-admission service verifies answer values and latest
 // questionnaire/journal receipts. They are not physical document rows.
 if(review&&!['customer_declaration','questionnaire_declaration'].includes(s.reading)&&!review.documents.some(d=>d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&d.page_count!==null&&s.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256)))throw Error('TRAVEL_PRODUCT_CURRENT_SOURCE');
}
function validate(input:TravelEntitlementInput,review?:DocumentReviewInput){
 for(const container of [input.product_facts,input.fare_source_context])for(const f of Object.values(container??{}))if(f&&typeof f==='object'&&'state' in f&&f.source){
  bound(f.source,input,review);if(f.state==='declared'&&!['customer_declaration','questionnaire_declaration'].includes(f.source.reading)||f.state==='observed'&&f.source.reading!=='identified_document_reading')throw Error('TRAVEL_PRODUCT_FACT_BASIS');
 }
 for(const f of [...Object.values(input.facts),input.monthly_pass])if(f.source)bound(f.source,input,review);
 if(input.commute_days)bound(input.commute_days.source,input,review);
}
export type TravelRouteSelection={kind:'zero'|'required'|'missing'|'unsupported';reason:string;consumed_paths:string[];directions:'both'|'outbound'|'return'|null};
/** Same ordered source branches used by the existing travel resolver. No new
 * formula, and no receipt of expenditure required merely to establish need. */
export function travelProductRoute(input:TravelEntitlementInput):TravelRouteSelection{
 const f=input.facts,result=(kind:TravelRouteSelection['kind'],reason:string,consumed_paths:string[],directions:TravelRouteSelection['directions']=null)=>({kind,reason,consumed_paths,directions});
 if(usable(f.needs_transport)&&f.needs_transport.value===false)return result('zero','no_need',['facts.needs_transport']);
 if(usable(f.employer_transport)&&f.employer_transport.value==='both')return result('zero','employer_both',['facts.employer_transport']);
 if(usable(f.free_travel)&&f.free_travel.value==='both')return result('zero','free_both',['facts.free_travel']);
 if(usable(f.employer_transport)&&usable(f.free_travel)&&((f.employer_transport.value==='outbound'&&f.free_travel.value==='return')||(f.employer_transport.value==='return'&&f.free_travel.value==='outbound')))return result('zero','no_uncovered_direction',['facts.employer_transport','facts.free_travel']);
 const days=input.commute_days;
 if(days&&['observed','declared'].includes(days.state)&&days.representation==='decimal_quantity'&&days.quantity_unit==='days'&&days.printed_value==='0')return result('zero','no_commute_days',['commute_days']);
 const paths=['facts.needs_transport','facts.employer_transport','facts.free_travel','commute_days'];
 if(Object.values(f).some(v=>!usable(v)))return result('missing','route_facts_missing',paths);
 if(f.employer_transport.value==='mixed'||f.free_travel.value==='mixed')return result('unsupported','dated_direction_breakdown_required',paths);
 if(!days||!['observed','declared'].includes(days.state)||days.representation!=='decimal_quantity'||days.quantity_unit!=='days'||!days.printed_value||!/^(?:[1-9]|[12]\d|3[01])$/u.test(days.printed_value))return result('missing','actual_commute_days_missing',paths);
 if(Number(days.printed_value)>Number(input.period.to.slice(8)))return result('unsupported','commute_days_conflict',paths);
 const covered=new Set([f.employer_transport.value,f.free_travel.value]);return result('required','required_uncovered_route',paths,covered.has('outbound')?'return':covered.has('return')?'outbound':'both');
}
export type TravelProductQuestion={path:string;question:string;fact:Fact;answer_kind:'text'|'choice';format?:'calendar_days';choices?:readonly {label:string;value:string|boolean|null}[]};
export function travelProductFactQuestions(input:TravelEntitlementInput):TravelProductQuestion[]{
 validate(input);const p=input.product_facts;if(!p)return [];
 const out:TravelProductQuestion[]=[
  {path:'product_facts.employment_relationship',question:'מה היה מעמד העבודה בתקופה הנבדקת?',fact:p.employment_relationship,answer_kind:'choice',choices:[{label:'שכיר או שכירה',value:'employee'},{label:'עצמאי או עצמאית',value:'self_employed'},{label:'מעמד אחר',value:'other'},{label:'לא ידוע',value:null}]},
  {path:'product_facts.workplace_sector',question:'באיזה מגזר היה מקום העבודה בתקופה הנבדקת?',fact:p.workplace_sector,answer_kind:'choice',choices:[{label:'המגזר הפרטי',value:'private'},{label:'המגזר הציבורי',value:'public'},{label:'מפעל מוגן',value:'protected_workshop'},{label:'מגזר אחר',value:'other'},{label:'לא ידוע',value:null}]},
  {path:'product_facts.other_travel_terms_known',question:'האם ידוע לך על הסדר נסיעות נוסף או התחייבות מיוחדת של המעסיק לתשלום נסיעות?',fact:p.other_travel_terms_known,answer_kind:'choice',choices:[{label:'כן',value:true},{label:'לא ידוע לי על הסדר נוסף',value:false},{label:'לא ידוע',value:null}]},
 ];
 if(p.schema_version===TRAVEL_JOURNEY_FACTS_POLICY&&travelProductRoute(input).kind!=='zero'&&!input.commute_days)out.push({path:'product_facts.actual_commute_days',question:'בכמה ימים הגעת בפועל למקום העבודה בחודש הנבדק? אין לכלול עבודה מהבית, חופשה או מחלה.',fact:p.actual_commute_days,answer_kind:'text',format:'calendar_days'});
 if(travelProductRoute(input).kind==='required'&&!usable(input.fare_source_context?.route_reference))out.push({path:'product_facts.route_reference',question:'מהו מסלול הנסיעה ממקום המגורים לעבודה בתקופה הנבדקת? אפשר לציין תחנות או אזורי נסיעה.',fact:p.route_reference,answer_kind:'text'});
 if(travelProductRoute(input).kind==='required')out.push({path:'product_facts.personal_discount_profile',question:'האם היה לך פרופיל הנחה אישי בתחבורה הציבורית בתקופה הנבדקת?',fact:p.personal_discount_profile,answer_kind:'choice',choices:[{label:'פרופיל מבוגר רגיל, ללא הנחה אישית',value:'standard_adult'},{label:'היה פרופיל הנחה אישי',value:'special_discount'},{label:'לא ידוע',value:null}]});
 const arrangement=input.applicability.find(d=>d.decision_id==='travel.no_better_arrangement');
 const arrangementCurrent=arrangement?.state==='accepted'&&arrangement.basis!=='customer_declaration'&&arrangement.sources.length>0
  &&(arrangement.valid_until===null||Date.parse(arrangement.valid_until)>Date.parse(input.evaluated_at))
  &&arrangement.sources.every(s=>{if(isPinnedTravelLegalSource(s))return true;if(['customer_declaration','questionnaire_declaration'].includes(s.reading))return false;try{bound(s,input);return true;}catch{return false;}});
 return out.filter(q=>!usable(q.fact)&&!(q.path==='product_facts.other_travel_terms_known'&&(arrangementCurrent||input.calculation_policy===TRAVEL_GENERAL_ORDER_FLOOR_POLICY)));
}
function identified(f:Fact|undefined){return f?.state==='observed'&&f.source?.reading==='identified_document_reading'&&f.value!==null;}
function fareCell(o:DocumentReviewOperand|null,expected:string,input:TravelEntitlementInput,review?:DocumentReviewInput){
 if(!o||o.state!=='observed'||o.source.reading!=='identified_document_reading'||o.representation!=='money_ils'||o.quantity_unit!==null||o.printed_value===null||!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(o.printed_value)||canonicalSha256(o)!==expected)return false;
 bound(o.source,input,review);return true;
}
export function evaluateTravelCaseRecipe(decisionId:string,input:TravelEntitlementInput,review?:DocumentReviewInput){
 validate(input,review);const paths=['period'],no=(reason:string)=>({allowed:false,reason,consumed_paths:paths});
 const last=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from.slice(8)!=='01'||input.period.to!==last)return no('unsupported_period');
 const route=travelProductRoute(input);paths.push(...route.consumed_paths);
 if(decisionId==='travel.general_order_floor'){
  // Only the scoped case predicate is established here. Applying this recipe
  // additionally requires a server-admitted current interpretation descriptor.
  paths.push('calculation_policy');
  return input.calculation_policy===TRAVEL_GENERAL_ORDER_FLOOR_POLICY?{allowed:true,reason:null,consumed_paths:paths}:no('general_order_floor_policy_not_selected');
 }
 if(decisionId==='travel.general_coverage'){
  paths.push('product_facts.employment_relationship','product_facts.workplace_sector');const p=input.product_facts;
  if(!usable(p?.employment_relationship)||!usable(p?.workplace_sector))return no('employment_scope_missing');
  if(p!.employment_relationship.value!=='employee'||p!.workplace_sector.value!=='private')return no('unsupported_employment_scope');
  return route.kind==='zero'||route.kind==='required'?{allowed:true,reason:null,consumed_paths:paths}:no(route.reason);
 }
 if(decisionId==='travel.no_better_arrangement')return no(usable(input.product_facts?.other_travel_terms_known)&&input.product_facts!.other_travel_terms_known.value===true?'other_arrangement_source_review_required':'arrangement_source_scope_missing');
 if(decisionId==='travel.one_direction_treatment')return no('one_direction_interpretation_required');
 if(!['travel.fare_basis','travel.ticket_options'].includes(decisionId))return no('unsupported_recipe');
 if(route.kind==='zero')return no('fare_recipe_not_consumed_by_zero_branch');
 if(route.kind!=='required')return no(route.reason);
 const context=input.fare_source_context;paths.push('fare_source_context.route_reference','fare_source_context.discount_profile','fare_source_context.association','fare_source_context.effective_period','fare_source_context.directions','fare_source_context.daily_fare_operand_sha256','discounted_daily_fare','product_facts.personal_discount_profile');
 if(context?.schema_version==='travel-fare-source-context-v2')paths.push('fare_source_context.source_group_sha256');
 if(!context)return no('identified_route_and_tariff_context_missing');
 if(context.schema_version==='travel-fare-source-context-v2'&&input.calculation_policy!==TRAVEL_GENERAL_ORDER_FLOOR_POLICY)return no('tariff_transcription_policy_not_selected');
 for(const key of ['route_reference','discount_profile','association','effective_period','directions'] as const)if(!identified(context[key]))return no('identified_'+key+'_required');
 if(!usable(input.product_facts?.personal_discount_profile))return no('personal_discount_profile_missing');
 if(input.product_facts!.personal_discount_profile.value!=='standard_adult'||context.discount_profile.value!=='standard_adult')return no('special_discount_applicability_source_required');
 if(context.effective_period.value!.from>input.period.from||context.effective_period.value!.to<input.period.to)return no('fare_effective_period_mismatch');
 if(context.directions.value!==route.directions)return no('fare_directions_mismatch');
 if(usable(input.product_facts?.route_reference)){paths.push('product_facts.route_reference');if(input.product_facts!.route_reference.value!==context.route_reference.value)return no('declared_route_source_conflict');}
 if(!fareCell(input.discounted_daily_fare,context.daily_fare_operand_sha256,input,review))return no('identified_daily_fare_cell_required');
 const fare=input.discounted_daily_fare!.source,group=context.association.source!;
 const sameGroup=(s:DocumentReviewSource)=>{
  if(s.document_id!==group.document_id||s.version_id!==group.version_id||s.file_sha256!==group.file_sha256||s.page!==group.page)return false;
  if(context.schema_version==='travel-fare-source-context-v1')return s.reading_receipt_sha256===group.reading_receipt_sha256;
  try{const locator=travelTariffSourceLocatorSchema.parse(JSON.parse(s.locator));return locator.source_group_sha256===context.source_group_sha256&&locator.receipt_sha256===s.reading_receipt_sha256;}catch{return false;}
 };
 if(![fare,...[context.route_reference,context.discount_profile,context.effective_period,context.directions].map(f=>f.source!)].every(sameGroup))return no('fare_group_source_mismatch');
 if(decisionId==='travel.fare_basis')return {allowed:true,reason:null,consumed_paths:paths};
 paths.push('fare_source_context.ticket_inventory','fare_source_context.monthly_pass_availability','fare_source_context.monthly_pass_operand_sha256','monthly_pass','monthly_pass_cost');
 if(!identified(context.ticket_inventory)||context.ticket_inventory.value!=='complete')return no('complete_discounted_ticket_inventory_required');
 if(!identified(context.monthly_pass_availability)||!usable(input.monthly_pass)||context.monthly_pass_availability.value!==input.monthly_pass.value)return no('monthly_pass_availability_source_required');
 if(input.monthly_pass.value==='available'){
  if(!context.monthly_pass_operand_sha256||!fareCell(input.monthly_pass_cost,context.monthly_pass_operand_sha256,input,review))return no('identified_monthly_pass_cell_required');
  if(!sameGroup(input.monthly_pass_cost!.source))return no('monthly_pass_group_source_mismatch');
 }else if(context.monthly_pass_operand_sha256!==null||input.monthly_pass_cost!==null)return no('monthly_pass_source_conflict');
 if(![context.ticket_inventory.source!,context.monthly_pass_availability.source!].every(sameGroup))return no('ticket_inventory_group_source_mismatch');
 return {allowed:true,reason:null,consumed_paths:paths};
}
function at(input:TravelEntitlementInput,path:string){let v:unknown=input;for(const k of path.split('.'))v=v&&typeof v==='object'?Reflect.get(v,k):null;return v??null;}
function sourcesIn(v:unknown):DocumentReviewSource[]{const result:DocumentReviewSource[]=[];const visit=(x:unknown):void=>{const s=source.safeParse(x);if(s.success){result.push(s.data);return;}if(x&&typeof x==='object')Object.values(x).forEach(visit);};visit(v);return [...new Map(result.map(s=>[canonicalSha256(s),s])).values()];}
export function travelCaseConsumed(input:TravelEntitlementInput,paths:readonly string[]){return paths.map(path=>{const value=at(input,path);return {path:'entitlement_evidence.travel.'+path,state:value&&typeof value==='object'&&'state' in value?String(value.state):value===null?'missing':'structural',value_sha256:canonicalSha256(value),source_sha256s:sourcesIn(value).map(s=>canonicalSha256(s))};});}
export function travelCaseDecisionSources(input:TravelEntitlementInput,id:string){const suffix=input.calculation_policy===TRAVEL_GENERAL_ORDER_FLOOR_POLICY?'.floor-v2':'';if(!input.case_recipe_bindings?.some(b=>b.method.recipe_id==='ai-case.'+id+suffix))return [];const ready=evaluateTravelCaseRecipe(id,input);return ready.allowed?sourcesIn(ready.consumed_paths.map(p=>at(input,p))):[];}
/** No numeric/material classification is derived. Replaying a correction only
 * retires the exact old recipe decision; a fresh admission must replace it. */
export function replayTravelProductFacts(effective:TravelEntitlementInput,original:TravelEntitlementInput,review?:DocumentReviewInput){
 if(original.case_id!==effective.case_id||!same(original.period,effective.period))throw Error('TRAVEL_CASE_REPLAY_SCOPE');
 const result=structuredClone(effective),bindings=original.case_recipe_bindings??[];if(new Set(bindings.map(b=>b.method.recipe_id)).size!==bindings.length)throw Error('TRAVEL_DUPLICATE_CASE_BINDING');
 if(original.case_recipe_bindings)result.case_recipe_bindings=structuredClone(original.case_recipe_bindings);
 for(const b of bindings){travelCaseRecipeBindingSchema.parse(b);const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===b.method.recipe_id&&r.recipe_id.startsWith('ai-case.travel.'));
  const floor=original.calculation_policy===TRAVEL_GENERAL_ORDER_FLOOR_POLICY;
  if(!recipe||recipe.branch!=='travel'||recipe.recipe_id.endsWith('.floor-v2')!==floor||effective.calculation_policy!==original.calculation_policy||recipe.recipe_sha256!==b.method.recipe_sha256||recipe.recipe_version!==b.method.recipe_version||b.method.source_policy_sha256!==(floor?TRAVEL_FLOOR_SOURCE_REVIEW_SHA256:TRAVEL_SOURCE_REVIEW_SHA256)||b.method.issued_at>b.evaluated_at||b.method.expires_at<=b.evaluated_at||recipe.legal_sources.some(s=>!b.method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))throw Error('TRAVEL_CASE_BINDING_SCOPE');
  const prior=original.applicability.find(d=>d.decision_id===recipe.decision_id);if(!prior)continue;let basis;try{basis=JSON.parse(prior.explanation);}catch{continue;}
  if(basis?.schema_version!=='ai-release-method-basis-v1'||basis.recipe_id!==recipe.recipe_id||basis.recipe_sha256!==recipe.recipe_sha256||basis.interpretation_receipt_sha256!==b.method.interpretation_receipt_sha256)continue;
  const ready=evaluateTravelCaseRecipe(recipe.decision_id,result,review),changed=basis.consumed_sha256!==canonicalSha256(travelCaseConsumed(result,ready.consumed_paths));
  const next=prior.state==='accepted'&&(!ready.allowed||changed)?{...prior,state:'stale' as const,explanation:JSON.stringify({schema_version:'travel-case-recipe-stale-v1',prior_explanation_sha256:canonicalSha256(prior.explanation),recipe_id:recipe.recipe_id,reason:ready.allowed?'consumed_facts_changed':ready.reason})}:structuredClone(prior);
  const index=result.applicability.findIndex(d=>d.decision_id===recipe.decision_id);if(index<0)result.applicability.push(next);else result.applicability[index]=next;
 }
 return result;
}
