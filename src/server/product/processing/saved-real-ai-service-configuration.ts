import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import type {DocumentReviewInput} from '@/engine/document-review/contracts';
import type {CaseAnalysisAiReleaseContext} from '@/engine/case-analysis/service';
import type {CaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {verifyAiReleaseConfiguration} from './ai-release-configuration';
import {savedAiEvaluationAnchor,aiEvaluationAnchorDependency} from './ai-release-evaluation-anchor';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {assertSavedAiReleaseCurrent,prepareSavedAiReleaseReview,savedAiReleasePreparation,type SavedAiReleaseExecutionProfile} from './saved-ai-release';
import {realAiServiceDecisionSchema,QUALIFIED_AI_RENDERER_ACTIONS} from '../reports/real-ai-service-admission';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const journalSchema=z.object({case_id:z.uuid(),input_revision:z.number().int().positive(),input_sha256:hash}).strict();
/** Same immutable configuration format as ordinary AI release, with an
 * explicitly different authenticated enrollment purpose. No default namespace,
 * QA coercion, owner identity or issue time is inferred by this parser. */
export const savedRealAiServiceContextSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('absent')}).strict(),
 z.object({state:z.literal('unavailable'),reason:z.enum(['disabled','forbidden','unscoped','not_enrolled','expired','revoked']),dependency_sha256:hash}).strict(),
 z.object({state:z.literal('configured'),purpose:z.literal('real_customer_service'),namespace:z.literal('real'),is_qa:z.literal(false),
  environment:z.enum(['development','preview','production','test']),identity_id:z.uuid(),source_journal:journalSchema,
  configuration:z.unknown(),configuration_sha256:hash,enrollment_id:z.uuid(),dependency_sha256:hash,
  service_decision:realAiServiceDecisionSchema,service_decision_sha256:hash,
  enrollment_issued_at:time,evaluated_at:time,expires_at:time,source_created_at:time,
  evidence:z.array(z.object({sha256:hash,content_base64:z.string().min(1).max(4_000_000)}).strict()).min(1).max(32),
  revocations:z.array(z.object({target_sha256:hash,effective_at:time}).strict()).max(1024),
 }).strict(),
]);
const issued=new WeakSet<object>();
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
function assert(condition:unknown,code:string):asserts condition{if(!condition)throw Error(code);}
function journal(job:SourceJob){return {case_id:job.case_id,input_revision:job.revision,input_sha256:job.input_sha256};}

function resolveConfiguration(candidate:unknown,job:SourceJob){
 const row=savedRealAiServiceContextSchema.parse(candidate);
 assert(row.state!=='absent','REAL_SERVICE_PROCESSING_ENROLLMENT_REQUIRED');
 assert(row.state==='configured',row.state==='unavailable'?`REAL_SERVICE_PROCESSING_${row.reason.toUpperCase()}`:'REAL_SERVICE_PROCESSING_CONTEXT_REQUIRED');
 assert(same(row.source_journal,journal(job))&&row.dependency_sha256===job.authority_dependency_sha256,'REAL_SERVICE_PROCESSING_SOURCE_SUPERSEDED');
 const build=getCompiledAiReleaseBuild(),verified=verifyAiReleaseConfiguration(row.configuration,build),config=verified.configuration,decision=row.service_decision;
 assert(config.sha256===row.configuration_sha256&&config.policy.namespace==='real'&&config.registry.namespace==='real','REAL_SERVICE_PROCESSING_CONFIGURATION_MISMATCH');
 assert(config.policy.allowed_environments.includes(row.environment),'REAL_SERVICE_PROCESSING_ENVIRONMENT_FORBIDDEN');
 assert(decision.sha256===row.service_decision_sha256&&decision.status==='active'&&decision.policy_sha256===config.policy.sha256
  &&decision.product_decision_sha256===config.policy.product_decision_sha256,'REAL_SERVICE_PROCESSING_DECISION_MISMATCH');
 assert(decision.renderer.code_sha256===build.manifest.source_graph_sha256,'REAL_SERVICE_PROCESSING_RENDERER_CHANGED');
 const live=Date.parse(row.evaluated_at),issuedAt=Date.parse(row.enrollment_issued_at),expiresAt=Date.parse(row.expires_at);
 assert(issuedAt<=live&&live<expiresAt&&issuedAt<expiresAt,'REAL_SERVICE_PROCESSING_ENROLLMENT_EXPIRED');
 for(const window of [config.policy,config.registry,decision]){
  assert(live>=Date.parse(window.issued_at)&&live<Date.parse(window.expires_at),'REAL_SERVICE_PROCESSING_CONFIGURATION_EXPIRED');
  assert(issuedAt>=Date.parse(window.issued_at)&&expiresAt<=Date.parse(window.expires_at),'REAL_SERVICE_PROCESSING_ENROLLMENT_WINDOW');
 }
 const evidence=row.evidence.map(e=>{
  const bytes=Buffer.from(e.content_base64,'base64');
  assert(bytes.toString('base64')===e.content_base64&&createHash('sha256').update(bytes).digest('hex')===e.sha256,'REAL_SERVICE_PROCESSING_EVIDENCE_BYTES_CHANGED');
  return e.sha256;
 });
 assert(new Set(evidence).size===evidence.length,'REAL_SERVICE_PROCESSING_DUPLICATE_EVIDENCE');
 const requiredEvidence=[decision.product_decision_sha256,decision.action_matrix_sha256,...Object.values(decision.evidence),...decision.action_reviews.map(r=>r.basis_sha256)];
 assert(requiredEvidence.every(sha=>evidence.includes(sha)),'REAL_SERVICE_PROCESSING_EVIDENCE_UNAVAILABLE');
 for(const action of QUALIFIED_AI_RENDERER_ACTIONS)assert(decision.action_reviews.some(r=>r.action===action),'REAL_SERVICE_PROCESSING_ACTION_NOT_ALLOWED');
 const expiries=[row.expires_at],dependencies=new Set([config.sha256,config.policy.sha256,config.registry.sha256,decision.sha256,
  decision.renderer.code_sha256,...requiredEvidence]);
 for(const action of decision.action_reviews){
  const receipt=config.interpretation_receipts.find(r=>r.sha256===action.interpretation_receipt_sha256);
  assert(receipt&&receipt.human_by_law.basis_sha256===action.basis_sha256,'REAL_SERVICE_PROCESSING_ACTION_REVIEW_BINDING');
  assert(receipt.human_by_law.state==='not_required_for_supported_branch','REAL_SERVICE_PROCESSING_ACTION_REVIEW_UNRESOLVED');
  assert(receipt.status==='accepted'&&live>=Date.parse(receipt.issued_at)&&live<Date.parse(receipt.expires_at),'REAL_SERVICE_PROCESSING_ACTION_REVIEW_UNAVAILABLE');
  assert(Date.parse(decision.issued_at)>=Date.parse(receipt.issued_at),'REAL_SERVICE_PROCESSING_DECISION_PRECEDES_REVIEW');
  expiries.push(receipt.expires_at);dependencies.add(receipt.sha256);
 }
 for(const revocation of [...row.revocations,...config.registry.revocations]){
  if(!dependencies.has(revocation.target_sha256))continue;
  assert(live<Date.parse(revocation.effective_at),'REAL_SERVICE_PROCESSING_REVOKED');expiries.push(revocation.effective_at);
 }
 const anchor=savedAiEvaluationAnchor(config,row.source_created_at,row.evaluated_at);
 assert(Date.parse(anchor.evaluated_at)<=live,'REAL_SERVICE_PROCESSING_ANCHOR_FUTURE');
 const profile=deepFreeze({...verified,purpose:row.purpose,namespace:row.namespace,identity_id:row.identity_id,source_journal:row.source_journal,
  service_decision:decision,enrollment_id:row.enrollment_id,dependency_sha256:row.dependency_sha256,...anchor,
  live_evaluated_at:row.evaluated_at,expires_at:new Date(Math.min(...expiries.map(Date.parse))).toISOString(),environment:row.environment,is_qa:row.is_qa,
  profile_sha256:canonicalSha256({schema_version:'saved-real-ai-service-profile-v1',configuration_sha256:config.sha256,enrollment_id:row.enrollment_id,
   dependency_sha256:row.dependency_sha256,identity_id:row.identity_id,source_journal:row.source_journal,service_decision_sha256:decision.sha256,
   ...aiEvaluationAnchorDependency(anchor)}),
  publication_allowed:false as const,notification_allowed:false as const} satisfies SavedAiReleaseExecutionProfile&Record<string,unknown>);
 issued.add(profile);return profile;
}
export type SavedRealAiServiceConfiguration=ReturnType<typeof resolveConfiguration>;

/** Authenticated worker RPC only. Its SQL must verify machine tenant, active
 * identity-case relation, REAL service enrollment, paid journal and current
 * source/order heads before returning this context. Missing/unavailable data
 * throws: callers must not fall through to owner, DEV or historical policy. */
export async function loadSavedRealAiServiceConfiguration(context:PostgresTransactionContext,candidate:SourceJob){
 assert(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1','REAL_SERVICE_PROCESSING_DISABLED');
 const job=sourceJobSchema.parse(candidate);
 // Retain the existing saved-source draft orchestration. The authenticated
 // purpose and namespace, not this bookkeeping mode, establish REAL scope.
 assert(job.mode==='draft','REAL_SERVICE_DRAFT_ORCHESTRATION_REQUIRED');
 assert(job.processing_profile==='qualified_ai_v1'&&job.authority_dependency_sha256,'REAL_SERVICE_PROCESSING_JOB_PROFILE_REQUIRED');
 const result=await context.client.query(statement('real_ai_service_processing_context',
  'select private.real_ai_service_processing_context($1::uuid,$2,$3) context',[job.case_id,job.revision,job.input_sha256]));
 assert(result.row_count===1,'REAL_SERVICE_PROCESSING_CONTEXT_ACK');
 return resolveConfiguration(result.rows[0]?.context,job);
}
function assertProfile(profile:SavedRealAiServiceConfiguration){assert(issued.has(profile),'REAL_SERVICE_PROCESSING_LOADER_REQUIRED');}

export function prepareSavedRealAiServiceReview(source:DocumentReviewInput,profile:SavedRealAiServiceConfiguration){
 assertProfile(profile);assert(source.case_id===profile.source_journal.case_id,'REAL_SERVICE_PROCESSING_CASE_MISMATCH');
 return prepareSavedAiReleaseReview(source,profile);
}
export function assertSavedRealAiServiceCurrent(candidate:CaseAnalysisAiRelease,profile:SavedRealAiServiceConfiguration){
 assertProfile(profile);
 const current=candidate.input.assessment_input.current;
 assert(candidate.schema_version==='case-analysis-ai-release-v1'&&current.namespace==='real'&&!current.is_qa
  &&current.environment===profile.environment&&same(candidate.binding.source_journal,profile.source_journal),'REAL_SERVICE_PROCESSING_ENVELOPE_SCOPE');
 return assertSavedAiReleaseCurrent(candidate,profile);
}
/** Same savedAiReleasePreparation, automatic assessment composer, decisions and
 * ordinary RuleSpec executor. Only the trusted loader is purpose-specific.
 * Every invocation reloads REAL authority; no previous owner/QA envelope can
 * be resumed here. Publication remains the independent service-delivery gate. */
export function savedRealAiServicePreparation(context:PostgresTransactionContext,candidate:SourceJob,profile:SavedRealAiServiceConfiguration){
 assertProfile(profile);const job=sourceJobSchema.parse(candidate);
 assert(same(journal(job),profile.source_journal)&&job.authority_dependency_sha256===profile.dependency_sha256,'REAL_SERVICE_PROCESSING_SOURCE_SUPERSEDED');
 const prepare=savedAiReleasePreparation(context,job,profile,loadSavedRealAiServiceConfiguration);
 return async(pins:CaseAnalysisAiReleaseContext)=>{
  assert(pins.command.mode==='real','REAL_SERVICE_PROCESSING_COMMAND_SCOPE');
  if(pins.previous_ai_release)assertSavedRealAiServiceCurrent(pins.previous_ai_release,profile);
  return prepare(pins);
 };
}
