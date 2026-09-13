import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-worker-contracts';
import type {RealServiceClaimAdmission} from './real-service-managed-case';
import {createRealServiceBudgetedExtraction,REAL_SERVICE_PROVIDER_PRICING} from './real-service-budgeted-extractor';
const sdk=vi.hoisted(()=>({count:vi.fn(),parse:vi.fn(),construct:vi.fn(),events:[] as string[]}));
vi.mock('server-only',()=>({}));
vi.mock('openai',()=>({default:class{responses={inputTokens:{count:sdk.count},parse:sdk.parse};constructor(options:unknown){sdk.construct(options);}}}));
const directories:string[]=[];const sha=(c:string)=>c.repeat(64);
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T05:00:00Z'));
 vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','1');
 sdk.events=[];sdk.construct.mockClear();sdk.count.mockReset().mockImplementation(async()=>{sdk.events.push('sdk-count');return {object:'response.input_tokens',input_tokens:2000};});
 sdk.parse.mockReset().mockImplementation(async()=>{sdk.events.push('sdk-generation');return {id:'resp_synthetic_unit_only',status:'failed',output_parsed:null,model:'gpt-5.6-sol',
  _request_id:'req_synthetic_unit_only',usage:{input_tokens:2000,output_tokens:2,total_tokens:2002}};});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const directory of directories.splice(0)){
 if(!path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep+'tivdoc-real-provider-unit-'))throw Error('UNSAFE_TEST_CLEANUP');rmSync(directory,{recursive:true,force:true});
}});
async function setup(){
 const directory=mkdtempSync(path.join(tmpdir(),'tivdoc-real-provider-unit-'));directories.push(directory);
 const pdf=await PDFDocument.create();pdf.addPage([595,842]);const bytes=await pdf.save();
 const source={sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,mimeType:'application/pdf' as const};
 const original=syntheticPayslipFixtures[0].request,request={...original,document:{...original.document,document_type:'payslip' as const,content_sha256:source.sha256,size_bytes:bytes.length,mime_type:source.mimeType}};
 const prepared=await preprocessPayslipDocument({bytes,mime_type:source.mimeType});
 const admission:RealServiceClaimAdmission={state:'admitted',reservation_id:randomUUID(),case_id:request.case_id,job_id:'synthetic-job',fencing_token:1,
  source_sha256:sha('a'),authority_dependency_sha256:sha('b'),plan_sha256:sha('c'),provider_budget_policy_sha256:sha('d'),extraction_mode:'budgeted_provider',expires_at:'2026-09-13T05:03:00Z'};
 const policy={schema_version:'real-service-provider-budget-policy-v1',namespace:'real',purpose:'real_customer_service',database_name:'synthetic_database',target_id:'synthetic-target',
  extraction_mode:'budgeted_provider',provider_calls_allowed:true,maximum_claims:2,maximum_active_claims:2,maximum_total_micro_usd:2850000,maximum_claim_micro_usd:1425000,maximum_calls_per_claim:4,
  issued_at:'2026-09-13T04:00:00Z',expires_at:'2026-09-13T06:00:00Z',request_limits:{model:'gpt-5.6-sol',input_token_ceiling:64000,output_token_ceiling:10000,count_reserved_micro_usd:256000,generation_reserved_micro_usd:456000}};
 const state={context:{state:'authorized',admission,policy,evaluated_at:'2026-09-13T05:00:00Z',expires_at:admission.expires_at},
  calls:[] as PostgresStatement[],requests:[] as Record<string,unknown>[],receipts:new Map<string,Record<string,unknown>>(),fail:'',mutateAck:(value:Record<string,unknown>)=>{void value;}};
 const transactions:SavedWorkerTransactions=async run=>{
  let mutation='';const context:PostgresTransactionContext={transaction_id:'synthetic-no-db',client:{async query(s){
   state.calls.push(s);if(state.fail===s.name)throw Error('REAL_SERVICE_PROVIDER_JOB_FENCE');
   let value:unknown;
   if(s.name==='real_service_provider_context')value=state.context;
   else if(s.name==='real_service_provider_request_reserve'){
    const [reservation,version,sourceSha,requestSha,kind]=s.values;
    let r=state.requests.find(r=>r.version_id===version&&r.source_sha256===sourceSha&&r.request_sha256===requestSha&&r.request_kind===kind);
    if(r)value={...r,dispatch:false};else{
     if(state.requests.some(q=>!state.receipts.has(String(q.request_id))||q.request_kind==='generation'&&state.receipts.get(String(q.request_id))?.token_usage===null))throw Error('REAL_SERVICE_PROVIDER_UNKNOWN_HELD');
     if(state.requests.length>=policy.maximum_calls_per_claim)throw Error('REAL_SERVICE_BUDGET_EXHAUSTED');
     r={state:'reserved',dispatch:true,request_id:randomUUID(),reservation_id:reservation,policy_sha256:admission.provider_budget_policy_sha256,case_id:admission.case_id,version_id:version,
      source_sha256:sourceSha,request_sha256:requestSha,request_kind:kind,reserved_micro_usd:kind==='input_tokens'?256000:456000,evaluated_at:state.context.evaluated_at,expires_at:state.context.expires_at};
     state.requests.push(r);value={...r};mutation=String(kind);state.mutateAck(value as Record<string,unknown>);
    }
   }else if(s.name==='real_service_provider_receipt_record'){
    const [requestId,json]=s.values,payload=JSON.parse(String(json));state.receipts.set(String(requestId),payload);value={state:'recorded',request_id:requestId,payload_sha256:canonicalSha256(payload)};mutation='receipt';
   }else throw Error('UNEXPECTED_SQL');
   return {row_count:1,rows:[{value}]};
  }}};
  const value=await run(context);if(state.fail==='commit-reserve'&&mutation&&mutation!=='receipt')throw Error('SYNTHETIC_UNCERTAIN_COMMIT');
  if(mutation)sdk.events.push(`commit-${mutation}`);return value;
 };
 const input={transactions,apiKey:'synthetic-unit-test-no-network',artifactDirectory:directory};
 const pass={request,prepared,kind:'first_pass' as const,requestedFields:[],sourcePageCount:1};
 return {input,admission,policy,state,pass,source,directory};
}
it('commits count and generation separately before actual existing SDK calls and retains private mapped receipts',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission),result=await runtime.extractor.extractPreparedPass(f.pass);
 expect(result.provider_receipt?.origin).toBe('openai_live');expect(sdk.events).toEqual(['commit-input_tokens','sdk-count','commit-receipt','commit-generation','sdk-generation','commit-receipt']);
 expect(f.state.requests).toHaveLength(2);expect(f.state.receipts.size).toBe(2);
 expect(sdk.construct.mock.calls.every(([o])=>o.maxRetries===0&&o.baseURL==='https://api.openai.com/v1')).toBe(true);
 const generation=f.state.requests.find(r=>r.request_kind==='generation')!;
 expect(canonicalSha256(sdk.parse.mock.calls[0][0])).toBe(generation.request_sha256);
 const mapped=JSON.parse(readFileSync(path.join(f.directory,f.admission.reservation_id,String(generation.request_id),'mapped.json'),'utf8'));
 expect(mapped.provider_receipt.receipt_sha256).toBe(result.provider_receipt?.receipt_sha256);
 expect(f.state.calls.filter(c=>c.name==='real_service_provider_request_reserve').every(c=>c.values[0]===f.admission.reservation_id&&c.values[1]===f.pass.request.document.document_id)).toBe(true);
});
it.each(['case','bytes','hash','pages','crops'] as const)('blocks foreign/changed %s before any SDK or reservation',async kind=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);
 if(kind==='case')f.pass.request.case_id=randomUUID();if(kind==='bytes')f.pass.prepared.original.bytes[0]=0;if(kind==='hash')f.pass.request.document.content_sha256=sha('e');
 if(kind==='pages')f.pass.sourcePageCount=2;if(kind==='crops')f.pass.prepared={...f.pass.prepared,crops:Array.from({length:5},()=>({}) as typeof f.pass.prepared.crops[number])};
 await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow();expect(f.state.requests).toHaveLength(0);expect(sdk.count).not.toHaveBeenCalled();expect(sdk.parse).not.toHaveBeenCalled();
});
it.each(['missing','underpriced','model','source','expired'] as const)('refuses %s claim/policy before SDK construction',async kind=>{
 const f=await setup();if(kind==='missing')f.state.fail='real_service_provider_context';if(kind==='underpriced')f.policy.request_limits.generation_reserved_micro_usd=1;
 if(kind==='model')f.policy.request_limits.model='foreign-model';if(kind==='source')f.state.context.admission={...f.admission,source_sha256:sha('e')};
 if(kind==='expired')f.state.context.expires_at=f.state.context.evaluated_at;
 await expect(createRealServiceBudgetedExtraction(f.input).forClaim(f.admission)).rejects.toThrow();expect(sdk.construct).not.toHaveBeenCalled();
});
it.each(['request_sha256','version_id','case_id','reserved_micro_usd','expires_at'] as const)('refuses a changed reservation %s before egress',async field=>{
 const f=await setup();f.state.mutateAck=v=>{v[field]=field==='reserved_micro_usd'?1:field==='expires_at'?'2026-09-13T07:00:00Z':field==='request_sha256'?sha('e'):randomUUID();};
 const runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);
 await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('REAL_SERVICE_PROVIDER_RESERVATION_CHANGED');expect(sdk.count).not.toHaveBeenCalled();
});
it('holds an uncertain reservation COMMIT and never calls the provider',async()=>{
 const f=await setup();f.state.fail='commit-reserve';const runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);
 await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('SYNTHETIC_UNCERTAIN_COMMIT');expect(sdk.count).not.toHaveBeenCalled();
});
it('retains an unknown count and prevents restart or changed-prompt recall',async()=>{
 const f=await setup(),factory=createRealServiceBudgetedExtraction(f.input),runtime=await factory.forClaim(f.admission);sdk.count.mockRejectedValue(Error('synthetic-provider-loss'));
 await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('synthetic-provider-loss');expect(f.state.receipts.size).toBe(0);
 const restarted=await factory.forClaim(f.admission);await expect(restarted.extractor.extractPreparedPass(f.pass)).rejects.toThrow('REAL_SERVICE_PROVIDER_REPLAY_HELD');
 await expect(restarted.extractor.extractPreparedPass({...f.pass,kind:'targeted_recovery',requestedFields:['gross_salary']})).rejects.toThrow('REAL_SERVICE_PROVIDER_UNKNOWN_HELD');
 expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).not.toHaveBeenCalled();
});
it('snapshots the actual request before asynchronous counting so caller mutation cannot change egress',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);
 sdk.count.mockImplementation(async()=>{Object.assign(f.pass,{kind:'targeted_recovery',requestedFields:['gross_salary']});f.pass.prepared.original.bytes[0]=0;
  return {object:'response.input_tokens',input_tokens:2000};});
 const result=await runtime.extractor.extractPreparedPass(f.pass),generation=f.state.requests.find(r=>r.request_kind==='generation')!;
 expect(result.provider_receipt?.pass_kind).toBe('first_pass');expect(canonicalSha256(sdk.parse.mock.calls[0][0])).toBe(generation.request_sha256);
});
it('requires another reserved pair for recovery and stops at the same finite claim cap',async()=>{
 const f=await setup();f.policy.maximum_calls_per_claim=2;const runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);
 await runtime.extractor.extractPreparedPass(f.pass);
 await expect(runtime.extractor.extractPreparedPass({...f.pass,kind:'targeted_recovery',requestedFields:['gross_salary']})).rejects.toThrow('REAL_SERVICE_BUDGET_EXHAUSTED');
 expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).toHaveBeenCalledOnce();expect(f.state.requests).toHaveLength(2);
});
it('honors cancellation after counting without starting generation',async()=>{
 const f=await setup(),signal=new AbortController(),runtime=await createRealServiceBudgetedExtraction({...f.input,signal:signal.signal}).forClaim(f.admission);
 sdk.count.mockImplementation(async()=>{signal.abort();return {object:'response.input_tokens',input_tokens:2000};});
 await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('SAVED_JOB_INTERRUPTED');expect(sdk.parse).not.toHaveBeenCalled();expect(f.state.requests).toHaveLength(1);
});
it('records a count beyond the input ceiling but never generates',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);sdk.count.mockResolvedValue({object:'response.input_tokens',input_tokens:64001});
 await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow('REAL_SERVICE_PROVIDER_INPUT_LIMIT');expect(f.state.receipts.size).toBe(1);expect(sdk.parse).not.toHaveBeenCalled();
});
it('keeps generation without provider usage reserved and prevents another generation',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);sdk.parse.mockRejectedValue(Error('synthetic-provider-loss'));
 const result=await runtime.extractor.extractPreparedPass(f.pass);expect(result.provider_receipt?.status).toBe('failed');expect(result.provider_receipt?.token_usage).toBeNull();
 await expect(runtime.extractor.extractPreparedPass({...f.pass,kind:'targeted_recovery',requestedFields:['gross_salary']})).rejects.toThrow('REAL_SERVICE_PROVIDER_UNKNOWN_HELD');
 expect(sdk.parse).toHaveBeenCalledOnce();expect(f.state.requests.reduce((n,r)=>n+Number(r.reserved_micro_usd),0)).toBe(712000);
});
it('routes document evidence through its genuine FromEnv SDK and authorization callback',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);
 const result=await runtime.documentEvidence!.extractor.extract({document:{...f.pass.request.document,document_type:'contract'},source:{read:async()=>f.pass.prepared.original.bytes},
  analysisRunId:randomUUID(),extractionId:randomUUID(),createdAt:new Date().toISOString()});
 expect(parseOpenAiProviderReceipt(result.provider_receipt).origin).toBe('openai_live');expect(sdk.count).toHaveBeenCalledOnce();expect(sdk.parse).toHaveBeenCalledOnce();
 expect(sdk.events.indexOf('commit-generation')).toBeLessThan(sdk.events.indexOf('sdk-generation'));expect(sdk.parse.mock.calls[0][0].text.format.name).toBe('document-evidence-v1-fp1');
});
it('shares one busy fence across payslip/document evidence',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission),pending=runtime.extractor.extractPreparedPass(f.pass);
 await expect(runtime.documentEvidence!.extractor.extract({document:{...f.pass.request.document,document_type:'attendance'},source:{read:async()=>f.pass.prepared.original.bytes},analysisRunId:randomUUID(),extractionId:randomUUID(),createdAt:new Date().toISOString()})).rejects.toThrow('REAL_SERVICE_PROVIDER_BUSY');await pending;
});
it('retains mapped artifacts when receipt settlement loses its connection',async()=>{
 const f=await setup(),runtime=await createRealServiceBudgetedExtraction(f.input).forClaim(f.admission);sdk.parse.mockImplementation(async()=>{
  f.state.fail='real_service_provider_receipt_record';return {id:'resp_synthetic',status:'failed',output_parsed:null,model:'gpt-5.6-sol',usage:{input_tokens:2000,output_tokens:1,total_tokens:2001}};
 });await expect(runtime.extractor.extractPreparedPass(f.pass)).rejects.toThrow();
 const generation=f.state.requests.find(r=>r.request_kind==='generation')!;expect(readdirSync(path.join(f.directory,f.admission.reservation_id,String(generation.request_id)))).toContain('mapped.json');
 expect(f.state.receipts.has(String(generation.request_id))).toBe(false);
});
it('expires pricing and independent REAL kill switches without touching historical ledgers',async()=>{
 const f=await setup();vi.setSystemTime(new Date(REAL_SERVICE_PROVIDER_PRICING.validUntil));await expect(createRealServiceBudgetedExtraction(f.input).forClaim({...f.admission,expires_at:'2026-09-18T00:00:00Z'})).rejects.toThrow('REAL_SERVICE_PROVIDER_PRICING_EXPIRED');
 vi.setSystemTime(new Date('2026-09-13T05:00:00Z'));vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','0');await expect(createRealServiceBudgetedExtraction(f.input).forClaim(f.admission)).rejects.toThrow('REAL_SERVICE_PROVIDER_DISABLED');expect(f.state.calls).toHaveLength(0);
});
