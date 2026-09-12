import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-extraction-worker.ts';
import {SOURCE_JOB_KIND,sourceJobSchema} from './source-dispatch.ts';
import {runSavedDraftJob} from './saved-job-runner.ts';

const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn(),extract:vi.fn(),month:vi.fn(),complete:vi.fn(),reviewScope:vi.fn(),testAuthority:vi.fn(),regularAuthority:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission.ts',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope.ts',async original=>({...await original<typeof import('./saved-order-scope.ts')>(),readSavedOrders:ports.orders}));
vi.mock('./saved-extraction-worker.ts',()=>({runSavedWorkerExtraction:ports.extract}));
vi.mock('./saved-document-evidence-worker.ts',()=>({runSavedWorkerDocumentEvidence:vi.fn()}));
vi.mock('./saved-worker.ts',()=>({runSavedWorkerMonth:ports.month}));
vi.mock('./saved-document-review.ts',()=>({savedDocumentReviewSourceScope:ports.reviewScope}));
vi.mock('./saved-june2026-test-authority.ts',()=>({loadJune2026TestAuthority:ports.testAuthority}));
vi.mock('./saved-june2026-regular-authority.ts',()=>({loadSavedJune2026RegularAuthority:ports.regularAuthority}));
vi.mock('./saved-job-completion.ts',()=>({completeSavedDraftJob:ports.complete}));
beforeEach(()=>vi.resetAllMocks());

function fixture(qualified=true){
 const caseId=randomUUID(),versionId=randomUUID(),orderId=randomUUID();
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:caseId,revision:9,input_sha256:'a'.repeat(64),mode:'draft',
  ...(qualified?{processing_profile:'qualified_ai_v1',authority_dependency_sha256:'b'.repeat(64)}:{})});
 const row={job_kind:SOURCE_JOB_KIND,payload:job,payload_sha256:canonicalSha256(job),tenant_id:`saved-case:${caseId}`,canonical_case_id:caseId,
  state:'running',lease_owner:'worker',fencing_token:1,lease_valid:true,cancellation_requested:false};
 const source={case_id:caseId,month:'2026-06',documents:[{id:randomUUID(),version_id:versionId,type:'payslip',month:'2026-06'}]};
 const orders=[{id:orderId,kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'c'.repeat(64)}];
 ports.orders.mockResolvedValue(orders);
 ports.reviewScope.mockResolvedValue({orderId,reviewSha256:'d'.repeat(64),sourceVersionIds:[versionId]});
 const events:string[]=[];
 const context:PostgresTransactionContext={transaction_id:'planning-test',client:{async query(statement){
  if(statement.name==='saved_runner_read'||statement.name==='saved_runner_lock')return {rows:[row],row_count:1};
  if(statement.name==='saved_runner_journal')return {rows:[{input:source,actual_sha256:job.input_sha256}],row_count:1};
  if(statement.name==='saved_runner_heartbeat')return {rows:[{job_id:'test-job'}],row_count:1};
  throw Error(`UNEXPECTED_SQL:${statement.name}`);
 }}};
 const transactions:SavedWorkerTransactions=operation=>operation(context);
 ports.extract.mockImplementation(async()=>{events.push('ordinary-extraction-worker');return {reused:true};});
 ports.month.mockImplementation(async()=>{events.push('ordinary-month');return {};});
 ports.complete.mockResolvedValue({manifest:{publication:'draft'}});
 const input={transactions,storage:{download:vi.fn()},providerEnabled:false,receiptOnly:true,jobId:'test-job',workerId:'worker',fencingToken:1};
 return {input,job,row,source,versionId,events,orderId};
}

describe('qualified saved-job extraction planning',()=>{
 it('sends a curated-covered payslip through ordinary receipt reuse before the enrolled monthly analysis',async()=>{
  const f=fixture();const result=await runSavedDraftJob(f.input);
  expect(ports.reviewScope).not.toHaveBeenCalled();
  expect(ports.testAuthority).not.toHaveBeenCalled();expect(ports.regularAuthority).not.toHaveBeenCalled();
  expect(ports.extract).toHaveBeenCalledOnce();
  expect(ports.extract.mock.calls[0][0]).toMatchObject({versionId:f.versionId,receiptOnly:true,providerEnabled:false});
  expect(f.events).toEqual(['ordinary-extraction-worker','ordinary-month']);
  expect(ports.month.mock.calls[0][0]).toMatchObject({job:f.job,orderId:f.orderId,month:'2026-06'});
  expect(result).toMatchObject({extractedVersions:1,analyzedMonths:1});
  expect(f.input.storage.download).not.toHaveBeenCalled();
 });
 it('does not substitute a curated review when the ordinary exact receipt is missing',async()=>{
  const f=fixture();ports.extract.mockRejectedValue(Error('SAVED_EXTRACTION_RECEIPT_REQUIRED'));
  await expect(runSavedDraftJob(f.input)).rejects.toThrow('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  expect(ports.reviewScope).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
  expect(f.input.storage.download).not.toHaveBeenCalled();
 });
 it('preserves historical curated-source skipping when the job has no enrolled profile',async()=>{
  const f=fixture(false);const result=await runSavedDraftJob(f.input);
  expect(ports.reviewScope).toHaveBeenCalledOnce();expect(ports.extract).not.toHaveBeenCalled();
  expect(f.events).toEqual(['ordinary-month']);expect(result).toMatchObject({extractedVersions:0,analyzedMonths:1});
 });
 it('checks current source authority before extracting an enrolled job',async()=>{
  const f=fixture();ports.admit.mockRejectedValue(Error('ANALYSIS_AUTHORITY_SUPERSEDED'));
  await expect(runSavedDraftJob(f.input)).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.reviewScope).not.toHaveBeenCalled();
  expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
 });
 it('still selects only payslips belonging to purchased months',async()=>{
  const f=fixture();f.source.documents.push({id:randomUUID(),version_id:randomUUID(),type:'payslip',month:'2026-07'},
   {id:randomUUID(),version_id:randomUUID(),type:'other',month:'2026-06'});
  await runSavedDraftJob(f.input);
  expect(ports.extract.mock.calls.map(([input])=>input.versionId)).toEqual([f.versionId]);
  expect(ports.month).toHaveBeenCalledOnce();
 });
});
