import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {validateReviewSourceStructure,sourceRelationshipUsable} from '../../document-review/source-structure-evidence.ts';
import {aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import type {PensionEntitlementInput} from './contracts.ts';
import {PENSION_SOURCE_REVIEW_SHA256,pensionLegalSource} from './sources.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict()
 .refine(f=>!['observed','declared'].includes(f.state)||('value' in f&&f.value!==null&&f.source!==null),'PENSION_PRODUCT_FACT_SOURCE');
export const PENSION_PRODUCT_FACTS_POLICY='pension-product-facts-v1' as const;
export const pensionProductFactsSchema=z.object({schema_version:z.literal(PENSION_PRODUCT_FACTS_POLICY),birth_date:fact(z.iso.date()),
 employment_relationship:fact(z.enum(['employee','self_employed','other'])),workplace_sector:fact(z.enum(['private','public','other'])),
 pension_product:fact(z.enum(['pension_fund','insurance_policy','provident_fund','other'])),
 other_pension_terms_known:fact(z.boolean()),
}).strict();
export const pensionCaseRecipeBindingSchema=z.object({schema_version:z.literal('pension-case-recipe-binding-v1'),method:aiReleaseDecisionMethodSchema,
 evaluated_at:z.iso.datetime(),binding_sha256:hash}).strict().refine(v=>{const {binding_sha256,...body}=v;return binding_sha256===canonicalSha256(body);},'PENSION_CASE_BINDING_HASH');
export const pensionDerivedFactSchema=z.object({schema_version:z.literal('pension-derived-fact-v1'),binding_sha256:hash,inputs_sha256:hash}).strict();
export function pensionCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string){const body={schema_version:'pension-case-recipe-binding-v1' as const,method,evaluated_at};return pensionCaseRecipeBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});}
export function pensionProductFacts(){const missing={state:'missing',value:null,source:null};return pensionProductFactsSchema.parse({schema_version:PENSION_PRODUCT_FACTS_POLICY,
 birth_date:missing,employment_relationship:missing,workplace_sector:missing,pension_product:missing,other_pension_terms_known:missing});}
type ProductFact=z.infer<typeof pensionProductFactsSchema>[Exclude<keyof z.infer<typeof pensionProductFactsSchema>,'schema_version'>];
const usable=(f:ProductFact|undefined)=>!!f&&['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
function sourceBound(s:DocumentReviewSource,input:PensionEntitlementInput,review?:DocumentReviewInput){
 const pins=input.source_manifest.filter(p=>p.document_id===s.document_id&&p.version_id===s.version_id);
 if(pins.length!==1||pins[0].case_id!==input.case_id||pins[0].file_sha256!==s.file_sha256||s.page>pins[0].page_count)throw Error('PENSION_PRODUCT_SOURCE_BINDING');
 if(s.reading==='customer_declaration'&&pins[0].kind!=='customer_answer'||s.reading==='questionnaire_declaration'&&pins[0].kind!=='questionnaire')throw Error('PENSION_PRODUCT_DECLARATION_BINDING');
 if(review&&(review.case_id!==input.case_id||canonicalSha256(review.period)!==canonicalSha256(input.period)))throw Error('PENSION_PRODUCT_CURRENT_SOURCE');
 // Answer and questionnaire citations are admitted by the ordinary packet
 // source-admission journal validator, not by pretending they are documents.
 if(review&&!['customer_declaration','questionnaire_declaration'].includes(s.reading)&&!review.documents.some(d=>d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256)))throw Error('PENSION_PRODUCT_CURRENT_SOURCE');
}
function validateFacts(input:PensionEntitlementInput,review?:DocumentReviewInput){
 for(const f of Object.values(input.product_facts??{}))if(typeof f==='object'&&f!==null&&'state' in f&&f.source){
  sourceBound(f.source,input,review);
  if(f.state==='declared'&&!['customer_declaration','questionnaire_declaration'].includes(f.source.reading)||f.state==='observed'&&f.source.reading!=='identified_document_reading')throw Error('PENSION_PRODUCT_FACT_BASIS');
 }
}
function anniversary(birth:string,years:number){const [y,m,d]=birth.split('-').map(Number),last=new Date(Date.UTC(y+years,m,0)).getUTCDate();return `${y+years}-${String(m).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;}
export function pensionProductAge(input:PensionEntitlementInput){
 validateFacts(input);const birth=input.product_facts?.birth_date;
 if(!usable(birth))return null;
 const date=String(birth!.value);if(date>input.period.from)return {state:'conflict' as const,aged_21_or_more:false,under_60:false};
 return {state:'derived' as const,aged_21_or_more:anniversary(date,21)<=input.period.from,under_60:anniversary(date,60)>input.period.to};
}
function identifiedFund(input:PensionEntitlementInput,review?:DocumentReviewInput){
 const paths:string[]=[];
 for(const [index,r]of input.recorded.entries()){
  const c=documentReviewCalculationInputSchema.parse(r.relationship_check);if(c.case_id!==input.case_id||canonicalSha256(c.period)!==canonicalSha256(input.period))throw Error('PENSION_PRODUCT_RELATION_SCOPE');
  for(const o of c.operands)sourceBound(o.source,input,review);
  validateReviewSourceStructure(c);const s=c.source_structure;
  if(s&&sourceRelationshipUsable(s)&&s.kind==='source_relationship'&&s.entry.reading?.value.kind==='source_relationship'&&s.entry.reading.value.fund_kind==='pension')paths.push(`recorded.${index}.relationship_check`);
 }
 return paths;
}
export type PensionProductQuestion={path:string;question:string;fact:ProductFact;answer_kind:'text'|'choice';format?:'iso_date';choices?:readonly {label:string;value:string|boolean|null}[]};
/** Existing employment facts retain their own questions. Never request a second
 * numeric reading or reinterpret an unknown source relationship as confirmed. */
export function pensionProductFactQuestions(input:PensionEntitlementInput):PensionProductQuestion[]{
 validateFacts(input);const p=input.product_facts;if(!p)return [];
 const out:PensionProductQuestion[]=[];
 if(!['known','derived'].includes(input.facts.aged_21_or_more.state)||!['known','derived'].includes(input.facts.under_60.state))out.push({path:'product_facts.birth_date',question:'מהו תאריך הלידה המלא? הוא ישמש לבדיקת הגיל בתקופת התלוש.',fact:p.birth_date,answer_kind:'text',format:'iso_date'});
 const add=(key:keyof Omit<typeof p,'schema_version'>,question:string,choices:PensionProductQuestion['choices'])=>out.push({path:`product_facts.${key}`,question,fact:p[key],answer_kind:'choice',choices});
 add('employment_relationship','מה היה מעמד העבודה בתקופה הנבדקת?',[{label:'שכיר או שכירה',value:'employee'},{label:'עצמאי או עצמאית',value:'self_employed'},{label:'מעמד אחר',value:'other'}]);
 add('workplace_sector','באיזה מגזר היה מקום העבודה בתקופה הנבדקת?',[{label:'המגזר הפרטי',value:'private'},{label:'המגזר הציבורי',value:'public'},{label:'מגזר אחר',value:'other'}]);
 if(!identifiedFund(input).length)add('pension_product','באיזה מוצר פנסיוני נוהל הביטוח בתקופה הנבדקת?',[{label:'קרן פנסיה',value:'pension_fund'},{label:'פוליסת ביטוח',value:'insurance_policy'},{label:'קופת גמל',value:'provident_fund'},{label:'מוצר אחר',value:'other'}]);
 add('other_pension_terms_known','האם ידוע לך על תנאי פנסיה נוספים בחוזה, בהסכם קיבוצי או בהסדר של מקום העבודה?',[{label:'כן',value:true},{label:'לא ידוע לי על תנאים נוספים',value:false}]);
 return out.filter(q=>!usable(q.fact)).map(q=>({...q,...(q.choices?{choices:[...q.choices,{label:'לא ידוע',value:null}]}:{})}));
}
export type PensionCaseRecipeReadiness={allowed:boolean;reason:string|null;consumed_paths:string[];derived_facts?:{aged_21_or_more:boolean;under_60:boolean}};
/** A predicate only: method/source receipt admission remains with the release
 * catalog. A client's product description is not a read fund classification. */
export function evaluatePensionCaseRecipe(decisionId:string,input:PensionEntitlementInput,review?:DocumentReviewInput):PensionCaseRecipeReadiness{
 validateFacts(input,review);const paths=['period'],no=(reason:string):PensionCaseRecipeReadiness=>({allowed:false,reason,consumed_paths:paths});
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from.slice(8)!=='01'||input.period.to!==new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10))return no('unsupported_period');
 const p=input.product_facts;
 if(decisionId==='pension.general_coverage'){
  paths.push('product_facts.employment_relationship','product_facts.workplace_sector');
  const existingAge=input.facts.aged_21_or_more.state==='known'&&input.facts.under_60.state==='known';
  if(existingAge){paths.push('facts.aged_21_or_more','facts.under_60');for(const f of [input.facts.aged_21_or_more,input.facts.under_60])if(f.source)sourceBound(f.source,input,review);}
  else paths.push('product_facts.birth_date');
  const born=pensionProductAge(input),age=existingAge?{state:'derived' as const,aged_21_or_more:input.facts.aged_21_or_more.value===true,under_60:input.facts.under_60.value===true}:born;
  if(born&&existingAge&&(born.state==='conflict'||born.aged_21_or_more!==age?.aged_21_or_more||born.under_60!==age?.under_60))return no('age_source_conflict');
  if(!age||age.state==='conflict')return no(age?'birth_date_conflict':'birth_date_missing');
  if(!age.aged_21_or_more||!age.under_60)return no('outside_adult_21_59_scope');
  if(!usable(p?.employment_relationship)||!usable(p?.workplace_sector))return no('employment_scope_missing');
  if(p!.employment_relationship.value!=='employee'||p!.workplace_sector.value!=='private')return no('unsupported_employment_scope');
  // General population selection does not decide better terms, legal wage
  // composition, prior insurance, or partial-period cap applicability.
  return {allowed:true,reason:null,consumed_paths:paths,derived_facts:{aged_21_or_more:age.aged_21_or_more,under_60:age.under_60}};
 }
 if(decisionId==='pension.pension_fund'){
  const links=identifiedFund(input,review);paths.push(...links);
  if(usable(p?.pension_product)){paths.push('product_facts.pension_product');if(p!.pension_product.value!=='pension_fund')return no('pension_product_conflict_or_unsupported');}
  if(links.length)return {allowed:true,reason:null,consumed_paths:paths};
  paths.push('product_facts.pension_product');
  return p?.pension_product.state==='observed'&&p.pension_product.source?.reading==='identified_document_reading'&&p.pension_product.value==='pension_fund'?{allowed:true,reason:null,consumed_paths:paths}:no('identified_fund_source_missing');
 }
 if(decisionId==='pension.no_better_arrangement')return no(usable(p?.other_pension_terms_known)&&p!.other_pension_terms_known.value===true?'other_arrangement_requires_source_review':'arrangement_source_scope_missing');
 if(decisionId==='pension.pensionable_wage')return no('wage_component_classification_source_missing');
 if(decisionId==='pension.prior_coverage_evidence')return no('prior_insurance_at_start_source_review_required');
 if(decisionId==='pension.cap_interval')return no('partial_period_cap_method_not_supported');
 return no('unsupported_recipe');
}
export function pensionCaseConsumed(input:PensionEntitlementInput,paths:readonly string[]){return paths.map(path=>{let value:unknown=input;for(const k of path.split('.'))value=value!==null&&typeof value==='object'?Reflect.get(value,k):null;
 const sources:DocumentReviewSource[]=[];const visit=(v:unknown):void=>{const s=source.safeParse(v);if(s.success){sources.push(s.data);return;}if(v&&typeof v==='object')for(const child of Object.values(v))visit(child);};visit(value);
 return {path:'entitlement_evidence.pension.'+path,state:value&&typeof value==='object'&&'state' in value?String(value.state):value===null||value===undefined?'missing':'structural',value_sha256:canonicalSha256(value??null),source_sha256s:[...new Set(sources.map(s=>canonicalSha256(s)))]};});}
export function pensionCaseDecisionSources(input:PensionEntitlementInput,decisionId:string){
 if(!input.case_recipe_bindings?.some(b=>b.method.recipe_id==='ai-case.'+decisionId))return [];
 const raw=structuredClone(input);for(const key of ['aged_21_or_more','under_60'] as const)if(raw.facts[key].state==='derived')raw.facts[key]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 const ready=evaluatePensionCaseRecipe(decisionId,raw);if(!ready.allowed)return [];
 const result:DocumentReviewSource[]=[];const visit=(v:unknown):void=>{const s=source.safeParse(v);if(s.success){result.push(s.data);return;}if(v&&typeof v==='object')for(const child of Object.values(v))visit(child);};
 for(const path of ready.consumed_paths){let value:unknown=raw;for(const k of path.split('.'))value=value&&typeof value==='object'?Reflect.get(value,k):null;visit(value);}
 return [...new Map(result.map(s=>[canonicalSha256(s),s])).values()];
}
/** Recomputed effective projection. The raw packet keeps its original facts and
 * method binding; changing birthday/period changes both derivation hashes. */
export function materializePensionCaseFacts(input:PensionEntitlementInput,review?:DocumentReviewInput):PensionEntitlementInput{
 const output=structuredClone(input);for(const key of ['aged_21_or_more','under_60'] as const)if(output.facts[key].state==='derived')throw Error('PENSION_RAW_DERIVED_FACT');
 const bindings=input.case_recipe_bindings??[];if(new Set(bindings.map(b=>b.method.recipe_id)).size!==bindings.length)throw Error('PENSION_DUPLICATE_CASE_BINDING');
 for(const raw of bindings){const binding=pensionCaseRecipeBindingSchema.parse(raw);
  const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===binding.method.recipe_id);
  if(!recipe||!['ai-case.pension.general_coverage','ai-case.pension.pension_fund'].includes(recipe.recipe_id)||recipe.branch!=='pension'||recipe.recipe_sha256!==binding.method.recipe_sha256||recipe.recipe_version!==binding.method.recipe_version||binding.method.source_policy_sha256!==PENSION_SOURCE_REVIEW_SHA256
   ||binding.method.issued_at>binding.evaluated_at||binding.method.expires_at<=binding.evaluated_at||recipe.legal_sources.some(s=>!binding.method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))throw Error('PENSION_CASE_BINDING_SCOPE');
  const ready=evaluatePensionCaseRecipe(recipe.decision_id,input,review);
  const currentConsumed=canonicalSha256(pensionCaseConsumed(input,ready.consumed_paths));
  output.applicability=output.applicability.map(d=>{if(d.decision_id!==recipe.decision_id||d.state!=='accepted'||d.basis!=='ai_source_assessment')return d;
    let basis;try{basis=JSON.parse(d.explanation);}catch{return d;}
    return basis?.schema_version==='ai-release-method-basis-v1'&&basis.recipe_id===recipe.recipe_id&&basis.recipe_sha256===recipe.recipe_sha256&&basis.interpretation_receipt_sha256===binding.method.interpretation_receipt_sha256&&(!ready.allowed||basis.consumed_sha256!==currentConsumed)
     ?{...d,state:'stale',explanation:JSON.stringify({schema_version:'pension-case-recipe-stale-v1',prior_explanation_sha256:canonicalSha256(d.explanation),recipe_id:recipe.recipe_id,reason:ready.allowed?'consumed_facts_changed':ready.reason})}:d;
   });
  if(!ready.allowed)continue;
  if(!ready.derived_facts)continue;
  const derivation={schema_version:'pension-derived-fact-v1' as const,binding_sha256:binding.binding_sha256,inputs_sha256:canonicalSha256(pensionCaseConsumed(input,ready.consumed_paths))};
  for(const key of ['aged_21_or_more','under_60'] as const){const old=input.facts[key];if(old.state==='known'){if(old.value!==ready.derived_facts[key])throw Error('PENSION_AGE_SOURCE_CONFLICT');continue;}
   if(old.state!=='missing')continue;
   output.facts[key]={state:'derived',value:ready.derived_facts[key],basis:'ai_source_assessment',source:pensionLegalSource('order2011',3,'סעיף 4; גזירת גיל לפי תאריך לידה, גבול מוצר 21–59'),derivation};
  }
 }
 return output;
}
/** Used after authenticated answer replay. Only the derived age projection is
 * reset from immutable raw facts; ordinary factual answers remain effective. */
export function replayPensionProductFacts(effective:PensionEntitlementInput,original:PensionEntitlementInput,review:DocumentReviewInput){
 if(original.case_id!==effective.case_id||canonicalSha256(original.period)!==canonicalSha256(effective.period))throw Error('PENSION_CASE_REPLAY_SCOPE');
 const raw=structuredClone(effective);raw.case_recipe_bindings=structuredClone(original.case_recipe_bindings);
 for(const b of original.case_recipe_bindings??[]){const id=b.method.recipe_id.replace(/^ai-case\./u,'');const prior=original.applicability.find(d=>d.decision_id===id);if(!prior)continue;
  let basis;try{basis=JSON.parse(prior.explanation);}catch{continue;}
  if(basis?.schema_version==='ai-release-method-basis-v1'&&basis.recipe_id===b.method.recipe_id&&basis.recipe_sha256===b.method.recipe_sha256&&basis.interpretation_receipt_sha256===b.method.interpretation_receipt_sha256){const index=raw.applicability.findIndex(d=>d.decision_id===id);if(index<0)raw.applicability.push(structuredClone(prior));else raw.applicability[index]=structuredClone(prior);}
 }
 for(const key of ['aged_21_or_more','under_60'] as const){if(original.facts[key].state==='derived')throw Error('PENSION_RAW_DERIVED_FACT');if(raw.facts[key].state==='derived')raw.facts[key]=structuredClone(original.facts[key]);}
 return materializePensionCaseFacts(raw,review);
}
/** Defense in depth for the engine. Authentication replays this against raw
 * source input separately; a derivation cannot merely carry a claimed hash. */
export function assertPensionDerivedFacts(input:PensionEntitlementInput){
 const derived=Object.entries(input.facts).filter(([,f])=>f.state==='derived');if(!derived.length)return;
 if(derived.some(([key])=>!['aged_21_or_more','under_60'].includes(key)))throw Error('PENSION_DERIVED_FACT_KEY');
 const raw=structuredClone(input);for(const [key]of derived){const name=key as 'aged_21_or_more'|'under_60';raw.facts[name]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};}
 const replay=materializePensionCaseFacts(raw);
 for(const [key,f]of derived)if(canonicalSha256(f)!==canonicalSha256(replay.facts[key as 'aged_21_or_more'|'under_60']))throw Error('PENSION_DERIVED_FACT_REPLAY');
}
