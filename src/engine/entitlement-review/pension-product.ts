import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import {resolvePensionEntitlement,PENSION_CATALOG,PENSION_SOURCE_REVIEW_SHA256,pensionEntitlementInputSchema} from './pension/index.ts';
import type {EntitlementBranchReview,EntitlementAnswerTarget} from './branch-contract.ts';
import {pensionProductFactQuestions} from './pension/product-facts.ts';

/** Adapter into the existing completion planner and document-review executor.
 * The envelope admits source facts; the caller cannot choose a RuleSpec. */
export function pensionProductReview(input:DocumentReviewInput,candidate:unknown):EntitlementBranchReview{
 const e=pensionEntitlementInputSchema.parse(candidate);
 if(e.case_id!==input.case_id||canonicalSha256(e.period)!==canonicalSha256(input.period))throw Error('ENTITLEMENT_PENSION_SCOPE');
 if(!input.purchased_scope.topics.includes('pension'))throw Error('ENTITLEMENT_PENSION_UNPURCHASED');
 const resolved=resolvePensionEntitlement(e),needs:ReviewCompletionNeed[]=[],answer_targets:EntitlementAnswerTarget[]=[];
 const pins=input.documents.filter(d=>e.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
 const gaps:DocumentReviewInput['coverage_gaps']=[];
 const personal=pensionProductFactQuestions(e);
 for(const missing of resolved.gaps){
  // The opt-in source packet asks for an exact birthday, not two customer
  // judgments about statutory age thresholds. Historical packets keep theirs.
  const derivedAge=!!e.product_facts&&['facts.aged_21_or_more','facts.under_60'].includes(missing.input_path);
  const fact_key=`entitlement.pension.${canonicalSha256({period:input.period,pins,path:missing.input_path}).slice(0,32)}`;
  const scalar=missing.kind==='missing_fact'&&/^facts\.(employment_start|employment_end|prior_coverage_at_start|continuous_employment|aged_21_or_more|under_60)$/u.test(missing.input_path);
  const date=missing.input_path==='facts.employment_start',end=missing.input_path==='facts.employment_end';
  const type:EntitlementAnswerTarget['value_kind']=date?'date':end?'date_or_ongoing':'boolean';
  const legal=missing.kind==='missing_applicability'||missing.kind==='missing_rule';
  const need:ReviewCompletionNeed={fact_key,kind:legal?'legal':'factual',reason:missing.state==='conflict'?'conflicted':missing.state==='unreadable'?'unreadable':missing.state==='missing'?'missing':'unknown',
   required_evidence_kind:scalar?'customer_declaration':'observed_reading',
   question:missing.question+(date?' יש להזין תאריך בתבנית YYYY-MM-DD.':end?' יש להזין תאריך YYYY-MM-DD או ״העבודה נמשכת״.':''),
   answer_kind:scalar?(date||end?'text':'boolean'):'text',
   ...(scalar&&(date||end)?{value_validation:{schema_version:'document-review-value-validation-v1' as const,format:date?'iso_date' as const:'iso_date_or_ongoing' as const}}:{}),
   source_pins:pins,dependent_check_ids:[...missing.dependent_check_ids],general_question:false};
  const prior=needs.find(n=>n.fact_key===fact_key);
  if(!prior&&!derivedAge){needs.push(need);if(scalar)answer_targets.push({fact_key,input_path:missing.input_path,branch:'pension',index:null,value_kind:type});}
  else if(prior&&canonicalSha256(prior)!==canonicalSha256(need))throw Error('ENTITLEMENT_PENSION_QUESTION_COLLISION');
  for(const id of missing.dependent_check_ids){
   const old=gaps.find(g=>g.check_id===id);
   if(old){if(!old.next_step.includes(missing.question))old.next_step+=' '+missing.question;continue;}
   gaps.push({check_id:id,topic:'pension',kind:missing.kind,detail:'בדיקת הפנסיה תלויה בנתונים ובתחולה המפורטים. סכום צפוי, ניכוי, הפרשת מעסיק והעברה בפועל נבדקים בנפרד.',next_step:missing.question,...(pins.length?{source_pins:pins}:{})});
  }
 }
 for(const q of personal){
  const fact_key=`entitlement.pension.${canonicalSha256({period:input.period,pins,path:q.path}).slice(0,32)}`;
  const ids=[...new Set([...resolved.checks.map(c=>c.check_id),...resolved.gaps.flatMap(g=>g.dependent_check_ids)])];
  if(!ids.length)continue;
  needs.push({fact_key,kind:'factual',reason:q.fact.state==='conflict'?'conflicted':q.fact.state==='unreadable'?'unreadable':q.fact.state==='missing'?'missing':'unknown',
   required_evidence_kind:'customer_declaration',question:q.question,answer_kind:q.answer_kind,source_pins:pins,dependent_check_ids:ids,general_question:false,
   ...(q.format?{value_validation:{schema_version:'document-review-value-validation-v1',format:q.format}}:{}),
   ...(q.choices?{options:q.choices.map(c=>c.label),value_mapping:{schema_version:'document-review-choice-values-v1',entries:[...q.choices]}}:{})});
  answer_targets.push({fact_key,input_path:q.path,branch:'pension',index:null,value_kind:q.format?'date':'text'});
 }
 const rules=resolved.checks.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).operation).filter(o=>o.kind==='candidate_rule').map(o=>({rule_id:o.rule.rule_spec_id,version:o.rule.rule_spec_version,sha256:o.rule.content_sha256}));
 return {checks:resolved.checks,gaps,needs,answer_targets,selections:[{topic:'pension',catalog_id:PENSION_CATALOG.catalog_id,catalog_version:PENSION_CATALOG.catalog_version,
  evidence_sha256:canonicalSha256(e),source_policy_sha256:PENSION_SOURCE_REVIEW_SHA256,status:resolved.checks.length?'selected_for_review':'missing_facts',
  rule_pins:[...new Map(rules.map(r=>[r.rule_id,r])).values()],generated_check_ids:resolved.checks.map(c=>c.check_id),generated_gap_ids:gaps.map(g=>g.check_id),
  publication_authority:false,authority_status:'candidate_review_not_financial_authority'}]};
}
