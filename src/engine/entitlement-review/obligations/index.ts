import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from '../../legal-operations/rulespec.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {obligationsEntitlementInputSchema,type ObligationsEntitlementInput,type ExplicitObligation,type ObligationGap} from './contracts.ts';
import {OBLIGATIONS_CATALOG,OBLIGATIONS_POLICY,OBLIGATIONS_POLICY_SHA256,OBLIGATION_ASSESSMENTS} from './policy.ts';
import {OBLIGATIONS_CASE_POLICY,OBLIGATIONS_SOURCE_REVIEW_SHA256,OBLIGATIONS_PINNED_LEGAL_DOCUMENTS} from './source-policy.ts';
export * from './contracts.ts';export * from './policy.ts';
type Decision=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>['decisions'][number];
export const obligationCheckIds=(prefix:string,id:string)=>[`${prefix}.${id}.expected`,`${prefix}.${id}.comparison`];
const location=(s:DocumentReviewSource)=>canonicalSha256({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page:s.page,locator:s.locator});
function bound(s:DocumentReviewSource,i:ObligationsEntitlementInput){
 const m=i.source_manifest.filter(m=>m.document_id===s.document_id&&m.version_id===s.version_id);
 const law=m.length===1&&i.case_policy===OBLIGATIONS_CASE_POLICY&&m[0].kind==='legal_source'&&m[0].case_id===null&&s.reading==='source_research'
  &&s.reading_receipt_sha256===OBLIGATIONS_SOURCE_REVIEW_SHA256&&OBLIGATIONS_PINNED_LEGAL_DOCUMENTS.some(p=>canonicalSha256(p)===canonicalSha256(m[0]));
 if(m.length!==1||!law&&m[0].case_id!==i.case_id||m[0].file_sha256!==s.file_sha256||m[0].page_count<s.page)throw Error('OBLIGATION_CASE_SOURCE_BINDING');
 if((s.reading==='customer_declaration')!==(m[0].kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(m[0].kind==='questionnaire'))throw Error('OBLIGATION_DECLARATION_SOURCE');
}
function money(o:DocumentReviewOperand|null){if(o&&(o.representation!=='money_ils'||o.quantity_unit!==null||o.printed_value!==null&&!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(o.printed_value)))throw Error('OBLIGATION_MONEY_OPERAND');}
function sameSource(a:DocumentReviewSource,b:DocumentReviewSource){return canonicalSha256(a)===canonicalSha256(b);}
function assessed(input:ObligationsEntitlementInput,o:ExplicitObligation):Decision[]{
 if(new Set(o.assessments.map(d=>d.decision_id)).size!==o.assessments.length||o.assessments.some(d=>!(d.decision_id in OBLIGATION_ASSESSMENTS)))throw Error('OBLIGATION_DECISION_SET');
 for(const d of o.assessments){for(const s of d.sources)bound(s,input);if(d.state==='accepted'&&!d.sources.some(s=>sameSource(s,o.clause.source)))throw Error('OBLIGATION_ASSESSMENT_CLAUSE_SOURCE');}
 return Object.entries(OBLIGATION_ASSESSMENTS).map(([decision_id,explanation])=>o.assessments.find(d=>d.decision_id===decision_id)??{decision_id,state:'missing',basis:'ai_source_assessment',explanation,sources:[o.clause.source],valid_until:null});
}
export function resolveExplicitObligations(candidate:unknown){
 const input=obligationsEntitlementInputSchema.parse(candidate),checks:DocumentReviewInput['checks']=[],gaps:ObligationGap[]=[],outcomes:{obligation_id:string;topic:'contract'|'bonuses';state:'selected'|'missing_facts'|'not_triggered'|'duplicate'|'outside_scope';evidence_sha256:string;consumed_condition_ids:string[]}[]=[];
 const policySha=input.case_policy===OBLIGATIONS_CASE_POLICY?OBLIGATIONS_SOURCE_REVIEW_SHA256:OBLIGATIONS_POLICY_SHA256;
 const monthEnd=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<OBLIGATIONS_POLICY.supported_period.from||input.period.to>OBLIGATIONS_POLICY.supported_period.to||input.period.from.slice(8)!=='01'||input.period.to!==monthEnd)throw Error('OBLIGATION_SUPPORTED_MONTH_REQUIRED');
 if(new Set(input.purchased_topics).size!==input.purchased_topics.length)throw Error('OBLIGATION_DUPLICATE_PURCHASE_TOPIC');
 const count=(keys:string[])=>{const m=new Map<string,number>();for(const k of keys)m.set(k,(m.get(k)??0)+1);return m;};
 const identities=count(input.obligations.map(o=>o.obligation_id)),clauses=count(input.obligations.map(o=>location(o.clause.source))),payments=count(input.obligations.flatMap(o=>o.recorded?[location(o.recorded.amount.source)]:[])),paymentIds=count(input.obligations.flatMap(o=>o.recorded?[o.recorded.payment_id]:[]));
 for(const [index,o] of input.obligations.entries()){
  const ids=obligationCheckIds(input.check_prefix,o.obligation_id),basePath=`obligations.${index}`;
  const add=(key:string,state:string,path:string,question:string,kind:ObligationGap['kind']='missing_fact',target:readonly string[]=ids,answer_kind:ObligationGap['answer_kind']='text')=>gaps.push({obligation_id:o.obligation_id,topic:o.topic,dependency_id:key,state,kind,input_path:basePath+'.'+path,question,answer_kind,...(answer_kind==='choice'?{options:['כן','לא','לא ידוע']}:{}),dependent_check_ids:target,source_required:true});
  const outcome=(state:(typeof outcomes)[number]['state'],consumed_condition_ids:string[])=>outcomes.push({obligation_id:o.obligation_id,topic:o.topic,state,evidence_sha256:canonicalSha256(o),consumed_condition_ids});
  bound(o.clause.source,input);if(['customer_declaration','questionnaire_declaration','source_research'].includes(o.clause.source.reading)||input.source_manifest.find(m=>m.document_id===o.clause.source.document_id&&m.version_id===o.clause.source.version_id)?.kind!=='case_document')throw Error('OBLIGATION_DOCUMENT_CLAUSE_REQUIRED');
  if(!input.purchased_topics.includes(o.topic)){outcome('outside_scope',[]);continue;}
  if(identities.get(o.obligation_id)!==1||clauses.get(location(o.clause.source))!==1){add('obligation.identity','conflict','clause','אותה התחייבות או אותו עוגן סעיף מופיעים יותר מפעם אחת. יש לזהות התחייבויות נפרדות לפני חישוב; שינוי נושא או מזהה אינו מכפיל את הסכום.','missing_source');outcome('duplicate',[]);continue;}
  if(canonicalSha256(o.payment_period)!==canonicalSha256(input.period)||o.clause.effective_period.from>input.period.to||o.clause.effective_period.to<input.period.from){add('obligation.period','conflict','payment_period','יש לקשור את תקופת החיוב המפורשת לסעיף בתוקף ולחודש הנבדק. לא נעביר הבטחה מחודש אחר ולא נחשב פרורציה.','missing_source');outcome('outside_scope',[]);continue;}
  if(new Set(o.conditions.map(c=>c.condition_id)).size!==o.conditions.length)throw Error('OBLIGATION_DUPLICATE_CONDITION');
  for(const c of o.conditions)if(c.fact.source){bound(c.fact.source,input);if(c.fact.basis==='customer_declaration'&&!['customer_declaration','questionnaire_declaration'].includes(c.fact.source.reading))throw Error('OBLIGATION_FACT_BASIS');}
  const decisions=assessed(input,o);
  if(o.product_facts){
   for(const key of ['agreement_used_for_employment','agreement_made_or_renewed_on','changes_or_side_terms','employer_disputes_term'] as const){
    const f=o.product_facts[key];if(f.source){bound(f.source,input);if(f.basis==='customer_declaration'&&!['customer_declaration','questionnaire_declaration'].includes(f.source.reading))throw Error('OBLIGATION_FACT_BASIS');}
    const conflict=f.state==='known'&&(key==='agreement_used_for_employment'&&f.value===false||['changes_or_side_terms','employer_disputes_term'].includes(key)&&f.value===true);
    const state=conflict?'conflict':f.state==='known'?'accepted':f.state==='unreadable'?'unknown':f.state;
    const explanation=conflict?(key==='agreement_used_for_employment'?'המסמך זוהה ככזה שלא שימש לקביעת תנאי העבודה בתקופה. נדרש המקור המתאים לפני חישוב מכוחו.':key==='changes_or_side_terms'?'נמסר שקיימים תיקון או תנאים נוספים לסעיף. יש לקשר ולקרוא אותם לפני שימוש בנוסחה מתוך הסעיף לבדו.':'נמסר שהמעסיק חולק על החלת הסעיף. נדרש מקור לעמדה ולנסיבות; אין להציג את הנוסחה כהתחייבות מוסכמת.'):'עובדת הקשר מזוהה בלבד; אינה אישור לתוקף, לפרשנות או לשלמות תנאי ההתחייבות.';
    decisions.push({decision_id:'obligation.context.'+key,state,basis:'ai_source_assessment',explanation:JSON.stringify({schema_version:'obligation-case-context-v1',key,fact_sha256:canonicalSha256(f),original_state:f.state,explanation,legal_applicability_approved:false}),sources:[o.clause.source,...(f.source?[f.source]:[])],valid_until:null});
    if(conflict)add('obligation.context.'+key,'conflict','product_facts.'+key,explanation,'missing_source');
   }
  }
  for(const d of decisions)if(!d.decision_id.startsWith('obligation.context.')&&(d.state!=='accepted'||d.basis==='customer_declaration'||!d.sources.length||d.valid_until!==null&&d.valid_until<=input.evaluated_at))add(d.decision_id,d.state==='accepted'?'unknown':d.state,'assessments.'+d.decision_id,d.explanation,'missing_applicability');
  const falseCondition=o.conditions.find(c=>c.fact.state==='known'&&c.fact.value===false);
  if(falseCondition){outcome('not_triggered',[falseCondition.condition_id]);continue;}
  const assumptions:{decision_id:string;explanation:string}[]=[];
  for(const [conditionIndex,c] of o.conditions.entries()){
   const state=c.fact.state==='known'?'accepted':c.fact.state==='unreadable'?'unknown':c.fact.state;
   const decision_id='condition.'+c.condition_id;
   decisions.push({decision_id,state,basis:'ai_source_assessment',explanation:JSON.stringify({description:c.description,fact_sha256:canonicalSha256(c.fact),value:c.fact.value,original_state:c.fact.state,fulfillment_fact_only:true,legal_applicability_approved:false}),sources:[o.clause.source,...(c.fact.source?[c.fact.source]:[])],valid_until:null});
   if(c.fact.state!=='known'){
    add(decision_id,c.fact.state,`conditions.${conditionIndex}.fact`,c.description,'missing_fact',ids,'choice');
    if(o.scenario==='if_conditions_fulfilled'&&['missing','unknown'].includes(c.fact.state))assumptions.push({decision_id,explanation:'תרחיש בלבד: אם התנאי הבא התקיים — '+c.description+'; אין אישור שהתנאי התקיים בפועל.'});
   }
  }
  const amounts=o.promise.kind==='fixed'?[o.promise.amount]:[o.promise.rate,o.promise.quantity];for(const a of amounts)if(a)bound(a.source,input);
  const clauseAmount=o.promise.kind==='fixed'?o.promise.amount:o.promise.rate;
  if(clauseAmount){const s=clauseAmount.source,c=o.clause.source;if(s.document_id!==c.document_id||s.version_id!==c.version_id||s.file_sha256!==c.file_sha256||s.page!==c.page||s.reading_receipt_sha256!==c.reading_receipt_sha256)throw Error('OBLIGATION_PROMISE_CLAUSE_BINDING');
   const interpretation=decisions.find(d=>d.decision_id==='obligation.clause_interpretation')!;if(interpretation.state==='accepted'&&!interpretation.sources.some(s=>sameSource(s,clauseAmount.source)))throw Error('OBLIGATION_PROMISE_READING_SOURCE');}
  if(o.promise.kind==='fixed')money(o.promise.amount);else{money(o.promise.rate);if(o.promise.quantity){const q=o.promise.quantity;if(q.quantity_unit!==o.promise.quantity_unit||!['decimal_quantity','hours_minutes','integer'].includes(q.representation)||q.representation==='hours_minutes'&&o.promise.quantity_unit!=='hours')throw Error('OBLIGATION_QUANTITY_UNIT');
   if(q.printed_value!==null&&!(q.representation==='hours_minutes'?/^(?:\d{1,6}):[0-5]\d$/u:/^(?:0|[1-9]\d{0,10})(?:\.\d{1,6})?$/u).test(q.printed_value))throw Error('OBLIGATION_NONNEGATIVE_QUANTITY');}}
  if(amounts.some(a=>a===null)){if(o.promise.kind==='fixed')add('obligation.fixed_amount','missing','promise.amount','מהו סכום ההתחייבות הכספית המפורש בסעיף? נדרשת קריאת מקור, לא השלמה לפי הציפייה.','missing_source',ids,'number');else{if(!o.promise.rate)add('obligation.rate','missing','promise.rate','נדרש התעריף המפורש ליחידה בסעיף.','missing_source',ids,'number');if(!o.promise.quantity)add('obligation.quantity','missing','promise.quantity','נדרשת הכמות המזוהה ביחידות שנקבעו ובתקופה המתאימה.','missing_fact',ids,'number');}outcome('missing_facts',o.conditions.map(c=>c.condition_id));continue;}
  const scopeEvidence={schema_version:'explicit-obligation-scope-v1',obligation_id:o.obligation_id,topic:o.topic,clause_source:o.clause.source,clause_text_sha256:o.clause.text_sha256,clause_effective_period:o.clause.effective_period,payment_period:o.payment_period,promise_kind:o.promise.kind,conditions:o.conditions.map(c=>({condition_id:c.condition_id,description:c.description})),conditions_mode:o.conditions_mode,policy_sha256:policySha};
  decisions.push({decision_id:'obligation.source_scope',state:'accepted',basis:'ai_source_assessment',explanation:JSON.stringify({schema_version:scopeEvidence.schema_version,scope_sha256:canonicalSha256(scopeEvidence),obligation_id:o.obligation_id,clause_text_sha256:o.clause.text_sha256,payment_period:o.payment_period,promise_kind:o.promise.kind,legal_applicability_approved:false}),sources:[o.clause.source],valid_until:null});
  for(const compared of [false,true]){
   let selectedDecisions=[...decisions];
   if(compared){
    if(!o.recorded){add('obligation.recorded','missing','recorded','נדרש לזהות תשלום רשום שמתייחס לאותה התחייבות ולתקופה, בנפרד מסכום ההתחייבות.','missing_source',[ids[1]],'number');continue;}
    bound(o.recorded.amount.source,input);money(o.recorded.amount);
    if(payments.get(location(o.recorded.amount.source))!==1||paymentIds.get(o.recorded.payment_id)!==1){add('obligation.payment_duplicate','conflict','recorded','אותו תשלום רשום משמש יותר מהתחייבות אחת. נדרש שיוך או פיצול מפורש במקור לפני השוואה; ההתחייבויות הצפויות נשמרות בנפרד.','missing_source',[ids[1]]);continue;}
    if(canonicalSha256(o.recorded.payment_period)!==canonicalSha256(input.period)){add('obligation.recorded_period','conflict','recorded.payment_period','התשלום הרשום אינו קשור לתקופת החיוב שנבחרה.','missing_source',[ids[1]]);continue;}
    const d=o.recorded.scope_assessment;for(const s of d.sources)bound(s,input);
    if(d.decision_id!=='obligation.recorded_scope')throw Error('OBLIGATION_RECORDED_DECISION');
    if(d.state==='accepted'&&(!d.sources.some(s=>sameSource(s,o.clause.source))||!d.sources.some(s=>sameSource(s,o.recorded!.amount.source))))throw Error('OBLIGATION_RECORDED_SOURCES');
    if(d.state!=='accepted'||d.basis==='customer_declaration'||d.valid_until!==null&&d.valid_until<=input.evaluated_at)add(d.decision_id,d.state==='accepted'?'unknown':d.state,'recorded.scope_assessment','נדרש לאמת את השיוך של התשלום הרשום להתחייבות המסוימת; דמיון בסכומים או בתווית אינו מספיק.','missing_source',[ids[1]]);
    selectedDecisions=[...selectedDecisions,d];
   }
   const operands:DocumentReviewOperand[]=[],facts:RuleSpecDraft['facts'][number][]=[],bindings:{ref_id:string;operand_id:string}[]=[],nodes:RuleSpecDraft['nodes'][number][]=[];
   const bind=(id:string,a:DocumentReviewOperand,kind:'money'|'rational'|'integer',unit:string)=>{operands.push({...a,id});facts.push({ref_id:'fact.'+id,value_kind:kind,unit});bindings.push({ref_id:'fact.'+id,operand_id:id});};
   if(o.promise.kind==='fixed'){bind('amount',o.promise.amount!,'money','currency.ils');nodes.push({node_id:'obligation.expected',operation:'aggregate.bounded',refs:['fact.amount']});}
   else{bind('rate',o.promise.rate!,'money','currency.ils');bind('quantity',o.promise.quantity!,o.promise.quantity!.representation==='integer'?'integer':'rational',o.promise.quantity_unit);nodes.push({node_id:'obligation.one.unit',operation:'constant.rational',value:'1',unit:o.promise.quantity_unit},{node_id:'obligation.multiplier',operation:'divide',left_ref:'fact.quantity',right_ref:'obligation.one.unit'},{node_id:'obligation.expected',operation:'money.scale',money_ref:'fact.rate',rational_ref:'obligation.multiplier',rounding:'half_up'});}
   if(compared){bind('recorded',o.recorded!.amount,'money','currency.ils');nodes.push({node_id:'obligation.difference',operation:'subtract',left_ref:'obligation.expected',right_ref:'fact.recorded'});}
   const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.1',rule_spec_id:`il.review.${o.topic}.${o.promise.kind}.${compared?'comparison':'expected'}.${canonicalSha256(scopeEvidence).slice(0,16)}`,rule_spec_version:'1.0.0',topic:o.topic,catalog_boundary:'real_inactive',source_version_ids:[o.clause.source.version_id],effective_period:input.period,sectors:['explicit_case_agreement_conditionally_assessed'],populations:['case_parties_only'],facts,parameters:[],nodes,output_ref:compared?'obligation.difference':'obligation.expected',golden_case_set_sha256:canonicalSha256({fixed_ils:'500.00',rate_ils:'12.50',quantity:'8',linear_expected_ils:'100.00'}),resource_policy:{max_steps:8,max_depth:6,max_aggregate_items:8,max_integer_digits:64}});
   const used=[...operands.map(a=>a.source),...selectedDecisions.flatMap(d=>d.sources)],source_manifest=input.source_manifest.filter(m=>used.some(s=>s.document_id===m.document_id&&s.version_id===m.version_id));
   const calculation=documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,check_id:ids[compared?1:0],period:input.period,evaluated_at:input.evaluated_at,source_manifest,operands,remittance_status:'not_assessed',operation:{kind:'candidate_rule',rule,fact_bindings:bindings,parameter_bindings:[],required_decision_ids:selectedDecisions.map(d=>d.decision_id),decisions:selectedDecisions,expected_output_ref:'obligation.expected',recorded_ref:null,...(assumptions.length?{conditional_assumptions:assumptions}:{}),...(compared?{comparison:{schema_version:'candidate-comparison-v1',expected_ref:'obligation.expected',recorded_ref:'fact.recorded',difference_ref:'obligation.difference',recorded_basis:'document_amount'}}:{})}});
   checks.push({check_id:calculation.check_id,topic:o.topic,title:o.title+(compared?' — מול התשלום שנרשם':''),explanation:'חישוב לפי התחייבות כספית מפורשת והיקפה, בכפוף לפרשנות, הסכמה מחייבת ותנאי ביצוע מזוהים. תרחיש אינו אישור שהתנאים התקיימו, והפרש אינו קביעה על חוב מזומן.',calculation});
  }
  outcome('selected',o.conditions.map(c=>c.condition_id));
 }
 return deepFreeze({schema_version:'obligations-entitlement-resolution-v1' as const,input_sha256:canonicalSha256(input),catalog:input.case_policy===OBLIGATIONS_CASE_POLICY?{...OBLIGATIONS_CATALOG,source_review_sha256:policySha}:OBLIGATIONS_CATALOG,checks,gaps,outcomes,rule_metadata:{policy_sha256:policySha,duplicate_cash_claims_created:false,agreement_binding_from_ocr:false,human_attestation:null,real_activation_allowed:false,
  additive_total_allowed:false,overlap_evidence:input.obligations.filter(o=>input.purchased_topics.includes(o.topic)).map(o=>({obligation_id:o.obligation_id,topic:o.topic,check_ids:obligationCheckIds(input.check_prefix,o.obligation_id),obligation_source_key:location(o.clause.source),
   payment_id:o.recorded?.payment_id??null,payment_source_key:o.recorded?location(o.recorded.amount.source):null,
   overlap_group:o.recorded?canonicalSha256({case_id:input.case_id,period:input.period,payment_source_key:location(o.recorded.amount.source)}):null,
   unknown_overlap_is_not_disjoint:true}))}});
}
