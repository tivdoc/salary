import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {evaluateAiReleaseAssessment,assertAiReleaseAdmission,type AiReleaseAdmission,type AiReleaseBlocker} from '../ai-release/policy.ts';
import type {AiReleaseSourcePin,AiReleaseCurrentContext} from '../ai-release/contracts.ts';
import {entitlementLegalDocuments,isPinnedEntitlementLegalDocument} from '../entitlement-review/legal-documents.ts';
import type {DocumentReviewCheckResult,DocumentReviewInput} from '../document-review/contracts.ts';
import type {RuleSpecInputValue} from '../legal-operations/rulespec.ts';
import {AI_RELEASE_RUNTIME_VERSION,aiReleaseRuntimeInputSchema,type AiReleaseRuntimeInput} from './contracts.ts';
import {prepareAiReleaseRuntime,type AiReleaseRuntimePreparation} from './generator-manifest.ts';

type Value=RuleSpecInputValue['value'];
type RuntimeBlocker={code:string;dependency_id:string|null};
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const issued=new WeakSet<object>();
const sourceMatch=(pin:AiReleaseSourcePin,source:{case_id:string;document_id:string;version_id:string;file_sha256:string})=>
 pin.case_id===source.case_id&&pin.version_id===source.version_id&&pin.source_sha256===source.file_sha256
 &&(pin.document_id===source.document_id||source.document_id===pin.version_id);

export function currentSources(prepared:AiReleaseRuntimePreparation,input:{assessment_input:{current:AiReleaseCurrentContext}}){
 const {current}=input.assessment_input,source=prepared.composed,purchase=source.purchased_scope;
 if(current.scope.case_id!==source.case_id||current.scope.order_id!==purchase.order_id||current.scope.order_origin!==purchase.origin
  ||current.scope.order_receipt_sha256!==purchase.receipt_sha256||!same(current.scope.period,source.period))throw Error('AI_RUNTIME_CURRENT_SCOPE_MISMATCH');
 const evidence=source.entitlement_evidence;
 const legal=entitlementLegalDocuments(source.case_id,['working_time','pension','travel','minimum_wage','vacation','convalescence'].filter(t=>evidence&&t in evidence));
 for(const document of source.documents){
  if(legal.some(d=>same(d,document))||isPinnedEntitlementLegalDocument(document,source.case_id))continue;
  if(!current.source_pins.some(p=>sourceMatch(p,document)))throw Error('AI_RUNTIME_CURRENT_SOURCE_MISMATCH');
 }
}

export function valueUnit(value:Value|null){return value===null?null:value.kind==='money'?'currency.'+value.currency.toLowerCase():value.kind==='boolean'?'boolean':value.unit;}
export function monetaryState(expected:Value|null,recorded:Value|null,difference:Value|null){
 if(expected?.kind!=='money')return 'nonmonetary' as const;
 if(difference?.kind!=='money'||recorded?.kind!=='money')return 'expected_only' as const;
 return difference.minor_units>0?'difference_positive' as const:difference.minor_units<0?'recorded_above_expected' as const:'difference_zero' as const;
}
export function checkCurrentDecisions(check:DocumentReviewCheckResult,at:string):RuntimeBlocker[]{
 const calculation=check.calculation,op=calculation.input.operation;
 if(op.kind!=='candidate_rule')return [{code:'AI_RUNTIME_NOT_GENERATED_ENTITLEMENT',dependency_id:check.check_id}];
 const blockers:RuntimeBlocker[]=[];
 if(op.conditional_assumptions?.length)blockers.push({code:'AI_RUNTIME_COUNTERFACTUAL_ONLY',dependency_id:check.check_id});
 for(const id of op.required_decision_ids){
  const decision=op.decisions.find(d=>d.decision_id===id);
  if(!decision||decision.state!=='accepted')blockers.push({code:'AI_RUNTIME_CASE_DECISION_NOT_ACCEPTED',dependency_id:id});
  if(decision?.valid_until&&Date.parse(decision.valid_until)<=Date.parse(at))blockers.push({code:'AI_RUNTIME_CASE_DECISION_EXPIRED',dependency_id:id});
 }
 if(calculation.state==='blocked')for(const b of calculation.blockers)blockers.push({code:b.reason,dependency_id:b.dependency_id});
 return blockers;
}

function qualifiedCheck(check:DocumentReviewCheckResult,family:AiReleaseRuntimePreparation['families'][number],
 authority:AiReleaseAdmission|null,blockers:readonly RuntimeBlocker[],at:string){
 const actualBlockers=[...blockers,...checkCurrentDecisions(check,at)];
 const calculation=check.calculation,op=calculation.input.operation;
 if(op.kind!=='candidate_rule')throw Error('AI_RUNTIME_CANDIDATE_REQUIRED');
 const allowed=authority!==null&&actualBlockers.length===0&&calculation.state==='calculated';
 const expected=allowed?calculation.expected:null,recorded=allowed?calculation.recorded:null,difference=allowed?calculation.difference:null;
 // The original calculation receipt remains untouched and retains its
 // inactive-candidate qualifier. Only this separate, admitted wrapper carries
 // the product claim, with signed comparisons and no combined debt total.
 const body={schema_version:'tivdoc-ai-qualified-check-v1' as const,case_id:calculation.input.case_id,
  analysis_run_id:calculation.input.run_id,check_id:check.check_id,topic:family.topic,family_id:family.family_id,
  title:check.title,explanation:check.explanation,period:calculation.input.period,
  state:allowed?'calculated' as const:'blocked' as const,outcome:allowed?monetaryState(expected,recorded,difference):'blocked' as const,
  blockers:actualBlockers,expected,recorded,difference,unit:valueUnit(expected),
  trace:allowed?calculation.execution:null,rule_sha256:op.rule.content_sha256,rule_id:op.rule.rule_spec_id,rule_version:op.rule.rule_spec_version,
  source_manifest:calculation.input.source_manifest,source_operands:calculation.input.operands,
  input_basis:calculation.input_basis,remittance_status:calculation.remittance_status,
  candidate_receipt_sha256:canonicalSha256(calculation),candidate_dependency_sha256:check.dependency_sha256,
  family_rule_manifest_sha256:family.expected?.rule_sha256??null,family_parameter_manifest_sha256:family.expected?.parameter_set_sha256??null,
  admission_dependency_sha256:allowed?authority.dependency_sha256:null,claim_kind:'qualified_ai_report' as const,
  human_attestation:null,verified_debt:false as const,actual_transfer_proven:false as const};
 return deepFreeze({...body,sha256:canonicalSha256(body)});
}

/** Existing ordinary composer → RuleSpec executor → source-bound qualified
 * result. A supplied current.expected_generated_rules array is never used as
 * evidence: exact family rules/facts/decisions are recomputed here. */
export function runAiReleaseRuntime(candidate:AiReleaseRuntimeInput){
 const input=aiReleaseRuntimeInputSchema.parse(candidate);
 const prepared=prepareAiReleaseRuntime({source:input.source,analysis_run_id:input.analysis_run_id,trusted_generator_pins:input.trusted_generator_pins});
 currentSources(prepared,input);
 const current={...input.assessment_input.current,expected_generated_rules:prepared.expected_generated_rules.map(r=>({...r}))};
 const admission=evaluateAiReleaseAssessment({...input.assessment_input,current});
 const authority=admission.state==='admitted'?admission.receipt:null;
 if(authority)assertAiReleaseAdmission(authority,current);
 const families=prepared.families.map(family=>{
  const decision=admission.branches.find(b=>b.branch_id===family.branch_id),policy=input.assessment_input.policy.branches.find(b=>b.branch_id===family.branch_id);
  const blockers:RuntimeBlocker[]=[...admission.blockers,...(decision?.blockers??[])];
  const add=(code:string,dependency_id:string|null=family.family_id)=>blockers.push({code,dependency_id});
  if(!family.selected)add('AI_RUNTIME_NO_SOURCE_SELECTION');
  if(!family.generator)add('AI_RUNTIME_COMPILED_GENERATOR_PIN_MISSING');
  if(!policy||policy.topic!==family.topic||!('generator' in policy)||!family.generator||!same(policy.generator,family.generator))add('AI_RUNTIME_POLICY_GENERATOR_REQUIRED');
  if(!decision||decision.state!=='admitted')add('AI_RUNTIME_FAMILY_NOT_ADMITTED');
  if(!family.candidate_check_ids.length&&!family.nonmonetary_outcomes.length)add('AI_RUNTIME_NO_GENERATED_OUTCOME');
  const checks=prepared.review.checks.filter(c=>family.candidate_check_ids.includes(c.check_id));
  // Policy sources must actually cover every legal document used by this
  // generated rule. A tested but unrelated source receipt cannot authorize it.
  const allowedSources=policy?input.assessment_input.source_receipts.filter(r=>policy.source_receipt_sha256s.includes(r.sha256)):[];
  for(const check of checks)for(const source of check.calculation.input.source_manifest.filter(s=>s.kind==='legal_source')){
   if(!allowedSources.some(r=>r.source_version_id===source.version_id&&r.artifact_sha256===source.file_sha256))add('AI_RUNTIME_RULE_LEGAL_SOURCE_NOT_REVIEWED',source.version_id);
  }
  const qualified=checks.map(check=>qualifiedCheck(check,family,authority,blockers,current.evaluated_at));
  const nonmonetary=family.nonmonetary_outcomes.map(outcome=>{
   const reasons=[...blockers];
   if(outcome.source_pins.some(p=>!current.source_pins.some(c=>same(c,p))))reasons.push({code:'AI_RUNTIME_NONMONETARY_SOURCE_MISMATCH',dependency_id:outcome.obligation_id});
   const body={schema_version:'tivdoc-ai-qualified-nonmonetary-v1' as const,case_id:prepared.composed.case_id,analysis_run_id:input.analysis_run_id,
    family_id:family.family_id,topic:family.topic,state:reasons.length?'blocked' as const:'condition_not_fulfilled' as const,blockers:reasons,
    source_outcome:outcome,amount:null,claim_kind:'qualified_ai_report' as const,human_attestation:null,verified_debt:false as const,
    admission_dependency_sha256:reasons.length?null:authority?.dependency_sha256??null};
   return deepFreeze({...body,sha256:canonicalSha256(body)});
  });
  const calculated=qualified.filter(c=>c.state==='calculated').length+nonmonetary.filter(o=>o.state!=='blocked').length;
  return {family_id:family.family_id,branch_id:family.branch_id,topic:family.topic,
   state:calculated===0?'blocked' as const:qualified.some(c=>c.state==='blocked')||nonmonetary.some(o=>o.state==='blocked')||family.coverage_gaps.length?'partial' as const:'qualified' as const,
   blockers,rule_manifest:family.rule_manifest,parameter_manifest:family.parameter_manifest,source_manifest:family.source_manifest,
   expected_generated_rule:family.expected,checks:qualified,nonmonetary_outcomes:nonmonetary,coverage_gaps:family.coverage_gaps};
 });
 const checks=families.flatMap(f=>f.checks),nonmonetary=families.flatMap(f=>f.nonmonetary_outcomes);
 const findings=checks.filter(c=>c.state==='calculated'&&c.expected?.kind==='money');
 const body={schema_version:AI_RELEASE_RUNTIME_VERSION,case_id:prepared.composed.case_id,analysis_run_id:input.analysis_run_id,
  source_input_sha256:prepared.source_input_sha256,composed_input_sha256:prepared.composed_input_sha256,review:prepared.review,
  current_scope:current.scope,admission,families,checks,findings,nonmonetary_outcomes:nonmonetary,
  purchased_scope:prepared.composed.purchased_scope,
  state:families.every(f=>f.state==='blocked')?'blocked' as const:families.some(f=>f.state!=='qualified')?'partial' as const:'qualified' as const,
  supplemental_check_ids:prepared.review.checks.filter(c=>!checks.some(q=>q.check_id===c.check_id)).map(c=>c.check_id),
  claim_kind:'qualified_ai_report' as const,human_attestation:null,verified_debt:false as const,
  legal_debt_total:null,combined_amount:null,actual_transfer_proven:false as const,publication_performed:false as const};
 const result=deepFreeze({...body,sha256:canonicalSha256(body)});issued.add(result);return result;
}
export type AiReleaseRuntimeResult=ReturnType<typeof runAiReleaseRuntime>;
export function assertAiReleaseRuntimeResult(value:AiReleaseRuntimeResult){if(!issued.has(value))throw Error('AI_RUNTIME_FACTORY_RESULT_REQUIRED');}
export function replayAiReleaseRuntime(value:unknown,input:AiReleaseRuntimeInput){
 const replay=runAiReleaseRuntime(input);if(!same(value,replay))throw Error('AI_RUNTIME_REPLAY_MISMATCH');return replay;
}
export type {AiReleaseBlocker,DocumentReviewInput};
