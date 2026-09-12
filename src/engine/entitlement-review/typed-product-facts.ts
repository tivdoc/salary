import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {minimumWagePersonalFacts} from './minimum-wage/product-facts.ts';
import {materializeMinimumWageCaseFacts} from '../ai-release-decisions/minimum-wage-case.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';
import {convalescencePersonalFacts,scaffoldConvalescenceSegments,periodFromDeclarations,unresolvedDeclaredPeriod,isDeclaredPeriodSource} from './convalescence/product-facts.ts';
import type {EntitlementEvidence} from './contracts.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {pensionProductFacts,replayPensionProductFacts} from './pension/product-facts.ts';
import {attachPensionSourceFacts} from './pension/source-facts.ts';
import {travelEntitlementInputSchema} from './travel/contracts.ts';
import {travelProductFacts,travelProductFactQuestions,replayTravelProductFacts,TRAVEL_JOURNEY_FACTS_POLICY} from './travel/product-facts.ts';
import {materializeTravelJourneyFacts} from './travel/journey-facts.ts';
import {vacationEntitlementInputSchema} from './vacation/contracts.ts';
import {vacationProductFacts,vacationProductFactQuestions,replayVacationProductFacts} from './vacation/product-facts.ts';
import {replayConvalescenceCaseFacts,enableConvalescenceCaseFacts,convalescenceCaseQuestions} from './convalescence/product-decisions.ts';

import {workingTimeEntitlementInputSchema} from './working-time/contracts.ts';
import {enableQuestionnaireAgeRangeReuse,materializeQuestionnaireAgeRanges} from './age-range-materialization.ts';
import {productAgeRangeSelection} from './product-age-range.ts';
import {obligationsEntitlementInputSchema} from './obligations/contracts.ts';
import {replayObligationProductFacts} from './obligations/case-replay.ts';
import {OBLIGATIONS_CASE_POLICY} from './obligations/source-policy.ts';
import {enableWorkingTimeProductFacts,replayWorkingTimeProductFacts} from './working-time/product-facts.ts';

type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
type Choice=Readonly<{label:string;value:string|number|boolean|null}>;
export type TypedEntitlementQuestion=Readonly<{path:string;question:string;fact:Fact;answer_kind:'text'|'choice';
 format?:NonNullable<ReviewCompletionNeed['value_validation']>['format'];choices?:readonly Choice[];fact_key?:string}>;
const usable=(f:Fact)=>['observed','declared','derived'].includes(f.state)&&f.value!==null&&f.source!==null;
const unknown={label:'לא ידוע',value:null};
const choices=(entries:Record<string,string|number|boolean>):Choice[]=>[...Object.entries(entries).map(([label,value])=>({label,value})),unknown];

/** Explicit opt-in for new saved source packets. Existing packets are untouched. */
export function enableTypedEntitlementPersonalFacts(candidate:EntitlementEvidence,options?:{travel?:true;travel_journey?:true;vacation?:true;convalescence?:true;working_time?:true;age_range?:true}):EntitlementEvidence{
 const e=structuredClone(candidate);
 if(e.pension){const p=pensionEntitlementInputSchema.parse(e.pension);e.pension={...p,product_facts:p.product_facts??pensionProductFacts()};}
 if(e.minimum_wage){const p=minimumWageEntitlementInputSchema.parse(e.minimum_wage);e.minimum_wage={...p,product_facts:p.product_facts??minimumWagePersonalFacts()};}
 if(e.convalescence){const p=convalescenceEntitlementInputSchema.parse(e.convalescence);e.convalescence=options?.convalescence?enableConvalescenceCaseFacts(p):{...p,product_facts:p.product_facts??convalescencePersonalFacts()};}
 if((options?.travel||options?.travel_journey)&&e.travel){const p=travelEntitlementInputSchema.parse(e.travel);
  const facts=options.travel_journey?{...travelProductFacts(TRAVEL_JOURNEY_FACTS_POLICY),...p.product_facts,schema_version:TRAVEL_JOURNEY_FACTS_POLICY}:p.product_facts??travelProductFacts();
  e.travel=travelEntitlementInputSchema.parse({...p,product_facts:facts});}
 if(options?.vacation&&e.vacation){const p=vacationEntitlementInputSchema.parse(e.vacation);e.vacation={...p,product_facts:p.product_facts??vacationProductFacts()};}
 if(options?.working_time&&e.working_time)e.working_time=workingTimeEntitlementInputSchema.array().min(1).max(6).parse(e.working_time).map(p=>enableWorkingTimeProductFacts(p));
 return options?.age_range?enableQuestionnaireAgeRangeReuse(e):e;
}

export function typedEntitlementQuestions(topic:'minimum_wage'|'convalescence'|'travel'|'vacation',raw:unknown):TypedEntitlementQuestion[]{
 if(topic==='vacation')return vacationProductFactQuestions(vacationEntitlementInputSchema.parse(raw));
 if(topic==='travel')return travelProductFactQuestions(travelEntitlementInputSchema.parse(raw));
 const result:TypedEntitlementQuestion[]=[];
 const add=(path:string,fact:Fact,question:string,options?:readonly Choice[],format?:TypedEntitlementQuestion['format'])=>{
  if(!usable(fact))result.push({path,fact,question,answer_kind:options?'choice':'text',...(options?{choices:options}:{}),...(format?{format}:{})});
 };
 if(topic==='minimum_wage'){
  const p=minimumWageEntitlementInputSchema.parse(raw);if(!p.product_facts)return result;
  if(!usable(p.population))add('product_facts.birth_date',p.product_facts.birth_date,'מה תאריך הלידה שלך? הנתון ישמש לבדיקת הגיל בתקופה, ואינו אישור לתחולת הסדר שכר מסוים.',undefined,'iso_date');
  if(!usable(p.employment))add('product_facts.salary_basis',p.product_facts.salary_basis,'כיצד נקבע השכר שלך בפועל בתקופה הנבדקת?',choices({'לפי שעות עבודה':'hourly','שכר חודשי':'monthly','לפי שיטה אחרת':'other'}));
  if(p.product_facts.schema_version==='minimum-wage-personal-facts-v2'){
   const f=p.product_facts,populationNeeded=!usable(p.population)||p.case_recipe_bindings?.some(b=>b.method.recipe_id==='ai-case.mw.population');
   if(populationNeeded){
    add('product_facts.birth_date',f.birth_date,'מה תאריך הלידה שלך? הנתון ישמש לבדיקת הגיל בתקופה, ואינו אישור לתחולת הסדר שכר מסוים.',undefined,'iso_date');
    add('product_facts.employment_relationship',f.employment_relationship,'איך הועסקת אצל המעסיק בתקופת הבדיקה?',choices({'כשכיר/ה':'employee','כעצמאי/ת כנגד חשבוניות':'self_employed','בדרך אחרת':'other'}));
    add('product_facts.workplace_sector',f.workplace_sector,'מה סוג מקום העבודה שבו הועסקת בתקופה?',choices({'מעסיק פרטי':'private','מעסיק ציבורי':'public','מפעל מוגן':'protected_workshop','אחר':'other'}));
    add('product_facts.adapted_wage_approval',f.adapted_wage_approval,'האם נקבע עבורך שכר מותאם באישור רשמי בתקופה הנבדקת?',choices({'כן':true,'לא':false}));
    add('product_facts.special_wage_arrangement',f.special_wage_arrangement,'האם קיים הסכם אישי מיטיב או הסדר שכר מיוחד, אישי או קיבוצי, שנמסר לך וחל בתקופה הנבדקת?',choices({'כן':true,'לא':false}));
   }
   if(!usable(p.employment)||p.case_recipe_bindings?.some(b=>b.method.recipe_id==='ai-case.mw.ordinary_scope')){
    add('product_facts.salary_basis',f.salary_basis,'כיצד נקבע השכר שלך בפועל בתקופה הנבדקת?',choices({'לפי שעות עבודה':'hourly','שכר חודשי':'monthly','לפי שיטה אחרת':'other'}));
    add('product_facts.weekly_schedule_hours',f.weekly_schedule_hours,'כמה שעות עבודה רגילות כוללת מתכונת משרה מלאה במקום העבודה לפי ההסדר שנמסר לך?',choices({'42 שעות בשבוע':'42','מתכונת אחרת':'other'}));
   }
  }
  if(p.method.value==='full_monthly')add('monthly_coverage',p.monthly_coverage,'האם עבדת במשרה מלאה במשך כל חודש הבדיקה, ללא תקופת עבודה חלקית או היעדרות שמשנה את השכר?',choices({'כן, חודש מלא במשרה מלאה':'full_month_full_time','לא, חודש או היקף חלקי':'partial'}));
  return p.product_age_range&&productAgeRangeSelection(p,p.product_facts.birth_date).kind==='range'?result.filter(q=>q.path!=='product_facts.birth_date'):result;
 }
 const p=convalescenceEntitlementInputSchema.parse(raw);if(!p.product_facts)return result;
 const f=p.product_facts;
 if(p.source_gates_policy==='cv-source-gates-v2')result.push(...convalescenceCaseQuestions(p));
 else if(!usable(p.population)){
  add('product_facts.birth_date',f.birth_date,'מה תאריך הלידה שלך? הנתון ישמש לבדיקת הגיל בתקופה.',undefined,'iso_date');
  add('product_facts.employment_category',f.employment_category,'מה סוג מקום העבודה והסדר השכר שלך בפועל?',choices({'מקום עבודה פרטי':'private','מקום עבודה ציבורי או שכר המוצמד לשכר ציבורי':'public_or_pegged','מפעל מוגן':'protected_workshop','אחר':'other'}));
 }
 add('employment_start',p.employment_start,'באיזה תאריך התחלת לעבוד באותו מקום עבודה?',undefined,'iso_date');
 add('qualifying_service',p.qualifying_service,'האם העבודה באותו מקום נמשכה ברציפות בתקופת הצבירה, ללא חל״ת או הפסקת העסקה? חופשת לידה כשלעצמה אינה הפסקת העסקה בשאלה זו.',choices({'כן, עבודה רציפה ללא חל״ת או הפסקת העסקה':'continuous_no_excluded_absence','לא, היה חל״ת או הייתה הפסקת העסקה':'excluded_absence_or_break'}));
 add('benefit_year',p.benefit_year,'לאיזו שנת הבראה משויך התשלום הנבדק? יש לציין שנה מפורשת; שנת התלוש אינה תשובה אוטומטית.',undefined,'year');
 add('due_date',p.due_date,'מה מועד תשלום ההבראה שסוכם או נהוג אצל המעסיק לתקופה זו? אם לא ידוע, אין לבחור תאריך לפי חודש התלוש.',undefined,'iso_date');
 if(!usable(p.payment_coverage)||isDeclaredPeriodSource(p.payment_coverage.source!)){
  add('product_facts.payment_from',f.payment_from,'מאיזה תאריך מתחילה תקופת הצבירה שהתשלום הנבדק מכסה?',undefined,'iso_date');
  add('product_facts.payment_to',f.payment_to,'עד איזה תאריך נמשכת תקופת הצבירה שהתשלום הנבדק מכסה?',undefined,'iso_date');
 }
 // Existing source segments are already an explicit inventory; do not ask for
 // another inventory or recreate them from a single payslip's FTE.
 if(!p.segments.length||p.segments.every(s=>s.id.startsWith('declared.segment.'))){
  add('product_facts.segment_count',f.segment_count,'לכמה תקופות נפרדות מתחלקת תקופת הצבירה לפי שינויים בהיקף המשרה? אם ההיקף היה קבוע לאורך כולה, יש לבחור תקופה אחת.',choices(Object.fromEntries(Array.from({length:8},(_,i)=>[String(i+1),i+1]))));
  for(const [i,s]of f.segments.entries()){
   add(`product_facts.segments.${i}.from`,s.from,`מה תאריך ההתחלה של תקופת היקף המשרה ${i+1}?`,undefined,'iso_date');
   add(`product_facts.segments.${i}.to`,s.to,`מה תאריך הסיום של תקופת היקף המשרה ${i+1}?`,undefined,'iso_date');
   add(`product_facts.segments.${i}.fte`,s.fte,`מה היקף המשרה הקבוע בתקופה ${i+1}? יש לציין יחס בין 0 ל־1, למשל 0.75 למשרה של 75%.`,undefined,'fte_ratio');
  }
 }else for(const [i,s]of p.segments.entries())add(`segments.${i}.fte`,s.fte,`מה היקף המשרה הקבוע בתקופה ${s.period.value?.from??'שטרם זוהתה'} עד ${s.period.value?.to??'שטרם זוהתה'}? יש לציין יחס בין 0 ל־1.`,undefined,'fte_ratio');
 return result;
}

export function materializeTypedEntitlementFacts(candidate:EntitlementEvidence,original?:EntitlementEvidence,source?:DocumentReviewInput):EntitlementEvidence{
 if(original&&source)candidate=materializeQuestionnaireAgeRanges(candidate,original,source);
 if(candidate.obligations&&original?.obligations&&source){const current=obligationsEntitlementInputSchema.parse(candidate.obligations),raw=obligationsEntitlementInputSchema.parse(original.obligations);
  if(raw.case_policy===OBLIGATIONS_CASE_POLICY)candidate={...candidate,obligations:replayObligationProductFacts(current,raw,source)};}
 if(candidate.working_time&&original?.working_time&&source){const current=workingTimeEntitlementInputSchema.array().min(1).max(6).parse(candidate.working_time),rawItems=workingTimeEntitlementInputSchema.array().min(1).max(6).parse(original.working_time);
  if(current.length!==rawItems.length)throw Error('WT_MATERIALIZATION_WEEK_SCOPE');
  candidate={...candidate,working_time:current.map((p,i)=>{
  const raw=rawItems[i];
  return p.product_facts?.schema_version==='working-time-product-facts-v2'||raw.case_recipe_bindings?.length?replayWorkingTimeProductFacts(p,raw,source):p;})};}
 if(candidate.vacation&&original?.vacation&&source){const p=vacationEntitlementInputSchema.parse(candidate.vacation),raw=vacationEntitlementInputSchema.parse(original.vacation);
  if(raw.case_recipe_bindings?.length||raw.product_scenario_policy)candidate={...candidate,vacation:replayVacationProductFacts(p,raw,source)};}
 if(candidate.travel&&original?.travel&&source){const p=travelEntitlementInputSchema.parse(candidate.travel),raw=travelEntitlementInputSchema.parse(original.travel);
  const journey=materializeTravelJourneyFacts(p,raw,source);
  if(raw.product_facts?.schema_version===TRAVEL_JOURNEY_FACTS_POLICY||raw.case_recipe_bindings?.length)candidate={...candidate,travel:raw.case_recipe_bindings?.length?replayTravelProductFacts(journey,raw,source):journey};}
 if(candidate.pension&&original?.pension&&source){const p=pensionEntitlementInputSchema.parse(candidate.pension),raw=pensionEntitlementInputSchema.parse(original.pension);
  if(raw.case_recipe_bindings?.length)candidate={...candidate,pension:replayPensionProductFacts(p,raw,source)};
  else if(raw.source_facts)candidate={...candidate,pension:attachPensionSourceFacts(p,source).input};}
 if(candidate.minimum_wage&&original?.minimum_wage&&source){const p=minimumWageEntitlementInputSchema.parse(candidate.minimum_wage),raw=minimumWageEntitlementInputSchema.parse(original.minimum_wage);
  if(raw.case_recipe_bindings?.length)candidate={...candidate,minimum_wage:materializeMinimumWageCaseFacts(p,raw,source)};}
 if(!candidate.convalescence)return candidate;
 const p=convalescenceEntitlementInputSchema.parse(candidate.convalescence);if(!p.product_facts)return candidate;
 p.product_facts=scaffoldConvalescenceSegments(p.product_facts);
 const f=p.product_facts,period=periodFromDeclarations(f.payment_from,f.payment_to);
 if(!usable(p.payment_coverage)||p.payment_coverage.source&&isDeclaredPeriodSource(p.payment_coverage.source))p.payment_coverage=period??unresolvedDeclaredPeriod(f.payment_from,f.payment_to);
 if(!p.segments.length||p.segments.every(s=>s.id.startsWith('declared.segment.')))p.segments=f.segments.map(s=>({id:s.id,
  period:periodFromDeclarations(s.from,s.to)??unresolvedDeclaredPeriod(s.from,s.to),fte:s.fte}));
 const materialized=convalescenceEntitlementInputSchema.parse(p);
 return {...candidate,convalescence:original?.convalescence&&source&&materialized.case_recipe_bindings?.length?replayConvalescenceCaseFacts(materialized,convalescenceEntitlementInputSchema.parse(original.convalescence),source):materialized};
}

/** Only the exact generated period positions may use a two-receipt derivation. */
export function assertTypedPeriodDerivation(packet:EntitlementEvidence,path:string,value:unknown):boolean{
 if(!packet.convalescence)return false;
 const p=convalescenceEntitlementInputSchema.parse(packet.convalescence),f=p.product_facts;if(!f)return false;
 let expected:ReturnType<typeof periodFromDeclarations>=null;
 if(path==='convalescence.payment_coverage')expected=periodFromDeclarations(f.payment_from,f.payment_to);
 else{const m=/^convalescence\.segments\.(\d+)\.period$/u.exec(path);if(m){const item=f.segments[Number(m[1])],actual=p.segments[Number(m[1])];
  if(item&&actual?.id===item.id)expected=periodFromDeclarations(item.from,item.to);}}
 return expected!==null&&canonicalSha256(expected)===canonicalSha256(value);
}
