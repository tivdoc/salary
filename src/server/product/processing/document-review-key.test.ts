import {beforeEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_REVIEW_POLICY} from '@/engine/document-review/contracts';
import {documentReviewIdempotencyKey,resolveSavedDocumentReviewKey,savedAiReleaseBaseKey} from './document-review-key';
import {DOCUMENT_REVIEW_RENDER_POLICY} from '../reports/document-review-render-policy';
import {AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import type {SavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import {savedMonthIdempotencyKey,type SavedOrderScope} from './saved-order-scope';
import {fixture} from '@/engine/entitlement-review/compose.fixture';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';

const ports=vi.hoisted(()=>({scope:vi.fn(),snapshot:vi.fn(),read:vi.fn(),source:vi.fn(),prepare:vi.fn()}));
vi.mock('./saved-snapshot',()=>({SavedCaseSnapshot:class {constructor(...args:unknown[]){ports.snapshot(...args);}read(){return ports.read();}}}));
vi.mock('./saved-document-review',()=>({savedDocumentReviewSourceScope:ports.scope,savedDocumentReviewInput:ports.source}));
vi.mock('./saved-ai-release',()=>({prepareSavedAiReleaseReview:ports.prepare}));
beforeEach(()=>{Object.values(ports).forEach(p=>p.mockReset());});

vi.mock('server-only',()=>({}));

it('pins the immutable review independently of the source-job base key',()=>{
 const source='saved-month:synthetic-source-order-month',first='a'.repeat(64),second='b'.repeat(64);
 const expected=`review:${canonicalSha256({baseKey:source,policy:DOCUMENT_REVIEW_POLICY,review_sha256:first,render_policy:DOCUMENT_REVIEW_RENDER_POLICY})}`;
 expect(documentReviewIdempotencyKey(source,first)).toBe(expected);
 expect(documentReviewIdempotencyKey(source,first)).toBe(documentReviewIdempotencyKey(source,first));
 expect(documentReviewIdempotencyKey(source,second)).not.toBe(expected);
 expect(documentReviewIdempotencyKey(source+':other-order',first)).not.toBe(expected);
 expect(expected).not.toBe(`review:${canonicalSha256({baseKey:source,policy:DOCUMENT_REVIEW_POLICY})}`);
});
it('preserves exact historical individual-v1 keys and gives grouped presentation a distinct dependency',()=>{
 const source='saved-month:legacy',review='b'.repeat(64);
 const legacy=`review:${canonicalSha256({baseKey:source,policy:DOCUMENT_REVIEW_POLICY,review_sha256:review})}`;
 expect(documentReviewIdempotencyKey(source,review,'individual-v1')).toBe(legacy);
 expect(documentReviewIdempotencyKey(source,review)).not.toBe(legacy);
 expect(documentReviewIdempotencyKey(source,review,DOCUMENT_REVIEW_RENDER_POLICY)).toBe(documentReviewIdempotencyKey(source,review));
});
it.each(['','a'.repeat(63),'A'.repeat(64),'z'.repeat(64)])('refuses an invalid review pin %s',pin=>{
 expect(()=>documentReviewIdempotencyKey('saved-source',pin)).toThrow();
});
it('uses the exact automatic snapshot, authenticated source answers and recipe output for the AI key',async()=>{
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:'11111111-1111-4111-8111-111111111111',revision:7,input_sha256:'a'.repeat(64),mode:'draft',processing_profile:'qualified_ai_v1'};
 const order:SavedOrderScope={id:'22222222-2222-4222-8222-222222222222',kind:'full',from:'2026-07-01',to:'2026-07-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)};
 // The profile is opaque to this identity/resolution seam; its loader owns
 // validation. This fixture deliberately supplies no authority or case facts.
 const profile={profile_sha256:'c'.repeat(64)} as SavedAiReleaseConfiguration;
 const context:PostgresTransactionContext={transaction_id:'key-unit',client:{query:vi.fn()}};
 const snapshot=buildSyntheticCaseFixture({fixture_id:'key',mode:'real'}).stored,source=fixture().input;
 const prepared={...source,coverage_gaps:[...source.coverage_gaps,{check_id:'recipe.missing',topic:'pension' as const,kind:'missing_applicability' as const,detail:'Synthetic recipe input remains unresolved',next_step:'Synthetic source needed'}]};
 ports.read.mockResolvedValue(snapshot);ports.source.mockResolvedValue(source);ports.prepare.mockReturnValue(prepared);
 const base=savedAiReleaseBaseKey(job,order.id,'2026-07',profile);
 expect(base).toBe(canonicalSha256({base:savedMonthIdempotencyKey(job,order.id,'2026-07'),ai_profile:profile.profile_sha256,template:AI_RELEASE_REPORT_TEMPLATE}));
 const result=await resolveSavedDocumentReviewKey(context,job,order,'2026-07',base,{aiProfile:profile});
 expect(ports.scope).not.toHaveBeenCalled();expect(ports.snapshot).toHaveBeenCalledWith(context,job,'2026-07',undefined,undefined,true,undefined);
 expect(ports.source).toHaveBeenCalledWith(context,job,order,'2026-07',snapshot,true);expect(ports.prepare).toHaveBeenCalledWith(source,profile);
 expect(result.reviewSha256).toBe(canonicalSha256(prepared));expect(result.key).toBe(documentReviewIdempotencyKey(base,canonicalSha256(prepared)));
 expect(result.key).not.toBe(documentReviewIdempotencyKey(base,canonicalSha256(source)));
 expect(savedAiReleaseBaseKey(job,order.id,'2026-07',{...profile,profile_sha256:'d'.repeat(64)})).not.toBe(base);
 await expect(resolveSavedDocumentReviewKey(context,job,order,'2026-07','legacy-base',{aiProfile:profile})).rejects.toThrow('AI_RELEASE_BASE_KEY_MISMATCH');
});
it('retains the historical source-scope path when no AI profile was selected',async()=>{
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:'11111111-1111-4111-8111-111111111111',revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:'22222222-2222-4222-8222-222222222222',kind:'full',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)};
 const context:PostgresTransactionContext={transaction_id:'key-unit',client:{query:vi.fn()}},source=fixture().input,scope={sourceVersionIds:['source']};
 ports.scope.mockResolvedValue(scope);ports.read.mockResolvedValue({});ports.source.mockResolvedValue(source);
 const result=await resolveSavedDocumentReviewKey(context,job,order,'2026-06','historical');
 expect(ports.scope).toHaveBeenCalledWith(context,job,order,'2026-06');expect(ports.snapshot).toHaveBeenCalledWith(context,job,'2026-06',undefined,undefined,true,scope);
 expect(ports.prepare).not.toHaveBeenCalled();expect(result.key).toBe(documentReviewIdempotencyKey('historical',canonicalSha256(source)));
});
