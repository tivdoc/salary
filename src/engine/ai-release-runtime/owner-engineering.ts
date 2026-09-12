import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {ownerEngineeringAssessmentInputSchema} from '../ai-release/contracts.ts';
import {evaluateOwnerEngineeringAssessment,assertOwnerEngineeringAdmission} from '../ai-release/policy.ts';
import {aiReleaseRuntimeInputSchema} from './contracts.ts';
import {prepareAiReleaseRuntime} from './generator-manifest.ts';
import {currentSources,checkCurrentDecisions,valueUnit,monetaryState} from './runtime.ts';

export const OWNER_ENGINEERING_RUNTIME_VERSION='tivdoc-owner-engineering-runtime-v1' as const;
export const ownerEngineeringRuntimeInputSchema=aiReleaseRuntimeInputSchema.extend({assessment_input:ownerEngineeringAssessmentInputSchema});
export type OwnerEngineeringRuntimeInput=z.infer<typeof ownerEngineeringRuntimeInputSchema>;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const issued=new WeakSet<object>();
const qualifications={claim_kind:'owner_engineering_review' as const,human_attestation:null,verified_debt:false as const,
 actual_transfer_proven:false as const,release_authorized:false as const,publication_allowed:false as const,notification_allowed:false as const};

/** Same ordinary composer, generated RuleSpecs and executor. This projection
 * never changes a candidate or law review into a qualified service result. */
export function runOwnerEngineeringRuntime(candidate:OwnerEngineeringRuntimeInput){
 const input=ownerEngineeringRuntimeInputSchema.parse(candidate);
 const prepared=prepareAiReleaseRuntime({source:input.source,analysis_run_id:input.analysis_run_id,trusted_generator_pins:input.trusted_generator_pins});
 currentSources(prepared,input);
 const current={...input.assessment_input.current,expected_generated_rules:prepared.expected_generated_rules.map(r=>({...r}))};
 const admission=evaluateOwnerEngineeringAssessment({...input.assessment_input,current});
 const authority=admission.state==='admitted'?admission.receipt:null;
 if(authority)assertOwnerEngineeringAdmission(authority,current);
 const families=prepared.families.map(family=>{
  const decision=admission.branches.find(b=>b.branch_id===family.branch_id),policy=input.assessment_input.policy.branches.find(b=>b.branch_id===family.branch_id);
  const blockers=[...admission.blockers,...(decision?.blockers??[])];
  const add=(code:string,dependency_id:string|null=family.family_id)=>blockers.push({code,dependency_id});
  if(!family.selected)add('AI_RUNTIME_NO_SOURCE_SELECTION');
  if(!family.generator)add('AI_RUNTIME_COMPILED_GENERATOR_PIN_MISSING');
  if(!policy||policy.topic!==family.topic||!('generator' in policy)||!family.generator||!same(policy.generator,family.generator))add('AI_RUNTIME_POLICY_GENERATOR_REQUIRED');
  if(!decision||decision.state!=='admitted')add('AI_RUNTIME_FAMILY_NOT_ADMITTED');
  if(!family.candidate_check_ids.length&&!family.nonmonetary_outcomes.length)add('AI_RUNTIME_NO_GENERATED_OUTCOME');
  const checks=prepared.review.checks.filter(c=>family.candidate_check_ids.includes(c.check_id));
  const allowedSources=policy?input.assessment_input.source_receipts.filter(r=>policy.source_receipt_sha256s.includes(r.sha256)):[];
  for(const check of checks)for(const source of check.calculation.input.source_manifest.filter(s=>s.kind==='legal_source')){
   if(!allowedSources.some(r=>r.source_version_id===source.version_id&&r.artifact_sha256===source.file_sha256))add('AI_RUNTIME_RULE_LEGAL_SOURCE_NOT_REVIEWED',source.version_id);
  }
  const interpretation=policy?input.assessment_input.interpretation_receipts.find(r=>r.sha256===policy.interpretation_receipt_sha256):undefined;
  const human_law_review=interpretation?{interpretation_receipt_sha256:interpretation.sha256,human_by_law:interpretation.human_by_law}:null;
  const engineeringChecks=checks.map(check=>{
   const calculation=check.calculation,op=calculation.input.operation;
   if(op.kind!=='candidate_rule')throw Error('AI_RUNTIME_CANDIDATE_REQUIRED');
   const actualBlockers=[...blockers,...checkCurrentDecisions(check,current.evaluated_at)];
   const allowed=authority!==null&&actualBlockers.length===0&&calculation.state==='calculated';
   const expected=allowed?calculation.expected:null,recorded=allowed?calculation.recorded:null,difference=allowed?calculation.difference:null;
   const body={schema_version:'tivdoc-owner-engineering-check-v1' as const,...qualifications,case_id:calculation.input.case_id,
    analysis_run_id:calculation.input.run_id,check_id:check.check_id,topic:family.topic,family_id:family.family_id,
    title:check.title,explanation:check.explanation,period:calculation.input.period,state:allowed?'calculated' as const:'blocked' as const,
    outcome:allowed?monetaryState(expected,recorded,difference):'blocked' as const,blockers:actualBlockers,expected,recorded,difference,unit:valueUnit(expected),
    trace:allowed?calculation.execution:null,rule_sha256:op.rule.content_sha256,rule_id:op.rule.rule_spec_id,rule_version:op.rule.rule_spec_version,
    source_manifest:calculation.input.source_manifest,source_operands:calculation.input.operands,input_basis:calculation.input_basis,remittance_status:calculation.remittance_status,
    candidate_receipt_sha256:canonicalSha256(calculation),candidate_dependency_sha256:check.dependency_sha256,
    engineering_dependency_sha256:allowed?authority.dependency_sha256:null,human_law_review};
   return deepFreeze({...body,sha256:canonicalSha256(body)});
  });
  const nonmonetary=family.nonmonetary_outcomes.map(outcome=>{
   const reasons=[...blockers];
   if(outcome.source_pins.some(p=>!current.source_pins.some(c=>same(c,p))))reasons.push({code:'AI_RUNTIME_NONMONETARY_SOURCE_MISMATCH',dependency_id:outcome.obligation_id});
   const body={schema_version:'tivdoc-owner-engineering-nonmonetary-v1' as const,...qualifications,case_id:prepared.composed.case_id,
    analysis_run_id:input.analysis_run_id,family_id:family.family_id,topic:family.topic,
    state:reasons.length?'blocked' as const:'condition_not_fulfilled' as const,blockers:reasons,source_outcome:outcome,amount:null,human_law_review,
    engineering_dependency_sha256:reasons.length?null:authority?.dependency_sha256??null};
   return deepFreeze({...body,sha256:canonicalSha256(body)});
  });
  const calculated=engineeringChecks.filter(c=>c.state==='calculated').length+nonmonetary.filter(o=>o.state!=='blocked').length;
  return {family_id:family.family_id,branch_id:family.branch_id,topic:family.topic,
   state:calculated===0?'blocked' as const:engineeringChecks.some(c=>c.state==='blocked')||nonmonetary.some(o=>o.state==='blocked')||family.coverage_gaps.length?'partial' as const:'engineering_ready' as const,
   blockers,checks:engineeringChecks,nonmonetary_outcomes:nonmonetary,human_law_review,coverage_gaps:family.coverage_gaps,
   rule_manifest:family.rule_manifest,parameter_manifest:family.parameter_manifest,source_manifest:family.source_manifest,expected_generated_rule:family.expected};
 });
 const checks=families.flatMap(f=>f.checks),nonmonetary=families.flatMap(f=>f.nonmonetary_outcomes);
 const body={schema_version:OWNER_ENGINEERING_RUNTIME_VERSION,...qualifications,case_id:prepared.composed.case_id,analysis_run_id:input.analysis_run_id,
  owner_scope:current.owner_scope,current_scope:current.scope,source_input_sha256:prepared.source_input_sha256,composed_input_sha256:prepared.composed_input_sha256,
  review:prepared.review,admission,families,checks,findings:checks.filter(c=>c.state==='calculated'&&c.expected?.kind==='money'),nonmonetary_outcomes:nonmonetary,
  purchased_scope:prepared.composed.purchased_scope,state:families.every(f=>f.state==='blocked')?'blocked' as const:families.some(f=>f.state!=='engineering_ready')?'partial' as const:'engineering_ready' as const,
  legal_debt_total:null,combined_amount:null,publication_performed:false as const};
 const result=deepFreeze({...body,sha256:canonicalSha256(body)});issued.add(result);return result;
}
export type OwnerEngineeringRuntimeResult=ReturnType<typeof runOwnerEngineeringRuntime>;
export function assertOwnerEngineeringRuntimeResult(value:OwnerEngineeringRuntimeResult){if(!issued.has(value))throw Error('OWNER_ENGINEERING_FACTORY_RESULT_REQUIRED');}
export function replayOwnerEngineeringRuntime(value:unknown,input:OwnerEngineeringRuntimeInput){
 const replay=runOwnerEngineeringRuntime(input);if(!same(value,replay))throw Error('OWNER_ENGINEERING_REPLAY_MISMATCH');return replay;
}
