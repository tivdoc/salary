import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {CANONICAL_POSTGRES_SCHEMA_VERSION} from '@/server/platform/composition/canonical-postgres';
import {readRealServiceCandidates,admitRealServiceSavedReceiptsClaim,admitRealServiceBudgetedProviderClaim,connectRealServiceController} from './real-service-controller';
import type {RealServiceClaimRequest} from './real-service-managed-case';
vi.mock('server-only',()=>({}));
vi.mock('./ai-release-build',()=>({getCompiledAiReleaseBuild:()=>({manifest:{sha256:'f'.repeat(64)}})}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(c:string)=>c.repeat(64);
beforeEach(()=>{vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function setup(){
 const target={schema_version:'real-service-worker-target-v1' as const,target_id:'synthetic-real',host:'db.example.test',port:5432,database:'synthetic',login:'tivdoc_worker_runtime',
  environment:'test' as const,deployment_sha256:sha('a'),machine_issuer_sha256:sha('b'),provider_budget_policy_sha256:sha('c')};
 const candidate={case_id:id(1),identity_id:id(2),enrollment_id:id(3),source_revision:1,source_sha256:sha('d'),authority_dependency_sha256:sha('e'),plan_sha256:sha('0'),expires_at:'2026-09-13T00:10:00Z'};
 const batch={evaluated_at:'2026-09-13T00:00:00Z',expires_at:candidate.expires_at,candidates:[candidate]},actual={database:target.database,principal:'tivdoc_worker_runtime',schema_version:CANONICAL_POSTGRES_SCHEMA_VERSION};
 const admission={state:'admitted' as const,reservation_id:id(4),case_id:candidate.case_id,job_id:'synthetic-job',fencing_token:1,source_sha256:candidate.source_sha256,
  authority_dependency_sha256:candidate.authority_dependency_sha256,plan_sha256:candidate.plan_sha256,provider_budget_policy_sha256:target.provider_budget_policy_sha256,
  extraction_mode:'saved_receipts_only' as 'saved_receipts_only'|'budgeted_provider',expires_at:candidate.expires_at};
 const request:RealServiceClaimRequest={candidate,job:{schema_version:'saved-case-work-v1',case_id:candidate.case_id,revision:1,input_sha256:candidate.source_sha256,
  authority_dependency_sha256:candidate.authority_dependency_sha256,processing_profile:'qualified_ai_v1',mode:'draft'},workerId:'synthetic-worker',jobId:admission.job_id,fencingToken:1,
  providerBudgetPolicySha256:target.provider_budget_policy_sha256,extraction_mode:'saved_receipts_only'};
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async q=>{
  if(q.name==='real_service_controller_actual')return {row_count:1,rows:[actual]};
  if(q.name==='real_service_controller_candidates')return {row_count:1,rows:[{value:batch}]};
  if(q.name==='real_service_claim_admit')return {row_count:1,rows:[{value:admission}]};throw Error('UNEXPECTED_QUERY');});
 const context:PostgresTransactionContext={transaction_id:'synthetic-claim-transaction',client:{query}},config={target,planSha256:candidate.plan_sha256,capability:'synthetic_capability_'.repeat(3),limit:2};
 return {target,candidate,batch,actual,admission,request,query,context,config};
}
describe('actual REAL controller and claim SQL adapters',()=>{
 it('uses actual principal/schema then a named bounded capability RPC with exact target pins',async()=>{
  const f=setup(),result=await readRealServiceCandidates(f.context,f.config);expect(result).toEqual(f.batch);expect(Object.isFrozen(result)).toBe(true);
  const [q]=f.query.mock.calls[1];expect(q.name).toBe('real_service_controller_candidates');expect(q.text).toContain('$4::jsonb');
  expect(q.values).toEqual([f.config.capability,f.config.planSha256,sha('f'),JSON.stringify({target_id:f.target.target_id,database_name:f.target.database,
   environment:f.target.environment,deployment_sha256:f.target.deployment_sha256,machine_issuer_sha256:f.target.machine_issuer_sha256,provider_budget_policy_sha256:f.target.provider_budget_policy_sha256}),2]);
 });
 it.each(['database','principal','schema_version'] as const)('rejects changed actual %s before discovery',async field=>{
  const f=setup();Object.assign(f.actual,{[field]:'foreign'});await expect(readRealServiceCandidates(f.context,f.config)).rejects.toThrow('REAL_SERVICE_CONTROLLER_DATABASE');expect(f.query).toHaveBeenCalledTimes(1);
 });
 it.each(['foreign_plan','expired','over_limit','duplicate'] as const)('rejects %s candidate responses',async change=>{
  const f=setup();if(change==='foreign_plan')f.candidate.plan_sha256=sha('1');if(change==='expired')f.batch.expires_at='2026-09-12T00:00:00Z';
  if(change==='over_limit')f.batch.candidates.push({...f.candidate,case_id:id(5)},{...f.candidate,case_id:id(6)});if(change==='duplicate')f.batch.candidates.push({...f.candidate});
  await expect(readRealServiceCandidates(f.context,f.config)).rejects.toThrow();
 });
 it('invokes admission only on the supplied claim transaction and returns the actual reservation',async()=>{
  const f=setup();expect(await admitRealServiceSavedReceiptsClaim(f.context,f.request)).toEqual(f.admission);expect(f.query).toHaveBeenCalledTimes(1);
  const [q]=f.query.mock.calls[0];expect(q.name).toBe('real_service_claim_admit');expect(q.values).toEqual([JSON.stringify(f.candidate),'synthetic-job',1,'synthetic-worker',sha('c'),'saved_receipts_only',sha('f')]);
 });
 it('blocks provider mode without querying or constructing an SDK',async()=>{
  const f=setup();await expect(admitRealServiceSavedReceiptsClaim(f.context,{...f.request,extraction_mode:'budgeted_provider'})).rejects.toThrow('REAL_SERVICE_PROVIDER_TRANSPORT_UNAVAILABLE');expect(f.query).not.toHaveBeenCalled();
 });
 it('admits requested provider mode only through the same authenticated policy/fence transaction',async()=>{
  const f=setup();vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','1');f.admission.extraction_mode='budgeted_provider';
  const request={...f.request,extraction_mode:'budgeted_provider' as const};
  expect(await admitRealServiceBudgetedProviderClaim(f.context,request)).toEqual(f.admission);expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls[0][0].values).toEqual([JSON.stringify(f.candidate),'synthetic-job',1,'synthetic-worker',sha('c'),'budgeted_provider',sha('f')]);
 });
 it('keeps provider mode disabled before SQL without its independent kill switch',async()=>{
  const f=setup();vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','0');
  await expect(admitRealServiceBudgetedProviderClaim(f.context,{...f.request,extraction_mode:'budgeted_provider'})).rejects.toThrow('REAL_SERVICE_PROVIDER_DISABLED');expect(f.query).not.toHaveBeenCalled();
 });
 it('does not reinterpret a saved-only request or acknowledgement as provider authority',async()=>{
  const f=setup();vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','1');
  await expect(admitRealServiceBudgetedProviderClaim(f.context,f.request)).rejects.toThrow('REAL_SERVICE_BUDGET_MODE');expect(f.query).not.toHaveBeenCalled();
  await expect(admitRealServiceBudgetedProviderClaim(f.context,{...f.request,extraction_mode:'budgeted_provider'})).rejects.toThrow('REAL_SERVICE_RUN_CLAIM_ADMISSION');expect(f.query).toHaveBeenCalledTimes(1);
 });
 it.each(['REAL_SERVICE_BUDGET_EVIDENCE_REQUIRED','REAL_SERVICE_BUDGET_EXPIRED','REAL_SERVICE_BUDGET_EXHAUSTED'])('preserves provider policy refusal %s for claim rollback',async code=>{
  const f=setup(),error=Error(code);vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','1');f.query.mockRejectedValue(error);
  await expect(admitRealServiceBudgetedProviderClaim(f.context,{...f.request,extraction_mode:'budgeted_provider'})).rejects.toBe(error);
 });
 it.each(['mode','fence','case','policy','expiry'] as const)('rejects changed %s admission acknowledgement',async change=>{
  const f=setup();if(change==='mode')f.admission.extraction_mode='budgeted_provider';if(change==='fence')f.admission.fencing_token=2;if(change==='case')f.admission.case_id=id(9);
  if(change==='policy')f.admission.provider_budget_policy_sha256=sha('9');if(change==='expiry')f.admission.expires_at='2026-09-13T00:00:00Z';
  await expect(admitRealServiceSavedReceiptsClaim(f.context,f.request)).rejects.toThrow('REAL_SERVICE_RUN_CLAIM_ADMISSION');
 });
 it('preserves SQL refusal so the outer claim transaction can roll back',async()=>{
  const f=setup(),error=Error('REAL_SERVICE_BUDGET_EXHAUSTED');f.query.mockRejectedValue(error);await expect(admitRealServiceSavedReceiptsClaim(f.context,f.request)).rejects.toBe(error);
 });
 it('rejects source/job drift before touching the claim ledger',async()=>{
  const f=setup();await expect(admitRealServiceSavedReceiptsClaim(f.context,{...f.request,job:{...f.request.job,revision:2}})).rejects.toThrow('REAL_SERVICE_RUN_SCOPE');expect(f.query).not.toHaveBeenCalled();
 });
 it('refuses foreign URL coordinates and insecure TLS before opening a pool',async()=>{
  const f=setup(),input={...f.config,connectionUrl:'postgresql://tivdoc_worker_runtime:synthetic@foreign.test/synthetic',certificateAuthority:'-----BEGIN CERTIFICATE-----synthetic'};
  await expect(connectRealServiceController(input)).rejects.toThrow('REAL_SERVICE_CONTROLLER_CONNECTION');
  await expect(connectRealServiceController({...input,connectionUrl:'postgresql://tivdoc_worker_runtime:synthetic@db.example.test/synthetic?sslmode=disable'})).rejects.toThrow('REAL_SERVICE_CONTROLLER_TLS');
 });
});
