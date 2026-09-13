import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {LIVE_EXTRACTION_BUDGET_POLICY as policy,LIVE_EXTRACTION_REVIEWED_RETRY as approval,
 newLiveExtractionBudgetLedger,reserveLiveExtractionPass,recordLiveExtractionPassReceipt,parseLiveExtractionBudgetLedger,summarizeLiveExtractionBudget,
 LIVE_EXTRACTION_HEBREW_SCAN_RETRY as hebrewAttempt,type LiveExtractionBudgetLedger} from './live-extraction-budget';
vi.mock('server-only',()=>({}));
const now='2026-09-09T21:00:00Z',later='2026-09-09T21:10:00Z',hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const retry={version:approval.version,attemptRevision:2 as const,reasonCode:approval.reasonCode,codeRevision:'a'.repeat(40)};
function receipt(sourceSha256:string,id:string,at=now,promptVersion='synthetic-contract-test'){
 const uuid='00000000-0000-4000-8000-000000000001';
 return createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'openai_live',case_id:uuid,
  analysis_run_id:uuid,document_id:uuid,extraction_id:uuid,source_sha256:sourceSha256,source_size_bytes:100,
  source_mime_type:'application/pdf',source_page_count:1,request_sha256:hash('synthetic-budget-request'),raw_extraction_sha256:hash('synthetic-contract-only'),
  pass_kind:'first_pass',requested_model:policy.model,actual_model:policy.model,extractor_version:'2.1',prompt_version:promptVersion,
  provider_response_id:id,provider_request_id:id,provider_attempted:true,status:'completed',error_code:null,http_status:null,
  duration_ms:1,token_usage:null,cost:{status:'not_returned_by_provider',amount_usd:null},created_at:at});
}
function priorEight(){
 let ledger=newLiveExtractionBudgetLedger(policy.model,now);
 for(let i=0;i<8;i++){
  const source=approval.sourceSha256s[i-6]??hash(`synthetic-prior-${i}`);
  ledger=reserveLiveExtractionPass({ledger,sourceSha256:source,requestSha256:hash('synthetic-budget-request'),passKind:'first_pass',now});
  ledger=recordLiveExtractionPassReceipt(ledger,receipt(source,`synthetic-old-response-${i}`));
 }
 return ledger;
}
const reserve=(ledger:LiveExtractionBudgetLedger,source:string=approval.sourceSha256s[0],reviewedRetry=retry)=>reserveLiveExtractionPass({ledger,
 sourceSha256:source,requestSha256:hash('synthetic-budget-request'),passKind:'first_pass',now:later,reviewedRetry});

describe('one reviewed attempt keeps all original paid or unknown reservations',()=>{
 it('preserves all eight original records byte for byte and counts the next reviewed pass as the ninth',()=>{
  const before=priorEight(),snapshot=JSON.stringify(before),after=reserve(before);
  expect(JSON.stringify(before)).toBe(snapshot);expect(after.reservations.slice(0,8)).toEqual(before.reservations);
  expect(summarizeLiveExtractionBudget(after)).toMatchObject({reservedPasses:9,reservedUpperBoundUsd:.2268,unknownOutcomes:1});
  expect(after.reservations[8].reviewedRetry).toEqual(retry);
  const saved=recordLiveExtractionPassReceipt(after,receipt(approval.sourceSha256s[0],'synthetic-new-response',later));
  expect(saved.reservations[6]).toEqual(before.reservations[6]);expect(saved.reservations[8].outcome).toBe('receipt_recorded');
 });
 it('refuses default reuse, repeated attempt 2, foreign sources and a changed code revision',()=>{
  const before=priorEight();
  expect(()=>reserveLiveExtractionPass({ledger:before,sourceSha256:approval.sourceSha256s[0],requestSha256:hash('synthetic-budget-request'),passKind:'first_pass',now:later})).toThrow('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
  expect(()=>reserve(before,hash('foreign'))).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  const pending=reserve(before);expect(()=>reserve(pending)).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  const saved=recordLiveExtractionPassReceipt(pending,receipt(approval.sourceSha256s[0],'synthetic-new-response',later));
  expect(()=>reserve(saved)).toThrow('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
  expect(()=>reserve(saved,approval.sourceSha256s[0],{...retry,codeRevision:'b'.repeat(40)})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
 });
 it('does not treat an old response as the receipt of the new paid attempt',()=>{
  const pending=reserve(priorEight());
  expect(()=>recordLiveExtractionPassReceipt(pending,receipt(approval.sourceSha256s[0],'synthetic-old-response-6',later))).toThrow('LIVE_BUDGET_RECEIPT_OUTSIDE_BOUND');
  expect(()=>recordLiveExtractionPassReceipt(pending,receipt(approval.sourceSha256s[0],'synthetic-different-id',now))).toThrow('LIVE_BUDGET_RECEIPT_OUTSIDE_BOUND');
 });
 it('rejects unknown earlier outcomes and forged retry history',()=>{
  const unknown=priorEight();unknown.reservations[6].outcome='reserved_unknown';unknown.reservations[6].receipt=null;
  expect(()=>reserve(unknown)).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  const orphan=reserve(priorEight());orphan.reservations.splice(6,1);expect(()=>parseLiveExtractionBudgetLedger(orphan)).toThrow('LIVE_BUDGET_RETRY_HISTORY_INVALID');
 });
 it('keeps the original 22-pass and monetary ceilings after a reviewed retry and restart',()=>{
  let ledger=recordLiveExtractionPassReceipt(reserve(priorEight()),receipt(approval.sourceSha256s[0],'synthetic-new-response',later));
  for(let i=9;i<22;i++)ledger=reserveLiveExtractionPass({ledger,sourceSha256:hash(`new-source-${i}`),requestSha256:hash('new-request'),passKind:'first_pass',now:later});
  ledger=parseLiveExtractionBudgetLedger(JSON.parse(JSON.stringify(ledger)));
  expect(summarizeLiveExtractionBudget(ledger)).toMatchObject({reservedPasses:22,reservedUpperBoundUsd:.5544});
  expect(()=>reserve(ledger,approval.sourceSha256s[1])).toThrow('LIVE_BUDGET_EXHAUSTED');
 });
});

it('attempt 3 requires a completed earlier reviewed attempt and preserves its paid receipts',()=>{
 const attempt3={version:approval.version,attemptRevision:3 as const,reasonCode:'aggregate_total_isolation_after_ef03418' as const,codeRevision:'c'.repeat(40)};
 const before=priorEight();const input={sourceSha256:approval.sourceSha256s[0],requestSha256:hash('synthetic-budget-request'),passKind:'first_pass' as const,now:later,reviewedRetry:attempt3};
 expect(()=>reserveLiveExtractionPass({...input,ledger:before})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
 const pending=reserve(before);expect(()=>reserveLiveExtractionPass({...input,ledger:pending})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
 const afterTwo=recordLiveExtractionPassReceipt(pending,receipt(approval.sourceSha256s[0],'synthetic-attempt-two',later));
 const afterThree=reserveLiveExtractionPass({...input,ledger:afterTwo});
 expect(afterThree.reservations.slice(0,9)).toEqual(afterTwo.reservations);expect(summarizeLiveExtractionBudget(afterThree).reservedPasses).toBe(10);
 expect(()=>parseLiveExtractionBudgetLedger({...afterThree,reservations:afterThree.reservations.filter(r=>r.reviewedRetry?.attemptRevision!==2)})).toThrow('LIVE_BUDGET_RETRY_HISTORY_INVALID');
 const saved=recordLiveExtractionPassReceipt(afterThree,receipt(approval.sourceSha256s[0],'synthetic-attempt-three',later));
 expect(()=>reserveLiveExtractionPass({...input,ledger:saved})).toThrow('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
});

it('recovery-confirmation attempt 4 requires the recorded failure history and keeps all spending',()=>{
 const source=approval.sourceSha256s[0];
 const attempt3={version:approval.version,attemptRevision:3 as const,reasonCode:'aggregate_total_isolation_after_ef03418' as const,codeRevision:'c'.repeat(40)};
 const attempt4={version:approval.version,attemptRevision:4 as const,reasonCode:'identified_recovery_confirmation_after_c521776' as const,codeRevision:'d'.repeat(40)};
 const input={sourceSha256:source,requestSha256:hash('synthetic-budget-request'),passKind:'first_pass' as const,now:later,reviewedRetry:attempt4};
 const afterTwo=recordLiveExtractionPassReceipt(reserve(priorEight()),receipt(source,'synthetic-two',later));
 expect(()=>reserveLiveExtractionPass({...input,ledger:afterTwo})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
 const pendingThree=reserveLiveExtractionPass({...input,ledger:afterTwo,reviewedRetry:attempt3});
 expect(()=>reserveLiveExtractionPass({...input,ledger:pendingThree})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
 const afterThree=recordLiveExtractionPassReceipt(pendingThree,receipt(source,'synthetic-three',later));
 const pendingFour=reserveLiveExtractionPass({...input,ledger:afterThree});
 expect(pendingFour.reservations.slice(0,10)).toEqual(afterThree.reservations);
 expect(summarizeLiveExtractionBudget(pendingFour)).toMatchObject({reservedPasses:11,reservedUpperBoundUsd:.2772});
 expect(()=>parseLiveExtractionBudgetLedger({...pendingFour,reservations:pendingFour.reservations.filter(r=>r.reviewedRetry?.attemptRevision!==3)})).toThrow('LIVE_BUDGET_RETRY_HISTORY_INVALID');
 const completed=recordLiveExtractionPassReceipt(pendingFour,receipt(source,'synthetic-four',later));
 expect(()=>reserveLiveExtractionPass({...input,ledger:completed})).toThrow('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
 expect(()=>reserveLiveExtractionPass({...input,ledger:completed,reviewedRetry:{...attempt4,codeRevision:'e'.repeat(40)}})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
});

describe('two pinned Hebrew/scan first-pass engineering probes preserve the shared ledger',()=>{
 const requestSha=hash('synthetic-budget-request'),codeRevision='e'.repeat(40);
 const reviewedRetry={version:hebrewAttempt.version,attemptRevision:5 as const,reasonCode:hebrewAttempt.reasonCode,promptVersion:hebrewAttempt.promptVersion,codeRevision};
 const makeNineteen=()=>{
  let ledger=newLiveExtractionBudgetLedger(policy.model,now);
  for(let i=0;i<19;i++){
   const source=hebrewAttempt.sourceSha256s[i]??hash(`synthetic-existing-nineteen-${i}`);
   ledger=reserveLiveExtractionPass({ledger,sourceSha256:source,requestSha256:requestSha,passKind:'first_pass',now});
   ledger=recordLiveExtractionPassReceipt(ledger,receipt(source,`synthetic-prior-nineteen-${i}`));
  }
  return ledger;
 };
 const next=(ledger:LiveExtractionBudgetLedger,index=0)=>reserveLiveExtractionPass({ledger,sourceSha256:hebrewAttempt.sourceSha256s[index],
  requestSha256:requestSha,passKind:'first_pass',now:later,reviewedRetry});
 it('preserves all nineteen reservations byte-for-byte and stops at twenty-one after the two probes',()=>{
  const initial=makeNineteen(),before=JSON.stringify(initial);let ledger=initial;
  for(let i=0;i<2;i++)ledger=recordLiveExtractionPassReceipt(next(ledger,i),receipt(hebrewAttempt.sourceSha256s[i],`synthetic-probe-${i}`,later,hebrewAttempt.promptVersion));
  expect(JSON.stringify(initial)).toBe(before);expect(ledger.reservations.slice(0,19)).toEqual(initial.reservations);
  expect(summarizeLiveExtractionBudget(ledger)).toMatchObject({reservedPasses:21,reservedUpperBoundUsd:0.5292,unknownOutcomes:0});
  expect(()=>next(ledger)).toThrow('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
 });
 it('refuses recovery, arbitrary sources, changed prompt/code, and unavailable original responses',()=>{
  const ledger=makeNineteen(),input={ledger,sourceSha256:hebrewAttempt.sourceSha256s[0],requestSha256:requestSha,passKind:'first_pass' as const,now:later,reviewedRetry};
  expect(()=>reserveLiveExtractionPass({...input,passKind:'targeted_recovery'})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  expect(()=>reserveLiveExtractionPass({...input,sourceSha256:approval.sourceSha256s[0]})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  expect(()=>reserveLiveExtractionPass({...input,reviewedRetry:{...reviewedRetry,promptVersion:'different-prompt'} as unknown as typeof reviewedRetry})).toThrow();
  const pending=next(ledger);expect(()=>next(pending)).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  expect(()=>recordLiveExtractionPassReceipt(pending,receipt(input.sourceSha256,'synthetic-wrong-prompt',later))).toThrow('LIVE_BUDGET_RECEIPT_OUTSIDE_BOUND');
  const finished=recordLiveExtractionPassReceipt(pending,receipt(input.sourceSha256,'synthetic-probe-recorded',later,hebrewAttempt.promptVersion));
  expect(()=>reserveLiveExtractionPass({...input,ledger:finished,reviewedRetry:{...reviewedRetry,codeRevision:'f'.repeat(40)}})).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  const unknown=makeNineteen();unknown.reservations[0].outcome='reserved_unknown';unknown.reservations[0].receipt=null;
  expect(()=>next(unknown)).toThrow('LIVE_BUDGET_RETRY_NOT_APPROVED');
  const orphan=next(ledger);orphan.reservations.splice(0,1);expect(()=>parseLiveExtractionBudgetLedger(orphan)).toThrow('LIVE_BUDGET_RETRY_HISTORY_INVALID');
 });
 it('keeps global exhaustion and uncertain-call reservations across a restart',()=>{
  let ledger=next(makeNineteen());
  ledger=reserveLiveExtractionPass({ledger,sourceSha256:hash('separate-existing-work-20'),requestSha256:requestSha,passKind:'first_pass',now:later});
  ledger=reserveLiveExtractionPass({ledger,sourceSha256:hash('separate-existing-work-21'),requestSha256:requestSha,passKind:'first_pass',now:later});
  ledger=parseLiveExtractionBudgetLedger(JSON.parse(JSON.stringify(ledger)));
  expect(summarizeLiveExtractionBudget(ledger)).toMatchObject({reservedPasses:22,reservedUpperBoundUsd:0.5544,unknownOutcomes:3});
  expect(()=>next(ledger,1)).toThrow('LIVE_BUDGET_EXHAUSTED');
 });
});
