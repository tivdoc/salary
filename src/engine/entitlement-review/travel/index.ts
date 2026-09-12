import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {TRAVEL_LEGACY_FORMULA_PROVENANCE} from './legacy-formula-provenance.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {travelEntitlementInputSchema,type TravelEntitlementInput,type TravelGap} from './contracts.ts';
import {TRAVEL_SOURCE_REVIEW,TRAVEL_SOURCE_REVIEW_SHA256,TRAVEL_LEGAL_MANIFEST,TRAVEL_CATALOG,travelLegalSource,isPinnedTravelLegalSource} from './sources.ts';
import {travelProductAnswerField} from './product-labels.ts';
import {travelCaseDecisionSources} from './product-facts.ts';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY,TRAVEL_FLOOR_CATALOG,TRAVEL_FLOOR_LEGAL_MANIFEST,TRAVEL_FLOOR_SOURCE_REVIEW_SHA256,travelFloorLegalSource,isPinnedTravelFloorLegalSource} from './floor-policy.ts';
export * from './contracts.ts';export * from './sources.ts';export * from './product-labels.ts';
export * from './product-facts.ts';
export * from './floor-policy.ts';
export * from './tariff-source.ts';
type Decision=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>['decisions'][number];
export const TRAVEL_APPLICABILITY=deepFreeze({
 'travel.general_coverage':'יש לוודא שהצו הכללי חל על העבודה והתקופה, לרבות החרגת מקום עבודה מוגן.',
 'travel.no_better_arrangement':'יש לבדוק אם חל הסדר מיטיב או התחייבות חוזית אחרת להחזר נסיעות.',
 'travel.fare_basis':'יש לזהות תעריף מוזל מתאים למסלול הבית–עבודה ולכיוונים שאינם מסופקים ללא עלות. אין צורך בקבלת תשלום כתנאי אוטומטי, אך יש צורך במקור התעריף.',
 'travel.ticket_options':'יש לבדוק כרטיסים והנחות מתאימים, לרבות מנוי חודשי. היעדר מחיר של מנוי אינו מוכיח שהמנוי אינו זמין או אינו מתאים.',
 'travel.rounding':'החישוב המועמד מעגל למחצית כלפי מעלה באגורה בסוף הכפלת התקופה; יש לבדוק הסדר מחייב אחר.',
 'travel.one_direction_treatment':'כאשר המעסיק מסיע בכיוון אחד, נדרשת החלטה מפורשת על פרשנות סעיף 6. המועמד משתמש במחיר הכיוון שנותר, בתקרה יומית של מחצית 22.60 ובמנוי מתאים; אין טענה שהצו הכריע במפורש כל שילוב של מנוי וכיוון.',
});
export const TRAVEL_FLOOR_APPLICABILITY=deepFreeze({...Object.fromEntries(Object.entries(TRAVEL_APPLICABILITY).filter(([id])=>id!=='travel.no_better_arrangement')),
 'travel.general_order_floor':'נדרשת הערכת מקור ופרשנות עדכנית לרצפת הצו הכללי לפי סעיף 30. הנוסח המקורי לבדו אינו אימות שרשרת התיקונים; אין כאן אישור שאין הסדר מיטיב.'});
const question={needs_transport:'האם נדרשת תחבורה כדי להגיע ממקום המגורים לעבודה?',employer_transport:'באילו כיוונים המעסיק מספק הסעה ללא עלות בתקופה: אין, לעבודה, מהעבודה, שניהם או שילוב המשתנה לפי תאריך?',free_travel:'האם קיימת זכאות לנסיעה חינם בכיוונים הרלוונטיים בתקופה? יש להפריד מנסיעה שממומנת בידי המעסיק.'};
export const travelCheckIds=(prefix:string)=>[`${prefix}.expected`,`${prefix}.comparison`];
function bound(source:DocumentReviewSource,input:TravelEntitlementInput){
 const m=input.source_manifest.filter(m=>m.document_id===source.document_id&&m.version_id===source.version_id);
 if(m.length!==1||m[0].case_id!==input.case_id||m[0].file_sha256!==source.file_sha256||m[0].page_count<source.page||!['case_document','customer_answer','questionnaire'].includes(m[0].kind))throw Error('TRAVEL_CASE_SOURCE_BINDING');
 if((source.reading==='customer_declaration')!==(m[0].kind==='customer_answer')||(source.reading==='questionnaire_declaration')!==(m[0].kind==='questionnaire'))throw Error('TRAVEL_DECLARATION_SOURCE');
}
function amount(o:DocumentReviewOperand){if(o.representation!=='money_ils'||o.quantity_unit!==null||o.printed_value!==null&&!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(o.printed_value))throw Error('TRAVEL_MONEY_OPERAND');}
const available=(o:DocumentReviewOperand|null)=>o!==null&&(o.state==='observed'||o.state==='declared')&&o.printed_value!==null;
export function resolveTravelEntitlement(candidate:unknown){
 const input=travelEntitlementInputSchema.parse(candidate),ids=travelCheckIds(input.check_prefix),gaps:TravelGap[]=[],checks:DocumentReviewInput['checks']=[];
 const floor=input.calculation_policy===TRAVEL_GENERAL_ORDER_FLOOR_POLICY,applicability=floor?TRAVEL_FLOOR_APPLICABILITY:TRAVEL_APPLICABILITY;
 const legalManifest=floor?TRAVEL_FLOOR_LEGAL_MANIFEST:TRAVEL_LEGAL_MANIFEST;
 const last=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<TRAVEL_SOURCE_REVIEW.supported_period.from||input.period.to>TRAVEL_SOURCE_REVIEW.supported_period.to||input.period.from.slice(8)!=='01'||input.period.to!==last)throw Error('TRAVEL_SUPPORTED_MONTH_REQUIRED');
 for(const f of [...Object.values(input.facts),input.monthly_pass])if(f.source){bound(f.source,input);if(f.basis==='customer_declaration'&&!['customer_declaration','questionnaire_declaration'].includes(f.source.reading))throw Error('TRAVEL_FACT_BASIS');}
 for(const o of [input.discounted_daily_fare,input.monthly_pass_cost,input.recorded])if(o){bound(o.source,input);amount(o);}
 if(input.commute_days){bound(input.commute_days.source,input);if(input.commute_days.representation!=='decimal_quantity'||input.commute_days.quantity_unit!=='days'||input.commute_days.printed_value!==null&&!/^(0|[1-9]|[12]\d|3[01])$/u.test(input.commute_days.printed_value))throw Error('TRAVEL_ACTUAL_DAYS');}
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length||input.applicability.some(d=>!(d.decision_id in applicability)&&!(floor&&d.decision_id==='travel.no_better_arrangement')))throw Error('TRAVEL_DECISION_SET');
 for(const d of input.applicability)for(const s of d.sources){if(s.reading==='source_research'){if(!(floor?isPinnedTravelFloorLegalSource(s):isPinnedTravelLegalSource(s)))throw Error('TRAVEL_LEGAL_SOURCE_PIN');}else bound(s,input);}
 let branch:'ordinary'|'no_need'|'employer_both'|'free_both'|'no_uncovered_direction'|'no_commute_days'|'mixed_unsupported'='ordinary';
 const consumed:string[]=[];
 const add=(key:string,state:string,path:string,text:string,kind:TravelGap['kind']='missing_fact',answer_kind:TravelGap['answer_kind']='text',dependent_check_ids:readonly string[]=ids)=>{
  const field=answer_kind==='choice'?travelProductAnswerField(path):null;
  gaps.push({dependency_id:key,state,kind,input_path:path,question:text,answer_kind,...(field?{options:field.options}:{}),dependent_check_ids,source_required:true});
 };
 const finish=()=>{if(floor)gaps.push({dependency_id:'travel.complete_arrangement',state:'unknown',kind:'missing_applicability',input_path:'complete_arrangement',question:'הרצפה לפי הצו הכללי אינה בודקת הסדר נסיעות מיטיב או את מלוא הזכאות. גם פער אפס או פער שלילי אינם מאשרים עמידה במלוא ההסדר.',answer_kind:'text',dependent_check_ids:[input.check_prefix+'.complete_arrangement'],source_required:true});return deepFreeze({schema_version:'travel-entitlement-resolution-v1' as const,input_sha256:canonicalSha256(input),catalog:floor?TRAVEL_FLOOR_CATALOG:TRAVEL_CATALOG,branch,checks,gaps,rule_metadata:{source_review_sha256:floor?TRAVEL_FLOOR_SOURCE_REVIEW_SHA256:TRAVEL_SOURCE_REVIEW_SHA256,cap_is_not_entitlement:true,paid_fare_receipt_required:false,amount_is_not_cash_debt:true,human_attestation:null,real_activation_allowed:false,...(floor?{complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false,current_source_and_interpretation_admission_required:true}: {})}});};
 if(input.facts.needs_transport.state==='known'&&input.facts.needs_transport.value===false){branch='no_need';consumed.push('needs_transport');}
 else if(input.facts.employer_transport.state==='known'&&input.facts.employer_transport.value==='both'){branch='employer_both';consumed.push('employer_transport');}
 else if(input.facts.free_travel.state==='known'&&input.facts.free_travel.value==='both'){branch='free_both';consumed.push('free_travel');}
 else if(input.facts.employer_transport.state==='known'&&input.facts.free_travel.state==='known'&&((input.facts.employer_transport.value==='outbound'&&input.facts.free_travel.value==='return')||(input.facts.employer_transport.value==='return'&&input.facts.free_travel.value==='outbound'))){branch='no_uncovered_direction';consumed.push('employer_transport','free_travel');}
 else if(available(input.commute_days)&&input.commute_days!.printed_value==='0'){branch='no_commute_days';}
 const zero=branch!=='ordinary';
 if(!zero){
  for(const [key,f] of Object.entries(input.facts)){consumed.push(key);if(f.state!=='known')add(`travel.${key}`,f.state,`facts.${key}`,question[key as keyof typeof question],'missing_fact','choice');else if(f.value==='mixed'){branch='mixed_unsupported';add(`travel.${key}.dated_breakdown`,'unknown',`facts.${key}`,'נדרש פירוט לפי תאריך של כיווני הנסיעה וההסעה כדי למנוע ממוצע שגוי בין הסדרים שונים.','missing_source');}}
  if(!available(input.commute_days))add('travel.commute_days',input.commute_days?.state??'missing','commute_days','כמה ימים הגעת בפועל למקום העבודה בתקופה? אין לכלול חופשה, מחלה או עבודה מהבית.','missing_fact','number');
  else if(Number(input.commute_days!.printed_value)>Number(last.slice(8)))add('travel.commute_days','conflict','commute_days','מספר ימי ההגעה שנשמר גדול ממספר הימים בחודש. יש לברר את הספירה והתקופה; לא נצמצם אותה בשקט.','missing_fact','number');
  if(!available(input.discounted_daily_fare))add('travel.discounted_daily_fare',input.discounted_daily_fare?.state??'missing','discounted_daily_fare','נדרש התעריף המוזל המתאים למסלול ולכיוונים שאינם ניתנים ללא עלות. אין להציב את התקרה במקום תעריף חסר.','missing_source','number');
  if(input.monthly_pass.state!=='known')add('travel.monthly_pass',input.monthly_pass.state,'monthly_pass','האם מנוי חודשי מתאים למסלול, לתקופה ולהנחות הזמינות? יש לברר זמינות גם אם מחירו עדיין חסר.','missing_fact','choice');
  else if(input.monthly_pass.value==='available'&&!available(input.monthly_pass_cost))add('travel.monthly_pass_cost',input.monthly_pass_cost?.state??'missing','monthly_pass_cost','מה מחיר המנוי החודשי המתאים לאחר הנחות? לא נשווה בלי נתון זה.','missing_source','number');
  if(gaps.length)return finish();
 }
 const half=!zero&&['outbound','return'].includes(input.facts.employer_transport.value??'');
 const decisionIds=Object.keys(applicability).filter(id=>zero?['travel.general_coverage',floor?'travel.general_order_floor':'travel.no_better_arrangement'].includes(id):id!=='travel.one_direction_treatment'||half);
 const decisions:Decision[]=decisionIds.map<Decision>(decision_id=>input.applicability.find(d=>d.decision_id===decision_id)??{decision_id,state:'missing',basis:'ai_source_assessment',explanation:applicability[decision_id as keyof typeof applicability],sources:[decision_id==='travel.general_order_floor'?travelFloorLegalSource('סעיף 30(א)–(ב); עדכניות ופרשנות דורשות קבלה נפרדת'):travelLegalSource(decision_id==='travel.one_direction_treatment'?2:1,decision_id)],valid_until:null}).map(d=>{const sources=d.state==='accepted'?travelCaseDecisionSources(input,d.decision_id):[];return sources.length?{...d,sources:[...new Map([...d.sources,...sources].map(s=>[canonicalSha256(s),s])).values()]}:d;});
 for(const d of decisions)if(d.state!=='accepted'||!d.sources.length||d.basis==='customer_declaration'||d.valid_until!==null&&d.valid_until<=input.evaluated_at)add(d.decision_id,d.state==='accepted'?'unknown':d.state,`applicability.${d.decision_id}`,d.explanation,'missing_applicability');
 const sourceFacts:{key:string;fact:TravelEntitlementInput['facts'][keyof TravelEntitlementInput['facts']]|TravelEntitlementInput['monthly_pass']}[]=consumed.map(key=>({key,fact:input.facts[key as keyof typeof input.facts]}));if(!zero)sourceFacts.push({key:'monthly_pass',fact:input.monthly_pass});
 const evidenceSources=[...new Map(sourceFacts.flatMap(({fact})=>fact.source?[[canonicalSha256(fact.source),fact.source] as const]:[])).values()];
 if(branch==='no_commute_days')evidenceSources.push(input.commute_days!.source);
 decisions.push({decision_id:'travel.factual_route_scope',state:'accepted',basis:'ai_source_assessment',explanation:JSON.stringify({schema_version:'travel-route-facts-v1',facts_sha256:canonicalSha256(sourceFacts),values:Object.fromEntries(sourceFacts.map(({key,fact})=>[key,fact.value])),branch,period:input.period,...(branch==='no_commute_days'?{commute_days:'0'}:{}),legal_applicability_approved:false}),sources:evidenceSources,valid_until:null});
 const assumptions=(input.conditional_assumptions??[]).filter(a=>decisionIds.includes(a.decision_id));
 for(const compared of [false,true]){
  if(compared&&!input.recorded){add('travel.recorded','missing','recorded','נדרש סכום הנסיעות שנרשם לתקופה לצורך השוואה. הסכום הצפוי נשמר בנפרד.','missing_source','number',[ids[1]]);continue;}
  const operands:DocumentReviewOperand[]=[],facts:RuleSpecDraft['facts'][number][]=[],parameters:RuleSpecDraft['parameters'][number][]=[],nodes:RuleSpecDraft['nodes'][number][]=[],bindings:{ref_id:string;operand_id:string}[]=[],parameterBindings:{ref_id:string;operand_id:string}[]=[];
  const fact=(id:string,o:DocumentReviewOperand,kind:'money'|'rational',unit:string)=>{operands.push({...o,id});facts.push({ref_id:'fact.'+id,value_kind:kind,unit});bindings.push({ref_id:'fact.'+id,operand_id:id});};
  const parameter=(id:string,value:string,kind:'money'|'rational',unit:string,page:number)=>{operands.push({id,observation_id:`travel.law.${id}`,state:'observed',printed_value:value,representation:kind==='money'?'money_ils':'decimal_quantity',quantity_unit:kind==='money'?null:'ratio',precision:'source_exact',source:travelLegalSource(page,id)});parameters.push({ref_id:'parameter.'+id,parameter_id:'il.travel.'+id,parameter_version:'2016.1',value_kind:kind,unit});parameterBindings.push({ref_id:'parameter.'+id,operand_id:id});};
  let expectedRef:string;
  if(zero){parameter('zero','0.00','money','currency.ils',branch==='employer_both'?2:1);nodes.push({node_id:'travel.expected',operation:'aggregate.bounded',refs:['parameter.zero']});expectedRef='travel.expected';}
  else{
   fact('days',input.commute_days!,'rational','days');fact('fare',input.discounted_daily_fare!,'money','currency.ils');parameter('cap','22.60','money','currency.ils',1);
   nodes.push({node_id:'travel.one.day',operation:'constant.rational',value:'1',unit:'days'},{node_id:'travel.days.multiplier',operation:'divide',left_ref:'fact.days',right_ref:'travel.one.day'});
   let capRef='parameter.cap';if(half){parameter('half','0.5','rational','ratio',2);nodes.push({node_id:'travel.direction.cap',operation:'money.scale',money_ref:capRef,rational_ref:'parameter.half',rounding:'half_up'});capRef='travel.direction.cap';}
   // Same min/scale/min formula as the retained TRAVEL_ACTUAL_COST_SPEC;
   // only the new source pins, source-selected branch and bindings differ.
   nodes.push({node_id:'travel.daily.allowed',operation:'min',refs:['fact.fare',capRef]},{node_id:'travel.period.allowed',operation:'money.scale',money_ref:'travel.daily.allowed',rational_ref:'travel.days.multiplier',rounding:'half_up'});expectedRef='travel.period.allowed';
   if(input.monthly_pass.value==='available'){fact('pass',input.monthly_pass_cost!,'money','currency.ils');nodes.push({node_id:'travel.expected',operation:'min',refs:[expectedRef,'fact.pass']});expectedRef='travel.expected';}
  }
  if(compared){fact('recorded',input.recorded!,'money','currency.ils');nodes.push({node_id:'travel.difference',operation:'subtract',left_ref:expectedRef,right_ref:'fact.recorded'});}
  const variant=zero?branch:half?'one_direction_candidate':input.monthly_pass.value==='available'?'ticket_comparison':'no_appropriate_pass';
  const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:`il.review.travel.${floor?'general_order_floor.':''}${variant}.${compared?'comparison':'expected'}`,rule_spec_version:floor?'2.0.0':'1.0.0',topic:'travel',catalog_boundary:'real_inactive',source_version_ids:legalManifest.map(s=>s.version_id),effective_period:TRAVEL_SOURCE_REVIEW.supported_period,sectors:['general_private_conditionally_assessed'],populations:['adult_general'],facts,parameters,nodes,output_ref:compared?'travel.difference':expectedRef,golden_case_set_sha256:canonicalSha256({daily:'12.00',days:20,pass:'200.00',expected:'200.00',legacy_formula_sha256:TRAVEL_LEGACY_FORMULA_PROVENANCE.content_sha256}),resource_policy:{max_steps:10,max_depth:6,max_aggregate_items:8,max_integer_digits:64}});
  const cited=[...operands.map(o=>o.source),...decisions.flatMap(d=>d.sources)],manifest=input.source_manifest.filter(m=>cited.some(s=>s.document_id===m.document_id&&s.version_id===m.version_id));
  for(const pin of legalManifest){const prior=input.source_manifest.find(m=>m.document_id===pin.document_id);if(prior&&canonicalSha256(prior)!==canonicalSha256(pin))throw Error('TRAVEL_LEGAL_MANIFEST_PIN');if(!manifest.some(m=>m.document_id===pin.document_id))manifest.push(pin);}
  const calculation=documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,check_id:ids[compared?1:0],period:input.period,evaluated_at:input.evaluated_at,source_manifest:manifest,operands,remittance_status:input.remittance_status,operation:{kind:'candidate_rule',rule,fact_bindings:bindings,parameter_bindings:parameterBindings,required_decision_ids:decisions.map(d=>d.decision_id),decisions,expected_output_ref:expectedRef,recorded_ref:null,...(assumptions.length?{conditional_assumptions:assumptions}:{}),...(compared?{comparison:{schema_version:'candidate-comparison-v1',expected_ref:expectedRef,recorded_ref:'fact.recorded',difference_ref:'travel.difference',recorded_basis:'document_amount'}}:{})}});
  checks.push({check_id:calculation.check_id,topic:'travel',title:floor?(compared?'רצפת נסיעות לפי הצו הכללי לעומת הסכום שנרשם':'רצפת השתתפות בנסיעות לפי הצו הכללי'):compared?'השתתפות בנסיעות לעומת הסכום שנרשם':'השתתפות צפויה בנסיעות',explanation:floor?'רצפה בלבד בכפוף לעובדות המסלול, לתעריפים ולהערכת תחולת המקור. מלוא ההסדר והזכויות המיטיבות אינם נבדקים; גם אפס או פער שלילי אינם אישור עמידה במלוא הזכאות. הפער אינו חוב מזומן.':zero?'לפי העובדות שזוהו, ענף זה אינו יוצר השתתפות צפויה במסגרת הצו הכללי; הסדר מיטיב ותחולה נבדקים בנפרד.':'סכום מותנה במסלול, ימים, הנחות וכרטיס מתאים; התקרה אינה סכום המגיע אוטומטית. הפער הוא צפוי פחות רשום ואינו קביעה על חוב מזומן.',calculation});
 }
 return finish();
}
