import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import {obligationsEntitlementInputSchema,resolveExplicitObligations,obligationCheckIds,OBLIGATIONS_CATALOG} from './obligations/index.ts';
import type {EntitlementBranchReview,EntitlementAnswerTarget} from './branch-contract.ts';
import {obligationProductQuestions} from './obligations/product-facts.ts';

/** Clause and condition identities remain distinct from labels and monetary
 * allocation. An answer confirms a case fact, never a binding agreement. */
export function obligationsProductReview(input:DocumentReviewInput,candidate:unknown):EntitlementBranchReview{
 const e=obligationsEntitlementInputSchema.parse(candidate);
 if(e.case_id!==input.case_id||canonicalSha256(e.period)!==canonicalSha256(input.period))throw Error('ENTITLEMENT_BRANCH_SCOPE');
 const topics=input.purchased_scope.topics.filter((t):t is 'contract'|'bonuses'=>t==='contract'||t==='bonuses');
 if(canonicalSha256([...topics].sort())!==canonicalSha256([...e.purchased_topics].sort()))throw Error('ENTITLEMENT_OBLIGATION_PURCHASE_SCOPE');
 const raw=resolveExplicitObligations(e),gaps:DocumentReviewInput['coverage_gaps']=[],needs:ReviewCompletionNeed[]=[],answer_targets:EntitlementAnswerTarget[]=[];
 const pinsFor=(id:string)=>{const o=e.obligations.find(o=>o.obligation_id===id)!;return [{case_id:input.case_id,document_id:o.clause.source.document_id,version_id:o.clause.source.version_id,source_sha256:o.clause.source.file_sha256}];};
 for(const m of raw.gaps){
  const pins=pinsFor(m.obligation_id),fact_key=`entitlement.obligations.${canonicalSha256({period:input.period,pins,path:m.input_path,key:m.dependency_id}).slice(0,28)}`;
  const condition=m.kind==='missing_fact'&&/^obligations\.\d+\.conditions\.\d+\.fact$/u.test(m.input_path),legal=m.kind==='missing_applicability'||m.kind==='missing_rule';
  if(!needs.some(n=>n.fact_key===fact_key)){
   needs.push({fact_key,kind:legal?'legal':'factual',reason:m.state==='conflict'?'conflicted':m.state==='unreadable'?'unreadable':m.state==='missing'?'missing':'unknown',required_evidence_kind:condition?'customer_declaration':'observed_reading',question:m.question,
    answer_kind:condition?'boolean':m.answer_kind==='number'?'number':'text',source_pins:pins,dependent_check_ids:[...m.dependent_check_ids],general_question:false});
   if(condition)answer_targets.push({fact_key,input_path:m.input_path,branch:'obligations',index:null,value_kind:'boolean'});
  }
  for(const id of m.dependent_check_ids){const old=gaps.find(g=>g.check_id===id);if(old){if(!old.next_step.includes(m.question))old.next_step+=' '+m.question;}else gaps.push({check_id:id,topic:m.topic,kind:m.kind,detail:'התחייבות זו תלויה בתנאים ובמקור המסוימים. סכום שחולץ אינו מוכיח הסכם מחייב או תשלום בפועל.',next_step:m.question,source_pins:pins});}
 }
 // Factual agreement context travels through the existing identified answer
 // journal. It never replaces the separate internal interpretation decisions.
 for(const [index,o]of e.obligations.entries())for(const q of obligationProductQuestions(e,o,index)){
  const ids=obligationCheckIds(e.check_prefix,o.obligation_id),pins=pinsFor(o.obligation_id);
  needs.push({fact_key:q.fact_key,kind:'factual',reason:q.fact.state==='conflict'?'conflicted':q.fact.state==='unreadable'?'unreadable':q.fact.state==='missing'?'missing':'unknown',
   required_evidence_kind:'customer_declaration',question:q.question,answer_kind:q.value_kind==='date'?'text':'boolean',
   ...(q.value_kind==='date'?{value_validation:{schema_version:'document-review-value-validation-v1' as const,format:'iso_date' as const}}:{}),source_pins:pins,dependent_check_ids:ids,general_question:false});
  answer_targets.push({fact_key:q.fact_key,input_path:q.path,branch:'obligations',index:null,value_kind:q.value_kind});
 }
 // A purchased topic without a discovered clause is visible; an empty array is
 // not proof that the agreement contains no monetary obligations.
 for(const topic of topics)if(!e.obligations.some(o=>o.topic===topic))gaps.push({check_id:`${e.check_prefix}.${topic}.inventory`,topic,kind:'missing_source',detail:'טרם זוהתה התחייבות כספית מפורשת בנושא זה מתוך המסמכים שנבדקו.',next_step:'נדרש לזהות במסמך את הסעיף, התקופה, הסכום או הנוסחה והתנאים; אין להסיק שאין התחייבות ממלאי חילוץ ריק.'});
 const outcomes=raw.outcomes.filter(o=>o.state==='not_triggered').map(o=>{
  const clause=e.obligations.find(c=>c.obligation_id===o.obligation_id)!;
  return {schema_version:'entitlement-nonmonetary-outcome-v1' as const,topic:o.topic,obligation_id:o.obligation_id,check_ids:obligationCheckIds(e.check_prefix,o.obligation_id),state:'condition_not_fulfilled' as const,title:clause.title,
   explanation:'לפי המידע המזוהה, התנאי הבא לא התקיים: '+clause.conditions.filter(c=>o.consumed_condition_ids.includes(c.condition_id)).map(c=>c.description).join(' ')+' לכן לא חושב סכום מכוח התחייבות זו. אין בכך קביעה שאין זכאות מכוח הסדר אחר, או אישור שההסכם מחייב.',
   input_basis:clause.conditions.some(c=>o.consumed_condition_ids.includes(c.condition_id)&&c.fact.basis==='customer_declaration')?'customer_declaration' as const:'document_reading' as const,evidence_sha256:o.evidence_sha256,consumed_condition_ids:[...o.consumed_condition_ids],source_pins:pinsFor(o.obligation_id)};
 });
 return {checks:[...raw.checks],gaps,needs,answer_targets,...(outcomes.length?{nonmonetary_outcomes:outcomes}:{}),selections:topics.map(topic=>{
  const checks=raw.checks.filter(c=>c.topic===topic),rules=checks.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).operation).filter(o=>o.kind==='candidate_rule').map(o=>({rule_id:o.rule.rule_spec_id,version:o.rule.rule_spec_version,sha256:o.rule.content_sha256}));
  return {topic,catalog_id:OBLIGATIONS_CATALOG.catalog_id,catalog_version:OBLIGATIONS_CATALOG.catalog_version,evidence_sha256:canonicalSha256(e),source_policy_sha256:raw.catalog.source_review_sha256,status:checks.length||outcomes.some(o=>o.topic===topic)?'selected_for_review':'missing_facts',rule_pins:rules,generated_check_ids:checks.map(c=>c.check_id),generated_gap_ids:gaps.filter(g=>g.topic===topic).map(g=>g.check_id),publication_authority:false,authority_status:'candidate_review_not_financial_authority'};
 })};
}
