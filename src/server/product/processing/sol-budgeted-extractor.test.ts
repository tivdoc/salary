import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {createSolBudgetedExtractor} from './sol-budgeted-extractor';
import {newSolComparisonLedger,reserveSolRequest,recordSolCount,recordSolReceipt} from './live-extraction-sol-comparison-budget';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import type {DocumentEvidenceExtractorInput} from '@/server/engine/extraction/providers/openai/document-evidence-adapter';
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
async function evidenceSetup(){
 const prepared=await setup(),document={...prepared.pass.request.document,document_type:'attendance'};
 const input={...prepared.input,allowedCaseIds:[document.case_id],allowedVersionIds:[document.document_id],expiresAt:new Date(Date.now()+120000).toISOString(),
  documentEvidenceScope:{schema_version:'sol-document-evidence-scope-v1' as const,sources:[{caseId:document.case_id,versionId:document.document_id,
   sourceSha256:document.content_sha256,kind:'attendance' as const,maxPages:1}]}};
 const request:DocumentEvidenceExtractorInput={document,source:{read:async()=>prepared.pass.prepared.original.bytes},
  analysisRunId:randomUUID(),extractionId:randomUUID(),createdAt:new Date().toISOString()};
 return {...prepared,input,request};
}
it('keeps non-payroll extraction opt-in, with exact source/case/version/window scope',async()=>{
 const f=await evidenceSetup(),legacy=createSolBudgetedExtractor(f.input.documentEvidenceScope?{...f.input,documentEvidenceScope:undefined}:f.input);
 expect(legacy.documentEvidenceExtractor).toBeUndefined();legacy.close();
 expect(()=>createSolBudgetedExtractor({...f.input,allowedVersionIds:[randomUUID()]})).toThrow('SOL_DOCUMENT_EVIDENCE_SCOPE');
 const runtime=createSolBudgetedExtractor(f.input);
 try{
  expect(runtime.documentEvidenceExtractor).toBeDefined();
  await expect(runtime.documentEvidenceExtractor!.extract({...f.request,document:{...f.request.document,document_id:randomUUID()}})).rejects.toThrow('SOURCE_NOT_ALLOWED');
  expect(sdk.count).not.toHaveBeenCalled();
 }finally{runtime.close();}
});
it('records non-payroll failure in the same count/generation ledger and blocks implicit retry',async()=>{
 const f=await evidenceSetup(),runtime=createSolBudgetedExtractor(f.input);
 try{
  const result=await runtime.documentEvidenceExtractor!.extract(f.request);
  expect(result.status).toBe('failed');expect(runtime.summary()).toMatchObject({contentRequests:2,generations:1,unknownOutcomes:0,reservedUpperBoundUsd:.712});
  const ledger=JSON.parse(readFileSync(f.input.ledgerPath,'utf8'));
  expect(ledger.reservations[1].receipt.prompt_version).toBe('document-evidence-v1-fp1');
  expect(ledger.reservations[1].receipt.document_id).toBe(f.request.document.document_id);
  await expect(runtime.documentEvidenceExtractor!.extract(f.request)).rejects.toThrow('GENERATION_LIMIT');
  expect(sdk.parse).toHaveBeenCalledOnce();expect(sdk.count).toHaveBeenCalledOnce();
 }finally{runtime.close();}
});
it('shares the busy fence between payroll and non-payroll provider paths',async()=>{
 const f=await evidenceSetup(),runtime=createSolBudgetedExtractor(f.input);
 try{
  const pending=runtime.documentEvidenceExtractor!.extract(f.request);
  await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('BUSY');
  expect(()=>runtime.close()).toThrow('STILL_RUNNING');await pending;
 }finally{runtime.close();}
});
it('preserves count charges and prevents non-payroll generation after operator pause',async()=>{
 const f=await evidenceSetup();let active=true;
 const runtime=createSolBudgetedExtractor({...f.input,assertActive(){if(!active)throw Error('OPERATOR_PAUSED');}});
 sdk.count.mockImplementation(async()=>{active=false;return {object:'response.input_tokens',input_tokens:2000};});
 try{
  await expect(runtime.documentEvidenceExtractor!.extract(f.request)).rejects.toThrow('OPERATOR_PAUSED');
  expect(runtime.summary()).toMatchObject({contentRequests:1,countRequests:1,generations:0});expect(sdk.parse).not.toHaveBeenCalled();
 }finally{runtime.close();}
});
it('retains an unknown non-payroll count outcome without resetting or recalling it',async()=>{
 const f=await evidenceSetup(),runtime=createSolBudgetedExtractor(f.input);
 sdk.count.mockRejectedValue(Error('synthetic count disconnect'));
 try{await expect(runtime.documentEvidenceExtractor!.extract(f.request)).rejects.toThrow('synthetic count disconnect');
  expect(runtime.summary()).toMatchObject({contentRequests:1,unknownOutcomes:1});}finally{runtime.close();}
 const retained=readFileSync(f.input.ledgerPath,'utf8'),next=createSolBudgetedExtractor(f.input);
 try{await expect(next.documentEvidenceExtractor!.extract(f.request)).rejects.toThrow('REPLAY_REQUIRES_REVIEW');
  expect(readFileSync(f.input.ledgerPath,'utf8')).toBe(retained);expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).not.toHaveBeenCalled();}finally{next.close();}
});
it('reserves capacity for both non-payroll calls and preserves prior counters',async()=>{
 const f=await evidenceSetup();let ledger=newSolComparisonLedger();
 for(let i=1;i<=11;i++){
  const requestSha256=i.toString(16).padStart(64,'0');
  ledger=reserveSolRequest({ledger,sourceSha256:(i+100).toString(16).padStart(64,'0'),requestSha256,codeRevision:f.input.codeRevision,
   attempt:1,kind:'input_tokens',now:new Date().toISOString()});ledger=recordSolCount(ledger,requestSha256,100);
 }
 writeFileSync(f.input.ledgerPath,JSON.stringify(ledger));const before=readFileSync(f.input.ledgerPath,'utf8'),runtime=createSolBudgetedExtractor(f.input);
 try{await expect(runtime.documentEvidenceExtractor!.extract(f.request)).rejects.toThrow('BUDGET_CAPACITY');
  expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();expect(readFileSync(f.input.ledgerPath,'utf8')).toBe(before);
 }finally{runtime.close();}
});
it('records the actual completed non-payroll provider output with the exact authorized request hash',async()=>{
 const f=await evidenceSetup(),runtime=createSolBudgetedExtractor(f.input);
 sdk.parse.mockResolvedValue({id:'resp_synthetic_document_success',status:'completed',output_parsed:{schema_version:'document-evidence-provider-v1',
  detected_document_type:'attendance',page_count:1,pages:[{page:1,coverage:'partial',missing_regions:['synthetic empty page']}],observations:[],warnings:[]},
  model:'gpt-5.6-sol',_request_id:'req_synthetic_document_success',usage:{input_tokens:2000,output_tokens:300,total_tokens:2300}});
 try{const result=await runtime.documentEvidenceExtractor!.extract(f.request);expect(result.status).toBe('completed');
  const ledger=JSON.parse(readFileSync(f.input.ledgerPath,'utf8'));expect(ledger.reservations[1].receipt.request_sha256).toBe(ledger.reservations[0].requestSha256);
  expect(ledger.reservations[1].receipt.status).toBe('completed');expect(sdk.parse.mock.calls[0][0].max_output_tokens).toBe(10000);
 }finally{runtime.close();}
});
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

it('preserves a reviewed r6-to-r7 receipt but refuses using its old authorization for the now-active r8 prompt',async()=>{
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
  await expect(second.extractor.extractPreparedPass(pass)).rejects.toThrow('SOL_REVIEWED_RETRY_NEW_PROMPT_REQUIRED');
  const after=JSON.parse(readFileSync(input.ledgerPath,'utf8'));
  expect(JSON.stringify(after.reservations)).toBe(retained);
  expect(second.summary()).toMatchObject({contentRequests:2,generations:1,unknownOutcomes:0});
 }finally{second.close();}
});

async function r7History(){
 const {input,pass}=await setup(),first=createSolBudgetedExtractor(input);await first.extractor.extractPreparedPass(pass);first.close();
 let ledger=JSON.parse(readFileSync(input.ledgerPath,'utf8'));
 const {receipt_sha256:ignored,...body}=ledger.reservations[1].receipt;void ignored;
 const reservation={sourceSha256:input.allowedSources[0].sha256,requestSha256:'b'.repeat(64),codeRevision:input.codeRevision,attempt:2,now:new Date().toISOString()};
 ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens'});ledger=recordSolCount(ledger,reservation.requestSha256,2000);
 ledger=reserveSolRequest({ledger,...reservation,kind:'generation'});
 const prior=createOpenAiProviderReceipt({...body,request_sha256:reservation.requestSha256,extraction_id:randomUUID(),status:'completed',error_code:null,
  prompt_version:'payslip-extraction-openai-v2-first-r7-fp1',provider_response_id:'resp_prior_r7_synthetic',created_at:new Date().toISOString()});
 ledger=recordSolReceipt(ledger,prior);writeFileSync(input.ledgerPath,JSON.stringify(ledger));
 const reviewedPolicyRevalidation={purpose:'policy_revalidation' as const,reason:'explicit-source-scope-r8' as const,priorReceiptSha256:prior.receipt_sha256,
  fromPromptVersion:'payslip-extraction-openai-v2-first-r7-fp1' as const,toPromptVersion:'payslip-extraction-openai-v2-first-r8-fp1' as const};
 pass.request.extraction_id=randomUUID();pass.request.analysis_run_id=randomUUID();
 sdk.count.mockClear();sdk.parse.mockClear();
 sdk.parse.mockResolvedValue({id:'resp_new_r8_synthetic',status:'failed',output_parsed:null,model:'gpt-5.6-sol',_request_id:'req_new_r8_synthetic',usage:{input_tokens:2000,output_tokens:2,total_tokens:2002}});
 return {pass,ledger,input:{...input,reviewedPolicyRevalidation,allowedCaseIds:[pass.request.case_id],allowedVersionIds:[pass.request.document.document_id],expiresAt:new Date(Date.now()+180000).toISOString()}};
}
it('records r7-success to r8 as a bounded policy revalidation, preserving history and reusing a recorded outcome after restart',async()=>{
 const f=await r7History(),before=JSON.stringify(f.ledger.reservations),runtime=createSolBudgetedExtractor(f.input);
 const first=await runtime.extractor.extractPreparedPass(f.pass);expect(await runtime.extractor.extractPreparedPass(f.pass)).toEqual(first);runtime.close();
 const after=JSON.parse(readFileSync(f.input.ledgerPath,'utf8'));
 expect(JSON.stringify(after.reservations.slice(0,4))).toBe(before);expect(after.reservations.slice(4).map((r:{attempt:number})=>r.attempt)).toEqual([3,3]);
 expect(after.reservations.slice(4).every((r:{policyRevalidation:unknown})=>JSON.stringify(r.policyRevalidation)===JSON.stringify(f.input.reviewedPolicyRevalidation))).toBe(true);
 expect(sdk.count).toHaveBeenCalledTimes(1);expect(sdk.parse).toHaveBeenCalledTimes(1);
 const restarted=createSolBudgetedExtractor(f.input);try{expect(await restarted.extractor.extractPreparedPass(f.pass)).toEqual(first);}finally{restarted.close();}
 expect(sdk.count).toHaveBeenCalledTimes(1);expect(sdk.parse).toHaveBeenCalledTimes(1);
});
it('blocks a different uploaded version and a revoked work window without reserving or sending content',async()=>{
 const f=await r7History(),blocked=createSolBudgetedExtractor({...f.input,allowedVersionIds:[randomUUID()]});
 try{await expect(blocked.extractor.extractPreparedPass(f.pass)).rejects.toThrow('SOL_SAVED_VERSION_NOT_ALLOWED');}finally{blocked.close();}
 let active=true;const paused=createSolBudgetedExtractor({...f.input,assertActive(){if(!active)throw Error('OPERATOR_PAUSED');}});active=false;
 try{await expect(paused.extractor.extractPreparedPass(f.pass)).rejects.toThrow('OPERATOR_PAUSED');}finally{paused.close();}
 expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(f.input.ledgerPath,'utf8'))).toEqual(f.ledger);
});
it('preserves the counted reservation and stops before generation if the operator pauses during count',async()=>{
 const f=await r7History();let active=true;const runtime=createSolBudgetedExtractor({...f.input,assertActive(){if(!active)throw Error('OPERATOR_PAUSED');}});
 sdk.count.mockImplementation(async()=>{active=false;return {object:'response.input_tokens',input_tokens:2000};});
 try{await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('OPERATOR_PAUSED');}finally{runtime.close();}
 expect(sdk.count).toHaveBeenCalledTimes(1);expect(sdk.parse).not.toHaveBeenCalled();
 expect(JSON.parse(readFileSync(f.input.ledgerPath,'utf8')).reservations).toHaveLength(5);
});
it('requires room for both content requests before spending a count slot',async()=>{
 const f=await r7History();let ledger=f.ledger;
 for(let i=0;i<7;i++){
  const sourceSha256=(i+10).toString(16).padStart(64,'0'),requestSha256=(i+20).toString(16).padStart(64,'0');
  ledger=reserveSolRequest({ledger,sourceSha256,requestSha256,codeRevision:f.input.codeRevision,attempt:1,kind:'input_tokens',now:new Date().toISOString()});
  ledger=recordSolCount(ledger,requestSha256,1000);
 }
 writeFileSync(f.input.ledgerPath,JSON.stringify(ledger));const runtime=createSolBudgetedExtractor(f.input);
 try{await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('SOL_POLICY_REVALIDATION_BUDGET_CAPACITY');}finally{runtime.close();}
 expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();expect(JSON.parse(readFileSync(f.input.ledgerPath,'utf8'))).toEqual(ledger);
});
