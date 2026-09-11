import {expect,it} from 'vitest';
import {buildLegacyPaidScope,adaptLegacyPaidCohort,legacyPaidMonthlyScope,inspectLegacyPaidReceiptForInternalReview,LEGACY_PAID_TOPICS,type LegacyPaidReceiptInput} from './legacy-paid-receipt';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
const caseId='11111111-1111-4111-8111-111111111111',paymentId='22222222-2222-4222-8222-222222222222';
function fixture():LegacyPaidReceiptInput{return {case:{id:caseId,public_id:'SYNTHETIC-LEGACY',payment_status:'verified',is_qa:false},
 payment:{id:paymentId,case_id:caseId,provider:'invoice4u',amount:'9.99',currency:'ILS',status:'verified',verified_at:'2026-08-30T00:00:00Z',
  idempotency_key:caseId+':initial-check',provider_order_id:'tivdoc-salary:SYNTHETIC-LEGACY',provider_payment_id:'1001',provider_reference:'2001',provider_clearing_log_id:'2001',provider_confirmation_number:'3001'},
 source:{project_ref:'a'.repeat(20),captured_at:'2026-09-11T00:00:00Z',snapshot_sha256:'b'.repeat(64)},periods:[]};}
it('retains the historical nine-topic purchase and exact decimal currency without inventing a selected month or new order',()=>{
 const f=fixture(),r=buildLegacyPaidScope(f);expect(r.state).toBe('admitted');if(r.state!=='admitted')throw Error('expected admitted');
 expect(r.scope).toMatchObject({id:paymentId,amount_minor:999,topics:LEGACY_PAID_TOPICS,period_state:'missing',periods:[],
  new_payment_required:false,publication_authority:false,deployment_at_purchase_verified:false,scope_basis:'legacy_initial_scope_not_versioned'});
 expect(r.scope).not.toHaveProperty('offer_sha256');expect(r.scope).not.toHaveProperty('human_approved');
 expect(buildLegacyPaidScope(f)).toEqual(r);expect(adaptLegacyPaidCohort([f,JSON.parse(JSON.stringify(f))])).toEqual([r]);
 expect(legacyPaidMonthlyScope(r.scope,'2026-06').state).toBe('period_evidence_required');
});
it.each(['99','149.5','349.00'])('preserves actual saved amount %s without comparing it to current prices',amount=>{
 const f=fixture();f.payment.amount=amount;const r=buildLegacyPaidScope(f);expect(r.state).toBe('admitted');if(r.state==='admitted')expect(r.scope.amount_minor).toBe(Number(amount)*100);
});
it.each(['0','-1','1e2','9.999','01.00'])('does not round or invent verification for invalid amount %s',amount=>{
 const f=fixture();f.payment.amount=amount;expect(buildLegacyPaidScope(f)).toMatchObject({state:'payment_review_required',reasons:['payment_amount_currency_or_provider']});
});
it('keeps QA and incomplete ownership out of ordinary admission even when payment bindings are consistent',()=>{
 for(const flag of [true,null]){const f=fixture();f.case.is_qa=flag;expect(buildLegacyPaidScope(f).state).toBe('ownership_review_required');expect(f.case.is_qa).toBe(flag);}
 const f=fixture();f.case.attribution_status='internal_qa';expect(buildLegacyPaidScope(f).state).toBe('ownership_review_required');
});
it('lets an internal owner inspect the authentic nine-topic receipt while preserving unresolved original ownership and refusing execution',()=>{
 const f=fixture();f.case.is_qa=true;const result=inspectLegacyPaidReceiptForInternalReview(f);
 expect(result).toMatchObject({state:'internal_review',admission:false,public_execution:false,ownership_review_required:true,
  blockers:['qa_or_unknown_ownership_flag_preserved'],scope:{topics:LEGACY_PAID_TOPICS,case_record_sha256:canonicalSha256(f.case),publication_authority:false}});
 expect(buildLegacyPaidScope(f).state).toBe('ownership_review_required');expect(f.case.is_qa).toBe(true);
 if(result.scope)expect(result.scope.case_record_sha256).not.toBe(canonicalSha256({...f.case,is_qa:false}));
 f.payment.verified_at=null;expect(inspectLegacyPaidReceiptForInternalReview(f)).toMatchObject({state:'payment_review_required',scope:null,admission:false,public_execution:false});
});
it('refuses missing verification, zero provider ID, foreign order and clearing mismatch without treating checkout as payment',()=>{
 for(const change of [{verified_at:null},{provider_payment_id:'0'},{provider_order_id:'another-case'},{provider_reference:'other'},{status:'paid'}]){
  const f=fixture();Object.assign(f.payment,change);expect(buildLegacyPaidScope(f).state).toBe('payment_review_required');
 }
 const f=fixture();f.payment.status='refunded';expect(buildLegacyPaidScope(f).state).toBe('inactive');
});
it('accepts only explicitly source-bound period evidence and retains its receipt independently from the purchase timestamp',()=>{
 const f=fixture();f.periods=[{period:{from:'2026-06-18',to:'2026-07-17'},evidence_sha256:'c'.repeat(64),source_pins:[{case_id:caseId,document_id:'source',version_id:'read-version',source_sha256:'d'.repeat(64)}]}];
 const r=buildLegacyPaidScope(f);expect(r).toMatchObject({state:'admitted',scope:{period_state:'source_observed',periods:f.periods}});
 if(r.state==='admitted')expect(legacyPaidMonthlyScope(r.scope,'2026-06').state).toBe('period_evidence_required');
 f.periods[0].source_pins[0].case_id=paymentId;expect(()=>buildLegacyPaidScope(f)).toThrow('PERIOD_CASE_BINDING');
});
it('provides a monthly adapter only for source evidence covering that month and refuses altered receipt bytes',()=>{
 const f=fixture();f.periods=[{period:{from:'2026-06-01',to:'2026-06-30'},evidence_sha256:'c'.repeat(64),source_pins:[{case_id:caseId,document_id:'source',version_id:'v1',source_sha256:'d'.repeat(64)}]}];
 const r=buildLegacyPaidScope(f);if(r.state!=='admitted')throw Error('expected admitted');
 expect(legacyPaidMonthlyScope(r.scope,'2026-06')).toMatchObject({state:'ready',id:paymentId,from:'2026-06-01',to:'2026-06-01',topics:LEGACY_PAID_TOPICS});
 expect(legacyPaidMonthlyScope(r.scope,'2026-07').state).toBe('period_evidence_required');
 expect(()=>legacyPaidMonthlyScope({...r.scope,amount_minor:1},'2026-06')).toThrow('RECEIPT_HASH');
});
it('rejects another case, divergent receipt retries and cross-case provider reuse',()=>{
 const f=fixture(),other=fixture();other.payment.amount='10';expect(()=>adaptLegacyPaidCohort([f,other])).toThrow('DUPLICATE_CONFLICT');
 other.case.id=paymentId;other.payment.id='33333333-3333-4333-8333-333333333333';other.payment.case_id=paymentId;
 expect(()=>adaptLegacyPaidCohort([f,other])).toThrow('REFERENCE_REUSE');
 f.payment.case_id=paymentId;expect(()=>buildLegacyPaidScope(f)).toThrow('CASE_BINDING');
});
