import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import {resolveWorkingTimeEntitlement,workingTimeEntitlementInputSchema,WORKING_TIME_CATALOG} from './working-time/index.ts';
import type {EntitlementBranchReview,EntitlementAnswerTarget} from './branch-contract.ts';

export function workingTimeProductReview(input:DocumentReviewInput,candidates:unknown):EntitlementBranchReview{
 if(!Array.isArray(candidates)||!candidates.length||candidates.length>6)throw Error('ENTITLEMENT_WORKING_WEEK_SET');
 const checks:DocumentReviewInput['checks']=[],gaps:DocumentReviewInput['coverage_gaps']=[],needs:ReviewCompletionNeed[]=[],answer_targets:EntitlementAnswerTarget[]=[];
 const purchased=input.purchased_scope.topics;
 if(!purchased.includes('working_time')&&!purchased.includes('rest_day'))throw Error('ENTITLEMENT_WORKING_TIME_UNPURCHASED');
 const prefixes=new Set<string>();
 candidates.forEach((candidate,index)=>{
  const e=workingTimeEntitlementInputSchema.parse(candidate);
  if(e.case_id!==input.case_id||canonicalSha256(e.period)!==canonicalSha256(input.period)||prefixes.has(e.check_id_prefix))throw Error('ENTITLEMENT_WORKING_TIME_SCOPE');
  prefixes.add(e.check_id_prefix);
  const resolved=resolveWorkingTimeEntitlement(e);
  const selected=resolved.checks.filter(c=>purchased.includes(c.topic));checks.push(...selected);
  const branchGaps=resolved.coverage_gaps.filter(g=>purchased.includes(g.topic));gaps.push(...branchGaps);
  for(const missing of resolved.missing){
   const topic=missing.fact_key==='wt.rest_window'?'rest_day':'working_time';if(!purchased.includes(topic))continue;
   const ids=missing.dependent_check_ids.filter(id=>!resolved.checks.some(c=>c.check_id===id&&!purchased.includes(c.topic)));
   if(!ids.length)continue;
   for(const id of ids)if(!checks.some(c=>c.check_id===id)&&!gaps.some(g=>g.check_id===id))gaps.push({check_id:id,topic,kind:'missing_fact',detail:missing.question,next_step:missing.question});
   const fact_key=`entitlement.work.${canonicalSha256({period:input.period,pins:missing.source_pins,prefix:e.check_id_prefix,path:missing.input_path}).slice(0,32)}`;
   const scalar=missing.customer_declaration_allowed&&missing.kind==='fact'&&/^workdays\.\d+\.(kind|no_work_credit|intervals\.\d+\.classification)$/u.test(missing.input_path);
   const legal=missing.kind==='applicability';
   const need:ReviewCompletionNeed={fact_key,kind:legal?'legal':'factual',reason:missing.state==='conflict'?'conflicted':missing.state==='unreadable'?'unreadable':missing.state==='missing'?'missing':'unknown',
    required_evidence_kind:scalar?'customer_declaration':'observed_reading',question:missing.question,
    answer_kind:scalar&&missing.options?.length?'choice':'text',...(scalar&&missing.options?.length?{options:[...missing.options]}:{}),
    source_pins:[...missing.source_pins],dependent_check_ids:[...ids],general_question:false};
   const prior=needs.find(n=>n.fact_key===fact_key);
   if(!prior){needs.push(need);if(scalar)answer_targets.push({fact_key,input_path:missing.input_path,branch:'working_time',index,value_kind:'text'});}
   else if(canonicalSha256(prior)!==canonicalSha256(need))throw Error('ENTITLEMENT_WORKING_QUESTION_COLLISION');
  }
 });
 if(new Set(checks.map(c=>c.check_id)).size!==checks.length)throw Error('ENTITLEMENT_WORKING_CHECK_COLLISION');
 const uniqueGaps=[...new Map(gaps.map(g=>[g.check_id,g])).values()];
 return {checks,gaps:uniqueGaps,needs,answer_targets,selections:(['working_time','rest_day'] as const).filter(t=>purchased.includes(t)).map(topic=>{
  const selected=checks.filter(c=>c.topic===topic),rule_pins=selected.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).operation).filter(o=>o.kind==='candidate_rule')
   .map(o=>({rule_id:o.rule.rule_spec_id,version:o.rule.rule_spec_version,sha256:o.rule.content_sha256}));
  return {topic,catalog_id:WORKING_TIME_CATALOG.catalog_id,catalog_version:WORKING_TIME_CATALOG.catalog_version,evidence_sha256:canonicalSha256(candidates),
   source_policy_sha256:WORKING_TIME_CATALOG.source_review_sha256,status:selected.length?'selected_for_review' as const:'missing_facts' as const,
   rule_pins:[...new Map(rule_pins.map(r=>[r.rule_id,r])).values()],generated_check_ids:selected.map(c=>c.check_id),generated_gap_ids:uniqueGaps.filter(g=>g.topic===topic).map(g=>g.check_id),
   publication_authority:false as const,authority_status:'candidate_review_not_financial_authority' as const};})};
}
