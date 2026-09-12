import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {convalescenceEntitlementInputSchema,type ConvalescenceMissing,type ConvalescenceEntitlementInput} from './contracts.ts';
import {CONVALESCENCE_CATALOG,CONVALESCENCE_SOURCE_REVIEW,CONVALESCENCE_PINNED_LEGAL_DOCUMENTS,convalescenceLegalSource,isPinnedConvalescenceLegalSource} from './source-policy.ts';
import {employmentAnniversary,nextConvalescenceDate,splitConvalescenceAccrual,type ConvalescenceAccrualSlice} from './periods.ts';
import {isDeclaredPeriodSource,periodFromDeclarations} from './product-facts.ts';

export const CONVALESCENCE_APPLICABILITY=deepFreeze({
 'cv.population':'יש לבסס תחולת המגזר הפרטי הכללי, ללא שכר ציבורי או הצמדה לשכר ציבורי, מפעל מוגן או הסדר מיוחד.',
 'cv.source_chain':'יש להעריך את תחולת צו 2016 ואת צו 2026 על התקופה, ולבדוק הסדר ענפי או מיטיב. עותק הרשומות של טבלת הימים מאוחסן באתר צד שלישי ואינו אישור אנושי.',
 'cv.benefit_year':'יש לזהות שהתקופה שנבדקת היא זו המשויכת לשנת הבראה 2026. הצו אינו מגדיר כאן שנה מיולי עד יוני; תאריך התלוש אינו קובע את תקופת הצבירה.',
 'cv.rate_2026':'יש להכריע בתחולת 451.50 ש״ח לפי הצו שפורסם ב־18.8.2026, ובמשמעות סעיף 2(ב) לחוק 2025 וחובת עדכון. אין להפחית יום בגין 2026 רק מכוח הוראת התשלום לשנת 2025.',
 'cv.qualifying_service':'יש לבסס ותק במקום העבודה והשלמת שנה ראשונה. חופשת לידה מזכה נשמרת; חל״ת, ניתוק או ותק רציף מיוחד דורשים מסלול ראיות אחר ולא נגרעים או מצורפים אוטומטית.',
 'cv.proration':'יש להכריע בשיטת היחס: הענף המועמד מחלק ימים קלנדריים מזכים במספר הימים בשנת ההעסקה המתאימה, מפצל בכל יום שנה ומשקלל היקף משרה קבוע בכל מקטע. הצו קובע חלקיות אך אינו מציין כאן נוסחת ימים זו.',
 'cv.due_date':'יש לבסס מועד תשלום מוסכם או נוהג ואת שיוך תקופת הצבירה אליו. טווח הקיץ יוני–ספטמבר אינו מוכיח חיוב בחודש מסוים; הסדר לתשלום במאי דורש מקור מפורש.',
 'cv.rounding':'המועמד מעגל לאגורה במחצית כלפי מעלה בסכום הכולל אחרי שקלול כל המקטעים. יש לבדוק אם חל הסדר מחייב אחר.',
 'cv.allocation':'יש לשייך מלאי תשלומי הבראה שלם לאותה תקופת צבירה, ללא כפל, יתרת עבר או תשלום לתקופה אחרת. רישום אינו הוכחת העברה בפועל.',
});
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
type Decision=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>['decisions'][number];
const usable=(f:Fact)=>['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
const missingState=(f:{state:string}):ConvalescenceMissing['state']=>['missing','unknown','conflict','stale','expired','unreadable'].includes(f.state)?f.state as ConvalescenceMissing['state']:'unknown';
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
export const convalescenceCheckIds=(prefix:string)=>[prefix+'.expected',prefix+'.comparison'] as const;
function sourcesIn(value:unknown):DocumentReviewSource[]{
 const list:DocumentReviewSource[]=[];
 const visit=(v:unknown):void=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return;}const r=v as Record<string,unknown>;
  if(typeof r.reading_receipt_sha256==='string'&&typeof r.locator==='string'){list.push(v as DocumentReviewSource);return;}Object.values(r).forEach(visit);};
 visit(value);return [...new Map(list.map(s=>[canonicalSha256(s),s])).values()];
}

/** A source date is not itself a day-count answer. Only these three exact
 * chronology operands may be derived from the paired date receipts. The
 * ordinary source/answer admission must still authenticate both receipts. */
export function convalescenceDeclaredChronologyOperand(raw:unknown,checkId:string,operand:DocumentReviewOperand):boolean{
 const parsed=convalescenceEntitlementInputSchema.safeParse(raw);if(!parsed.success)return false;
 const input=parsed.data,personal=input.product_facts;
 if(!personal||!/^slice\.\d+\.(?:year|calendar_days|year_days)$/u.test(operand.id)||operand.representation!=='integer'||operand.state!=='declared')return false;
 if(!convalescenceCheckIds(input.check_prefix).includes(checkId))return false;
 const segments=input.segments.filter(s=>s.period.source&&isDeclaredPeriodSource(s.period.source));
 if(!segments.length)return false;
 for(const segment of segments){const supplied=personal.segments.find(s=>s.id===segment.id);
  if(!supplied||!same(periodFromDeclarations(supplied.from,supplied.to),segment.period))return false;
 }
 const check=resolveConvalescenceEntitlement(input).checks.find(c=>c.check_id===checkId);if(!check)return false;
 const expected=documentReviewCalculationInputSchema.parse(check.calculation).operands.find(o=>o.id===operand.id);
 return expected!==undefined&&same(expected,operand)&&segments.some(s=>s.period.source!.document_id===operand.source.document_id
  &&s.period.source!.version_id===operand.source.version_id&&s.period.source!.reading_receipt_sha256===operand.source.reading_receipt_sha256);
}
function assertSources(input:ConvalescenceEntitlementInput){
 if(new Set(input.source_manifest.map(d=>d.document_id+':'+d.version_id)).size!==input.source_manifest.length)throw Error('CONVALESCENCE_MANIFEST_DUPLICATE');
 for(const s of sourcesIn(input)){
  if(s.reading==='source_research'){if(!isPinnedConvalescenceLegalSource(s))throw Error('CONVALESCENCE_LEGAL_SOURCE_PIN');continue;}
  const d=input.source_manifest.find(d=>d.document_id===s.document_id&&d.version_id===s.version_id);
  if(!d||d.case_id!==input.case_id||d.file_sha256!==s.file_sha256||s.page>d.page_count||!['case_document','customer_answer','questionnaire'].includes(d.kind))throw Error('CONVALESCENCE_SOURCE_BINDING');
  if((s.reading==='customer_declaration')!==(d.kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(d.kind==='questionnaire'))throw Error('CONVALESCENCE_DECLARATION_SOURCE');
 }
 for(const d of input.source_manifest.filter(d=>d.kind==='legal_source'))if(!CONVALESCENCE_PINNED_LEGAL_DOCUMENTS.some(p=>same(p,d)))throw Error('CONVALESCENCE_LEGAL_MANIFEST_PIN');
}

export function resolveConvalescenceEntitlement(raw:unknown){
 const input=convalescenceEntitlementInputSchema.parse(raw),ids=convalescenceCheckIds(input.check_prefix);
 const missing:ConvalescenceMissing[]=[],checks:DocumentReviewInput['checks']=[];
 let slices:ConvalescenceAccrualSlice[]=[];
 const month=input.period.from.slice(0,7),last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<CONVALESCENCE_CATALOG.supported_work_period.from||input.period.to>CONVALESCENCE_CATALOG.supported_work_period.to||input.period.from!==month+'-01'||input.period.to!==last)throw Error('CONVALESCENCE_SUPPORTED_PAYROLL_MONTH');
 assertSources(input);
 if(new Set(input.segments.map(s=>s.id)).size!==input.segments.length)throw Error('CONVALESCENCE_DUPLICATE_SEGMENT');
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length||input.applicability.some(d=>!Object.hasOwn(CONVALESCENCE_APPLICABILITY,d.decision_id)))throw Error('CONVALESCENCE_DECISION_SET');
 if(input.applicability.some(d=>d.state==='accepted'&&(d.basis==='customer_declaration'||!d.sources.length)))throw Error('CONVALESCENCE_DECLARATION_NOT_APPLICABILITY');
 const assumptions=input.conditional_assumptions??[];
 if(new Set(assumptions.map(a=>a.decision_id)).size!==assumptions.length||assumptions.some(a=>!Object.hasOwn(CONVALESCENCE_APPLICABILITY,a.decision_id)))throw Error('CONVALESCENCE_ASSUMPTION_SET');
 const add=(fact_key:string,input_path:string,state:ConvalescenceMissing['state'],question:string,kind:ConvalescenceMissing['kind'],sources:DocumentReviewSource[]=[],dependent_check_ids:readonly string[]=ids)=>{
  const pins=[...new Map(sources.filter(s=>s.reading!=='source_research').map(s=>{const pin={case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,source_sha256:s.file_sha256};return [canonicalSha256(pin),pin];})).values()];
  missing.push({fact_key,input_path,state,question,kind,answer_kind:kind==='source'?'document':'text',customer_declaration_allowed:false,source_pins:pins,dependent_check_ids});
 };
 const gap=(key:string,f:Fact,text:string,kind:ConvalescenceMissing['kind']='fact',state=missingState(f))=>add('cv.'+key,key,state,text,kind,f.source?[f.source]:[]);
 let hard=false;
 if(input.evaluated_at.slice(0,10)<CONVALESCENCE_SOURCE_REVIEW.knowledge_available_from){add('cv.publication_knowledge','evaluated_at','unsupported','צו התעריף לשנת 2026 פורסם ב־18.8.2026. אין לחשב לפי מקור עתידי כאשר מועד הידיעה שנבחר מוקדם מהפרסום.','source');hard=true;}
 if(!usable(input.population)||input.population.value!=='adult_private_general_21_59'){gap('population',input.population,CONVALESCENCE_APPLICABILITY['cv.population'],'applicability',usable(input.population)?'unsupported':missingState(input.population));hard=true;}
 if(!usable(input.employment_start)){gap('employment_start',input.employment_start,'נדרש מועד תחילת עבודה מזוהה באותו מקום עבודה לצורך הוותק; תאריך התלוש אינו תאריך התחלה.','source');hard=true;}
 if(input.employment_start.value?.slice(5)==='02-29'){gap('leap_start',input.employment_start,'תחילת עבודה ב־29 בפברואר דורשת הכרעה מפורשת במועד יום השנה בשנים שאינן מעוברות; הענף אינו מזיז תאריך בשקט.','applicability','unsupported');hard=true;}
 if(!usable(input.qualifying_service)||input.qualifying_service.value!=='continuous_no_excluded_absence'){gap('qualifying_service',input.qualifying_service,CONVALESCENCE_APPLICABILITY['cv.qualifying_service'],'source',usable(input.qualifying_service)?'unsupported':missingState(input.qualifying_service));hard=true;}
 if(!usable(input.payment_coverage)){gap('payment_coverage',input.payment_coverage,'איזו תקופת צבירה מכסה תשלום ההבראה הנבדק? נדרש מסמך או פירוט תקופה; אין ברירת מחדל של שנת תלוש או יולי–יוני.','source');hard=true;}
 if(!usable(input.benefit_year)||input.benefit_year.value!==2026){gap('benefit_year',input.benefit_year,'יש לזהות בנפרד את שנת ההבראה שהתשלום מכסה. הענף הנוכחי מתמחר רק שנה מזוהה 2026 ואינו מתמחר יתרות שנים קודמות באותו תעריף.','source',usable(input.benefit_year)?'unsupported':missingState(input.benefit_year));hard=true;}
 if(!usable(input.due_date)){gap('due_date',input.due_date,CONVALESCENCE_APPLICABILITY['cv.due_date'],'source');hard=true;}
 else if(input.due_date.value!<input.period.from||input.due_date.value!>input.period.to){gap('due_date',input.due_date,'מועד התשלום שזוהה אינו בחודש הבדיקה. יש לבחור את חודש המועד או להבהיר את ההקצאה; אין חוב מהיעדר רכיב בחודש אחר.','source','conflict');hard=true;}
 if(!input.segments.length){add('cv.fte_segments','segments','missing','נדרש היקף המשרה לאורך כל תקופת הצבירה. היקף בתלוש אחד אינו משלים אוטומטית שנה.','source');hard=true;}
 for(const [i,s]of input.segments.entries()){
  if(!usable(s.period)||!usable(s.fte)){add('cv.segment.'+s.id,`segments.${i}`,missingState(!usable(s.period)?s.period:s.fte),'יש לזהות את תקופת המקטע והיקף המשרה הקבוע בו; שינוי בהיקף מחייב מקטעים נפרדים.','source',sourcesIn(s));hard=true;}
  else if(Number(s.fte.value)<=0){add('cv.segment.'+s.id,`segments.${i}.fte`,'unsupported','היקף משרה אפס אינו תחליף לבירור היעדרות וצבירה מזכה. נדרשת ראיה לתקופה ולהסדר.','source',sourcesIn(s));hard=true;}
 }
 if(!hard){
  const coverage=input.payment_coverage.value!,start=input.employment_start.value!,due=input.due_date.value!;
  if(coverage.from<start||coverage.to<coverage.from||coverage.to>due){gap('payment_coverage',input.payment_coverage,'תקופת הצבירה חייבת להתחיל לאחר תחילת העבודה ולהסתיים עד המועד המזוהה. תאריכים סותרים אינם נחתכים אוטומטית.','source','conflict');hard=true;}
  if(due<employmentAnniversary(start,1)){gap('first_year',input.employment_start,'עד המועד שנבדק טרם הושלמה שנת העבודה הראשונה. הצו הכללי דורש השלמת שנה; יש לבדוק הסדר מיטיב או מועד מאוחר מתאים, ללא יצירת חוב מוקדם.','applicability','unsupported');hard=true;}
  const ordered=[...input.segments].sort((a,b)=>a.period.value!.from.localeCompare(b.period.value!.from));
  let cursor=coverage.from;
  for(const s of ordered){if(s.period.value!.from!==cursor||s.period.value!.to<s.period.value!.from||s.period.value!.to>coverage.to){add('cv.segment_inventory','segments','conflict','מקטעי היקף המשרה חייבים לכסות בדיוק את תקופת הצבירה ללא חפיפה או ימים חסרים. אין חישוב על מלאי חלקי.','source',sourcesIn(input.segments));hard=true;break;}cursor=nextConvalescenceDate(s.period.value!.to);}
  if(cursor!==nextConvalescenceDate(coverage.to)){add('cv.segment_inventory','segments','unknown','מקטעי היקף המשרה אינם מכסים את כל תקופת הצבירה המזוהה. יש להשלים את הימים החסרים.','source',sourcesIn(input.segments));hard=true;}
  if(!hard)slices=splitConvalescenceAccrual(start,ordered.map(s=>({id:s.id,from:s.period.value!.from,to:s.period.value!.to,fte:s.fte.value!})));
 }
 if(hard)return finish();
 const core={population:input.population,employment_start:input.employment_start,qualifying_service:input.qualifying_service,
  payment_coverage:input.payment_coverage,benefit_year:input.benefit_year,due_date:input.due_date,segments:input.segments,slices,
  ...(input.product_facts?{product_facts:input.product_facts}:{})};
 const decisionsFor=(compared:boolean):Decision[]=>{
  const decisions=Object.entries(CONVALESCENCE_APPLICABILITY).filter(([id])=>compared||id!=='cv.allocation').map(([decision_id,question])=>{
   let d:Decision=input.applicability.find(d=>d.decision_id===decision_id)??{decision_id,state:'missing',basis:'ai_source_assessment',explanation:question,sources:[convalescenceLegalSource(decision_id==='cv.rate_2026'?1:0)],valid_until:null};
   if(d.valid_until){const expiry=new Date(d.valid_until).toISOString();d={...d,valid_until:expiry,...(Date.parse(expiry)<=Date.parse(input.evaluated_at)?{state:'expired' as const}:{})};}
   if(d.state!=='accepted'&&!missing.some(m=>m.fact_key===decision_id))add(decision_id,'applicability.'+decision_id,d.state,question,'applicability',d.sources,decision_id==='cv.allocation'?[ids[1]]:ids);
   return d;
  });
  const evidence=compared?{core,recorded_coverage:input.recorded_coverage,recorded_inventory:input.recorded_inventory}:core;
  const cited=sourcesIn(evidence);
  for(let i=0;i<cited.length;i+=16)decisions.push({decision_id:'cv.evidence.'+i,state:'accepted',basis:'ai_source_assessment',
   explanation:'Source-bound factual chronology and allocation; local hashes do not authenticate signatures: '+canonicalSha256(evidence),sources:cited.slice(i,i+16),valid_until:null});
  return decisions;
 };
 let comparisonReady=true;
 if(input.recorded&&(input.recorded.representation!=='money_ils'||input.recorded.quantity_unit!==null||input.recorded.printed_value!==null&&!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(input.recorded.printed_value)))throw Error('CONVALESCENCE_RECORDED_MONEY');
 if(!input.recorded||!['observed','declared'].includes(input.recorded.state)||input.recorded.printed_value===null){add('cv.recorded','recorded',input.recorded?missingState(input.recorded):'missing','נדרש סכום הבראה מזוהה שהוקצה לתקופת הצבירה. שורה חסרה אינה אפס; הסכום הצפוי מוצג בנפרד.','source',input.recorded?[input.recorded.source]:[],[ids[1]]);comparisonReady=false;}
 if(!usable(input.recorded_inventory)||input.recorded_inventory.value!=='complete_allocated'){add('cv.recorded_inventory','recorded_inventory',missingState(input.recorded_inventory),'נדרש מלאי תשלומי הבראה שלם ומוקצה לתקופה הנבדקת. אין השוואת מלוא הזכאות לשורה חלקית או למקדמה.','source',sourcesIn(input.recorded_inventory),[ids[1]]);comparisonReady=false;}
 if(!usable(input.recorded_coverage)||!same(input.recorded_coverage.value,input.payment_coverage.value)){add('cv.recorded_coverage','recorded_coverage',usable(input.recorded_coverage)?'conflict':missingState(input.recorded_coverage),'יש לשייך את הסכום הרשום לאותה תקופת צבירה בדיוק. שנת התלוש או סכום דומה אינם ראיית שיוך.','source',sourcesIn(input.recorded_coverage),[ids[1]]);comparisonReady=false;}
 for(const compared of [false,true]){
  if(compared&&!comparisonReady)continue;
  checks.push(buildCheck(compared,decisionsFor(compared)));
 }
 return finish();

 function buildCheck(compared:boolean,decisions:Decision[]):DocumentReviewInput['checks'][number]{
  type Candidate=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>;
  const operands:DocumentReviewOperand[]=[],facts:RuleSpecDraft['facts'][number][]=[],parameters:RuleSpecDraft['parameters'][number][]=[],nodes:RuleSpecDraft['nodes'][number][]=[],bindings:Candidate['fact_bindings']=[],parameterBindings:Candidate['parameter_bindings']=[];
  const put=(id:string,value:string,kind:'integer'|'rational'|'money',unit:'count'|'days'|'calendar_days'|'ratio'|null,source:DocumentReviewSource,parameter=false)=>{
   const ref_id=(parameter?'parameter.':'fact.')+id;
   operands.push({id,observation_id:'cv.'+id,state:source.reading==='customer_declaration'||source.reading==='questionnaire_declaration'?'declared':'observed',printed_value:value,
    representation:kind==='money'?'money_ils':kind==='integer'?'integer':'decimal_quantity',quantity_unit:unit,precision:'source_exact',source});
   if(parameter){parameters.push({ref_id,parameter_id:'il.convalescence.'+id,parameter_version:'1.0.0',value_kind:kind,unit:unit??'currency.ils'});parameterBindings.push({ref_id,operand_id:id});}
   else{facts.push({ref_id,value_kind:kind,unit:unit??'currency.ils'});bindings.push({ref_id,operand_id:id});}return ref_id;
  };
  const bandRefs=CONVALESCENCE_SOURCE_REVIEW.bands.map((b,i)=>put('days.band.'+i,String(b.days),'integer','days',convalescenceLegalSource(0,'YP7417 p1434 section5(a), annual employment-year band'+b.from),true));
  const rate=put('rate.2026','451.50','money',null,convalescenceLegalSource(1),true);
  nodes.push({node_id:'cv.one.day',operation:'constant.rational',value:'1',unit:'days'});
  const contributions:string[]=[];
  for(const [i,s]of slices.entries()){
   const segment=input.segments.find(p=>p.id===s.segment_id)!;
   const source={...segment.period.source!,locator:'Convalescence source chronology '+canonicalSha256({start:input.employment_start,slice:s})};
   const year=put('slice.'+i+'.year',String(s.employment_year),'integer','count',source),days=put('slice.'+i+'.calendar_days',String(s.calendar_days),'integer','calendar_days',source),denominator=put('slice.'+i+'.year_days',String(s.year_calendar_days),'integer','calendar_days',source),fte=put('slice.'+i+'.fte',s.fte,'rational','ratio',segment.fte.source!);
   const prefix='cv.slice.'+i;
   nodes.push({node_id:prefix+'.annual_days',operation:'band.lookup',input_ref:year,bands:CONVALESCENCE_SOURCE_REVIEW.bands.map((b,j)=>({from_inclusive:b.from,to_exclusive:b.to,value_ref:bandRefs[j]}))},
    {node_id:prefix+'.year_fraction',operation:'divide',left_ref:days,right_ref:denominator},
    {node_id:prefix+'.day_count',operation:'divide',left_ref:prefix+'.annual_days',right_ref:'cv.one.day'},
    {node_id:prefix+'.partial_days',operation:'multiply',left_ref:prefix+'.day_count',right_ref:prefix+'.year_fraction'},
    {node_id:prefix+'.fte_days',operation:'multiply',left_ref:prefix+'.partial_days',right_ref:fte});
   contributions.push(prefix+'.fte_days');
  }
  nodes.push({node_id:'cv.weighted_days',operation:'aggregate.bounded',refs:contributions},{node_id:'cv.expected',operation:'money.scale',money_ref:rate,rational_ref:'cv.weighted_days',rounding:'half_up'});
  if(compared){const o=input.recorded!;const ref=put('recorded',o.printed_value!,'money',null,o.source);operands[operands.length-1]={...o,id:'recorded'};nodes.push({node_id:'cv.difference',operation:'subtract',left_ref:'cv.expected',right_ref:ref});}
  const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:'il.review.convalescence.2026.calendar-fraction.'+slices.length+'.'+(compared?'comparison':'expected'),rule_spec_version:'1.0.0',topic:'convalescence',catalog_boundary:'real_inactive',
   source_version_ids:CONVALESCENCE_PINNED_LEGAL_DOCUMENTS.map(d=>d.version_id),effective_period:CONVALESCENCE_CATALOG.supported_work_period,sectors:['general_private_explicitly_assessed'],populations:['adult_21_59_explicitly_assessed'],facts,parameters,nodes,output_ref:compared?'cv.difference':'cv.expected',
   golden_case_set_sha256:canonicalSha256({first_year_half_fte_minor:112875,second_year_full_fte_minor:270900,fourth_year_full_fte_minor:316050,half_third_half_fourth_weighted_days:'6.5',no_2026_day_reduction:true}),
   resource_policy:{max_steps:64,max_depth:16,max_aggregate_items:16,max_integer_digits:64}});
  const consumed=[...operands.map(o=>o.source),...decisions.flatMap(d=>d.sources)],manifest=input.source_manifest.filter(d=>consumed.some(s=>s.document_id===d.document_id&&s.version_id===d.version_id));
  for(const d of CONVALESCENCE_PINNED_LEGAL_DOCUMENTS)if(!manifest.some(p=>p.document_id===d.document_id&&p.version_id===d.version_id))manifest.push(d);
  const selectedAssumptions=assumptions.filter(a=>decisions.some(d=>d.decision_id===a.decision_id&&['missing','unknown'].includes(d.state)&&(!d.valid_until||Date.parse(d.valid_until)>Date.parse(input.evaluated_at))));
  const calculation=documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',input_basis_policy:'all-consumed-citations-v2',case_id:input.case_id,run_id:input.run_id,check_id:ids[compared?1:0],period:input.period,evaluated_at:input.evaluated_at,source_manifest:manifest,operands,remittance_status:'not_assessed',
   operation:{kind:'candidate_rule',rule,fact_bindings:bindings,parameter_bindings:parameterBindings,required_decision_ids:decisions.map(d=>d.decision_id),decisions,expected_output_ref:'cv.expected',recorded_ref:null,
    ...(selectedAssumptions.length?{conditional_assumptions:selectedAssumptions}:{}),...(compared?{comparison:{schema_version:'candidate-comparison-v1',expected_ref:'cv.expected',recorded_ref:'fact.recorded',difference_ref:'cv.difference',recorded_basis:'document_allocation'}}:{})}});
  return {check_id:calculation.check_id,topic:'convalescence',title:compared?'דמי הבראה — סכום צפוי לעומת רישום שהוקצה לתקופה':'דמי הבראה — מכסה צפויה לפי ותק וחלקיות',
   explanation:`תקופת הצבירה המזוהה: ${input.payment_coverage.value!.from} עד ${input.payment_coverage.value!.to}; מועד התשלום שנבדק: ${input.due_date.value}. נבדקת שנת הבראה 2026 על בסיס צו שפורסם מאוחר יותר, ב־18.8.2026, לפי מועד הידיעה ${input.evaluated_at.slice(0,10)}. המכסה נגזרת מטבלת הוותק, עם פיצול ימי שנה ושקלול היקף המשרה. יחס ימי הלוח ועיגול הסכום הם שיטת מועמד מפורשת. אין הנחת שנת יולי–יוני, הפחתת יום לשנת 2026, אישור העברה בפועל או קביעת חוב משפטי.`,calculation};
 }
 function finish(){return deepFreeze({catalog_descriptor:CONVALESCENCE_CATALOG,checks,missing,
  coverage_gaps:missing.map(m=>({check_id:input.check_prefix+'.gap.'+m.fact_key,topic:'convalescence' as const,kind:m.kind==='source'?'missing_source' as const:m.kind==='applicability'?'missing_applicability' as const:'missing_fact' as const,detail:m.question,next_step:m.question,...(m.source_pins.length?{source_pins:[...m.source_pins]}:{})})),
  selection_receipt:{schema_version:'convalescence-selection-v1',input_sha256:canonicalSha256(input),source_policy_sha256:CONVALESCENCE_CATALOG.source_review_sha256,
   payroll_period:input.period,payment_coverage:input.payment_coverage.value,benefit_year:input.benefit_year.value,knowledge_at:input.evaluated_at,
   source_published_at:CONVALESCENCE_SOURCE_REVIEW.knowledge_available_from,later_publication_assessment:true,accrual_slices:slices,requested_assumptions:assumptions,checks_sha256:checks.map(c=>canonicalSha256(c)),publication_authority:false}});}
}
