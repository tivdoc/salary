import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {runOpenAiPayslipExtractionV21} from '@/server/engine/extraction/providers/openai/v21-adapter';
import {devFinancialInputFixture} from './dev-financial-flow.fixture';
import {createManagedSolBudgetedExtractor} from './sol-budgeted-extractor';
import {newSolComparisonLedger,reserveSolRequest,recordSolCount,recordSolReceipt} from './live-extraction-sol-comparison-budget';
import {managedSolLiveWindowSchema,assertManagedSolLiveLedger,assertManagedSolLiveLedgerTransition,readManagedSolLiveWindow,type ManagedSolLiveWindow} from './managed-sol-live-window';

const sdk=vi.hoisted(()=>({count:vi.fn(),parse:vi.fn(),construct:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('openai',()=>({default:class{responses={inputTokens:{count:sdk.count},parse:sdk.parse};constructor(options:unknown){sdk.construct(options);}}}));
const dirs:string[]=[];
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-09-12T12:00:00Z');
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('VERCEL','');vi.stubEnv('VERCEL_ENV','');vi.stubEnv('TIVDOC_SOL_SAVED_WORKER_PROOF','');
 sdk.construct.mockReset();sdk.count.mockReset().mockResolvedValue({object:'response.input_tokens',input_tokens:2000});sdk.parse.mockReset();
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const dir of dirs.splice(0)){
 // Test-created directories only, resolved and checked before recursive removal.
 if(path.dirname(dir)!==path.resolve('../release-work')||!path.basename(dir).startsWith('synthetic-live-window-test-'))throw Error('TEST_PATH');
 rmSync(dir,{recursive:true,force:true});
}});
async function fixture(){
 const directory=mkdtempSync(path.resolve('../release-work/synthetic-live-window-test-'));dirs.push(directory);
 const document=await devFinancialInputFixture(true),original=syntheticPayslipFixtures[0].request;
 const request={...original,document:{...original.document,content_sha256:document.sha256,size_bytes:document.bytes.length,document_period:null}};
 let ledger=newSolComparisonLedger();const unknown:string[]=[];let priorReceiptSha256='';
 // Synthetic historical SDK receipts, confined to the unit-test directory.
 // Two failed unknown-cost receipts remain charged, followed by an R7 success.
 for(let n=0;n<5;n++){
  const sourceSha256=n===0||n===2?document.sha256:String(n).repeat(64),requestSha256=String(n+5).repeat(64),failed=n<2;
  const reservation={sourceSha256,requestSha256,codeRevision:'b'.repeat(40),attempt:n===2?2:1,now:'2026-09-12T11:00:00Z'};
  ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens'});ledger=recordSolCount(ledger,requestSha256,1000);
  ledger=reserveSolRequest({ledger,...reservation,kind:'generation'});
  const receipt=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'openai_live',case_id:request.case_id,
   analysis_run_id:randomUUID(),document_id:randomUUID(),extraction_id:randomUUID(),source_sha256:sourceSha256,source_size_bytes:document.bytes.length,
   source_mime_type:'application/pdf',source_page_count:1,request_sha256:requestSha256,raw_extraction_sha256:'f'.repeat(64),pass_kind:'first_pass',
   requested_model:'gpt-5.6-sol',actual_model:failed?null:'gpt-5.6-sol',extractor_version:'payslip-extraction-v2.1',prompt_version:'payslip-extraction-openai-v2-first-r7-fp1',
   provider_response_id:failed?null:'resp_synthetic_history_'+n,provider_request_id:null,provider_attempted:true,status:failed?'failed':'completed',
   error_code:failed?'provider_timeout':null,http_status:failed?503:200,duration_ms:10,token_usage:failed?null:{input_tokens:1000,output_tokens:10,total_tokens:1010},
   cost:{status:'not_returned_by_provider',amount_usd:null},created_at:'2026-09-12T11:00:01Z'});
  ledger=recordSolReceipt(ledger,receipt);if(failed)unknown.push(receipt.receipt_sha256);if(n===2)priorReceiptSha256=receipt.receipt_sha256;
 }
 const ledgerPath=path.join(directory,'ledger.json'),packagePath=path.join(directory,'window.private.json'),capability='synthetic_unit_capability_'.repeat(3);
 const originalLedger=JSON.stringify(ledger,null,2)+'\n';writeFileSync(ledgerPath,originalLedger);
 const config:ManagedSolLiveWindow=managedSolLiveWindowSchema.parse({version:'sol-managed-live-window-v2',enabled:true,authorizationId:randomUUID(),
  authorizedAt:'2026-09-12T11:59:00Z',expiresAt:'2026-09-12T12:30:00Z',buildSha:'a'.repeat(40),capabilitySha256:hash(capability),ledgerPath,
  artifactDirectory:path.join(directory,'provider'),baseline:{fileSha256:hash(originalLedger),reservationsSha256:canonicalSha256(ledger.reservations),
   contentRequests:10,reservedMicroUsd:3560000,acknowledgedUnknownReceiptSha256s:unknown},
  source:{caseId:request.case_id,versionId:request.document.document_id,sha256:document.sha256,sizeBytes:document.bytes.length,mimeType:'application/pdf'},
  maxContentRequests:2,maxGenerations:1,maxReservedMicroUsd:712000,recovery:'disabled',retry:'disabled',
  policyRevalidation:{purpose:'policy_revalidation',reason:'explicit-source-scope-r8',priorReceiptSha256,
   fromPromptVersion:'payslip-extraction-openai-v2-first-r7-fp1',toPromptVersion:'payslip-extraction-openai-v2-first-r8-fp1'}});
 const save=()=>writeFileSync(packagePath,JSON.stringify(config,null,2)+'\n');save();
 const env={NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:capability,
  TIVDOC_MANAGED_DEV_BUILD_SHA:config.buildSha,TIVDOC_WORKER_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu:synthetic-password@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907',
  NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',OPENAI_EXTRACTION_MODEL:'gpt-5.6-sol',OPENAI_API_KEY:'synthetic-no-network',
  TIVDOC_MANAGED_SOL_PACKAGE_FILE:packagePath};
 sdk.parse.mockResolvedValue({id:'resp_explicit_synthetic_new_r8',status:'completed',output_parsed:document.output,usage:null,model:'gpt-5.6-sol'});
 const context={case_id:request.case_id,analysis_run_id:request.analysis_run_id,snapshot_id:randomUUID(),schema_version:'1.0',created_at:request.requested_at,
  fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(field=>[field,randomUUID()]))};
 const run=(runtime:ReturnType<typeof createManagedSolBudgetedExtractor>,next=request)=>runOpenAiPayslipExtractionV21({request:next,extractor:runtime.extractor,
  source:{async read(){return document.bytes;}},reference_year:2026,snapshot_context:context});
 return {directory,document,request,config,save,env,ledger,originalLedger,ledgerPath,run};
}
it('admits a later bounded window through the real managed factory and ordinary mapper/resolver, preserving ten historical rows',async()=>{
 const f=await fixture(),runtime=createManagedSolBudgetedExtractor(f.env,f.config.buildSha);
 try{
  const result=await f.run(runtime);
  const receipts=result.provider_receipts;expect(receipts).toHaveLength(1);if(!receipts?.[0])throw Error('SYNTHETIC_PROVIDER_RECEIPT_REQUIRED');
  expect(receipts[0]).toMatchObject({origin:'openai_live',document_id:f.request.document.document_id,prompt_version:'payslip-extraction-openai-v2-first-r8-fp1'});
  expect(result.result.recovery_passes).toEqual([]);expect(result.result.recovery_decision.reason_codes).toContain('recovery_skipped_package_budget');
  expect(result.result.final_extraction.fields.filter(field=>field.field==='regular_hours'&&field.normalized_value!==null)).toEqual([]);
  const after=JSON.parse(readFileSync(f.ledgerPath,'utf8'));expect(after.reservations.slice(0,10)).toEqual(f.ledger.reservations);
  expect(()=>assertManagedSolLiveLedgerTransition(f.config,f.ledger,after)).not.toThrow();
  expect(()=>assertManagedSolLiveLedgerTransition(f.config,after,f.ledger)).toThrow('SOL_LIVE_WINDOW_LEDGER_ROLLBACK');
  const changedCount=structuredClone(after);changedCount.reservations[10].inputTokens++;
  expect(()=>assertManagedSolLiveLedgerTransition(f.config,after,changedCount)).toThrow('SOL_LIVE_WINDOW_LEDGER_REWRITE');
  expect(JSON.parse(readFileSync(path.join(f.config.artifactDirectory,receipts[0].extraction_id,'source-context.json'),'utf8')).managedLiveWindow)
   .toMatchObject({version:f.config.version,authorizationId:f.config.authorizationId,baselineLedgerSha256:f.config.baseline.fileSha256});
  const foreign=structuredClone(after),{receipt_sha256:ignored,...body}=foreign.reservations[11].receipt;void ignored;
  foreign.reservations[11].receipt=createOpenAiProviderReceipt({...body,document_id:randomUUID()});
  expect(()=>assertManagedSolLiveLedger(f.config,foreign)).toThrow('SOL_LIVE_WINDOW_CURRENT_RECEIPT');
  expect(after.reservations.slice(10).map((row:{attempt:number})=>row.attempt)).toEqual([3,3]);
  expect(runtime.summary()).toMatchObject({contentRequests:12,reservedUpperBoundUsd:4.272,unknownOutcomes:2,instanceGenerations:1});
  const repeated=await f.run(runtime);expect(repeated).toEqual(result);
  expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).toHaveBeenCalledOnce();
  expect(sdk.construct.mock.calls.every(([config])=>config.maxRetries===0)).toBe(true);
 }finally{runtime.close();}
 const restarted=createManagedSolBudgetedExtractor(f.env,f.config.buildSha);try{await f.run(restarted);expect(sdk.parse).toHaveBeenCalledOnce();}finally{restarted.close();}
});
it.each(['version','case','kind','source'] as const)('refuses a foreign %s before any content request',async kind=>{
 const f=await fixture(),runtime=createManagedSolBudgetedExtractor(f.env,f.config.buildSha),request=structuredClone(f.request);
 if(kind==='version')request.document.document_id=randomUUID();if(kind==='case')request.case_id=request.document.case_id=randomUUID();
 if(kind==='kind')request.document.document_type='contract';if(kind==='source')request.document.content_sha256='a'.repeat(64);
 try{await expect(f.run(runtime,request)).rejects.toThrow();expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();
  expect(readFileSync(f.ledgerPath,'utf8')).toBe(f.originalLedger);}finally{runtime.close();}
});
it.each(['expired','future','long','capability','build','receipt_only','production'] as const)('rejects %s authorization before constructing SDK',async kind=>{
 const f=await fixture();if(kind==='expired')f.config.expiresAt='2026-09-12T11:59:30Z';if(kind==='future')f.config.authorizedAt='2026-09-12T12:01:00Z';
 if(kind==='long')f.config.expiresAt='2026-09-12T16:00:00Z';if(kind==='capability')f.config.capabilitySha256='d'.repeat(64);if(kind==='build')f.config.buildSha='d'.repeat(40);f.save();
 const env={...f.env,...(kind==='receipt_only'?{TIVDOC_MANAGED_EXTRACTION_MODE:'saved_receipts_only'}:{}),...(kind==='production'?{VERCEL_ENV:'production'}:{})};
 expect(()=>createManagedSolBudgetedExtractor(env,'a'.repeat(40))).toThrow();expect(sdk.construct).not.toHaveBeenCalled();
});
it.each(['file','prefix','acknowledgement','unresolved'] as const)('rejects %s history without rewriting the ledger',async kind=>{
 const f=await fixture();if(kind==='file')f.config.baseline.fileSha256='e'.repeat(64);if(kind==='prefix')f.config.baseline.reservationsSha256='e'.repeat(64);
 if(kind==='acknowledgement')f.config.baseline.acknowledgedUnknownReceiptSha256s=[];
 if(kind==='unresolved'){f.ledger.reservations[9].outcome='reserved_unknown';f.ledger.reservations[9].inputTokens=null;f.ledger.reservations[9].receipt=null;
  const bytes=JSON.stringify(f.ledger);writeFileSync(f.ledgerPath,bytes);f.config.baseline.fileSha256=hash(bytes);f.config.baseline.reservationsSha256=canonicalSha256(f.ledger.reservations);}
 f.save();const before=readFileSync(f.ledgerPath,'utf8');expect(()=>createManagedSolBudgetedExtractor(f.env,f.config.buildSha)).toThrow();
 expect(readFileSync(f.ledgerPath,'utf8')).toBe(before);expect(sdk.construct).not.toHaveBeenCalled();
});
it.each(['pause','expire','ledger_change'] as const)('stops after count on %s; no generation or automatic recall',async kind=>{
 const f=await fixture(),runtime=createManagedSolBudgetedExtractor(f.env,f.config.buildSha);
 sdk.count.mockImplementation(async()=>{if(kind==='pause')writeFileSync(f.env.TIVDOC_MANAGED_SOL_PACKAGE_FILE,'{}');
  if(kind==='expire')vi.setSystemTime('2026-09-12T12:30:00Z');if(kind==='ledger_change')writeFileSync(f.ledgerPath,f.originalLedger+' ');
  return {object:'response.input_tokens',input_tokens:2000};});
 try{await expect(f.run(runtime)).rejects.toThrow();expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).not.toHaveBeenCalled();}finally{runtime.close();}
 if(kind==='pause')f.save();if(kind==='expire')vi.setSystemTime('2026-09-12T12:01:00Z');
 if(kind!=='ledger_change'){const retry=createManagedSolBudgetedExtractor(f.env,f.config.buildSha);try{await expect(f.run(retry)).rejects.toThrow();expect(sdk.count).toHaveBeenCalledOnce();}finally{retry.close();}}
});
it('bounds the schema and refuses an appended foreign row or an external ledger path',async()=>{
 const f=await fixture();expect(managedSolLiveWindowSchema.safeParse({...f.config,maxGenerations:2}).success).toBe(false);
 expect(managedSolLiveWindowSchema.safeParse({...f.config,maxReservedMicroUsd:1440000}).success).toBe(false);
 const changed=structuredClone(f.ledger);changed.reservations.push({...changed.reservations[0],key:'c'.repeat(64)+':1:input_tokens',sourceSha256:'c'.repeat(64)});
 expect(()=>assertManagedSolLiveLedger(f.config,changed)).toThrow();f.config.ledgerPath=path.resolve('../../foreign-ledger.json');f.save();
 expect(()=>readManagedSolLiveWindow(f.env,f.config.buildSha)).toThrow();
});
