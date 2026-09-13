import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {AI_RELEASE_TOPICS,aiReleaseCurrentContextSchema} from '@/engine/ai-release/contracts';
import {assertAiReleaseAdmission} from '@/engine/ai-release/policy';
import {replayCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {aiReleaseTrustedGeneratorPinSchema} from '@/engine/ai-release-runtime/contracts';
import {AI_RELEASE_REPORT_TEMPLATE} from './ai-release-report';

export const REAL_AI_SERVICE_DECISION_VERSION='tivdoc-real-ai-service-decision-v1' as const;
/** Action IDs are those in docs/real-service-release-action-matrix.md. A08–A10
 * have no permission in this version. A11 authorizes delivery of covered
 * content; it does not authorize a message, commercial charge or debt total. */
export const REAL_AI_SERVICE_ACTIONS=['A01','A02','A03','A04','A05','A06','A07','A11'] as const;
export const SOURCE_ARITHMETIC_ACTIONS=['A01','A02','A03','A04'] as const;
// The existing qualified renderer can include rule selection, scenarios and
// contract conditions. An arithmetic-only decision cannot authorize its bytes.
export const QUALIFIED_AI_RENDERER_ACTIONS=['A01','A03','A05','A06','A07','A11'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().min(1).max(200),time=z.iso.datetime({offset:true});
const action=z.enum(REAL_AI_SERVICE_ACTIONS);
const hashes=z.array(hash).min(1).max(128).refine(v=>new Set(v).size===v.length);
const topics=z.array(z.enum(AI_RELEASE_TOPICS)).min(1).max(9).refine(v=>new Set(v).size===v.length);

/** This is an immutable action-scope bridge to the EXISTING product decision
 * and human_by_law reviews, not a new law-review authority. A hash establishes
 * integrity, never who approved it. The trusted loader must authenticate the
 * active decision and make each referenced evidence artifact available. */
export const realAiServiceDecisionSchema=z.object({schema_version:z.literal(REAL_AI_SERVICE_DECISION_VERSION),
 decision_id:id,version:id,namespace:z.literal('real'),purpose:z.literal('real_customer_service'),
 status:z.enum(['proposed_not_activated','active']),policy_sha256:hash,product_decision_sha256:hash,
 human_attestation:z.null(),action_matrix_sha256:hash,
 action_reviews:z.array(z.object({action,interpretation_receipt_sha256:hash,basis_sha256:hash}).strict()).min(1).max(8),
 renderer:z.object({template:z.literal(AI_RELEASE_REPORT_TEMPLATE),code_sha256:hash}).strict(),
 evidence:z.object({operator_identity_sha256:hash,purchase_presentation_sha256:hash,support_presentation_sha256:hash,
  sample_html_sha256:hash,sample_pdf_sha256:hash}).strict(),
 issued_at:time,expires_at:time,sha256:hash,
}).strict().superRefine((v,ctx)=>{
 const {sha256,...body}=v;
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'REAL_SERVICE_DECISION_HASH'});
 if(new Set(v.action_reviews.map(r=>r.action)).size!==v.action_reviews.length)ctx.addIssue({code:'custom',message:'REAL_SERVICE_DUPLICATE_ACTION'});
 if(Date.parse(v.issued_at)>=Date.parse(v.expires_at))ctx.addIssue({code:'custom',message:'REAL_SERVICE_VALIDITY'});
});
export type RealAiServiceDecision=z.infer<typeof realAiServiceDecisionSchema>;

const artifactsSchema=z.object({case_id:id,report_id:id,analysis_run_id:id,envelope_sha256:hash,
 renderer_template:z.literal(AI_RELEASE_REPORT_TEMPLATE),renderer_code_sha256:hash,
 html_sha256:hash,pdf_sha256:hash,purchased_topics:topics,represented_topics:topics,
}).strict();
export const realAiServiceDeliveryRequestSchema=z.object({identity_id:z.uuid(),artifacts:artifactsSchema}).strict();
/** All expectations are supplied independently by an authenticated scoped
 * loader, using live DB time, current service revocations and stored artifact
 * manifests. Never construct this context from a download request/envelope.
 * Generator pins come from the verified compiled build. Evidence hashes name
 * bytes the loader actually verified, not arbitrary digests from the decision. */
export const realAiServiceCurrentContextSchema=z.object({assessment:aiReleaseCurrentContextSchema,
 identity_id:z.uuid(),service_decision_sha256:hash,artifacts:artifactsSchema,
 trusted_generator_pins:z.array(aiReleaseTrustedGeneratorPinSchema).min(1).max(9),
 available_evidence_sha256s:hashes,
 revocations:z.array(z.object({target_sha256:hash,effective_at:time}).strict()).max(1024),
}).strict();
export type RealAiServiceCurrentContext=z.infer<typeof realAiServiceCurrentContextSchema>;
export type RealAiServiceDeliveryRequest=z.infer<typeof realAiServiceDeliveryRequestSchema>;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const setSame=(a:readonly string[],b:readonly string[])=>same([...a].sort(),[...b].sort());
function assert(condition:unknown,code:string):asserts condition{if(!condition)throw Error(code);}

/** Replays the ordinary engine. This function neither renders nor publishes,
 * grants access, sends notifications, updates READY or changes the historical
 * publication gate. Call at atomic publication AND every HTML/PDF read with
 * freshly loaded expectations; never reuse its returned receipt as authority.
 * A separate source/arithmetic renderer and source-review admission remain
 * necessary before an A01–A04-only service can use this path. */
export function admitRealAiServiceDelivery(candidate:{decision:unknown;envelope:unknown;request:unknown},currentCandidate:unknown){
 const decision=realAiServiceDecisionSchema.parse(candidate.decision),current=realAiServiceCurrentContextSchema.parse(currentCandidate);
 const request=realAiServiceDeliveryRequestSchema.parse(candidate.request),live=current.assessment;
 assert(live.namespace==='real'&&!live.is_qa,'REAL_SERVICE_REAL_CONTEXT_REQUIRED');
 assert(decision.status==='active'&&decision.sha256===current.service_decision_sha256,'REAL_SERVICE_ACTIVE_DECISION_REQUIRED');
 const at=Date.parse(live.evaluated_at);
 assert(at>=Date.parse(decision.issued_at)&&at<Date.parse(decision.expires_at),'REAL_SERVICE_DECISION_EXPIRED');
 assert(request.identity_id===current.identity_id,'REAL_SERVICE_RECIPIENT_MISMATCH');
 assert(same(request.artifacts,current.artifacts),'REAL_SERVICE_ARTIFACTS_CHANGED');
 const artifacts=request.artifacts;
 assert(artifacts.case_id===live.scope.case_id,'REAL_SERVICE_CASE_MISMATCH');
 assert(decision.renderer.template===artifacts.renderer_template&&decision.renderer.code_sha256===artifacts.renderer_code_sha256,'REAL_SERVICE_RENDERER_CHANGED');
 const requiredEvidence=[decision.action_matrix_sha256,...Object.values(decision.evidence),...decision.action_reviews.map(r=>r.basis_sha256)];
 assert(requiredEvidence.every(sha=>current.available_evidence_sha256s.includes(sha)),'REAL_SERVICE_EVIDENCE_UNAVAILABLE');
 for(const required of QUALIFIED_AI_RENDERER_ACTIONS)assert(decision.action_reviews.some(r=>r.action===required),'REAL_SERVICE_ACTION_NOT_ALLOWED');
 const envelope=replayCaseAnalysisAiRelease(candidate.envelope),input=envelope.input.assessment_input;
 assert(input.policy.namespace==='real'&&input.current.namespace==='real'&&!input.current.is_qa,'REAL_SERVICE_REAL_ENVELOPE_REQUIRED');
 assert(decision.policy_sha256===input.policy.sha256&&decision.product_decision_sha256===input.policy.product_decision_sha256,'REAL_SERVICE_PRODUCT_DECISION_MISMATCH');
 assert(same(envelope.input.trusted_generator_pins,current.trusted_generator_pins),'REAL_SERVICE_BUILD_CHANGED');
 assert(envelope.sha256===artifacts.envelope_sha256&&envelope.result.analysis_run_id===artifacts.analysis_run_id
  &&envelope.result.case_id===artifacts.case_id,'REAL_SERVICE_REPORT_BINDING');
 assert(envelope.binding.source_journal.case_id===live.scope.case_id
  &&envelope.binding.source_journal.input_revision===live.scope.input_revision
  &&envelope.binding.source_journal.input_sha256===live.scope.input_sha256,'REAL_SERVICE_JOURNAL_CHANGED');
 assert(setSame(artifacts.purchased_topics,envelope.input.source.purchased_scope.topics)
  &&setSame(artifacts.represented_topics,artifacts.purchased_topics),'REAL_SERVICE_PURCHASE_COVERAGE');
 const admission=envelope.result.admission;
 assert(admission.state==='admitted','REAL_SERVICE_RUNTIME_NOT_ADMITTED');
 assertAiReleaseAdmission(admission.receipt,live);
 const expiries=[decision.expires_at,admission.receipt.expires_at];
 const dependencies=new Set([decision.sha256,decision.product_decision_sha256,decision.action_matrix_sha256,
  decision.renderer.code_sha256,...Object.values(decision.evidence),...decision.action_reviews.map(r=>r.basis_sha256)]);
 for(const review of decision.action_reviews){
  const interpretation=input.interpretation_receipts.find(r=>r.sha256===review.interpretation_receipt_sha256);
  assert(interpretation&&interpretation.human_by_law.basis_sha256===review.basis_sha256,'REAL_SERVICE_ACTION_REVIEW_BINDING');
  assert(interpretation.human_by_law.state==='not_required_for_supported_branch','REAL_SERVICE_ACTION_REVIEW_UNRESOLVED');
  // Only reuse a review that the ordinary engine actually admitted, including
  // its source, method, period, reviewer, confidence, tests and revocations.
  assert(input.policy.branches.some(b=>b.interpretation_receipt_sha256===interpretation.sha256
   &&admission.receipt.admitted_branch_ids.includes(b.branch_id)),'REAL_SERVICE_ACTION_REVIEW_NOT_ADMITTED');
  assert(Date.parse(decision.issued_at)>=Date.parse(interpretation.issued_at),'REAL_SERVICE_DECISION_PRECEDES_REVIEW');
  dependencies.add(interpretation.sha256);
 }
 // Retain the live case-decision fence from assertSavedAiReleaseCurrent;
 // historical replay alone is not evidence that a decision still applies.
 const calculated=new Set(envelope.result.checks.filter(c=>c.state==='calculated').map(c=>c.check_id));
 for(const check of envelope.result.review.checks){
  if(!calculated.has(check.check_id))continue;
  const operation=check.calculation.input.operation;
  assert(operation.kind==='candidate_rule','REAL_SERVICE_OPERATION_MISMATCH');
  for(const id of operation.required_decision_ids){
   const item=operation.decisions.find(d=>d.decision_id===id);
   assert(item?.state==='accepted','REAL_SERVICE_CASE_DECISION_NOT_ACCEPTED');
   if(item.valid_until){assert(at<Date.parse(item.valid_until),'REAL_SERVICE_CASE_DECISION_EXPIRED');expiries.push(item.valid_until);}
  }
 }
 for(const revocation of [...current.revocations,...input.registry.revocations]){
  if(!dependencies.has(revocation.target_sha256))continue;
  assert(at<Date.parse(revocation.effective_at),'REAL_SERVICE_REVOKED');
  expiries.push(revocation.effective_at);
 }
 const body={schema_version:'tivdoc-real-ai-service-delivery-admission-v1' as const,namespace:'real' as const,
  identity_id:request.identity_id,service_decision_sha256:decision.sha256,policy_sha256:input.policy.sha256,
  registry_sha256:input.registry.sha256,admission_sha256:admission.receipt.sha256,artifacts,
  allowed_actions:[...QUALIFIED_AI_RENDERER_ACTIONS],evaluated_at:live.evaluated_at,
  expires_at:new Date(Math.min(...expiries.map(Date.parse))).toISOString(),
  human_attestation:null,legal_debt_total:null,combined_amount:null,
  publication_performed:false as const,notification_allowed:false as const,commercial_charge_allowed:false as const};
 return deepFreeze({...body,sha256:canonicalSha256(body)});
}
