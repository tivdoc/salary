import {resolveSavedOwnerEngineeringProfile,savedOwnerEngineeringContextSchema} from '../processing/saved-owner-engineering-configuration';
import {assertSavedOwnerEngineeringCurrent} from '../processing/saved-owner-engineering';
import {replayCaseAnalysisOwnerEngineering,assertCaseAnalysisOwnerEngineeringScope} from '@/engine/case-analysis/contracts';
import 'server-only';
import {z} from 'zod';
import {decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {WAVE3_TOPICS} from '@/engine/wave3/contracts';
import {replayCaseAnalysisAiRelease,assertCaseAnalysisAiReleaseScope} from '@/engine/case-analysis/contracts';
import {verifyAiReleaseConfiguration} from '../processing/ai-release-configuration';
import {getCompiledAiReleaseBuild} from '../processing/ai-release-build';
import {assertSavedAiReleaseCurrent} from '../processing/saved-ai-release';
import type {SavedAiReleaseConfiguration} from '../processing/saved-ai-release-configuration';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const qualifiedContext=z.discriminatedUnion('state',[
 z.object({state:z.literal('absent')}).strict(),
 z.object({state:z.literal('unavailable'),reason:z.enum(['revoked','expired']),dependency_sha256:hash}).strict(),
 z.object({state:z.literal('configured'),configuration:z.unknown(),configuration_sha256:hash,enrollment_id:z.uuid(),
  dependency_sha256:hash,evaluated_at:time,expires_at:time,source_created_at:time,is_qa:z.literal(true),environment:z.literal('development')}).strict(),
]);
const aiContext=z.union([qualifiedContext,savedOwnerEngineeringContextSchema]);
function contextAvailable(context:z.infer<typeof aiContext>|null|undefined){
 if(context==null)return true;
 if(context.state==='configured'&&'owner_identity_id' in context){try{resolveSavedOwnerEngineeringProfile(context);return true;}catch{return false;}}
 return currentAiProfile(context)!==null;
}
/** The owner-scoped RPC supplies these pins and the live database clock.
 * This reader has no environment switch or client-provided authority input. */
function currentAiProfile(context:z.infer<typeof aiContext>|null|undefined):SavedAiReleaseConfiguration|null{
 if(context?.state!=='configured')return null;
 try{
  const verified=verifyAiReleaseConfiguration(context.configuration,getCompiledAiReleaseBuild()),configuration=verified.configuration;
  if(configuration.sha256!==context.configuration_sha256)return null;
  const live=Date.parse(context.evaluated_at);
  const windows=[configuration.policy,configuration.registry];
  if(live>=Date.parse(context.expires_at)||windows.some(w=>live<Date.parse(w.issued_at)||live>=Date.parse(w.expires_at)))return null;
  // A configuration can cover several independent families. Only SQL's saved
  // admission/currentness receipt and the artifact replay below know which
  // source reviews, tests, reviewers and methods this report actually consumed.
  // Do not let an unrelated expired/revoked family invalidate a partial report.
  const evaluated_at=new Date(Math.max(Date.parse(context.source_created_at),Date.parse(configuration.policy.issued_at),Date.parse(configuration.registry.issued_at))).toISOString();
  if(Date.parse(evaluated_at)>live)return null;
  return {...verified,enrollment_id:context.enrollment_id,dependency_sha256:context.dependency_sha256,evaluated_at,
   live_evaluated_at:context.evaluated_at,expires_at:context.expires_at,environment:context.environment,is_qa:context.is_qa,
   profile_sha256:canonicalSha256({schema_version:'saved-ai-release-profile-v1',configuration_sha256:configuration.sha256,
    enrollment_id:context.enrollment_id,dependency_sha256:context.dependency_sha256})};
 }catch{
  // Invalid/mismatched compiled authority is unavailable, never a fallback to
  // the historical authority profile. Artifact corruption is checked outside.
  return null;
 }
}
const summary=z.object({report_id:z.uuid(),analysis_run_id:z.uuid(),period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),
 report_revision:z.number().int().positive(),current:z.boolean(),created_at:z.string(),purchased_topics:z.array(z.string()).min(1),
 ai_context:aiContext.nullable().optional()}).strict();
/** Protected owner drafts; SQL additionally restricts these to the isolated
 * QA database. No publication projection or customer notification is created. */
export async function privateDocumentReviewReports(caseId:string,identityId:string,db?:CaseAccessDb){
 z.uuid().parse(caseId);z.uuid().parse(identityId);
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('PRIVATE_REVIEW_STORE');
 const rows=await store.rpc<{value:unknown}>('case_report_private_review_list',{target_case:caseId,target_identity:identityId});
 if(rows.length!==1)throw Error('PRIVATE_REVIEW_LIST_ACK');
 return z.array(summary).max(100).parse(rows[0].value).map(({ai_context,...item})=>({
  ...item,current:item.current&&contextAvailable(ai_context),
 }));
}
export async function privateDocumentReviewArtifact(caseId:string,identityId:string,reportId:string,db?:CaseAccessDb){
 [caseId,identityId,reportId].forEach(value=>z.uuid().parse(value));
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('PRIVATE_REVIEW_STORE');
 const rows=await store.rpc<{value:unknown}>('case_report_private_review_artifact',{target_case:caseId,target_identity:identityId,target_report:reportId});
 if(rows.length===0||rows.length===1&&rows[0].value===null)return null;
 if(rows.length!==1)throw Error('PRIVATE_REVIEW_ACK');
 const row=z.object({current:z.boolean(),completion:z.object({bundle:z.unknown(),report:z.unknown()}).passthrough(),ai_context:aiContext.nullable().optional()}).strict().parse(rows[0].value);
 const topics=z.object({topic_results:z.array(z.object({topic:z.enum(WAVE3_TOPICS)}))}).parse(row.completion.bundle).topic_results.map(t=>t.topic);
 const bundle=decodeBundle(row.completion.bundle,topics),report=decodeReport(row.completion.report);
 const presentation=z.object({schema_version:z.literal('document-review-presentation-v1'),report_id:z.uuid(),analysis_run_id:z.uuid(),
  analysis_result_sha256:z.string(),report_revision:z.number().int()}).passthrough().parse(JSON.parse(Buffer.from(report.json).toString('utf8')));
 if(!bundle.document_review||bundle.case_id!==caseId||report.report_id!==reportId||report.analysis_result_sha256!==bundle.result_sha256
  ||presentation.report_id!==reportId||presentation.analysis_run_id!==bundle.analysis_run_id||presentation.analysis_result_sha256!==bundle.result_sha256
  ||presentation.report_revision!==report.report_revision||canonicalSha256(bundle.document_review.input)!==bundle.document_review.input_sha256)throw Error('PRIVATE_REVIEW_BINDING');
 let current=row.current;
 if(bundle.owner_engineering){
  const envelope=replayCaseAnalysisOwnerEngineering(bundle.owner_engineering);assertCaseAnalysisOwnerEngineeringScope(envelope,bundle);
  if(envelope.result.owner_scope.case_id!==caseId||envelope.result.owner_scope.identity_id!==identityId)throw Error('PRIVATE_REVIEW_OWNER_SCOPE');
  const parsed=savedOwnerEngineeringContextSchema.safeParse(row.ai_context);
  if(!parsed.success)current=false;
  else{
   // Corrupt historical bytes fail replay above; a revoked/expired/current-build
   // mismatch preserves history with current=false, never financial publication.
   try{assertSavedOwnerEngineeringCurrent(envelope,resolveSavedOwnerEngineeringProfile(parsed.data));}catch{current=false;}
  }
 }else if(bundle.ai_release){
  const envelope=replayCaseAnalysisAiRelease(bundle.ai_release);
  assertCaseAnalysisAiReleaseScope(envelope,bundle);
  const profile=currentAiProfile(row.ai_context);
  if(!profile)current=false;
  else try{assertSavedAiReleaseCurrent(envelope,profile);}catch(error){
   if(!(error instanceof Error)||!['AI_RELEASE_CURRENT_PROFILE_MISMATCH','AI_RELEASE_ADMISSION_EXPIRED','AI_RELEASE_CASE_DECISION_EXPIRED','AI_RELEASE_CURRENT_ADMISSION_MISMATCH'].includes(error.message))throw error;
   current=false;
  }
 }else if(row.ai_context!=null){
  // Context on a non-AI bundle is not authority to relabel a legacy artifact.
  throw Error('PRIVATE_REVIEW_AI_BINDING');
 }
 return {bundle,report,current};
}
