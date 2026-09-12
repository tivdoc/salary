import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {verifyOwnerEngineeringConfiguration} from './ai-release-configuration';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {savedAiEvaluationAnchor,aiEvaluationAnchorDependency} from './ai-release-evaluation-anchor';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
export const savedOwnerEngineeringContextSchema=z.object({state:z.literal('configured'),configuration:z.unknown(),configuration_sha256:hash,
 enrollment_id:z.uuid(),dependency_sha256:hash,evaluated_at:time,expires_at:time,source_created_at:time,is_qa:z.literal(true),
 environment:z.literal('development'),owner_identity_id:z.uuid()}).strict();
/** Only authenticated SQL may supply this context. A caller's purpose or owner
 * ID is not authority; the immutable enrollment binds both before this read. */
export function resolveSavedOwnerEngineeringProfile(candidate:unknown){
 const context=savedOwnerEngineeringContextSchema.parse(candidate);
 const verified=verifyOwnerEngineeringConfiguration(context.configuration,getCompiledAiReleaseBuild()),configuration=verified.configuration;
 const owner=configuration.policy.owner_scope,live=Date.parse(context.evaluated_at);
 if(configuration.sha256!==context.configuration_sha256||owner.identity_id!==context.owner_identity_id
  ||owner.enrollment_id!==context.enrollment_id)throw Error('OWNER_ENGINEERING_ENROLLMENT_SCOPE');
 if(live>=Date.parse(context.expires_at)||[configuration.policy,configuration.registry].some(w=>live<Date.parse(w.issued_at)||live>=Date.parse(w.expires_at)))
  throw Error('OWNER_ENGINEERING_ENROLLMENT_EXPIRED');
 const anchor=savedAiEvaluationAnchor(configuration,context.source_created_at,context.evaluated_at),{evaluated_at}=anchor;
 if(Date.parse(evaluated_at)>live)throw Error('OWNER_ENGINEERING_ANCHOR_FUTURE');
 return {...verified,enrollment_id:context.enrollment_id,dependency_sha256:context.dependency_sha256,...anchor,live_evaluated_at:context.evaluated_at,
  expires_at:context.expires_at,environment:context.environment,is_qa:context.is_qa,owner_scope:owner,
  profile_sha256:canonicalSha256({schema_version:'saved-owner-engineering-profile-v1',configuration_sha256:configuration.sha256,
   enrollment_id:context.enrollment_id,dependency_sha256:context.dependency_sha256,owner_scope:owner,...aiEvaluationAnchorDependency(anchor)})};
}
export async function loadSavedOwnerEngineeringConfiguration(context:PostgresTransactionContext,candidate:SourceJob){
 const job=sourceJobSchema.parse(candidate);
 if(process.env.TIVDOC_AI_RELEASE_ENABLED!=='1')return null;
 if(job.mode!=='draft')throw Error('OWNER_ENGINEERING_DEV_DRAFT_REQUIRED');
 const result=await context.client.query(statement('owner_engineering_configuration_read',
  'select private.ai_release_context_read($1::uuid,$2,$3) context',[job.case_id,job.revision,job.input_sha256]));
 if(result.row_count!==1)throw Error('OWNER_ENGINEERING_CONFIGURATION_REQUIRED');
 const tag=z.object({state:z.string(),configuration:z.object({schema_version:z.string()}).passthrough().optional()}).passthrough().parse(result.rows[0].context);
 // Absent, expired and qualified contexts go to the existing strict loader,
 // which preserves its refusal behavior. No fallback after an owner mismatch.
 if(tag.state!=='configured'||tag.configuration?.schema_version!=='tivdoc-owner-engineering-configuration-v1')return null;
 const profile=resolveSavedOwnerEngineeringProfile(result.rows[0].context);
 if(job.processing_profile!=='qualified_ai_v1'||job.authority_dependency_sha256!==profile.dependency_sha256
  ||profile.owner_scope.case_id!==job.case_id)throw Error('OWNER_ENGINEERING_JOB_SCOPE');
 return profile;
}
export type SavedOwnerEngineeringConfiguration=ReturnType<typeof resolveSavedOwnerEngineeringProfile>;
