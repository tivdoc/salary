import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {verifyAiReleaseConfiguration} from './ai-release-configuration';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {savedAiEvaluationAnchor,aiEvaluationAnchorDependency} from './ai-release-evaluation-anchor';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const stateSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('absent')}).strict(),
 z.object({state:z.literal('unavailable'),reason:z.enum(['revoked','expired']),dependency_sha256:hash}).strict(),
 z.object({state:z.literal('configured'),configuration:z.unknown(),configuration_sha256:hash,enrollment_id:z.uuid(),
  dependency_sha256:hash,evaluated_at:time,expires_at:time,source_created_at:time,is_qa:z.literal(true),environment:z.literal('development')}).strict(),
]);
/** Enabled explicitly by the managed DEV host. An absent grant retains the
 * historical review profile; a revoked/expired grant must never fall back to a
 * less restrictive profile or renew itself by starting a worker. */
export async function loadSavedAiReleaseConfiguration(context:PostgresTransactionContext,candidate:SourceJob){
 const job=sourceJobSchema.parse(candidate);
 if(process.env.TIVDOC_AI_RELEASE_ENABLED!=='1'){
  if(job.processing_profile==='qualified_ai_v1')throw Error('AI_RELEASE_DISABLED');
  return null;
 }
 if(job.mode!=='draft')throw Error('AI_RELEASE_DEV_DRAFT_REQUIRED');
 const result=await context.client.query(statement('ai_release_configuration_read',
  'select private.ai_release_context_read($1::uuid,$2,$3) context',[job.case_id,job.revision,job.input_sha256]));
 if(result.row_count!==1)throw Error('AI_RELEASE_CONFIGURATION_REQUIRED');
 const state=stateSchema.parse(result.rows[0].context);
 if(state.state==='absent'){if(job.processing_profile)throw Error('AI_RELEASE_ENROLLMENT_REQUIRED');return null;}
 if(job.processing_profile!=='qualified_ai_v1')throw Error('AI_RELEASE_JOB_PROFILE_REQUIRED');
 if(state.dependency_sha256!==job.authority_dependency_sha256)throw Error('ANALYSIS_AUTHORITY_SUPERSEDED');
 if(state.state==='unavailable')throw Error(state.reason==='expired'?'AI_RELEASE_ENROLLMENT_EXPIRED':'AI_RELEASE_ENROLLMENT_REVOKED');
 const verified=verifyAiReleaseConfiguration(state.configuration,getCompiledAiReleaseBuild()),config=verified.configuration;
 if(config.sha256!==state.configuration_sha256)throw Error('AI_RELEASE_CONFIGURATION_HASH');
 const at=Date.parse(state.evaluated_at);
 for(const window of [config.policy,config.registry]){
  if(at<Date.parse(window.issued_at)||at>=Date.parse(window.expires_at))throw Error('AI_RELEASE_CONFIGURATION_EXPIRED');
 }
 const anchor=savedAiEvaluationAnchor(config,state.source_created_at,state.evaluated_at),{evaluated_at}=anchor;
 if(Date.parse(evaluated_at)>at)throw Error('AI_RELEASE_EVALUATION_ANCHOR_FUTURE');
 return {...verified,enrollment_id:state.enrollment_id,dependency_sha256:state.dependency_sha256,
  ...anchor,live_evaluated_at:state.evaluated_at,expires_at:state.expires_at,
  profile_sha256:canonicalSha256({schema_version:'saved-ai-release-profile-v1',configuration_sha256:config.sha256,enrollment_id:state.enrollment_id,dependency_sha256:state.dependency_sha256,...aiEvaluationAnchorDependency(anchor)}),
  environment:state.environment,is_qa:state.is_qa};
}
export type SavedAiReleaseConfiguration=NonNullable<Awaited<ReturnType<typeof loadSavedAiReleaseConfiguration>>>;
