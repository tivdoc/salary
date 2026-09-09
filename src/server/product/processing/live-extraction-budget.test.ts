import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {LIVE_EXTRACTION_BUDGET_POLICY as policy,assertLiveExtractionBudgetModel,newLiveExtractionBudgetLedger,
 reserveLiveExtractionPass,parseLiveExtractionBudgetLedger,summarizeLiveExtractionBudget,
 preflightLiveExtractionRequest,recordLiveExtractionPassReceipt} from './live-extraction-budget';
import {loadLiveExtractionCorpus} from './live-extraction-corpus';
vi.mock('server-only',()=>({}));
const now='2026-09-09T18:00:00Z',sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const fresh=()=>newLiveExtractionBudgetLedger(policy.model,now);
function reserve(ledger=fresh(),id='synthetic-budget-source',passKind:'first_pass'|'targeted_recovery'='first_pass'){
 return reserveLiveExtractionPass({ledger,sourceSha256:sha(id),requestSha256:sha('synthetic-budget-request'),passKind,now});
}
function receipt(){
 const uuid='00000000-0000-4000-8000-000000000001';
 return createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'openai_live',case_id:uuid,
  analysis_run_id:uuid,document_id:uuid,extraction_id:uuid,source_sha256:sha('synthetic-budget-source'),source_size_bytes:100,
  source_mime_type:'application/pdf',source_page_count:1,request_sha256:sha('synthetic-budget-request'),raw_extraction_sha256:sha('synthetic-contract-test'),
  pass_kind:'first_pass',requested_model:policy.model,actual_model:policy.model,extractor_version:'2.1',prompt_version:'synthetic-contract-test',
  provider_response_id:'synthetic-contract-only',provider_request_id:'synthetic-contract-only',provider_attempted:true,status:'completed',
  error_code:null,http_status:null,duration_ms:1,token_usage:{input_tokens:1500,output_tokens:500,total_tokens:2000},
  cost:{status:'not_returned_by_provider',amount_usd:null},created_at:now});
}

describe('pre-call spending bound; no SDK call or fabricated supplier cost',()=>{
 it('rejects unpriced models, floating aliases and stale pricing before a call',()=>{
  for(const model of ['gpt-5.6-sol','gpt-4o-mini','unpriced'])expect(()=>assertLiveExtractionBudgetModel(model,now)).toThrow('LIVE_BUDGET_UNPRICED_MODEL');
  expect(()=>assertLiveExtractionBudgetModel(policy.model,'2026-09-16T00:00:00Z')).toThrow('LIVE_BUDGET_PRICING_REVIEW_EXPIRED');
 });
 it('reserves the full model context and output ceiling for every pass, without discounting failures',()=>{
  let ledger=fresh();for(let index=0;index<22;index++)ledger=reserve(ledger,`input-${index}`);
  const summary=summarizeLiveExtractionBudget(ledger);
  expect(summary.reservedUpperBoundUsd).toBe(0.5544);expect(summary.unknownOutcomes).toBe(22);
  expect(summary.reservedUpperBoundUsd).toBeLessThanOrEqual(5);
  expect(()=>reserve(ledger,'input-23')).toThrow('LIVE_BUDGET_EXHAUSTED');
  expect(summary.supplierReturnedCost).toEqual({status:'not_returned_by_provider',amountUsd:null});
 });
 it('refuses a repeated pass after a serialize/parse restart, while retaining the first-pass reservation',()=>{
  const ledger=parseLiveExtractionBudgetLedger(JSON.parse(JSON.stringify(reserve())));
  expect(()=>reserve(ledger)).toThrow('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
  expect(reserve(ledger,'synthetic-budget-source','targeted_recovery').reservations).toHaveLength(2);
 });
 it('records synthetic receipt-contract usage separately from its pre-call conservative reservation',()=>{
  const ledger=recordLiveExtractionPassReceipt(reserve(),receipt());
  expect(summarizeLiveExtractionBudget(ledger).unknownOutcomes).toBe(0);
  expect(summarizeLiveExtractionBudget(ledger).reservedUpperBoundUsd).toBe(0.0252);
  expect(summarizeLiveExtractionBudget(ledger).supplierReturnedCost.amountUsd).toBeNull();
 });
 it.each(['source','request','model','usage','origin'] as const)('refuses an out-of-bound receipt: %s',change=>{
  const original=receipt(),{receipt_sha256:discarded,...body}=original;void discarded;
  if(change==='source')body.source_sha256=sha('foreign-source');
  if(change==='request')body.request_sha256=sha('other-request');
  if(change==='model')body.actual_model='unpriced-model';
  if(change==='origin')body.origin='injected_test_provider';
  if(change==='usage')body.token_usage={input_tokens:128001,output_tokens:0,total_tokens:128001};
  expect(()=>recordLiveExtractionPassReceipt(reserve(),createOpenAiProviderReceipt(body))).toThrow('LIVE_BUDGET_RECEIPT_OUTSIDE_BOUND');
 });
 it('preflights all eleven exact approved files, including prior PDF/scan/photo and their actual crops',async()=>{
  for(const entry of loadLiveExtractionCorpus('all')){
   const prepared=await preprocessPayslipDocument({bytes:readFileSync(entry.path),mime_type:entry.mimeType});
   const result=await preflightLiveExtractionRequest({model:policy.model,prepared,sourceSha256:entry.sha256,kind:'first_pass',requestedFields:[],now});
   expect(result.pageCount).toBe(1);expect(result.inputImages).toBeLessThanOrEqual(5);
  }
 });
 it('preflights the actual A4 Hebrew PDF request without calling any provider',async()=>{
  const entry=loadLiveExtractionCorpus()[0],bytes=readFileSync(entry.path);
  const prepared=await preprocessPayslipDocument({bytes,mime_type:entry.mimeType});
  const result=await preflightLiveExtractionRequest({model:policy.model,prepared,sourceSha256:entry.sha256,kind:'first_pass',requestedFields:[],now});
  expect(result.pageCount).toBe(1);expect(result.textBytes).toBeLessThanOrEqual(policy.maxRequestTextBytes);
  expect(result.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
  await expect(preflightLiveExtractionRequest({model:policy.model,prepared,sourceSha256:sha('wrong'),kind:'first_pass',requestedFields:[],now}))
   .rejects.toThrow('LIVE_BUDGET_SOURCE_BOUND');
 });
 it('rejects too many image inputs before constructing or forwarding the request',async()=>{
  const entry=loadLiveExtractionCorpus().find(entry=>entry.mimeType==='image/png')!,bytes=readFileSync(entry.path);
  const prepared=await preprocessPayslipDocument({bytes,mime_type:entry.mimeType});
  const image={bytes,mime_type:'image/png' as const,width:1241,height:1754,sha256:entry.sha256};
  await expect(preflightLiveExtractionRequest({model:policy.model,prepared:{...prepared,crops:Array.from({length:5},()=>({region:'header' as const,image}))},
   sourceSha256:entry.sha256,kind:'first_pass',requestedFields:[],now})).rejects.toThrow('LIVE_BUDGET_IMAGE_COUNT');
 });
});
