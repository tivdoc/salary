import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {devFinancialInputFixture} from '@/server/product/processing/dev-financial-flow.fixture';
import {newSolComparisonLedger} from '@/server/product/processing/live-extraction-sol-comparison-budget';
import {createManagedSolBudgetedExtractor} from '@/server/product/processing/sol-budgeted-extractor';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import {OpenAiPayslipV2PassExtractor} from './v2-adapter';
import {runOpenAiPayslipExtractionV21} from './v21-adapter';
import {OPENAI_SOL_COMPARISON_PROFILE} from './v2-request';
import {authorizeManagedOpenAiRecovery} from './managed-package-recovery';

const io=vi.hoisted(()=>({packageBytes:Buffer.alloc(0),ledgerBytes:Buffer.alloc(0),parse:vi.fn(),count:vi.fn(),construct:vi.fn(),lock:vi.fn(),close:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/product/processing/sol-budget-lock',()=>({acquireSolBudgetLock:io.lock,recoverStaleSolBudgetLock:vi.fn()}));
vi.mock('node:fs',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs')>();
 return {...fs,readFileSync:(file:Parameters<typeof fs.readFileSync>[0],encoding?:string)=>{
  const name=String(file).replaceAll('\\','/');
  const bytes=name.endsWith('/sol-scheduled-package-20260911.private.json')?io.packageBytes:name.endsWith('/sol-scheduled-20260911/package-budget-ledger.json')?io.ledgerBytes:null;
  return bytes?encoding?bytes.toString('utf8'):bytes:fs.readFileSync(file,encoding as BufferEncoding);
 },mkdirSync:(file:Parameters<typeof fs.mkdirSync>[0],options?:Parameters<typeof fs.mkdirSync>[1])=>{
  if(String(file).replaceAll('\\','/').endsWith('/sol-scheduled-20260911/provider'))return undefined;
  return fs.mkdirSync(file,options);
 }};
});
vi.mock('openai',()=>({default:class{responses={parse:io.parse,inputTokens:{count:io.count}};constructor(input:unknown){io.construct(input);}}}));
beforeEach(()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('VERCEL','');vi.stubEnv('VERCEL_ENV','');vi.stubEnv('TIVDOC_SOL_SAVED_WORKER_PROOF','');
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-09-11T01:00:00Z');
 io.parse.mockReset();io.count.mockReset();io.construct.mockReset();io.close.mockReset();io.lock.mockReset().mockReturnValue({close:io.close});
 io.ledgerBytes=Buffer.from(JSON.stringify(newSolComparisonLedger()));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(){
 const document=await devFinancialInputFixture(true),original=syntheticPayslipFixtures[0].request;
 const request={...original,document:{...original.document,content_sha256:document.sha256,size_bytes:document.bytes.length,document_period:null}};
 const config={version:'sol-scheduled-dev-package-20260911-v1',enabled:true,buildSha:'a'.repeat(40),expiresAt:'2026-09-11T04:00:00Z',
  ledgerPath:path.resolve('output/release-completion/sol-scheduled-20260911/package-budget-ledger.json'),artifactDirectory:path.resolve('output/release-completion/sol-scheduled-20260911/provider'),
  allowedCaseIds:[request.case_id],allowedSources:[{sha256:document.sha256,sizeBytes:document.bytes.length,mimeType:'application/pdf'}]};
 const env={NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:'synthetic_capability_'.repeat(3),
  TIVDOC_MANAGED_DEV_BUILD_SHA:config.buildSha,TIVDOC_WORKER_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu:synthetic-password@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907',
  NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',OPENAI_EXTRACTION_MODEL:'gpt-5.6-sol',OPENAI_API_KEY:'synthetic-unit-no-network',
  TIVDOC_MANAGED_SOL_PACKAGE_FILE:path.resolve('../release-work/sol-scheduled-package-20260911.private.json')};
 io.packageBytes=Buffer.from(JSON.stringify(config));
 const issue=()=>authorizeManagedOpenAiRecovery({apiKey:env.OPENAI_API_KEY,buildSha:config.buildSha,environment:env,packageSha256:createHash('sha256').update(io.packageBytes).digest('hex')});
 const adapter=(authority=issue())=>new OpenAiPayslipV2PassExtractor({apiKey:env.OPENAI_API_KEY,model:'gpt-5.6-sol',timeoutMs:1000},
  {extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution:'skip_managed_package_budget',managedRecoveryAuthority:authority});
 const run=(extractor:OpenAiPayslipV2PassExtractor)=>runOpenAiPayslipExtractionV21({request,extractor,source:{async read(){return document.bytes;}},reference_year:2026,
  snapshot_context:{case_id:request.case_id,analysis_run_id:request.analysis_run_id,snapshot_id:randomUUID(),schema_version:'1.0',created_at:request.requested_at,
   fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(field=>[field,randomUUID()]))}});
 return {document,request,config,env,issue,adapter,run};
}
it('the real managed factory constructs in development with a validated private permit and no SDK request',async()=>{
 const f=await fixture(),runtime=createManagedSolBudgetedExtractor(f.env,f.config.buildSha);
 expect(runtime.extractor.recoveryExecution).toBe('skip_managed_package_budget');expect(io.count).not.toHaveBeenCalled();expect(io.parse).not.toHaveBeenCalled();
 expect(io.construct.mock.calls.every(([config])=>config.baseURL==='https://api.openai.com/v1'&&config.maxRetries===0)).toBe(true);
 runtime.close();expect(io.close).toHaveBeenCalledOnce();
});
it('retains first-pass receipt, missing hours and honest skipped recovery through the ordinary V2.1 runner (SDK mocked only)',async()=>{
 const f=await fixture();io.parse.mockResolvedValue({id:'resp_explicit_unit_mock',status:'completed',output_parsed:f.document.output,usage:null,model:'gpt-5.6-sol'});
 const result=await f.run(f.adapter());
 expect(io.parse).toHaveBeenCalledOnce();expect(result.result.recovery_passes).toEqual([]);
 expect(result.result.recovery_decision).toMatchObject({requested:false,skipped:true});
 expect(result.result.recovery_decision.reason_codes).toContain('recovery_skipped_package_budget');
 expect(result.result.recovery_decision.fields_requested).toContain('regular_hours');
 expect(result.result.final_extraction.fields.filter(field=>field.field==='regular_hours'&&field.normalized_value!==null)).toEqual([]);
 expect(result.result.final_validation.issues.some(issue=>issue.field_keys.includes('regular_hours'))).toBe(true);
 expect(result.provider_receipts).toHaveLength(1);
});
it.each(['production','preview','test'] as const)('refuses %s actual runtime even with a previously issued permit',async mode=>{
 const f=await fixture(),authority=f.issue();
 if(mode==='preview')vi.stubEnv('VERCEL_ENV','preview');else vi.stubEnv('NODE_ENV',mode);
 expect(()=>f.adapter(authority)).toThrow('MANAGED_RECOVERY_AUTHORITY');expect(io.construct).not.toHaveBeenCalled();
});
it('refuses forged, copied and wrong-key permits, and injected transport before SDK construction',async()=>{
 const f=await fixture(),authority=f.issue();
 for(const forged of [{kind:'managed-openai-package-recovery-v1' as const},{...authority}])expect(()=>f.adapter(forged)).toThrow('MANAGED_RECOVERY_AUTHORITY');
 const options={executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution:'skip_managed_package_budget' as const,managedRecoveryAuthority:authority};
 expect(()=>new OpenAiPayslipV2PassExtractor({apiKey:'wrong-key',model:'gpt-5.6-sol',timeoutMs:1000},options)).toThrow('MANAGED_RECOVERY_AUTHORITY');
 expect(()=>new OpenAiPayslipV2PassExtractor({apiKey:f.env.OPENAI_API_KEY,model:'gpt-5.6-sol',timeoutMs:1000},{...options,transport:{parse:io.parse}})).toThrow('RECOVERY_EXECUTION_SCOPE');
 expect(io.construct).not.toHaveBeenCalled();
});
it.each(['changed','expired','foreign_case','foreign_source'])('refuses %s before the first provider call',async mode=>{
 const f=await fixture();
 if(mode==='foreign_source')io.packageBytes=Buffer.from(JSON.stringify({...f.config,allowedSources:[{...f.config.allowedSources[0],sha256:'f'.repeat(64)}]}));
 if(mode==='foreign_case')io.packageBytes=Buffer.from(JSON.stringify({...f.config,allowedCaseIds:[randomUUID()]}));
 const extractor=f.adapter();
 if(mode==='changed')io.packageBytes=Buffer.from(JSON.stringify({...f.config,enabled:false}));
 if(mode==='expired')vi.setSystemTime('2026-09-11T04:00:00Z');
 await expect(f.run(extractor)).rejects.toThrow('MANAGED_RECOVERY_AUTHORITY');expect(io.parse).not.toHaveBeenCalled();
});
it('does not let managed mode enable the original test-only skip policy',async()=>{
 await fixture();expect(()=>new OpenAiPayslipV2PassExtractor({apiKey:null,model:'gpt-5.6-sol',timeoutMs:1000},
  {executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution:'skip_package_budget'})).toThrow('RECOVERY_EXECUTION_SCOPE');
});
