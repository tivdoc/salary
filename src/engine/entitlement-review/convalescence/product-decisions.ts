import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {convalescenceEntitlementInputSchema,type ConvalescenceEntitlementInput} from './contracts.ts';
import {employmentAnniversary,nextConvalescenceDate} from './periods.ts';
import {CONVALESCENCE_SOURCE_REVIEW,CONVALESCENCE_SOURCE_REVIEW_SHA256,CONVALESCENCE_PINNED_LEGAL_DOCUMENTS,convalescenceLegalSource} from './source-policy.ts';
import {convalescenceCaseBindingSchema} from './case-bindings.ts';
import {CONVALESCENCE_CASE_FACTS_POLICY,convalescenceCaseProductFacts} from './product-facts.ts';
export {convalescenceCaseBinding} from './case-bindings.ts';

type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const usable=(f:Fact)=>['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
function sourcesIn(value:unknown){const sources:DocumentReviewSource[]=[];const visit=(v:unknown):void=>{const s=sourceSchema.safeParse(v);if(s.success){sources.push(s.data);return;}if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(value);return [...new Map(sources.map(s=>[canonicalSha256(s),s])).values()];}
function at(input:ConvalescenceEntitlementInput,path:string){if(path==='applicability#cv.source_chain')return input.applicability.find(d=>d.decision_id==='cv.source_chain')??null;let v:unknown=input;for(const k of path.split('.'))v=v&&typeof v==='object'?Reflect.get(v,k):null;return v??null;}
function validateSource(source:DocumentReviewSource,input:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 const pins=input.source_manifest.filter(p=>p.document_id===source.document_id&&p.version_id===source.version_id);
 if(pins.length!==1||pins[0].case_id!==input.case_id||pins[0].file_sha256!==source.file_sha256||source.page>pins[0].page_count)throw Error('CV_CASE_SOURCE_BINDING');
 if((source.reading==='customer_declaration')!==(pins[0].kind==='customer_answer')||(source.reading==='questionnaire_declaration')!==(pins[0].kind==='questionnaire'))throw Error('CV_CASE_DECLARATION_SOURCE');
 // Full declaration value, history, latest-revision and currentness admission
 // remains in the ordinary authenticated source-packet service.
 if(review&&!['customer_declaration','questionnaire_declaration'].includes(source.reading)&&!review.documents.some(d=>d.case_id===input.case_id&&d.document_id===source.document_id&&d.version_id===source.version_id&&d.file_sha256===source.file_sha256&&d.page_count!==null&&source.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(source.reading_receipt_sha256)))throw Error('CV_CASE_CURRENT_SOURCE');
}
function factReason(path:string,f:Fact,input:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 if(f.source)validateSource(f.source,input,review);
 if(!usable(f))return path+':'+f.state;
 if(f.state==='declared'&&!['customer_declaration','questionnaire_declaration'].includes(f.source!.reading))return path+':declaration_basis_mismatch';
 if(f.state==='observed'&&['customer_declaration','questionnaire_declaration','source_research'].includes(f.source!.reading))return path+':observed_basis_mismatch';
 return null;
}
export function convalescenceCaseConsumed(input:ConvalescenceEntitlementInput,paths:readonly string[]){return paths.map(path=>{const value=at(input,path);return {path:'entitlement_evidence.convalescence.'+path,state:value&&typeof value==='object'&&'state' in value?String(value.state):value===null?'missing':'structural',value_sha256:canonicalSha256(value),source_sha256s:sourcesIn(value).map(s=>canonicalSha256(s))};});}
function coverageReason(input:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 const missing=factReason('payment_coverage',input.payment_coverage,input,review);if(missing)return missing;
 const p=input.payment_coverage.value!;return p.from>p.to?'payment_coverage:conflict':null;
}
function serviceReason(input:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 for(const [path,f]of [['employment_start',input.employment_start],['qualifying_service',input.qualifying_service],['due_date',input.due_date]] as const){const reason=factReason(path,f,input,review);if(reason)return reason;}
 const coverage=coverageReason(input,review);if(coverage)return coverage;
 if(input.qualifying_service.value!=='continuous_no_excluded_absence')return 'qualifying_service:excluded_absence_or_break';
 const start=input.employment_start.value!,period=input.payment_coverage.value!,due=input.due_date.value!;
 if(start.slice(5)==='02-29')return 'employment_start:leap_anniversary_method_required';
 if(period.from<start||period.to>due||due<start)return 'employment_chronology:conflict';
 if(due<employmentAnniversary(start,1))return 'first_year:not_completed_by_due_date';
 return null;
}
/** Validates the existing segment inventory; never creates an FTE or assumes a
 * July–June service year. Date stepping reuses the branch's existing helper. */
export function convalescenceCaseSegmentReadiness(input:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 const coverage=coverageReason(input,review);if(coverage)return {allowed:false,reason:coverage};
 if(!input.segments.length)return {allowed:false,reason:'segments:missing'};
 if(new Set(input.segments.map(s=>s.id)).size!==input.segments.length)return {allowed:false,reason:'segments:duplicate'};
 for(const [i,s]of input.segments.entries()){
  for(const [path,f]of [[`segments.${i}.period`,s.period],[`segments.${i}.fte`,s.fte]] as const){const reason=factReason(path,f,input,review);if(reason)return {allowed:false,reason};}
  if(Number(s.fte.value)<=0)return {allowed:false,reason:`segments.${i}.fte:zero_requires_absence_review`};
 }
 const ordered=[...input.segments].sort((a,b)=>a.period.value!.from.localeCompare(b.period.value!.from));let cursor=input.payment_coverage.value!.from;
 for(const s of ordered){const p=s.period.value!;if(p.from!==cursor||p.to<p.from||p.to>input.payment_coverage.value!.to)return {allowed:false,reason:'segments:overlap_gap_or_outside_coverage'};cursor=nextConvalescenceDate(p.to);}
 return cursor===nextConvalescenceDate(input.payment_coverage.value!.to)?{allowed:true,reason:null}:{allowed:false,reason:'segments:incomplete_coverage'};
}
const pathsFor:Readonly<Record<string,readonly string[]>>={
 'cv.benefit_year':['period','evaluated_at','benefit_year','payment_coverage'],
 'cv.qualifying_service':['period','employment_start','qualifying_service','payment_coverage','due_date','segments'],
 'cv.due_date':['period','employment_start','payment_coverage','due_date'],
 'cv.allocation':['period','payment_coverage','recorded','recorded_coverage','recorded_inventory'],
 'cv.population':['period','source_gates_policy','product_facts.birth_date','product_facts.employment_relationship','product_facts.workplace_sector','product_facts.employment_category','product_facts.public_wage_linked'],
 'cv.legal_source_chain':['period','evaluated_at','source_gates_policy'],
 'cv.arrangement_scope':['period','source_gates_policy','applicability#cv.source_chain','product_facts.special_terms_known'],
};
export type ConvalescenceCaseReadiness={allowed:boolean;reason:string|null;consumed_paths:string[];consumed_sha256:string;source_sha256s:string[];source_policy_sha256:string;dependent_check_ids:string[]};
/** Readiness only. No assessment, legal acceptance, derived money, or extra
 * questions are generated. The caller still needs a pinned method receipt. */
export function evaluateConvalescenceCaseRecipe(decisionId:string,candidate:ConvalescenceEntitlementInput,review?:DocumentReviewInput):ConvalescenceCaseReadiness{
 const input=convalescenceEntitlementInputSchema.parse(candidate),paths=[...(pathsFor[decisionId]??[])];
 const finish=(reason:string|null):ConvalescenceCaseReadiness=>{const consumed=convalescenceCaseConsumed(input,paths);return {allowed:reason===null,reason,consumed_paths:paths,consumed_sha256:canonicalSha256(consumed),source_sha256s:[...new Set(consumed.flatMap(c=>c.source_sha256s))],source_policy_sha256:CONVALESCENCE_SOURCE_REVIEW_SHA256,dependent_check_ids:decisionId==='cv.allocation'?[input.check_prefix+'.comparison']:[input.check_prefix+'.expected',input.check_prefix+'.comparison']};};
 if(review&&(review.case_id!==input.case_id||!same(review.period,input.period)))throw Error('CV_CASE_SCOPE');
 const last=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from.slice(8)!=='01'||input.period.to!==last)return finish('unsupported_payroll_month');
 if(!Object.hasOwn(pathsFor,decisionId))return finish(decisionId==='cv.source_chain'?'source_chain_and_arrangement_must_be_assessed_separately':'unsupported_case_recipe');
 if(['cv.population','cv.legal_source_chain','cv.arrangement_scope'].includes(decisionId)&&input.source_gates_policy!=='cv-source-gates-v2')return finish('source_gates_v2_required');
 if(decisionId==='cv.population'){
  const p=input.product_facts;if(p?.schema_version!==CONVALESCENCE_CASE_FACTS_POLICY)return finish('personal_facts_v2_required');
  if(!['missing','observed','declared','derived'].includes(input.population.state))return finish('population:'+input.population.state);
  if(['observed','declared'].includes(input.population.state)&&input.population.value!=='adult_private_general_21_59')return finish('population:existing_source_conflict');
  for(const [path,f]of [['birth_date',p.birth_date],['employment_relationship',p.employment_relationship],['public_wage_linked',p.public_wage_linked]] as const){const reason=factReason('product_facts.'+path,f,input,review);if(reason)return finish(reason);}
  const sector=p.workplace_sector.state==='missing'?p.employment_category:p.workplace_sector,reason=factReason('product_facts.workplace_sector',sector,input,review);if(reason)return finish(reason);
  if(p.employment_category.source)validateSource(p.employment_category.source,input,review);
  if(!['missing','observed','declared'].includes(p.employment_category.state))return finish('product_facts.employment_category:'+p.employment_category.state);
  if(p.employment_relationship.value!=='employee'||sector.value!=='private'||p.public_wage_linked.value!==false)return finish('population:unsupported_employee_sector_or_public_linkage');
  if(usable(p.employment_category)&&p.employment_category.value!=='private')return finish('population:employment_category_conflict');
  const birthday=p.birth_date.value!;const anniversary=(years:number)=>{const [year,month,day]=birthday.split('-').map(Number),last=new Date(Date.UTC(year+years,month,0)).getUTCDate();return `${year+years}-${String(month).padStart(2,'0')}-${String(Math.min(day,last)).padStart(2,'0')}`;};
  return finish(anniversary(21)>input.period.from||anniversary(60)<=input.period.to?'population:outside_product_age21_59':null);
 }
 if(decisionId==='cv.legal_source_chain')return finish(input.evaluated_at.slice(0,10)<CONVALESCENCE_SOURCE_REVIEW.knowledge_available_from?'source_not_yet_published_at_knowledge_date':null);
 if(decisionId==='cv.arrangement_scope'){
  if(input.product_facts?.schema_version===CONVALESCENCE_CASE_FACTS_POLICY&&usable(input.product_facts.special_terms_known)&&input.product_facts.special_terms_known.value===true)return finish('arrangement:reported_special_terms_require_source_review');
  const prior=input.applicability.find(d=>d.decision_id==='cv.source_chain');
  if(!prior||prior.state!=='accepted'||prior.basis==='customer_declaration'||prior.valid_until!==null&&Date.parse(prior.valid_until)<=Date.parse(input.evaluated_at))return finish('arrangement:current_positive_contract_classification_required');
  const contractSources=prior.sources.filter(s=>review?.documents.some(d=>d.kind==='contract'&&d.case_id===input.case_id&&d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256));
  if(!contractSources.length||contractSources.some(s=>['customer_declaration','questionnaire_declaration','source_research'].includes(s.reading)))return finish('arrangement:identified_contract_classification_source_required');
  for(const s of contractSources)validateSource(s,input,review);
  return finish(null);
 }
 if(decisionId==='cv.benefit_year'){
  if(input.evaluated_at.slice(0,10)<CONVALESCENCE_SOURCE_REVIEW.knowledge_available_from)return finish('source_not_yet_published_at_knowledge_date');
  const reason=factReason('benefit_year',input.benefit_year,input,review)??coverageReason(input,review);if(reason)return finish(reason);
  // An explicit factual answer/source names the benefit year. Neither the
  // payroll month nor calendar boundaries are used to invent that answer.
  return finish(input.benefit_year.value===2026?null:'benefit_year:unsupported_or_prior_year');
 }
 if(decisionId==='cv.qualifying_service'){
  const service=serviceReason(input,review);if(service)return finish(service);
  return finish(convalescenceCaseSegmentReadiness(input,review).reason);
 }
 if(decisionId==='cv.due_date'){
  const missing=factReason('employment_start',input.employment_start,input,review)??coverageReason(input,review)??factReason('due_date',input.due_date,input,review);if(missing)return finish(missing);
  const due=input.due_date.value!,coverage=input.payment_coverage.value!;
  if(coverage.from<input.employment_start.value!||coverage.to>due)return finish('due_date:coverage_chronology_conflict');
  return finish(due<input.period.from||due>input.period.to?'due_date:outside_selected_payroll_month':null);
 }
 const missing=coverageReason(input,review)??factReason('recorded_coverage',input.recorded_coverage,input,review)??factReason('recorded_inventory',input.recorded_inventory,input,review);if(missing)return finish(missing);
 const r=input.recorded;if(!r||r.state!=='observed'||r.printed_value===null||r.representation!=='money_ils'||r.quantity_unit!==null||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(r.printed_value))return finish('recorded:identified_amount_required');
 validateSource(r.source,input,review);
 if(r.source.reading!=='identified_document_reading'||input.recorded_coverage.state!=='observed'||input.recorded_inventory.state!=='observed'||input.recorded_coverage.source!.reading!=='identified_document_reading'||input.recorded_inventory.source!.reading!=='identified_document_reading')return finish('recorded:identified_allocation_required');
 if(input.recorded_inventory.value!=='complete_allocated')return finish('recorded_inventory:complete_allocation_required');
 if(!same(input.recorded_coverage.value,input.payment_coverage.value))return finish('recorded_coverage:period_mismatch');
 const match=(s:DocumentReviewSource)=>s.document_id===r.source.document_id&&s.version_id===r.source.version_id&&s.file_sha256===r.source.file_sha256&&s.reading_receipt_sha256===r.source.reading_receipt_sha256&&s.page===r.source.page;
 return finish([input.recorded_coverage.source!,input.recorded_inventory.source!].every(match)?null:'recorded_allocation:source_group_mismatch');
}
/** Legal-version completeness is independently visible; it is deliberately not
 * the old combined cv.source_chain decision, nor a population assessment. */
export function convalescenceSourceChainReadiness(input:ConvalescenceEntitlementInput,method:AiReleaseDecisionMethod|undefined,at:string){
 const recipe=method?AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===method.recipe_id):null;
 const expected=CONVALESCENCE_PINNED_LEGAL_DOCUMENTS,legal=!!method&&!!recipe&&recipe.branch==='convalescence'&&recipe.recipe_sha256===method.recipe_sha256&&recipe.recipe_version===method.recipe_version&&method.source_policy_sha256===CONVALESCENCE_SOURCE_REVIEW_SHA256&&Date.parse(method.issued_at)<=Date.parse(at)&&Date.parse(method.expires_at)>Date.parse(at)&&at.slice(0,10)>=CONVALESCENCE_SOURCE_REVIEW.knowledge_available_from&&input.evaluated_at.slice(0,10)>=CONVALESCENCE_SOURCE_REVIEW.knowledge_available_from&&input.period.from>='2026-05-01'&&input.period.to<='2026-07-31'&&expected.every(s=>method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256));
 return {legal_chain_ready:legal,legal_chain_reason:legal?null:'current_complete_source_chain_receipt_required',arrangement_ready:false as const,arrangement_reason:'separate_sector_or_better_arrangement_source_required',population:input.population.state==='observed'||input.population.state==='declared'?input.population.value:null,legacy_combined_decision_allowed:false as const,publication_authority:false as const,source_policy_sha256:CONVALESCENCE_SOURCE_REVIEW_SHA256};
}
/** Full receipt guard for integration, without issuing or mutating a decision. */
export function validateConvalescenceCaseMethod(method:AiReleaseDecisionMethod,at:string,input:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===method.recipe_id&&r.recipe_id.startsWith('ai-case.cv.'));
 if(!recipe||recipe.branch!=='convalescence'||recipe.recipe_sha256!==method.recipe_sha256||recipe.recipe_version!==method.recipe_version||method.source_policy_sha256!==CONVALESCENCE_SOURCE_REVIEW_SHA256||Date.parse(method.issued_at)>Date.parse(at)||Date.parse(method.expires_at)<=Date.parse(at)||recipe.legal_sources.some(s=>!method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))throw Error('CV_CASE_METHOD_BINDING');
 return evaluateConvalescenceCaseRecipe(recipe.decision_id,input,review);
}
/** The immutable source keeps its original facts and law-only method decision.
 * Only the current effective candidate cites the consumed personal/source data. */
export function convalescenceCaseDecisionSources(input:ConvalescenceEntitlementInput,id:string){
 if(!input.case_recipe_bindings?.some(b=>b.method.recipe_id==='ai-case.'+id))return [];
 const paths=pathsFor[id];return paths?sourcesIn(paths.map(p=>at(input,p))):[];
}
export function replayConvalescenceCaseFacts(effective:ConvalescenceEntitlementInput,original:ConvalescenceEntitlementInput,review?:DocumentReviewInput){
 if(original.case_id!==effective.case_id||!same(original.period,effective.period))throw Error('CV_CASE_REPLAY_SCOPE');
 const result=structuredClone(effective),bindings=original.case_recipe_bindings??[];
 if(bindings.some(b=>b.method.recipe_id==='ai-case.cv.population'))result.population=structuredClone(original.population);
 if(new Set(bindings.map(b=>b.method.recipe_id)).size!==bindings.length)throw Error('CV_DUPLICATE_CASE_BINDING');
 if(original.case_recipe_bindings)result.case_recipe_bindings=structuredClone(original.case_recipe_bindings);
 for(const b of bindings){convalescenceCaseBindingSchema.parse(b);const ready=validateConvalescenceCaseMethod(b.method,b.evaluated_at,result,review),recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===b.method.recipe_id)!;
  const prior=original.applicability.find(d=>d.decision_id===recipe.decision_id);if(!prior)continue;let basis;try{basis=JSON.parse(prior.explanation);}catch{continue;}
  if(basis?.schema_version!=='ai-release-method-basis-v1'||basis.recipe_id!==recipe.recipe_id||basis.recipe_sha256!==recipe.recipe_sha256||basis.interpretation_receipt_sha256!==b.method.interpretation_receipt_sha256)continue;
  const changed=basis.consumed_sha256!==canonicalSha256(convalescenceCaseConsumed(result,ready.consumed_paths));
  const next=prior.state==='accepted'&&(!ready.allowed||changed)?{...prior,state:'stale' as const,explanation:JSON.stringify({schema_version:'convalescence-case-recipe-stale-v1',prior_explanation_sha256:canonicalSha256(prior.explanation),recipe_id:recipe.recipe_id,reason:ready.allowed?'consumed_facts_changed':ready.reason})}:structuredClone(prior);
  const index=result.applicability.findIndex(d=>d.decision_id===recipe.decision_id);if(index<0)result.applicability.push(next);else result.applicability[index]=next;
  if(recipe.decision_id==='cv.population'&&ready.allowed&&!changed&&next.state==='accepted'&&original.population.state==='missing')result.population={state:'derived',value:'adult_private_general_21_59',source:convalescenceLegalSource(0,'נגזר מנתוני העסקה וגיל מזוהים; גיל 21–59 הוא גבול המוצר ולא תנאי הזכאות בצו'),
   derivation:{schema_version:'convalescence-derived-population-v1',binding_sha256:b.binding_sha256,inputs_sha256:canonicalSha256(convalescenceCaseConsumed(result,ready.consumed_paths))}};
 }
 return result;
}
export function enableConvalescenceCaseFacts(raw:ConvalescenceEntitlementInput){return convalescenceEntitlementInputSchema.parse({...raw,source_gates_policy:'cv-source-gates-v2',product_facts:convalescenceCaseProductFacts(raw.product_facts)});}
/** Reconstruct the only new derived field from the exact bound original facts.
 * The source-packet boundary separately authenticates current answer receipts. */
export function assertConvalescenceDerivedPopulation(input:ConvalescenceEntitlementInput){
 if(input.population.state!=='derived')return;
 if(input.source_gates_policy!=='cv-source-gates-v2')throw Error('CV_DERIVED_POPULATION_POLICY');
 const raw={...structuredClone(input),population:{state:'missing' as const,value:null,source:null}};
 const reconstructed=replayConvalescenceCaseFacts(raw,raw);
 if(!same(reconstructed.population,input.population))throw Error('CV_DERIVED_POPULATION_REPLAY');
}
export function convalescenceCaseQuestions(input:ConvalescenceEntitlementInput){
 const p=input.product_facts;if(input.source_gates_policy!=='cv-source-gates-v2'||p?.schema_version!==CONVALESCENCE_CASE_FACTS_POLICY)return [];
 const questions:Array<{path:string;question:string;fact:Fact;answer_kind:'choice'|'text';format?:'iso_date';choices?:readonly {label:string;value:string|boolean|null}[]}>=[];
 const add=(path:string,fact:Fact,question:string,entries?:Record<string,string|boolean>,format?:'iso_date')=>{if(!usable(fact))questions.push({path:'product_facts.'+path,fact,question,answer_kind:entries?'choice':'text',...(entries?{choices:[...Object.entries(entries).map(([label,value])=>({label,value})),{label:'לא ידוע',value:null}]}:{}),...(format?{format}:{})});};
 const populationAccepted=input.applicability.some(d=>d.decision_id==='cv.population'&&d.state==='accepted'&&d.basis!=='customer_declaration'&&d.sources.length&&(d.valid_until===null||Date.parse(d.valid_until)>Date.parse(input.evaluated_at)));
 if(!['observed','declared','derived'].includes(input.population.state)||!populationAccepted){
  add('birth_date',p.birth_date,'מה תאריך הלידה שלך? גיל 21–59 מגדיר את היקף בדיקת המוצר, ואינו תנאי הזכאות לדמי הבראה בצו.',undefined,'iso_date');
  add('employment_relationship',p.employment_relationship,'איך הועסקת אצל המעסיק בתקופת הבדיקה?',{'כשכיר/ה':'employee','כעצמאי/ת כנגד חשבוניות':'self_employed','בדרך אחרת':'other'});
  if(!usable(p.employment_category))add('workplace_sector',p.workplace_sector,'מה סוג מקום העבודה בתקופה הנבדקת?',{'מעסיק פרטי':'private','מעסיק ציבורי':'public','מפעל מוגן':'protected_workshop','אחר':'other'});
  add('public_wage_linked',p.public_wage_linked,'האם השכר נקבע לפי דירוג או טבלאות שכר במגזר הציבורי, או מוצמד אליהם?',{'כן':true,'לא':false});
 }
 if(!input.applicability.some(d=>d.decision_id==='cv.arrangement_scope'&&d.state==='accepted'&&(d.valid_until===null||Date.parse(d.valid_until)>Date.parse(input.evaluated_at))))add('special_terms_known',p.special_terms_known,'האם ידוע לך על תנאי הבראה מיוחדים בחוזה, בהסכם או בהודעה מהמעסיק? תשובה שלילית אינה אישור שאין זכויות נוספות.',{'כן':true,'לא ידוע לי על תנאים מיוחדים':false});
 return questions;
}
