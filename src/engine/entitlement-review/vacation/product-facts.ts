import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import {aiReleaseDecisionMethodSchema,type AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import type {VacationEntitlementInput} from './contracts.ts';
import {VACATION_SOURCE_REVIEW_SHA256,vacationLegalSource} from './sources.ts';
import {evaluateVacationCaseRecipe,vacationCaseConsumed} from './product-decisions.ts';
import {produceVacationSourceEvidence,vacationSourceFactKey} from './product-source-evidence.ts';

const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source,sha=z.string().regex(/^[a-f0-9]{64}$/u);
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:sourceSchema.nullable()}).strict().refine(f=>!['observed','declared'].includes(f.state)||'value'in f&&f.value!==null&&f.source!==null,'VACATION_PRODUCT_FACT_SOURCE');
export const vacationProductFactsSchema=z.object({schema_version:z.literal('vacation-product-facts-v1'),
 birth_date:fact(z.iso.date()),employment_relationship:fact(z.enum(['employee','self_employed','other'])),workplace_sector:fact(z.enum(['private','public','protected_workshop','other'])),
 salary_basis:fact(z.enum(['monthly','hourly','other'])),continuous_employment:fact(z.boolean()),same_employer_or_workplace:fact(z.boolean()),
 other_vacation_terms_known:fact(z.boolean()),preceding_quarter_full_months:fact(z.boolean()),
}).strict();
export function vacationProductFacts(){const missing={state:'missing',value:null,source:null};return vacationProductFactsSchema.parse({schema_version:'vacation-product-facts-v1',birth_date:missing,employment_relationship:missing,workplace_sector:missing,salary_basis:missing,continuous_employment:missing,same_employer_or_workplace:missing,other_vacation_terms_known:missing,preceding_quarter_full_months:missing});}
export function enableVacationProductFacts(input:VacationEntitlementInput,options?:{statutory_scenario:true}):VacationEntitlementInput{return {...input,product_facts:input.product_facts??vacationProductFacts(),...(options?.statutory_scenario?{product_scenario_policy:'vacation-qualified-statutory-scenario-v1' as const}:{})};}
export const vacationCaseRecipeBindingSchema=z.object({schema_version:z.literal('vacation-case-recipe-binding-v1'),method:aiReleaseDecisionMethodSchema,evaluated_at:z.iso.datetime(),binding_sha256:sha}).strict().refine(b=>{const {binding_sha256,...body}=b;return canonicalSha256(body)===binding_sha256;},'VACATION_CASE_BINDING_HASH');
export const vacationDerivedFactSchema=z.object({schema_version:z.literal('vacation-derived-fact-v1'),binding_sha256:sha,inputs_sha256:sha}).strict();
export const vacationDerivedSenioritySchema=z.object({state:z.literal('derived'),value:z.number().int().min(1).max(60),employment_start:z.iso.date(),reference_year:z.literal(2026),source:sourceSchema,derivation:vacationDerivedFactSchema}).strict();
export function vacationCaseBinding(method:AiReleaseDecisionMethod,evaluated_at:string){const body={schema_version:'vacation-case-recipe-binding-v1' as const,method,evaluated_at};return vacationCaseRecipeBindingSchema.parse({...body,binding_sha256:canonicalSha256(body)});}
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
const usable=(f:Fact|undefined)=>!!f&&['observed','declared','known'].includes(f.state)&&f.value!==null&&f.source!==null;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
function sourceBound(s:DocumentReviewSource,input:VacationEntitlementInput,review:DocumentReviewInput){
 const pin=input.source_manifest.filter(p=>p.document_id===s.document_id&&p.version_id===s.version_id);
 if(pin.length!==1||pin[0].case_id!==input.case_id||pin[0].file_sha256!==s.file_sha256||s.page>pin[0].page_count)throw Error('VACATION_PRODUCT_SOURCE_PIN');
 if((s.reading==='customer_declaration')!==(pin[0].kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(pin[0].kind==='questionnaire'))throw Error('VACATION_PRODUCT_DECLARATION_PIN');
 if(!['customer_declaration','questionnaire_declaration'].includes(s.reading)&&!review.documents.some(d=>d.case_id===input.case_id&&d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&d.page_count!==null&&s.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256)))throw Error('VACATION_PRODUCT_CURRENT_SOURCE');
}
function validate(input:VacationEntitlementInput,review:DocumentReviewInput){
 if(input.case_id!==review.case_id||!same(input.period,review.period))throw Error('VACATION_PRODUCT_SCOPE');
 for(const f of Object.values(input.product_facts??{}))if(typeof f==='object'&&f.source){sourceBound(f.source,input,review);if(f.state==='declared'&&!['customer_declaration','questionnaire_declaration'].includes(f.source.reading)||f.state==='observed'&&!['identified_document_reading','provider_extraction'].includes(f.source.reading))throw Error('VACATION_PRODUCT_FACT_BASIS');}
}
const ageAt=(birth:string,date:string)=>Number(date.slice(0,4))-Number(birth.slice(0,4))-(date.slice(5)<birth.slice(5)?1:0);
export function evaluateVacationProductRecipe(decisionId:string,input:VacationEntitlementInput,review:DocumentReviewInput){
 validate(input,review);const paths=['period'],no=(reason:string)=>({allowed:false,reason,consumed_paths:paths,derived_ages:null as {aged_21_or_more:boolean;under_60:boolean}|null,derived_seniority:null as number|null});
 if(!input.product_facts)return no('product_facts_opt_in_required');
 const last=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from.slice(8)!=='01'||input.period.to!==last)return no('unsupported_period');
 const f=input.product_facts;
 if(decisionId==='vacation.general_section3'){
  paths.push('product_facts.birth_date','product_facts.employment_relationship','product_facts.workplace_sector','product_facts.salary_basis');
  if(!usable(f.birth_date)||!usable(f.employment_relationship)||!usable(f.workplace_sector)||!usable(f.salary_basis))return no('population_facts_missing');
  if(f.employment_relationship.value!=='employee'||f.workplace_sector.value!=='private'||ageAt(f.birth_date.value!,input.period.from)<21||ageAt(f.birth_date.value!,input.period.to)>=60)return no('unsupported_population');
  if(f.salary_basis.value==='hourly'){
   paths.push('product_facts.continuous_employment','annual_basis.employment_start');
   const start=input.annual_basis?.employment_start;if(!usable(f.continuous_employment)||f.continuous_employment.value!==true||!usable(start))return no('consecutive_employment_facts_required');
   sourceBound(start!.source!,input,review);
   if(Date.parse(input.period.from)-Date.parse(start!.value!)<74*86400000)return no('section4_short_employment_separate_branch');
  }else if(f.salary_basis.value!=='monthly')return no('salary_basis_unsupported');
  for(const key of ['aged_21_or_more','under_60'] as const)if(input.facts[key].state!=='missing'&&input.facts[key].state!=='derived'&&(!usable(input.facts[key])||input.facts[key].value!==true))return no('existing_age_state_preserved');
  return {...no(''),allowed:true,reason:null,derived_ages:{aged_21_or_more:true,under_60:true}};
 }
 if(decisionId==='vacation.seniority_basis'&&!input.seniority_year){
  paths.push('annual_basis.employment_start','product_facts.same_employer_or_workplace');const start=input.annual_basis?.employment_start;
  if(!usable(start)||!usable(f.same_employer_or_workplace)||f.same_employer_or_workplace.value!==true)return no('same_employment_source_facts_required');
  sourceBound(start!.source!,input,review);const year=2026-Number(start!.value!.slice(0,4))+1;
  if(start!.value!>input.period.to||year<1||year>60)return no('employment_start_conflict');
  return {...no(''),allowed:true,reason:null,derived_seniority:year};
 }
 if(decisionId==='vacation.no_better_arrangement'){paths.push('product_facts.other_vacation_terms_known');return no(f.other_vacation_terms_known.value===true?'other_terms_source_review_required':'specific_arrangement_source_producer_required');}
 const produced=produceVacationSourceEvidence(input,review),ready=evaluateVacationCaseRecipe(decisionId,input,{review,evidence:produced.evidence,authenticated_evidence_sha256s:produced.authenticated_evidence_sha256s});
 return {...no(ready.reason??''),allowed:ready.allowed,reason:ready.reason,consumed_paths:ready.consumed_paths};
}
export function vacationProductCaseConsumed(input:VacationEntitlementInput,paths:readonly string[],review:DocumentReviewInput){
 const values=vacationCaseConsumed(input,paths);
 // Only witnesses actually associated with the selected source operand/period
 // are dependencies. Do not bind an independent check to every case answer.
 const kinds=paths.includes('seniority_year')?['seniority']:paths.includes('annual_basis')?['annual_workdays']:paths.includes('leave_pay.leave_calendar_days')?['calendar_days']:paths.includes('leave_pay.quarter_period')?['quarter_selection']:paths.includes('leave_pay.recorded')?['recorded_allocation']:paths.includes('leave_pay.wage')?['monthly_period']:[];
 if(!kinds.length)return values;const p=produceVacationSourceEvidence(input,review);
 const hashes=p.evidence.entries.filter(e=>kinds.includes(e.kind)).map(e=>canonicalSha256(e));
 const witnesses=p.receipt.witnesses.filter(w=>typeof w==='object'&&w!==null&&'entry_sha256'in w&&hashes.includes(String(w.entry_sha256)));
 return [...values,...(kinds.length?[{path:'vacation_internal_source_witnesses',state:'derived',value_sha256:canonicalSha256(witnesses),source_sha256s:hashes}]:[])];
}
export function replayVacationProductFacts(effective:VacationEntitlementInput,original:VacationEntitlementInput,review:DocumentReviewInput):VacationEntitlementInput{
 const out=structuredClone(effective);validate(out,review);if(!same(original.period,effective.period)||original.case_id!==effective.case_id)throw Error('VACATION_REPLAY_SCOPE');
 if(original.product_scenario_policy==='vacation-qualified-statutory-scenario-v1'){
  const awareness=out.product_facts?.other_vacation_terms_known,decision=out.applicability.find(d=>d.decision_id==='vacation.no_better_arrangement');
  const remaining=(original.conditional_assumptions??[]).filter(a=>a.decision_id!=='vacation.no_better_arrangement');
  if(usable(awareness)&&awareness!.value===false&&(!decision||decision.state==='missing'))remaining.push({decision_id:'vacation.no_better_arrangement',explanation:'תרחיש מינימום מותנה בלבד: בהנחה שלא חל הסדר חופשה מיטיב או מיוחד. לא ידועים לעובד תנאים נוספים, אך תחולת ההסדר טרם אומתה; אין קביעת חוב.'});
  if(remaining.length)out.conditional_assumptions=remaining;else delete out.conditional_assumptions;
 }
 if(!original.case_recipe_bindings?.length)return out;
 if(new Set(original.case_recipe_bindings.map(b=>b.method.recipe_id)).size!==original.case_recipe_bindings.length)throw Error('VACATION_DUPLICATE_CASE_BINDING');
 for(const key of ['aged_21_or_more','under_60'] as const){if(original.facts[key].state==='derived')throw Error('VACATION_RAW_DERIVED_FACT');if(out.facts[key].state==='derived')out.facts[key]=structuredClone(original.facts[key]);}
 if(original.derived_seniority)throw Error('VACATION_RAW_DERIVED_SENIORITY');delete out.derived_seniority;
 out.case_recipe_bindings=structuredClone(original.case_recipe_bindings);
 for(const b of out.case_recipe_bindings){
  const binding=vacationCaseRecipeBindingSchema.parse(b),m=binding.method,r=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===m.recipe_id&&r.recipe_id.startsWith('ai-case.vacation.'));
  if(!r||r.branch!=='vacation'||r.recipe_sha256!==m.recipe_sha256||r.recipe_version!==m.recipe_version||m.source_policy_sha256!==VACATION_SOURCE_REVIEW_SHA256||m.issued_at>binding.evaluated_at||m.expires_at<=binding.evaluated_at||r.legal_sources.some(s=>!m.source_receipts.some(p=>p.source_version_id===s.version_id&&p.artifact_sha256===s.file_sha256)))throw Error('VACATION_RECIPE_BINDING');
  const prior=original.applicability.find(d=>d.decision_id===r.decision_id);if(prior){out.applicability=out.applicability.filter(d=>d.decision_id!==r.decision_id);out.applicability.push(structuredClone(prior));}
  const ready=evaluateVacationProductRecipe(r.decision_id,out,review),inputsSha=canonicalSha256(vacationProductCaseConsumed(out,ready.consumed_paths,review));
  out.applicability=out.applicability.map(d=>{if(d.decision_id!==r.decision_id||d.state!=='accepted')return d;let parsed;try{parsed=JSON.parse(d.explanation);}catch{return d;}
   return parsed?.schema_version==='ai-release-method-basis-v1'&&parsed.recipe_id===r.recipe_id&&parsed.recipe_sha256===r.recipe_sha256&&parsed.interpretation_receipt_sha256===m.interpretation_receipt_sha256&&(!ready.allowed||parsed.consumed_sha256!==inputsSha)?{...d,state:'stale',explanation:JSON.stringify({schema_version:'vacation-case-stale-v1',prior_sha256:canonicalSha256(d.explanation),reason:ready.reason??'consumed_facts_changed'})}:d;});
  const current=out.applicability.find(d=>d.decision_id===r.decision_id);let currentBasis;try{currentBasis=current?JSON.parse(current.explanation):null;}catch{currentBasis=null;}
  if(!ready.allowed||current?.state!=='accepted'||currentBasis?.schema_version!=='ai-release-method-basis-v1'||currentBasis.recipe_id!==r.recipe_id||currentBasis.recipe_sha256!==r.recipe_sha256||currentBasis.interpretation_receipt_sha256!==m.interpretation_receipt_sha256||currentBasis.consumed_sha256!==inputsSha)continue;
  const derivation={schema_version:'vacation-derived-fact-v1' as const,binding_sha256:binding.binding_sha256,inputs_sha256:inputsSha};
  if(ready.derived_ages)for(const key of ['aged_21_or_more','under_60'] as const)if(out.facts[key].state==='missing')out.facts[key]={state:'derived',value:ready.derived_ages[key],basis:'ai_source_assessment',source:vacationLegalSource('law',1,'גיל לפי תאריך לידה; גבול מוצר 21–59'),derivation};
  if(ready.derived_seniority!==null)out.derived_seniority={state:'derived',value:ready.derived_seniority,reference_year:2026,employment_start:out.annual_basis!.employment_start.value!,source:vacationLegalSource('law',1,'סעיפים 1 ו־3; שנת עבודה אצל אותו מעסיק או מקום'),derivation};
 }
 return out;
}
export function vacationProductFactQuestions(input:VacationEntitlementInput){
 const f=input.product_facts;if(!f)return [];const unknown={label:'לא ידוע',value:null};
 const choices=(v:Record<string,string|boolean>)=>[...Object.entries(v).map(([label,value])=>({label,value})),unknown];
 const all=[
  {path:'product_facts.birth_date',question:'מה תאריך הלידה שלך?',fact:f.birth_date,answer_kind:'text' as const,format:'iso_date' as const},
  {path:'product_facts.employment_relationship',question:'איך הועסקת בתקופת הבדיקה?',fact:f.employment_relationship,answer_kind:'choice' as const,choices:choices({'שכיר/ה':'employee','עצמאי/ת':'self_employed','אחר':'other'})},
  {path:'product_facts.workplace_sector',question:'מהו סוג מקום העבודה בתקופה?',fact:f.workplace_sector,answer_kind:'choice' as const,choices:choices({'מעסיק פרטי':'private','מעסיק ציבורי':'public','מפעל מוגן':'protected_workshop','אחר':'other'})},
  {path:'product_facts.salary_basis',question:'האם השכר נקבע לפי חודש או לפי שעות?',fact:f.salary_basis,answer_kind:'choice' as const,choices:choices({'חודשי':'monthly','שעתי':'hourly','אחר':'other'})},
  {path:'product_facts.same_employer_or_workplace',fact_key:vacationSourceFactKey('same_employer_or_workplace'),question:'האם תקופת העבודה מתאריך ההתחלה שצויין הייתה אצל אותו מעסיק או באותו מקום עבודה?',fact:f.same_employer_or_workplace,answer_kind:'choice' as const,choices:choices({'כן':true,'לא':false})},
  {path:'product_facts.other_vacation_terms_known',question:'האם נמסרו לך תנאי חופשה נוספים בחוזה, בהסכם או בנוהג במקום העבודה?',fact:f.other_vacation_terms_known,answer_kind:'choice' as const,choices:choices({'כן':true,'לא ידועים לי תנאים נוספים':false})},
  ...(input.annual_basis?[{path:'annual_basis.employment_start',question:'באיזה תאריך התחלת לעבוד באותו מקום עבודה?',fact:input.annual_basis.employment_start,answer_kind:'text' as const,format:'iso_date' as const}]:[]),
  ...(f.salary_basis.value==='hourly'?[{path:'product_facts.continuous_employment',question:'האם יחסי העבודה נמשכו ברציפות מתאריך ההתחלה, בלי סיום העסקה והתחלה מחדש?',fact:f.continuous_employment,answer_kind:'choice' as const,choices:choices({'כן':true,'לא':false})}]:[]),
  ...(input.leave_pay?.mode==='hourly_quarter'?[{path:'product_facts.preceding_quarter_full_months',fact_key:vacationSourceFactKey('preceding_quarter_full_months'),question:'האם בכל שלושת החודשים שלפני החופשה עבדת חודש מלא, ללא חודש עבודה חלקי?',fact:f.preceding_quarter_full_months,answer_kind:'choice' as const,choices:choices({'כן':true,'לא':false})}]:[]),
 ];return all.filter(q=>!usable(q.fact));
}
export function vacationProductDecisionSources(input:VacationEntitlementInput,id:string){
 if(id==='vacation.no_better_arrangement'&&input.product_scenario_policy&&input.conditional_assumptions?.some(a=>a.decision_id===id)&&input.product_facts?.other_vacation_terms_known.source)return [input.product_facts.other_vacation_terms_known.source];
 if(!input.case_recipe_bindings?.some(b=>b.method.recipe_id==='ai-case.'+id))return [];
 const f=input.product_facts;if(!f)return [];
 const facts=id==='vacation.general_section3'?[f.birth_date,f.employment_relationship,f.workplace_sector,f.salary_basis,...(f.salary_basis.value==='hourly'?[f.continuous_employment,input.annual_basis?.employment_start]:[])]:id==='vacation.seniority_basis'?[f.same_employer_or_workplace,input.annual_basis?.employment_start]:[];
 return [...new Map(facts.flatMap(f=>f?.source?[f.source]:[]).map(s=>[canonicalSha256(s),s])).values()];
}
/** Arithmetic-layer defense. Authentication/currentness is independently
 * replayed by source-admission against the original saved source packet. */
export function assertVacationDerivedFacts(input:VacationEntitlementInput){
 if(!input.derived_seniority&&!Object.values(input.facts).some(f=>f.state==='derived'))return;
 const raw=structuredClone(input);delete raw.derived_seniority;
 for(const key of ['aged_21_or_more','under_60'] as const)if(raw.facts[key].state==='derived')raw.facts[key]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 const sources:DocumentReviewSource[]=[];const visit=(v:unknown):void=>{const s=sourceSchema.safeParse(v);if(s.success){sources.push(s.data);return;}if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(raw);
 const review=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:input.case_id,period:input.period,purchased_scope:{order_id:'internal.derived.replay',receipt_sha256:VACATION_SOURCE_REVIEW_SHA256,topics:['vacation'],origin:'legacy_paid_receipt'},documents:input.source_manifest.filter(m=>m.kind==='case_document'&&sources.some(s=>s.document_id===m.document_id&&s.version_id===m.version_id)).map(m=>({...m,kind:'other',period:input.period,label:'Internal immutable source replay',reading_origin:'provider_extraction',reading_sha256:sources.find(s=>s.document_id===m.document_id&&s.version_id===m.version_id)?.reading_receipt_sha256??VACATION_SOURCE_REVIEW_SHA256,accepted_reading_sha256:[...new Set(sources.filter(s=>s.document_id===m.document_id&&s.version_id===m.version_id).map(s=>s.reading_receipt_sha256))]})),checks:[],completion_input:{},answer_history:[],coverage_gaps:[]});
 const replay=replayVacationProductFacts(raw,raw,review);
 for(const key of ['aged_21_or_more','under_60'] as const)if(input.facts[key].state==='derived'&&!same(input.facts[key],replay.facts[key]))throw Error('VACATION_DERIVED_AGE_REPLAY');
 if(input.derived_seniority&&!same(input.derived_seniority,replay.derived_seniority))throw Error('VACATION_DERIVED_SENIORITY_REPLAY');
}
