import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_REVIEW_POLICY} from '@/engine/document-review/contracts';
import {documentReviewIdempotencyKey} from './document-review-key';
import {DOCUMENT_REVIEW_RENDER_POLICY} from '../reports/document-review-render-policy';

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
