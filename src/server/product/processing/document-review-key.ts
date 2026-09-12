import type {SavedOwnerEngineeringConfiguration} from './saved-owner-engineering-configuration';
import {prepareSavedOwnerEngineeringReview} from './saved-owner-engineering';
import {OWNER_ENGINEERING_REPORT_TEMPLATE} from '../reports/owner-engineering-report';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_REVIEW_POLICY} from '@/engine/document-review/contracts';
import {DOCUMENT_REVIEW_RENDER_POLICY,type DocumentReviewRenderPolicy} from '../reports/document-review-render-policy';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import type {SavedExecutionOrder} from './saved-order-scope';
import {SavedCaseSnapshot} from './saved-snapshot';
import {savedDocumentReviewInput,savedDocumentReviewSourceScope} from './saved-document-review';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import {prepareSavedAiReleaseReview} from './saved-ai-release';
import type {SavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import {AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';

/** Configuration and report policy are execution dependencies, independent of
 * the source revision. Never derive this identity from caller-supplied facts. */
export function savedAiReleaseBaseKey(job:SourceJob,orderId:string,month:string,profile:SavedAiReleaseConfiguration|SavedOwnerEngineeringConfiguration){
 z.string().regex(/^[a-f0-9]{64}$/u).parse(profile.profile_sha256);
 return canonicalSha256({base:savedMonthIdempotencyKey(job,orderId,month),ai_profile:profile.profile_sha256,template:'owner_scope' in profile?OWNER_ENGINEERING_REPORT_TEMPLATE:AI_RELEASE_REPORT_TEMPLATE});
}

/** A source review can be appended after a normalized extraction. Its immutable
 * input hash is therefore an execution dependency in addition to the source job.
 * Never reuse the pre-review key for a newly composed review result. */
export function documentReviewIdempotencyKey(baseKey:string,reviewSha256:string,renderPolicy:DocumentReviewRenderPolicy=DOCUMENT_REVIEW_RENDER_POLICY){
 z.string().min(1).parse(baseKey);z.string().regex(/^[a-f0-9]{64}$/u).parse(reviewSha256);
 z.enum(['individual-v1',DOCUMENT_REVIEW_RENDER_POLICY]).parse(renderPolicy);
 const identity={baseKey,policy:DOCUMENT_REVIEW_POLICY,review_sha256:reviewSha256};
 return `review:${canonicalSha256(renderPolicy==='individual-v1'?identity:{...identity,render_policy:renderPolicy})}`;
}

/** Use the same authenticated snapshot/receipt adapters as saved analysis.
 * This only resolves current inputs; it neither calculates nor publishes. */
export async function resolveSavedDocumentReviewKey(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string,baseKey:string,options?:{aiProfile?:SavedAiReleaseConfiguration;ownerProfile?:SavedOwnerEngineeringConfiguration}){
 if(options?.aiProfile&&options.ownerProfile)throw Error('ANALYSIS_PROFILE_AMBIGUOUS');
 const profile=options?.ownerProfile??options?.aiProfile;
 if(profile&&baseKey!==savedAiReleaseBaseKey(job,order.id,month,profile))throw Error('AI_RELEASE_BASE_KEY_MISMATCH');
 const sourceScope=profile?undefined:await savedDocumentReviewSourceScope(context,job,order,month);
 const snapshot=await new SavedCaseSnapshot(context,job,month,undefined,undefined,true,sourceScope).read();
 const source=await savedDocumentReviewInput(context,job,order,month,snapshot,!!profile);
 const review=profile?('owner_scope' in profile?prepareSavedOwnerEngineeringReview(source,profile):prepareSavedAiReleaseReview(source,profile)):source;
 const reviewSha256=canonicalSha256(review);
 return {key:documentReviewIdempotencyKey(baseKey,reviewSha256),review,reviewSha256,snapshot};
}
