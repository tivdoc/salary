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
afterEach(()=>{vi.unstubAllEnvs();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
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
