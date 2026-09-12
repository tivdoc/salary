import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {minimumWageEntitlementInputSchema,type MinimumWageMissing,type MinimumWageEntitlementInput} from './contracts.ts';
import {MINIMUM_WAGE_CATALOG,MINIMUM_WAGE_PINNED_LEGAL_DOCUMENTS,MINIMUM_WAGE_SOURCE_REVIEW,minimumWageLegalSource} from './source-policy.ts';

export const MINIMUM_WAGE_APPLICABILITY=deepFreeze({
 'mw.population':'יש לבסס בגירות לאורך התקופה ואת תחולת המסגרת הכללית; שכר נוער, שכר מותאם והסדר ענפי דורשים כלל אחר.',
 'mw.method':'נדרשת בחירה מנומקת בין תעריף שעתי מפורסם, חלוקת הסכום החודשי ב־182 או רצפה חודשית מלאה. הן שיטות שונות ואינן נבחרות לפי גובה ההפרש.',
 'mw.ordinary_scope':'יש לזהות את השעות הרגילות או החודש המלא ואת ההסדר של 182 שעות/42 שעות שבועיות. שעות נוספות ומנוחה אינן שעות רגילות לצורך הבדיקה הזו.',
 'mw.eligible_components':'יש לבסס את סיווג כל רכיבי השכר לפי סעיף 3. החזר הוצאות, נסיעות, תוספת משמרת ושעות נוספות אינם בסיס רגיל אוטומטי.',
 'mw.allocation':'יש לוודא שהרכיבים המזוהים משויכים לאותה תקופה ולאותן שעות רגילות, ושמלאי הרכיבים שלם ללא כפל.',
 'mw.rounding':'יש להכריע בשלב ובשיטת העיגול של השיטה הנבחרת. תעריף 35.40 אינו מוחלף בשקט בדיוק מלא של הסכום החודשי חלקי 182.',
});
const included=new Set(['base_salary','cost_of_living','fixed_work_supplement']);
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
const usable=(f:Fact)=>['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
const state=(f:{state:string}):MinimumWageMissing['state']=>['missing','unknown','conflict','stale','expired','unreadable'].includes(f.state)?f.state as MinimumWageMissing['state']:'unknown';
function numeric(o:DocumentReviewOperand,kind:'money'|'hours'){
 if(kind==='money'&&(o.representation!=='money_ils'||o.quantity_unit!==null)||kind==='hours'&&(!['hours_minutes','decimal_quantity'].includes(o.representation)||o.quantity_unit!=='hours'))throw Error('MINIMUM_WAGE_INPUT_UNIT');
 if(!['observed','declared'].includes(o.state)||o.printed_value===null)return null;
 if(o.representation==='hours_minutes'){const m=/^(\d{1,3}):([0-5]\d)$/u.exec(o.printed_value);if(!m)throw Error('MINIMUM_WAGE_HOURS_FORMAT');return Number(m[1])+Number(m[2])/60;}
 if(!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/u.test(o.printed_value))throw Error('MINIMUM_WAGE_SOURCE_NUMBER');return Number(o.printed_value);
}
function sourcesOf(input:unknown):DocumentReviewSource[]{const result:DocumentReviewSource[]=[];
 const visit=(v:unknown):void=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return;}const r=v as Record<string,unknown>;
  if(typeof r.reading_receipt_sha256==='string'&&typeof r.locator==='string'){result.push(v as DocumentReviewSource);return;}Object.values(r).forEach(visit);};visit(input);
 return [...new Map(result.map(s=>[canonicalSha256(s),s])).values()];
}
function assertSources(input:MinimumWageEntitlementInput){for(const s of sourcesOf(input)){
 const d=input.source_manifest.find(d=>d.document_id===s.document_id&&d.version_id===s.version_id);
 if(!d||d.file_sha256!==s.file_sha256||s.page<1||s.page>d.page_count||d.kind!=='legal_source'&&d.case_id!==input.case_id
  ||s.reading==='customer_declaration'&&d.kind!=='customer_answer')throw Error('MINIMUM_WAGE_SOURCE_BINDING');
}}

export function resolveMinimumWageEntitlement(raw:unknown){
 const input=minimumWageEntitlementInputSchema.parse(raw),missing:MinimumWageMissing[]=[],checks:DocumentReviewInput['checks']=[];
 if(input.period.from<MINIMUM_WAGE_CATALOG.supported_work_period.from||input.period.to>MINIMUM_WAGE_CATALOG.supported_work_period.to||input.period.from>input.period.to)throw Error('MINIMUM_WAGE_RESEARCH_PERIOD');
 const month=input.period.from.slice(0,7),last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from!==month+'-01'||input.period.to!==last)throw Error('MINIMUM_WAGE_FULL_CALENDAR_SCOPE');
 assertSources(input);
 if(new Set(input.components.map(c=>c.id)).size!==input.components.length||new Set(input.components.map(c=>canonicalSha256({observation_id:c.amount.observation_id,source:c.amount.source}))).size!==input.components.length)throw Error('MINIMUM_WAGE_DUPLICATE_COMPONENT');
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length||input.applicability.some(d=>!Object.hasOwn(MINIMUM_WAGE_APPLICABILITY,d.decision_id)))throw Error('MINIMUM_WAGE_DECISION_SET');
 if(input.applicability.some(d=>d.state==='accepted'&&(d.basis==='customer_declaration'||!d.sources.length)))throw Error('MINIMUM_WAGE_DECLARATION_NOT_APPLICABILITY');
 const add=(fact_key:string,input_path:string,s:MinimumWageMissing['state'],question:string,kind:MinimumWageMissing['kind'],sources:DocumentReviewSource[]=[],answer_kind:MinimumWageMissing['answer_kind']='text')=>{
  const pins=[...new Map(sources.filter(s=>s.reading!=='source_research').map(s=>{const pin={case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,source_sha256:s.file_sha256};return [canonicalSha256(pin),pin];})).values()];
  missing.push({fact_key,input_path,state:s,question,kind,answer_kind,customer_declaration_allowed:false,source_pins:pins,dependent_check_ids:[input.check_id]});
 };
 const gap=(key:string,f:Fact,question:string,kind:MinimumWageMissing['kind']='fact')=>add('mw.'+key,key,state(f),question,kind,f.source?[f.source]:[],kind==='source'?'document':'text');
 let hard=false;
 if(!usable(input.method)){gap('method',input.method,MINIMUM_WAGE_APPLICABILITY['mw.method'],'applicability');hard=true;}
 if(!usable(input.population)||input.population.value!=='adult_general'){
  gap('population',input.population,'יש לזהות גיל והסדר שכר רלוונטי לאורך התקופה. נוער ושכר מותאם אינם מחושבים לפי הרצפה הכללית.','applicability');hard=true;}
 if(!usable(input.employment)||input.employment.value==='unsupported'){
  gap('employment',input.employment,'יש להכריע מתוך סוג השכר והסדר העבודה המזוהים אם חלה המסגרת השעתית של 182 שעות, החודשית המלאה של 42 שעות או כלל אחר. זו בחירת מסגרת משפטית פנימית; אין לבקש מהלקוח לבחור מחלק או נוסחה.','applicability');hard=true;}
 if(input.employment.value==='partial_monthly'){
  gap('partial_monthly',input.monthly_coverage,'לשכר חודשי חלקי יש לזהות היקף משרה לתקופה, חודש התחלה/סיום, היעדרויות והסדר התשלום עבורן. סעיף 2(ב)–(ג) אינו מתיר להסיק אחוז משרה מסך ברוטו או משעות נוכחות בלבד.','applicability');hard=true;}
 if(!usable(input.eligible_pay_inventory)||input.eligible_pay_inventory.value!=='complete'){
  gap('eligible_pay_inventory',input.eligible_pay_inventory,'יש להשלים את מלאי רכיבי השכר הרגיל לאותה תקופה ואת סיווגם. סכום חלקי אינו מוצג כסך השכר הזכאי להיכלל.','source');hard=true;}
 const selected:MinimumWageEntitlementInput['components']=[];
 for(const [i,c]of input.components.entries()){
  if(!usable(c.classification)||c.classification.value==='unknown'){
   add('mw.classification.'+c.id,`components.${i}.classification`,state(c.classification),'יש לזהות את משמעות רכיב השכר ותנאי תשלומו לפני הכללתו או הוצאתו מבסיס שכר המינימום.','source',c.classification.source?[c.classification.source]:[],'document');hard=true;continue;}
  if(!included.has(c.classification.value!))continue;
  if(!usable(c.period)||canonicalSha256(c.period.value)!==canonicalSha256(input.period)){
   add('mw.component_period.'+c.id,`components.${i}.period`,usable(c.period)?'conflict':state(c.period),'יש לשייך את רכיב השכר לחודש הבדיקה; הפרשי תקופות אינם מצורפים אוטומטית לשכר החודש.','source',c.period.source?[c.period.source]:[],'document');hard=true;continue;}
  if(numeric(c.amount,'money')===null){add('mw.amount.'+c.id,`components.${i}.amount`,state(c.amount),'יש לאמת את סכום הרכיב הרלוונטי. תא ריק או סכום חסר אינם אפס.','source',[c.amount.source],'document');hard=true;continue;}
  selected.push(c);
 }
 if(!selected.length){add('mw.eligible_pay','components','missing','לא זוהה סכום שכר רגיל בר־השוואה. יש לזהות רכיב בסיס או תוספת נכללת; אין יצירת שכר אפס מתוך היעדר קריאה.','source',[],'document');hard=true;}
 const method=input.method.value;
 if(method==='full_monthly'){
  if(input.employment.value!=='full_monthly_42'||!usable(input.monthly_coverage)||input.monthly_coverage.value!=='full_month_full_time'){
   gap('monthly_coverage',input.monthly_coverage,'יש לבסס משרה מלאה וחודש מלא, וכן את הטיפול בהיעדרויות. אין להחיל אוטומטית רצפה חודשית מלאה על חודש חלקי.','source');hard=true;}
 }else if(method){
  if(input.employment.value!=='hourly_182'){gap('hourly_scope',input.employment,'השיטה השעתית שנבחרה דורשת מסגרת שעתית של 182 שעות. אין החלפה אוטומטית של שכר חודשי בשיטה שעתית.','applicability');hard=true;}
  const hours=input.ordinary_hours?numeric(input.ordinary_hours,'hours'):null;
  if(hours===null||hours<=0||hours>182){add('mw.ordinary_hours','ordinary_hours',input.ordinary_hours?state(input.ordinary_hours):'missing','יש לזהות שעות עבודה רגילות באותו חודש, עד 182 במסגרת הענף; שעות נוספות או סך נוכחות לא מסווג אינם תחליף.','source',input.ordinary_hours?[input.ordinary_hours.source]:[],'document');hard=true;}
  if(!usable(input.ordinary_hours_period)||canonicalSha256(input.ordinary_hours_period.value)!==canonicalSha256(input.period)){
   gap('ordinary_hours_period',input.ordinary_hours_period,'יש לאמת שהשעות הרגילות שייכות לחודש הבדיקה. אין צירוף תקופות או השלמת תאריכים.','source');hard=true;}
 }
 if(hard||!method)return finish();
 type Candidate=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>;
 const operands:DocumentReviewOperand[]=[],facts:RuleSpecDraft['facts'][number][]=[],parameters:RuleSpecDraft['parameters'][number][]=[],nodes:RuleSpecDraft['nodes'][number][]=[],bindings:Candidate['fact_bindings']=[],parameterBindings:Candidate['parameter_bindings']=[];
 const fact=(o:DocumentReviewOperand)=>{const id='mw.input.'+operands.length,ref_id='fact.'+id;operands.push({...o,id});facts.push({ref_id,value_kind:o.representation==='money_ils'?'money':'rational',unit:o.representation==='money_ils'?'currency.ils':o.quantity_unit});bindings.push({ref_id,operand_id:id});return ref_id;};
 const parameter=(id:string,value:string,kind:'money'|'hours',source:DocumentReviewSource)=>{const operandId='legal.'+id,ref_id='parameter.'+id;
  operands.push({id:operandId,observation_id:'mw.law.'+id,state:'observed',printed_value:value,representation:kind==='money'?'money_ils':'decimal_quantity',quantity_unit:kind==='money'?null:'hours',precision:'source_exact',source});
  parameters.push({ref_id,parameter_id:'il.review.mw.'+method+'.'+id,parameter_version:'1.0.0',value_kind:kind==='money'?'money':'rational',unit:kind==='money'?'currency.ils':'hours'});parameterBindings.push({ref_id,operand_id:operandId});return ref_id;};
 const recordedRefs=selected.map(c=>fact(c.amount));
 if(method==='full_monthly'){
  const monthly=parameter('monthly.floor','6443.85','money',minimumWageLegalSource(2,2,'YP14324 p4496: monthly6443.85 from2026-04-01'));
  nodes.push({node_id:'mw.required',operation:'aggregate.bounded',refs:[monthly]});
 }else {
  const hours=fact(input.ordinary_hours!);
  const floor=parameter(method==='published_hourly_182'?'hourly.floor':'monthly.floor',method==='published_hourly_182'?'35.40':'6443.85','money',minimumWageLegalSource(method==='published_hourly_182'?3:2,method==='published_hourly_182'?1:2,method==='published_hourly_182'?'Adult rates182, effective2026-04-01':'YP14324 p4496 monthlyfloor'));
  let divisor:string;
  if(method==='monthly_exact_div182')divisor=parameter('month.hours','182','hours',minimumWageLegalSource(1,3,'YP7732 p6285 section2.8'));
  else {divisor='mw.one.hour';nodes.push({node_id:divisor,operation:'constant.rational',value:'1',unit:'hours'});}
  nodes.push({node_id:'mw.factor',operation:'divide',left_ref:hours,right_ref:divisor},{node_id:'mw.required',operation:'money.scale',money_ref:floor,rational_ref:'mw.factor',rounding:'half_up'});
 }
 nodes.push({node_id:'mw.recorded.eligible',operation:'aggregate.bounded',refs:recordedRefs},{node_id:'mw.difference',operation:'subtract',left_ref:'mw.required',right_ref:'mw.recorded.eligible'});
 const decisions:Candidate['decisions']=Object.entries(MINIMUM_WAGE_APPLICABILITY).map(([decision_id,question])=>{
  let d:Candidate['decisions'][number]=input.applicability.find(d=>d.decision_id===decision_id)??{decision_id,state:'missing',basis:'ai_source_assessment',explanation:question,sources:[minimumWageLegalSource(0,1,decision_id)],valid_until:null};
  if(d.valid_until){const until=new Date(d.valid_until).toISOString();d={...d,valid_until:until,...(Date.parse(until)<=Date.parse(input.evaluated_at)?{state:'expired' as const}:{})};}
  if(d.state!=='accepted')add(decision_id,'applicability.'+decision_id,d.state,question,'applicability',d.sources);
  return d;
 });
 const evidence={method:input.method,population:input.population,employment:input.employment,inventory:input.eligible_pay_inventory,
  components:input.components.map(c=>({id:c.id,classification:c.classification,...(included.has(c.classification.value??'')?{period:c.period}:{} )})),
  coverage:method==='full_monthly'?input.monthly_coverage:input.ordinary_hours_period};
 const evidenceSources=sourcesOf(evidence);for(let i=0;i<Math.max(1,evidenceSources.length);i+=16)decisions.push({decision_id:'mw.evidence.'+i,state:'accepted',basis:'ai_source_assessment',
  explanation:'Locally bound source facts, not cryptographic authority verification: '+canonicalSha256(evidence),sources:evidenceSources.slice(i,i+16),valid_until:null});
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:'il.review.minimum-wage.'+method+'.components.'+selected.length,rule_spec_version:'1.0.0',
  topic:'minimum_wage',catalog_boundary:'real_inactive',source_version_ids:MINIMUM_WAGE_PINNED_LEGAL_DOCUMENTS.map(d=>d.version_id),effective_period:MINIMUM_WAGE_CATALOG.supported_work_period,
  sectors:['general_explicitly_assessed'],populations:['adult_general_explicitly_assessed'],facts,parameters,nodes,output_ref:'mw.difference',
  golden_case_set_sha256:canonicalSha256({method,independent_oracles:{published_hourly_182:{hours:100,recorded_minor:330000,expected_minor:354000,gap_minor:24000},monthly_exact_div182:{hours:100,recorded_minor:330000,expected_minor:354058,gap_minor:24058},full_monthly:{recorded_minor:640000,expected_minor:644385,gap_minor:4385}}}),
  resource_policy:{max_steps:16,max_depth:8,max_aggregate_items:32,max_integer_digits:64}});
 const consumed=[...operands.map(o=>o.source),...decisions.flatMap(d=>d.sources)],manifest=input.source_manifest.filter(d=>consumed.some(s=>s.document_id===d.document_id&&s.version_id===d.version_id));
 for(const d of MINIMUM_WAGE_PINNED_LEGAL_DOCUMENTS){const prior=manifest.find(p=>p.document_id===d.document_id);if(prior&&canonicalSha256(prior)!==canonicalSha256(d))throw Error('MINIMUM_WAGE_LEGAL_PIN');if(!prior)manifest.push(d);}
 const calculation=documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,check_id:input.check_id,period:input.period,evaluated_at:input.evaluated_at,
  source_manifest:manifest,operands,remittance_status:'not_assessed',operation:{kind:'candidate_rule',rule,fact_bindings:bindings,parameter_bindings:parameterBindings,
   required_decision_ids:decisions.map(d=>d.decision_id),decisions,expected_output_ref:'mw.required',recorded_ref:null,
   comparison:{schema_version:'candidate-comparison-v1',expected_ref:'mw.required',recorded_ref:'mw.recorded.eligible',difference_ref:'mw.difference',recorded_basis:'document_allocation'}}});
 const descriptions={published_hourly_182:'35.40 ש״ח לשעת עבודה רגילה לפי התעריף המפורסם במסגרת 182 שעות',monthly_exact_div182:'6,443.85 ש״ח כפול השעות הרגילות וחלקי 182, בעיגול רק בסכום הסופי',full_monthly:'6,443.85 ש״ח למשרה מלאה בחודש מלא'};
 checks.push({check_id:input.check_id,topic:'minimum_wage',title:'שכר מינימום — השוואה לשכר הרגיל המזוהה',explanation:'השיטה שנבחרה: '+descriptions[method]+'. ההשוואה כוללת רק רכיבים מסווגים באותה תקופה. זו שיטת מועמד מפורשת; אין לסכום חלופות, ואין כאן הוכחת העברה בפועל או חוב משפטי מאושר.',calculation});
 return finish();
 function finish(){const coverage_gaps:DocumentReviewInput['coverage_gaps']=missing.map(m=>({check_id:input.check_id+'.gap.'+m.fact_key,topic:'minimum_wage',kind:m.kind==='source'?'missing_source':m.kind==='applicability'?'missing_applicability':'missing_fact',
  detail:m.question,next_step:m.question,...(m.source_pins.length?{source_pins:[...m.source_pins]}:{})}));
  return deepFreeze({catalog_descriptor:MINIMUM_WAGE_CATALOG,checks,missing,coverage_gaps,method:input.method.value,
   selection_receipt:{schema_version:'minimum-wage-selection-v1',input_sha256:canonicalSha256(input),method:input.method.value,source_policy_sha256:MINIMUM_WAGE_CATALOG.source_review_sha256,
    calculation_method:input.method.value?MINIMUM_WAGE_SOURCE_REVIEW.methods[input.method.value]:null,check_sha256:checks.map(c=>canonicalSha256(c)),publication_authority:false}});}
}
