import 'server-only';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {prepareAiReleaseRuntime} from '@/engine/ai-release-runtime';
import {composeAutomaticAiReleaseAssessment} from '@/engine/ai-release-runtime/automatic-assessment';
import {applyAiReleaseDecisionRecipes} from '@/engine/ai-release-decisions';
import type {DocumentReviewInput} from '@/engine/document-review/contracts';
import type {CaseAnalysisAiReleaseContext} from '@/engine/case-analysis/service';
import {replayCaseAnalysisAiRelease,type CaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {assertAiReleaseAdmission} from '@/engine/ai-release';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {loadSavedAiReleaseConfiguration,type SavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import type {SourceJob} from './source-dispatch';

/** Preserve historical bytes but fence their present use. Admission expiry
 * includes source, interpretation, tests, reviewers and future revocations;
 * case-method decision expiry is checked separately against the same DB clock. */
export function assertSavedAiReleaseCurrent(candidate:CaseAnalysisAiRelease,profile:SavedAiReleaseConfiguration){
 const envelope=replayCaseAnalysisAiRelease(candidate),{assessment_input}=envelope.input;
 if(assessment_input.policy.sha256!==profile.configuration.policy.sha256||assessment_input.registry.sha256!==profile.configuration.registry.sha256
  ||canonicalSha256(envelope.input.trusted_generator_pins)!==canonicalSha256(profile.trusted_generator_pins)
  ||assessment_input.current.scope.authority_dependency_sha256!==profile.dependency_sha256
  ||assessment_input.current.scope.population!==profile.configuration.population
  ||assessment_input.current.evaluated_at!==profile.evaluated_at)throw Error('AI_RELEASE_CURRENT_PROFILE_MISMATCH');
 if(envelope.result.admission.state==='admitted')assertAiReleaseAdmission(envelope.result.admission.receipt,
  {...assessment_input.current,evaluated_at:profile.live_evaluated_at,expected_generated_rules:[...envelope.result.admission.receipt.expected_generated_rules]});
 const calculated=new Set(envelope.result.checks.filter(c=>c.state==='calculated').map(c=>c.check_id));
 for(const check of envelope.result.review.checks){
  if(!calculated.has(check.check_id))continue;
  const operation=check.calculation.input.operation;
  if(operation.kind!=='candidate_rule')throw Error('AI_RELEASE_CURRENT_OPERATION');
  for(const id of operation.required_decision_ids){
   const decision=operation.decisions.find(d=>d.decision_id===id);
   if(!decision||decision.state!=='accepted'||decision.valid_until&&Date.parse(decision.valid_until)<=Date.parse(profile.live_evaluated_at))throw Error('AI_RELEASE_CASE_DECISION_EXPIRED');
  }
 }
 return envelope;
}

/** Called once after the authenticated answer journal, before the immutable
 * command hash. It never imports an earlier recipe's accepted decisions. */
export function prepareSavedAiReleaseReview(source:DocumentReviewInput,profile:SavedAiReleaseConfiguration){
 return applyAiReleaseDecisionRecipes({source,methods:profile.configuration.methods??[],at:profile.evaluated_at}).source;
}

export function savedAiReleasePreparation(context:PostgresTransactionContext,job:SourceJob,profile:SavedAiReleaseConfiguration){
 return async(pins:CaseAnalysisAiReleaseContext)=>{
  const current=await loadSavedAiReleaseConfiguration(context,job);
  if(!current||current.profile_sha256!==profile.profile_sha256)throw Error('AI_RELEASE_CONFIGURATION_CHANGED');
  if(pins.previous_ai_release)assertSavedAiReleaseCurrent(pins.previous_ai_release,current);
  const source=pins.document_review_input,journal=pins.source_journal,command=pins.command;
  if(!source||!journal||journal.case_id!==job.case_id||journal.input_revision!==job.revision||journal.input_sha256!==job.input_sha256
   ||command.case_id!==job.case_id||command.document_review_sha256!==canonicalSha256(source)
   ||command.population!==profile.configuration.population||!job.authority_dependency_sha256)throw Error('AI_RELEASE_SAVED_INPUT_BINDING');
  const {configuration, trusted_generator_pins}=profile;
  const {policy,registry,source_receipts,interpretation_receipts,test_receipts}=configuration;
  const reviewer=[...registry.reviewers].sort((a,b)=>`${a.actor_id}:${a.actor_version}`.localeCompare(`${b.actor_id}:${b.actor_version}`,'en'))
   .find(r=>r.review_method_version===policy.review_method_version&&Date.parse(r.issued_at)<=Date.parse(profile.evaluated_at)
    &&Date.parse(r.expires_at)>Date.parse(current.live_evaluated_at));
  if(!reviewer)throw Error('AI_RELEASE_REVIEWER_UNAVAILABLE');
  const expires_at=new Date(Math.min(...[profile.expires_at,policy.expires_at,registry.expires_at,reviewer.expires_at].map(Date.parse))).toISOString();
  const scope={case_id:job.case_id,order_id:source.purchased_scope.order_id,order_origin:source.purchased_scope.origin,
   order_receipt_sha256:source.purchased_scope.receipt_sha256,input_revision:journal.input_revision,input_sha256:journal.input_sha256,
   period:source.period,facts_sha256:pins.facts_snapshot_sha256,population:configuration.population,authority_dependency_sha256:job.authority_dependency_sha256};
  const prepared=prepareAiReleaseRuntime({source,analysis_run_id:pins.analysis_run_id,trusted_generator_pins:[...trusted_generator_pins]});
  const source_pins=[...new Map(prepared.composed.documents.map(d=>{
   const pin={case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256};
   return [canonicalSha256(pin),pin] as const;
  })).values()];
  const automatic=composeAutomaticAiReleaseAssessment({configuration:{policy,registry,source_receipts,interpretation_receipts,test_receipts},source,prepared,trusted_generator_pins,
   current:{evaluated_at:profile.evaluated_at,environment:profile.environment,namespace:policy.namespace,is_qa:profile.is_qa,
    policy_sha256:policy.sha256,registry_sha256:registry.sha256,registry_revision:registry.revision,scope,source_pins},
   issuance:{issued_at:profile.evaluated_at,expires_at,reviewer_id:reviewer.actor_id,reviewer_version:reviewer.actor_version}});
  if(pins.previous_ai_release&&canonicalSha256(pins.previous_ai_release.input.assessment_input)!==canonicalSha256(automatic.assessment_input))throw Error('AI_RELEASE_RESUME_ASSESSMENT_CHANGED');
  return {assessment_input:automatic.assessment_input,trusted_generator_pins:[...trusted_generator_pins]};
 };
}
