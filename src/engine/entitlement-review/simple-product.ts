import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import {travelEntitlementInputSchema,resolveTravelEntitlement,travelProductAnswerField} from './travel/index.ts';
import {minimumWageEntitlementInputSchema,resolveMinimumWageEntitlement,MINIMUM_WAGE_CATALOG} from './minimum-wage/index.ts';
import {vacationEntitlementInputSchema,resolveVacationEntitlement,VACATION_CATALOG} from './vacation/index.ts';
import {convalescenceEntitlementInputSchema,resolveConvalescenceEntitlement,CONVALESCENCE_CATALOG} from './convalescence/index.ts';
import type {EntitlementBranchReview,EntitlementAnswerTarget} from './branch-contract.ts';
import {typedEntitlementQuestions,type TypedEntitlementQuestion} from './typed-product-facts.ts';
import {SHARED_PERSONAL_FACTS_TRAVEL_POLICY,SHARED_PERSONAL_FACTS_EXPANDED_POLICY} from './shared-product-fact-contracts.ts';
type Topic='travel'|'minimum_wage'|'vacation'|'convalescence';
type Gap={key:string;path:string;state:string;kind:'missing_fact'|'missing_source'|'missing_applicability'|'missing_rule';question:string;ids:readonly string[];answer_kind:string;date_format?:'iso_date'|'iso_date_or_ongoing';typed?:TypedEntitlementQuestion;gap_only?:boolean};

/** Common product projection. No legal choices are delegated to a customer. */
export function simpleEntitlementProduct(input:DocumentReviewInput,topic:Topic,candidate:unknown):EntitlementBranchReview{
 if(!input.purchased_scope.topics.includes(topic))throw Error('ENTITLEMENT_UNPURCHASED_BRANCH');
 const e=topic==='travel'?travelEntitlementInputSchema.parse(candidate):topic==='vacation'?vacationEntitlementInputSchema.parse(candidate):topic==='convalescence'?convalescenceEntitlementInputSchema.parse(candidate):minimumWageEntitlementInputSchema.parse(candidate);
 if(e.case_id!==input.case_id||canonicalSha256(e.period)!==canonicalSha256(input.period))throw Error('ENTITLEMENT_BRANCH_SCOPE');
 const raw=topic==='travel'?resolveTravelEntitlement(e):topic==='vacation'?resolveVacationEntitlement(e):topic==='convalescence'?resolveConvalescenceEntitlement(e):resolveMinimumWageEntitlement(e);
 const catalog=topic==='travel'?resolveTravelEntitlement(e).catalog:topic==='vacation'?VACATION_CATALOG:topic==='convalescence'?CONVALESCENCE_CATALOG:MINIMUM_WAGE_CATALOG;
 const missing:Gap[]='gaps'in raw?raw.gaps.map(g=>({key:g.dependency_id,path:g.input_path,state:g.state,kind:g.kind,question:g.question,ids:g.dependent_check_ids,answer_kind:g.answer_kind,
  ...('value_validation'in g&&g.value_validation?{date_format:g.value_validation.format}:{})})):raw.missing.map(g=>({key:g.fact_key,path:g.input_path,state:g.state,
   kind:g.kind==='source'?'missing_source':g.kind==='applicability'?'missing_applicability':'missing_fact',question:g.question,ids:g.dependent_check_ids,answer_kind:g.answer_kind}));
 if(topic==='minimum_wage'||topic==='convalescence'||topic==='vacation'&&vacationEntitlementInputSchema.parse(e).product_facts||topic==='travel'&&[SHARED_PERSONAL_FACTS_TRAVEL_POLICY,SHARED_PERSONAL_FACTS_EXPANDED_POLICY].some(p=>p===input.entitlement_evidence?.shared_personal_facts_policy)){
  const typed=typedEntitlementQuestions(topic,e),ids=topic==='minimum_wage'?[minimumWageEntitlementInputSchema.parse(e).check_id]:topic==='vacation'?['annual.quota','annual.prorated','pay.expected','pay.comparison'].map(s=>vacationEntitlementInputSchema.parse(e).check_prefix+'.'+s):['expected','comparison'].map(s=>(topic==='travel'?travelEntitlementInputSchema.parse(e):convalescenceEntitlementInputSchema.parse(e)).check_prefix+'.'+s);
  for(const q of typed){const old=missing.find(m=>m.path===q.path);if(old){Object.assign(old,{kind:'missing_fact',question:q.question,answer_kind:q.answer_kind,typed:q});}
   else missing.push({key:'personal.'+q.path,path:q.path,state:q.fact.state,kind:'missing_fact',question:q.question,ids,answer_kind:q.answer_kind,typed:q});}
  if(topic==='travel'&&travelEntitlementInputSchema.parse(e).product_facts?.schema_version==='travel-product-facts-v2')for(const m of missing)if(m.path==='commute_days')m.gap_only=true;
  if(topic==='vacation'&&vacationEntitlementInputSchema.parse(e).product_facts){
   for(const m of missing)if(['facts.aged_21_or_more','facts.under_60','seniority_year'].includes(m.path))m.gap_only=true;
  }
  if(topic==='convalescence'){
   const p=convalescenceEntitlementInputSchema.parse(e);
   if(p.product_facts)for(const m of missing){
    if(m.path==='payment_coverage'||(!p.segments.length||p.segments.every(s=>s.id.startsWith('declared.segment.')))&&(/^segments(?:\.\d+)?$/u.test(m.path)||/^segments\.\d+\.period$/u.test(m.path)))m.gap_only=true;
   }
  }
 }
 const pins=input.documents.filter(d=>e.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
 if(topic==='travel'&&travelEntitlementInputSchema.parse(e).calculation_policy)for(const m of missing)if(m.path==='complete_arrangement')m.gap_only=true;
 const gaps:DocumentReviewInput['coverage_gaps']=[],needs:ReviewCompletionNeed[]=[],answer_targets:EntitlementAnswerTarget[]=[];
 for(const m of missing){
  const fact_key=m.typed?.fact_key??`entitlement.${topic}.${canonicalSha256({period:input.period,pins,path:m.path,key:m.key}).slice(0,28)}`;
  const field=topic==='travel'&&m.kind==='missing_fact'?travelProductAnswerField(m.path):null;
  const boolean=topic==='vacation'&&m.kind==='missing_fact'&&['facts.aged_21_or_more','facts.under_60','annual_basis.complete_year_evidence'].includes(m.path);
  const date=topic==='vacation'&&m.kind==='missing_fact'&&m.date_format;
  const scalar=Boolean(field||boolean||date||m.typed),legal=['missing_applicability','missing_rule'].includes(m.kind);
  const need:ReviewCompletionNeed={fact_key,kind:legal?'legal':'factual',reason:m.state==='conflict'?'conflicted':m.state==='unreadable'?'unreadable':m.state==='missing'?'missing':'unknown',
   required_evidence_kind:scalar?'customer_declaration':'observed_reading',question:m.question+(date?' יש להזין YYYY-MM-DD'+(date==='iso_date_or_ongoing'?' או ״העבודה נמשכת״.':'.'):''),
   answer_kind:m.typed?.answer_kind??(field?'choice':boolean?'boolean':m.answer_kind==='number'&&!legal?'number':'text'),
   ...(field?{options:[...field.options],value_mapping:{schema_version:'document-review-choice-values-v1' as const,entries:field.options.map(label=>({label,value:field.decode(label)}))}}:{}),
   ...(date?{value_validation:{schema_version:'document-review-value-validation-v1' as const,format:date}}:{}),
   ...(m.typed?.choices?{options:m.typed.choices.map(c=>c.label),value_mapping:{schema_version:'document-review-choice-values-v1' as const,entries:[...m.typed.choices]}}:{}),
   ...(m.typed?.format?{value_validation:{schema_version:'document-review-value-validation-v1' as const,format:m.typed.format}}:{}),
   source_pins:pins,dependent_check_ids:[...m.ids],general_question:false};
  if(!needs.some(n=>n.fact_key===fact_key)){
   if(!m.gap_only){needs.push(need);if(scalar)answer_targets.push({fact_key,input_path:m.path,branch:topic,index:null,value_kind:boolean?'boolean':date==='iso_date'?'date':date?'date_or_ongoing':'text'});}
  }
  for(const id of m.ids){const old=gaps.find(g=>g.check_id===id);if(old){if(!old.next_step.includes(m.question))old.next_step+=' '+m.question;continue;}
   gaps.push({check_id:id,topic,kind:m.kind,detail:'הבדיקה תלויה בנתונים ובתחולה המפורטים; לא הוחלף חוסר בסכום אפס.',next_step:m.question,...(pins.length?{source_pins:pins}:{})});}
 }
 const rules=raw.checks.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).operation).filter(o=>o.kind==='candidate_rule').map(o=>({rule_id:o.rule.rule_spec_id,version:o.rule.rule_spec_version,sha256:o.rule.content_sha256}));
 return {checks:[...raw.checks],gaps,needs,answer_targets,selections:[{topic,catalog_id:catalog.catalog_id,catalog_version:catalog.catalog_version,evidence_sha256:canonicalSha256(e),source_policy_sha256:catalog.source_review_sha256,
  status:raw.checks.length?'selected_for_review':'missing_facts',rule_pins:[...new Map(rules.map(r=>[r.rule_id,r])).values()],generated_check_ids:raw.checks.map(c=>c.check_id),generated_gap_ids:gaps.map(g=>g.check_id),
  publication_authority:false,authority_status:'candidate_review_not_financial_authority'}]};
}
