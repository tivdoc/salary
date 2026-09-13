import {it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createReleaseQuotePreparationStatus,releaseQuotePreparationStatusSchema} from './release-quote-status';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pins={case_id:id(1),identity_id:id(2),initial_order_id:id(3),initial_order_receipt_sha256:'a'.repeat(64),source_revision:2,source_sha256:'b'.repeat(64),analysis_run_id:'synthetic-analysis',period:{from:'2026-06',to:'2026-06'},quote_id:null,order_id:null};
it.each([
 ['pricing_comparison_incomplete','needs_information'],['pricing_comparison_conditional','conditional_result'],['pricing_adapter_unsupported_topics','coverage_unavailable'],
 ['pricing_cross_topic_allocation_unavailable','comparison_needs_review'],['pricing_payment_source_overlap','comparison_needs_review'],['PRICE_QUOTE_CREDIT_UNAVAILABLE','order_needs_review'],
 ['PRICE_QUOTE_EXPIRED','quote_expired'],['below_threshold','below_upgrade_threshold'],['unclassified_future_reason','not_prepared'],
])('maps %s to safe customer state %s without exposing the internal reason', (reason,state)=>{
 const s=createReleaseQuotePreparationStatus({...pins,reason});expect(s.availability).toEqual({state,period:pins.period});expect(JSON.stringify(s.availability)).not.toContain(reason);
});
it('is deterministic across retries and rejects changed pins or forged ready state',()=>{
 const s=createReleaseQuotePreparationStatus({...pins,reason:'pricing_comparison_incomplete'});expect(createReleaseQuotePreparationStatus({...pins,reason:'pricing_comparison_incomplete'})).toEqual(s);
 expect(releaseQuotePreparationStatusSchema.safeParse({...s,source_revision:3}).success).toBe(false);
 const {sha256,...body}=s;void sha256;const fake={...body,availability:{...body.availability,state:'ready'}};expect(releaseQuotePreparationStatusSchema.safeParse({...fake,sha256:canonicalSha256(fake)}).success).toBe(false);
 expect(()=>createReleaseQuotePreparationStatus({...pins,reason:'offer_saved',quote_id:id(4)})).toThrow();
});
