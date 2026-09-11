import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_REVIEW_POLICY} from '@/engine/document-review/contracts';
import {documentReviewIdempotencyKey} from './document-review-key';

vi.mock('server-only',()=>({}));

it('pins the immutable review independently of the source-job base key',()=>{
 const source='saved-month:synthetic-source-order-month',first='a'.repeat(64),second='b'.repeat(64);
 const expected=`review:${canonicalSha256({baseKey:source,policy:DOCUMENT_REVIEW_POLICY,review_sha256:first})}`;
 expect(documentReviewIdempotencyKey(source,first)).toBe(expected);
 expect(documentReviewIdempotencyKey(source,first)).toBe(documentReviewIdempotencyKey(source,first));
 expect(documentReviewIdempotencyKey(source,second)).not.toBe(expected);
 expect(documentReviewIdempotencyKey(source+':other-order',first)).not.toBe(expected);
 expect(expected).not.toBe(`review:${canonicalSha256({baseKey:source,policy:DOCUMENT_REVIEW_POLICY})}`);
});
it.each(['','a'.repeat(63),'A'.repeat(64),'z'.repeat(64)])('refuses an invalid review pin %s',pin=>{
 expect(()=>documentReviewIdempotencyKey('saved-source',pin)).toThrow();
});
