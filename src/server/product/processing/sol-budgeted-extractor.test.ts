import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {createSolBudgetedExtractor} from './sol-budgeted-extractor';
import {newSolComparisonLedger} from './live-extraction-sol-comparison-budget';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
const sdk=vi.hoisted(()=>({count:vi.fn(),parse:vi.fn(),construct:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('openai',()=>({default:class{responses={inputTokens:{count:sdk.count},parse:sdk.parse};constructor(options:unknown){sdk.construct(options);}}}));
const directories:string[]=[];
beforeEach(()=>{
 vi.stubEnv('TIVDOC_SOL_SAVED_WORKER_PROOF','1');vi.stubEnv('NODE_ENV','test');vi.stubEnv('VERCEL','');
 sdk.construct.mockClear();sdk.count.mockReset().mockResolvedValue({object:'response.input_tokens',input_tokens:2000});
 sdk.parse.mockReset().mockResolvedValue({id:'resp_synthetic_unit_only',status:'failed',output_parsed:null,model:'gpt-5.6-sol',
  _request_id:'req_synthetic_unit_only',usage:{input_tokens:2000,output_tokens:2,total_tokens:2002}});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
async function setup(){
 const directory=mkdtempSync(path.join(tmpdir(),'tivdoc-sol-unit-'));directories.push(directory);
 const pdf=await PDFDocument.create();pdf.addPage([595,842]);const bytes=await pdf.save();
 const source={sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,mimeType:'application/pdf' as const};
 const request=syntheticPayslipFixtures[0].request;
 const actualRequest={...request,document:{...request.document,content_sha256:source.sha256,size_bytes:bytes.length,mime_type:source.mimeType}};
 const prepared=await preprocessPayslipDocument({bytes,mime_type:source.mimeType});
 const ledgerPath=path.join(directory,'ledger.json');writeFileSync(ledgerPath,JSON.stringify(newSolComparisonLedger()));
 const input={apiKey:'synthetic-unit-test-no-network',ledgerPath,artifactDirectory:path.join(directory,'artifacts'),codeRevision:'a'.repeat(40),allowedSources:[source],maxGenerations:1};
 const pass={request:actualRequest,prepared,kind:'first_pass' as const,requestedFields:[],sourcePageCount:1};
 return {input,pass};
}
it('simulates the SDK boundary with actual source bytes and reserves count then generation, without modifying worker document identity',async()=>{
 const {input,pass}=await setup(),runtime=createSolBudgetedExtractor(input);
 try{
  const result=await runtime.extractor.extractPreparedPass(pass);
  expect(sdk.count).toHaveBeenCalledTimes(1);expect(sdk.parse).toHaveBeenCalledTimes(1);
  expect(result.extraction.document_id).toBe(pass.request.document.document_id);
  expect(runtime.summary()).toMatchObject({contentRequests:2,generations:1,unknownOutcomes:0,reservedUpperBoundUsd:0.712});
  expect(runtime.extractor.recoveryExecution).toBe('skip_package_budget');
  expect(sdk.construct.mock.calls.every(([options])=>options.baseURL==='https://api.openai.com/v1'&&options.maxRetries===0)).toBe(true);
  const ledger=JSON.parse(readFileSync(input.ledgerPath,'utf8'));expect(ledger.reservations.map((r:{kind:string})=>r.kind)).toEqual(['input_tokens','generation']);
  await expect(runtime.extractor.extractPreparedPass({...pass,kind:'targeted_recovery'})).rejects.toThrow('NOT_AUTHORIZED');
  await expect(runtime.extractor.extractPreparedPass(pass)).rejects.toThrow('GENERATION_LIMIT');
  expect(sdk.parse).toHaveBeenCalledTimes(1);
 }finally{runtime.close();}
});
it('refuses altered source bytes and overlapping calls before another content request',async()=>{
 const {input,pass}=await setup(),runtime=createSolBudgetedExtractor(input);
 try{
  await expect(runtime.extractor.extractPreparedPass({...pass,prepared:{...pass.prepared,original:{...pass.prepared.original,bytes:new Uint8Array([1])}}})).rejects.toThrow('SOURCE_NOT_ALLOWED');
  expect(sdk.count).not.toHaveBeenCalled();
  const first=runtime.extractor.extractPreparedPass(pass);
  await expect(runtime.extractor.extractPreparedPass(pass)).rejects.toThrow('BUSY');
  expect(()=>runtime.close()).toThrow('STILL_RUNNING');
  await first;expect(sdk.parse).toHaveBeenCalledTimes(1);
 }finally{runtime.close();}
});
it('keeps a failed oversized count charged and never invokes generation',async()=>{
 const {input,pass}=await setup(),runtime=createSolBudgetedExtractor(input);
 sdk.count.mockResolvedValue({object:'response.input_tokens',input_tokens:64001});
 try{
  await expect(runtime.extractor.extractPreparedPass(pass)).rejects.toThrow('COUNT_OUTSIDE_BOUND');
  expect(sdk.parse).not.toHaveBeenCalled();expect(runtime.summary()).toMatchObject({contentRequests:1,unknownOutcomes:1,reservedUpperBoundUsd:0.256});
 }finally{runtime.close();}
});
it.each(['header-observation-classification-r5','literal-label-cell-transcription-r7'] as const)('refuses %s without the exact retained completed receipt before any content request',async(reason)=>{
 const {input}=await setup();
 expect(()=>createSolBudgetedExtractor({...input,reviewedRetry:{sourceSha256:input.allowedSources[0].sha256,
  priorReceiptSha256:'f'.repeat(64),reason}})).toThrow('REVIEWED_RETRY_RECEIPT_REQUIRED');
 expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();
 expect(JSON.parse(readFileSync(input.ledgerPath,'utf8')).reservations).toEqual([]);
 const fresh=createSolBudgetedExtractor(input);fresh.close();
});


it('refuses an unenrolled case and an expired package before sending either content request',async()=>{
 const {input,pass}=await setup();
 for(const restriction of [{allowedCaseIds:['00000000-0000-4000-8000-000000000000']},{expiresAt:'2000-01-01T00:00:00Z'}]){
  const runtime=createSolBudgetedExtractor({...input,...restriction});
  try { await expect(runtime.extractor.extractPreparedPass(pass)).rejects.toThrow(/CASE_NOT_ALLOWED|PACKAGE_EXPIRED/); }
  finally{runtime.close();}
 }
 expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();
});
it('retains a successful count but refuses generation when the package expires during that count',async()=>{
 const {input,pass}=await setup();const now=new Date('2026-09-11T00:30:00Z').getTime();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 const runtime=createSolBudgetedExtractor({...input,expiresAt:new Date(now+500).toISOString()});
 sdk.count.mockImplementation(async()=>{vi.setSystemTime(now+1000);return {object:'response.input_tokens',input_tokens:2000};});
 try{
  await expect(runtime.extractor.extractPreparedPass(pass)).rejects.toThrow('SOL_MANAGED_PACKAGE_EXPIRED');
  expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).not.toHaveBeenCalled();
  const ledger=JSON.parse(readFileSync(input.ledgerPath,'utf8'));expect(ledger.reservations).toHaveLength(1);expect(ledger.reservations[0].outcome).toBe('count_recorded');
 }finally{runtime.close();}
});

it('allows one explicitly reviewed r6-to-r7 retry while preserving the first attempt and refusing changed receipt bytes',async()=>{
 const {input,pass}=await setup(),first=createSolBudgetedExtractor(input);
 await first.extractor.extractPreparedPass(pass);first.close();
 const ledger=JSON.parse(readFileSync(input.ledgerPath,'utf8'));
 const prior=ledger.reservations[1];
 // Synthetic SDK contract fixture only; never written to a package ledger.
 const {receipt_sha256:ignored,...body}=prior.receipt;void ignored;
 for(const row of ledger.reservations)row.requestSha256='1'.repeat(64);
 prior.receipt=createOpenAiProviderReceipt({...body,request_sha256:'1'.repeat(64),status:'completed',error_code:null,prompt_version:'payslip-extraction-openai-v2-first-r6'});
 writeFileSync(input.ledgerPath,JSON.stringify(ledger));
 const retained=JSON.stringify(ledger.reservations);
 const reviewedRetry={reason:'literal-label-cell-transcription-r7' as const,sourceSha256:input.allowedSources[0].sha256,priorReceiptSha256:prior.receipt.receipt_sha256};
 const changed=structuredClone(ledger);changed.reservations[1].receipt.duration_ms++;
 writeFileSync(input.ledgerPath,JSON.stringify(changed));
 expect(()=>createSolBudgetedExtractor({...input,reviewedRetry})).toThrow('PROVIDER_RECEIPT_HASH_MISMATCH');
 writeFileSync(input.ledgerPath,JSON.stringify(ledger));
 const second=createSolBudgetedExtractor({...input,reviewedRetry});
 sdk.parse.mockResolvedValue({id:'resp_synthetic_unit_second',status:'failed',output_parsed:null,model:'gpt-5.6-sol',
  _request_id:'req_synthetic_unit_second',usage:{input_tokens:2000,output_tokens:2,total_tokens:2002}});
 try{
  await second.extractor.extractPreparedPass(pass);
  const after=JSON.parse(readFileSync(input.ledgerPath,'utf8'));
  expect(JSON.stringify(after.reservations.slice(0,2))).toBe(retained);
  expect(after.reservations.map((r:{attempt:number})=>r.attempt)).toEqual([1,1,2,2]);
  expect(second.summary()).toMatchObject({contentRequests:4,generations:2,unknownOutcomes:0});
 }finally{second.close();}
});
