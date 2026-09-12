import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {productAgeRangeSelection} from '../product-age-range.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeEntitlementInput} from './contracts.ts';
import {workingTimeProductFactsV2Schema,WORKING_TIME_PRODUCT_FACTS_POLICY,workingTimeCaseRecipeBindingSchema} from './product-fact-contracts.ts';
import {evaluateWorkingTimeCaseRecipe} from './product-decisions.ts';
import {WORKING_TIME_SOURCE_REVIEW_SHA256} from './source-policy.ts';
import {atTime} from './time-source.ts';
import {attachWorkingTimeSourceFacts,workingTimeProductSourcePins} from './source-facts.ts';

type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
export type WorkingTimeProductQuestion={path:string;fact:Fact;question:string;answer_kind:'choice'|'text';format?:'iso_date'|'clock_time';choices?:readonly {label:string;value:string|boolean|null}[]};
const usable=(f:Fact)=>['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
function at(input:WorkingTimeEntitlementInput,path:string){let value:unknown=input;for(const key of path.split('.'))value=value&&typeof value==='object'?Reflect.get(value,key):null;return value??null;}
function sourcesIn(v:unknown){const result:DocumentReviewSource[]=[];const visit=(x:unknown):void=>{const parsed=sourceSchema.safeParse(x);if(parsed.success){result.push(parsed.data);return;}if(x&&typeof x==='object')Object.values(x).forEach(visit);};visit(v);return [...new Map(result.map(s=>[canonicalSha256(s),s])).values()];}
export function workingTimeProductFacts(){const missing={state:'missing',value:null,source:null};return workingTimeProductFactsV2Schema.parse({schema_version:WORKING_TIME_PRODUCT_FACTS_POLICY,
 birth_date:missing,employment_relationship:missing,workplace_sector:missing,salary_basis:missing,job_duties:missing,occupation_group:missing,company_policy_authority:missing,employer_personal_proxy:missing,hours_trackable:missing,other_hours_terms_known:missing,contract_terms_current:missing,
 rest_start_date:missing,rest_start_time:missing,rest_end_date:missing,rest_end_time:missing,regular_wage_basis:missing,assignment_witnesses:[]});}
export function enableWorkingTimeProductFacts(candidate:WorkingTimeEntitlementInput){const input=workingTimeEntitlementInputSchema.parse(candidate);return {...input,product_facts:input.product_facts??workingTimeProductFacts()};}
export function workingTimeProductFactQuestions(input:WorkingTimeEntitlementInput,review?:DocumentReviewInput):WorkingTimeProductQuestion[]{
 const p=input.product_facts;if(p?.schema_version!==WORKING_TIME_PRODUCT_FACTS_POLICY)return [];
 const out:WorkingTimeProductQuestion[]=[];
 const add=(key:keyof typeof p,question:string,values?:Record<string,string|boolean>,format?:WorkingTimeProductQuestion['format'])=>{const f=p[key];if(!f||typeof f!=='object'||!('state'in f)||usable(f))return;out.push({path:'product_facts.'+key,fact:f,question,answer_kind:values?'choice':'text',...(values?{choices:[...Object.entries(values).map(([label,value])=>({label,value})),{label:'לא ידוע',value:null}]}:{}),...(format?{format}:{})});};
 if(productAgeRangeSelection(input,p.birth_date).kind!=='range')add('birth_date','מה תאריך הלידה שלך? הנתון ישמש לבדיקת הגיל בתקופת העבודה.',undefined,'iso_date');
 add('employment_relationship','מה היה מעמד העבודה בתקופה הנבדקת?',{'שכיר או שכירה':'employee','עצמאי או עצמאית':'self_employed','מעמד אחר':'other'});
 add('workplace_sector','באיזה מגזר היה מקום העבודה בתקופה הנבדקת?',{'המגזר הפרטי':'private','המגזר הציבורי':'public','מפעל מוגן':'protected_workshop','מגזר אחר':'other'});
 add('salary_basis','כיצד נקבע השכר בתקופה הנבדקת?',{'לפי שעות עבודה':'hourly','שכר חודשי':'monthly','שיטה אחרת':'other'});
 add('job_duties','מה היו המשימות והסמכויות שביצעת בפועל בתקופת העבודה? נא לתאר את התפקיד, לא רק את שם המשרה.');
 add('occupation_group','האם העבודה הייתה באחת מהמסגרות הבאות?',{'עבודה אחרת שאינה אחת המסגרות המפורטות':'ordinary','משטרה או שירות בתי הסוהר':'police_prison','עבודה בים או בדיג':'sea_fishing','צוות אוויר':'aircrew','טיפול סיעודי תוך מגורים בבית המטופל':'live_in_care','מסגרת אחרת שאיני יודע/ת לסווג':'other'});
 add('company_policy_authority','האם הייתה לך סמכות לקבוע את מדיניות העסק או תנאי העסקתם של עובדים, מעבר לביצוע משימות או תיאום משמרת?',{'כן':true,'לא':false});
 add('employer_personal_proxy','האם פעלת כנציג/ה אישי/ת של בעל העסק, עם סמכות עצמאית להתחייב בשמו או לנהל את ענייניו האישיים?',{'כן':true,'לא':false});
 add('hours_trackable','האם המעסיק יכול היה לעקוב בפועל אחר זמני תחילת העבודה וסיומה, למשל באמצעות רישום נוכחות, סידור עבודה או מנהל במקום?',{'כן':true,'לא':false});
 add('other_hours_terms_known','האם נמסר לך הסדר שעות מיוחד או מיטיב בחוזה, בהסכם קיבוצי או במקום העבודה?',{'כן':true,'לא ידוע לי על הסדר נוסף':false});
 if(review?.documents.some(d=>d.kind==='contract'&&input.source_manifest.some(m=>m.document_id===d.document_id)))add('contract_terms_current',`האם נמסר או סוכם שינוי בתנאי השכר או מתכונת השבוע שבחוזה המצורף בתקופה ${input.period.from} עד ${input.period.to}?`,{'לא נמסר ולא סוכם שינוי לתנאים אלה':true,'נמסר או סוכם שינוי לתנאים אלה':false});
 if(!usable(input.rest_window)||isWorkingTimeRestDeclarationSource(input.rest_window.source)){
  add('rest_start_date',`באיזה תאריך התחילה המנוחה השבועית שנקבעה בשבוע שמתחיל ב־${input.week_start}?`,undefined,'iso_date');
  add('rest_start_time','באיזו שעה התחילה המנוחה השבועית שנקבעה? יש להזין HH:mm.',undefined,'clock_time');
  add('rest_end_date','באיזה תאריך הסתיימה המנוחה השבועית שנקבעה?',undefined,'iso_date');
  add('rest_end_time','באיזו שעה הסתיימה המנוחה השבועית שנקבעה? יש להזין HH:mm.',undefined,'clock_time');
 }
 return out;
}
export function workingTimeProductFactKey(review:DocumentReviewInput,input:WorkingTimeEntitlementInput,path:string){
 const pins=workingTimeProductSourcePins(review,input);
 return 'entitlement.work.personal.'+canonicalSha256({period:input.period,pins,path,...(path.startsWith('product_facts.rest_')?{week_start:input.week_start}:{})}).slice(0,28);
}
export function assertWorkingTimeAnswerTarget(review:DocumentReviewInput,input:WorkingTimeEntitlementInput,path:string,value:unknown){
 if(!/^product_facts\.[a-z_]+$/u.test(path))return false;
 if(!value||typeof value!=='object'||!('source'in value))return false;
 const parsed=sourceSchema.safeParse(value.source);if(!parsed.success||parsed.data.reading!=='customer_declaration')return false;
 const h=review.answer_history.find(h=>h.receipt.answer_sha256===parsed.data.reading_receipt_sha256);
 if(!h||h.request.target.fact_key!==workingTimeProductFactKey(review,input,path))throw Error('WT_PERSONAL_ANSWER_TARGET');
 return true;
}
const REST_DERIVATION='working-time-rest-declaration-v1';
export function isWorkingTimeRestDeclarationSource(source:DocumentReviewSource|null|undefined){if(!source?.locator.startsWith('{'))return false;try{return JSON.parse(source.locator).schema_version===REST_DERIVATION;}catch{return false;}}
/** Combines four identified factual answers. Their source hashes remain in the
 * input and calculation citations; the combined value is never observed time. */
export function workingTimeRestFromDeclarations(input:WorkingTimeEntitlementInput):WorkingTimeEntitlementInput['rest_window']|null{
 const p=input.product_facts;if(p?.schema_version!==WORKING_TIME_PRODUCT_FACTS_POLICY)return null;
 const parts=[p.rest_start_date,p.rest_start_time,p.rest_end_date,p.rest_end_time];
 if(!parts.every(f=>usable(f)&&f.state==='declared'&&f.source?.reading==='customer_declaration'))return null;
 const start_at=p.rest_start_date.value+'T'+p.rest_start_time.value+':00+03:00',end_at=p.rest_end_date.value+'T'+p.rest_end_time.value+':00+03:00';
 const body={schema_version:REST_DERIVATION,week_start:input.week_start,timezone:'Asia/Jerusalem',utc_offset:'+03:00',parts_sha256:parts.map(canonicalSha256)};
 const source={...parts[0].source!,locator:JSON.stringify({schema_version:REST_DERIVATION,derivation_sha256:canonicalSha256(body)}),label:'חלון מנוחה מתוך ארבע תשובות מזוהות'};
 if(![start_at,end_at].every(v=>/^2026-(?:05|06|07|08)-/u.test(v)))return {state:'conflict',value:null,source};
 const start=atTime(start_at),end=atTime(end_at),week=Date.parse(input.week_start+'T00:00:00+03:00');
 if(end<=start||end-start<36*3600000||end-start>168*3600000||start<week-36*3600000||end>week+204*3600000)return {state:'conflict',value:null,source};
 return {state:'declared',value:{start_at,end_at},source};
}
export function assertWorkingTimeRestDerivation(input:WorkingTimeEntitlementInput,value:unknown){const expected=workingTimeRestFromDeclarations(input);return expected!==null&&canonicalSha256(expected)===canonicalSha256(value);}
export function materializeWorkingTimeProductFacts(candidate:WorkingTimeEntitlementInput){
 const input=workingTimeEntitlementInputSchema.parse(candidate),result=structuredClone(input);if(input.product_facts?.schema_version!==WORKING_TIME_PRODUCT_FACTS_POLICY)return result;
 if(isWorkingTimeRestDeclarationSource(input.rest_window.source)||(['missing','unknown'].includes(input.rest_window.state)&&!input.rest_window.source)){
  const derived=workingTimeRestFromDeclarations(input);
  const parts=[input.product_facts.rest_start_date,input.product_facts.rest_start_time,input.product_facts.rest_end_date,input.product_facts.rest_end_time];
  const state=(['conflict','stale','expired','unreadable','unknown','missing'] as const).find(state=>parts.some(p=>p.state===state))??'missing';
  result.rest_window=derived??{state,value:null,source:null};
 }
 return result;
}
export function workingTimeCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string,decision_id:string,day_id:string|null=null){const body={schema_version:'working-time-case-recipe-binding-v1' as const,method,evaluated_at,decision_id,day_id};return workingTimeCaseRecipeBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});}
export function replayWorkingTimeProductFacts(effective:WorkingTimeEntitlementInput,original:WorkingTimeEntitlementInput,review?:DocumentReviewInput){
 if(effective.case_id!==original.case_id||canonicalSha256(effective.period)!==canonicalSha256(original.period)||effective.check_id_prefix!==original.check_id_prefix)throw Error('WT_CASE_REPLAY_SCOPE');
 const materialized=materializeWorkingTimeProductFacts(effective),result=review?attachWorkingTimeSourceFacts(materialized,review).input:materialized,bindings=original.case_recipe_bindings??[];
 if(new Set(bindings.map(b=>b.decision_id)).size!==bindings.length)throw Error('WT_CASE_DUPLICATE_BINDING');
 if(original.case_recipe_bindings)result.case_recipe_bindings=structuredClone(original.case_recipe_bindings);
 for(const raw of bindings){const b=workingTimeCaseRecipeBindingSchema.parse(raw),recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===b.method.recipe_id&&r.recipe_id.startsWith('ai-case.wt.'));
  if(!recipe||recipe.branch!=='working_time'||recipe.recipe_sha256!==b.method.recipe_sha256||recipe.recipe_version!==b.method.recipe_version||b.method.source_policy_sha256!==WORKING_TIME_SOURCE_REVIEW_SHA256||b.method.issued_at>b.evaluated_at||b.method.expires_at<=b.evaluated_at||recipe.legal_sources.some(s=>!b.method.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256)))throw Error('WT_CASE_BINDING_SCOPE');
  const expectedId=b.day_id?recipe.decision_id+'.'+b.day_id:recipe.decision_id;
  if(expectedId!==b.decision_id||b.day_id&&!original.workdays.some(d=>d.id===b.day_id))throw Error('WT_CASE_BINDING_DAY');
  const prior=original.applicability.find(d=>d.decision_id===b.decision_id);if(!prior||prior.state!=='accepted')continue;
  // A negative or stale decision is never promoted by replay. An accepted
  // bound decision must carry the exact compiler-produced method basis.
  let basis;try{basis=JSON.parse(prior.explanation);}catch{throw Error('WT_CASE_DECISION_BINDING');}
  if(basis?.schema_version!=='ai-release-method-basis-v1'||basis.recipe_id!==recipe.recipe_id||basis.recipe_sha256!==recipe.recipe_sha256||basis.interpretation_receipt_sha256!==b.method.interpretation_receipt_sha256)throw Error('WT_CASE_DECISION_BINDING');
  const ready=evaluateWorkingTimeCaseRecipe(b.decision_id,result,{review,day_id:b.day_id??undefined,...(b.method.recipe_id.endsWith('.age-range-v1')?{age_range:true as const}:{})});
  const current=ready.allowed&&basis.consumed_sha256===ready.consumed_sha256?prior:{...prior,state:'stale' as const,explanation:JSON.stringify({schema_version:'working-time-case-stale-v1',prior_explanation_sha256:canonicalSha256(prior.explanation),reason:ready.allowed?'consumed_facts_changed':ready.reason})};
  result.applicability=result.applicability.filter(d=>d.decision_id!==b.decision_id);result.applicability.push(structuredClone(current));
 }
 return result;
}
export function workingTimeCaseDecisionSources(input:WorkingTimeEntitlementInput,decisionId:string){
 const binding=input.case_recipe_bindings?.find(b=>b.decision_id===decisionId);if(!binding)return [];
 const ready=evaluateWorkingTimeCaseRecipe(decisionId,input,binding.method.recipe_id.endsWith('.age-range-v1')?{age_range:true}:{});return ready.allowed?sourcesIn(ready.consumed_paths.map(p=>at(input,p))):[];
}
export function workingTimeRestDeclarationSources(input:WorkingTimeEntitlementInput){const p=input.product_facts;return p?.schema_version===WORKING_TIME_PRODUCT_FACTS_POLICY&&isWorkingTimeRestDeclarationSource(input.rest_window.source)?sourcesIn([p.rest_start_date,p.rest_start_time,p.rest_end_date,p.rest_end_time]):[];}
