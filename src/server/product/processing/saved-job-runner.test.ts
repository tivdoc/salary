import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {SOURCE_JOB_KIND} from './source-dispatch';
import {runSavedDraftJob,type SavedMonthCompletion} from './saved-job-runner';

const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn(),extract:vi.fn(),evidence:vi.fn(),month:vi.fn(),complete:vi.fn(),reviewScope:vi.fn(),testAuthority:vi.fn(),regularAuthority:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope',async importOriginal=>({...await importOriginal<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
vi.mock('./saved-extraction-worker',()=>({runSavedWorkerExtraction:ports.extract}));
vi.mock('./saved-document-evidence-worker',()=>({runSavedWorkerDocumentEvidence:ports.evidence}));
vi.mock('./saved-worker',()=>({runSavedWorkerMonth:ports.month}));
vi.mock('./saved-document-review',()=>({savedDocumentReviewSourceScope:ports.reviewScope}));
vi.mock('./saved-june2026-test-authority',()=>({loadJune2026TestAuthority:ports.testAuthority}));
vi.mock('./saved-june2026-regular-authority',()=>({loadSavedJune2026RegularAuthority:ports.regularAuthority}));
vi.mock('./saved-job-completion',()=>({completeSavedDraftJob:ports.complete}));
beforeEach(()=>vi.resetAllMocks());
afterEach(()=>vi.useRealTimers());

function setup(){
 const caseId=randomUUID(),january=randomUUID(),february=randomUUID(),fullId=randomUUID(),initialId=randomUUID();
 const job={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const row={job_kind:SOURCE_JOB_KIND,payload:job,payload_sha256:canonicalSha256(job),tenant_id:`saved-case:${caseId}`,canonical_case_id:caseId,
  state:'running',lease_owner:'worker',fencing_token:2,lease_valid:true,cancellation_requested:false};
 const source={case_id:caseId,month:'2025-01',documents:[
  {id:randomUUID(),version_id:january,type:'payslip',month:null},
  {id:randomUUID(),version_id:february,type:'payslip',month:'2025-02-01'},
  {id:randomUUID(),version_id:randomUUID(),type:'payslip',month:'2025-03'},
  {id:randomUUID(),version_id:randomUUID(),type:'contract',month:null},
 ]};
 const base={from:'2025-01-01',topics:['pension'],offer_sha256:'b'.repeat(64)};
 ports.orders.mockResolvedValue([{...base,id:fullId,kind:'full',to:'2025-02-01'},{...base,id:initialId,kind:'initial',to:'2025-01-01'}]);
 const state={depth:0,heartbeats:0,heartbeatFails:false,journalHash:job.input_sha256,receipts:[] as string[],outbox:0};
 const calls:string[]=[],preparedStatements=new Map<string,string>();
 const context:PostgresTransactionContext={transaction_id:'unit',client:{async query(s){
  const prior=preparedStatements.get(s.name);
  if(prior!==undefined&&prior!==s.text)throw Error('PREPARED_STATEMENT_TEXT_CHANGED');
  preparedStatements.set(s.name,s.text);
  expect(state.depth).toBe(1);calls.push(s.name);
  if(s.name==='saved_runner_read'||s.name==='saved_runner_lock')return {rows:[row],row_count:1};
  if(s.name==='saved_runner_journal')return {rows:[{input:source,actual_sha256:state.journalHash}],row_count:1};
  if(s.name==='saved_runner_heartbeat'){
   state.heartbeats++;expect(s.text).toContain('clock_timestamp()');expect(s.text).toContain('not cancellation_requested');
   return {rows:state.heartbeatFails?[]:[{job_id:'job'}],row_count:state.heartbeatFails?0:1};
  }
  throw new Error(`UNEXPECTED_SQL:${s.name}`);
 }}};
 const transactions:SavedWorkerTransactions=async operation=>{
  expect(state.depth).toBe(0);state.depth++;const saved=[...state.receipts];
  try{return await operation(context);}catch(error){state.receipts=saved;throw error;}finally{state.depth--;}
 };
 ports.extract.mockImplementation(async()=>{expect(state.depth).toBe(0);return {};});
 ports.month.mockImplementation(async({orderId,month})=>{
  expect(state.depth).toBe(1);const key=orderId+':'+month;if(!state.receipts.includes(key))state.receipts.push(key);return {};
 });
 ports.complete.mockImplementation(async()=>{expect(state.depth).toBe(1);state.outbox=1;return {replayed:row.state==='succeeded',manifest:{publication:'draft'}};});
 const input={transactions,storage:{download:vi.fn()},providerEnabled:true,jobId:'job',workerId:'worker',fencingToken:2,heartbeat:{intervalMs:1000,leaseMs:10000}};
 return {input,row,source,state,calls,january,february,fullId,initialId};
}

describe('saved draft job consumer',()=>{
 it('reuses one prepared journal statement across qualified admission and planning',async()=>{
  const s=setup();Object.assign(s.row.payload,{processing_profile:'qualified_ai_v1'});
  s.row.payload_sha256=canonicalSha256(s.row.payload);
  const result=await runSavedDraftJob(s.input);
  expect(s.calls.filter(name=>name==='saved_runner_journal')).toHaveLength(2);
  expect(result).toMatchObject({extractedVersions:2,analyzedMonths:3});
 });
 it('extracts each purchased file once across overlapping orders and completes all order-months',async()=>{
  const s=setup(),result=await runSavedDraftJob(s.input);
  expect(ports.extract.mock.calls.map(c=>c[0].versionId).sort()).toEqual([s.january,s.february].sort());
  expect(s.state.receipts.sort()).toEqual([s.fullId+':2025-01',s.fullId+':2025-02',s.initialId+':2025-01'].sort());
  expect(result).toMatchObject({extractedVersions:2,analyzedMonths:3,completion:{manifest:{publication:'draft'}}});
  expect(s.state.heartbeats).toBe(5);expect(s.state.outbox).toBe(1);
 });
 it('keeps an other tariff PDF out of both OCR queues while valid payslips complete normally',async()=>{
  const s=setup(),tariff=randomUUID();s.source.documents=s.source.documents.filter(d=>d.type==='payslip');
  s.source.documents.push({id:randomUUID(),version_id:tariff,type:'other',month:'2025-01'});
  const result=await runSavedDraftJob({...s.input,documentEvidence:{}});
  expect(ports.extract.mock.calls.map(([input])=>input.versionId).sort()).toEqual([s.january,s.february].sort());
  expect(ports.evidence).not.toHaveBeenCalled();expect(s.input.storage.download).not.toHaveBeenCalled();
  expect(result).toMatchObject({extractedVersions:2,analyzedMonths:3});
  expect(ports.complete).toHaveBeenCalledOnce();expect(s.state.receipts).toHaveLength(3);
 });
 it('skips OCR only when every purchased scope consuming each version has an admitted pinned review',async()=>{
  const s=setup();ports.reviewScope.mockImplementation(async(_context,_job,order)=>({orderId:order.id,reviewSha256:'c'.repeat(64),sourceVersionIds:[s.january,s.february]}));
  const result=await runSavedDraftJob(s.input);
  expect(result).toMatchObject({extractedVersions:0,analyzedMonths:3});expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).toHaveBeenCalledTimes(3);
 });
 it.each(['one_order_unreviewed','one_month_unreviewed','version_omitted'])( 'preserves real extraction when %s still needs the source',async kind=>{
  const s=setup();ports.reviewScope.mockImplementation(async(_context,_job,order,month)=>{
   if(kind==='one_order_unreviewed'&&order.id===s.initialId||kind==='one_month_unreviewed'&&month==='2025-01')return undefined;
   return {orderId:order.id,reviewSha256:'c'.repeat(64),sourceVersionIds:kind==='version_omitted'?[s.february]:[s.january,s.february]};
  });
  await runSavedDraftJob(s.input);expect(ports.extract.mock.calls.map(([input])=>input.versionId)).toEqual([s.january]);
 });
 it('refuses a changed admitted source scope before any provider or month work',async()=>{
  const s=setup();ports.reviewScope.mockRejectedValue(Error('SAVED_REVIEW_SOURCE_SCOPE'));
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('SAVED_REVIEW_SOURCE_SCOPE');
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();
 });
 it.each(['test','regular'])('retains extraction for an active %s canonical runtime even if a reviewed source exists',async kind=>{
  const s=setup();s.source.month='2026-06';s.source.documents=s.source.documents.filter(d=>d.version_id===s.january);
  ports.orders.mockResolvedValue([{id:s.fullId,kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)}]);
  ports.reviewScope.mockResolvedValue({orderId:s.fullId,reviewSha256:'c'.repeat(64),sourceVersionIds:[s.january]});
  if(kind==='test')ports.testAuthority.mockResolvedValue({});else ports.regularAuthority.mockResolvedValue({state:'ready'});
  await runSavedDraftJob(s.input);expect(ports.extract.mock.calls.map(([input])=>input.versionId)).toEqual([s.january]);expect(ports.reviewScope).not.toHaveBeenCalled();
 });
 it('replays a completed job through the durable manifest without OCR, analysis or a heartbeat',async()=>{
  const s=setup(),onMonth=vi.fn();s.row.state='succeeded';s.row.lease_valid=false;
  expect((await runSavedDraftJob({...s.input,onMonth})).completion.replayed).toBe(true);
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(s.state.heartbeats).toBe(0);
  expect(onMonth).not.toHaveBeenCalled();
 });
 it('composes the optional managed month effect with the exact canonical parent before completion',async()=>{
  const s=setup(),onMonth=vi.fn<SavedMonthCompletion>(async({context,job,orderId,month,parent})=>{
   expect(context.transaction_id).toBe('unit');expect(s.state.depth).toBe(1);
   expect(job).toEqual(s.row.payload);expect(s.state.receipts).toContain(orderId+':'+month);
   expect(parent).toEqual({});expect(ports.complete).not.toHaveBeenCalled();
  });
  await runSavedDraftJob({...s.input,onMonth});expect(onMonth).toHaveBeenCalledTimes(3);expect(s.state.outbox).toBe(1);
 });
 it('rolls back the canonical parent and withholds terminal success when managed composition fails',async()=>{
  const s=setup(),onMonth=vi.fn(async()=>{throw Error('MANAGED_COMPOSITION_FAILED');});
  await expect(runSavedDraftJob({...s.input,onMonth})).rejects.toThrow('MANAGED_COMPOSITION_FAILED');
  expect(s.state.receipts).toEqual([]);expect(ports.complete).not.toHaveBeenCalled();expect(s.state.outbox).toBe(0);
 });
 it.each(['foreign_case','wrong_kind','payload_changed','stale_fence','wrong_worker','expired','cancelled'])(
  'refuses %s before provider work',async mutation=>{
   const s=setup();
   if(mutation==='foreign_case')s.row.canonical_case_id=randomUUID();
   if(mutation==='wrong_kind')s.row.job_kind='unrelated_job';
   if(mutation==='payload_changed')s.row.payload_sha256='f'.repeat(64);
   if(mutation==='stale_fence')s.row.fencing_token++;
   if(mutation==='wrong_worker')s.row.lease_owner='other';
   if(mutation==='expired')s.row.lease_valid=false;
   if(mutation==='cancelled')s.row.cancellation_requested=true;
   await expect(runSavedDraftJob(s.input)).rejects.toThrow();expect(ports.extract).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
  });
 it('propagates authoritative tenant/source/paid refusal without dispatch',async()=>{
  const s=setup();ports.admit.mockRejectedValue(new Error('SAVED_WORKER_SCOPE_FORBIDDEN'));
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');expect(ports.extract).not.toHaveBeenCalled();
 });
 it.each(['hash','foreign_journal','duplicate_version'])(
  'refuses invalid saved plan %s without truncating purchased scope',async mutation=>{
   const s=setup();
   if(mutation==='hash')s.state.journalHash='c'.repeat(64);
   if(mutation==='foreign_journal')s.source.case_id=randomUUID();
   if(mutation==='duplicate_version')s.source.documents.push({...s.source.documents[0]});
   await expect(runSavedDraftJob(s.input)).rejects.toThrow();expect(ports.extract).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
  });
 it('reviews every purchased month when one financial source is missing, extracting only existing in-scope payslips',async()=>{
  const s=setup();s.source.documents.splice(1,1);
  const result=await runSavedDraftJob(s.input);
  expect(ports.extract.mock.calls.map(c=>c[0].versionId)).toEqual([s.january]);
  expect(s.state.receipts.sort()).toEqual([s.fullId+':2025-01',s.fullId+':2025-02',s.initialId+':2025-01'].sort());
  expect(result).toMatchObject({extractedVersions:1,analyzedMonths:3});
  expect(ports.complete).toHaveBeenCalledOnce();expect(s.state.outbox).toBe(1);
 });
 it.each(['attendance_and_contract','contract_only','empty_inventory'])(
  'persists all month reviews for %s without storage or provider work, preserving ordinary service output on retry',async inventory=>{
   const s=setup();s.source.documents.splice(0,s.source.documents.length);
   if(inventory!=='empty_inventory')s.source.documents.push({id:randomUUID(),version_id:randomUUID(),type:'contract',month:null});
   if(inventory==='attendance_and_contract')s.source.documents.push({id:randomUUID(),version_id:randomUUID(),type:'attendance',month:'2025-01'});
   const normal=ports.month.getMockImplementation()!;
   const partial={bundle:{findings:[],document_review:{completions:{customer_requests:[{kind:'file_upload'}]}}}};
   ports.month.mockImplementation(async input=>{await normal(input);return partial;});
   const onMonth=vi.fn<SavedMonthCompletion>(async input=>{expect(input.parent).toBe(partial);});
   const result=await runSavedDraftJob({...s.input,onMonth});
   await runSavedDraftJob({...s.input,onMonth});
   expect(result).toMatchObject({extractedVersions:0,analyzedMonths:3});
   expect(ports.extract).not.toHaveBeenCalled();expect(s.input.storage.download).not.toHaveBeenCalled();
   expect(ports.month.mock.calls.map(([input])=>[input.orderId,input.month])).toEqual([
    [s.fullId,'2025-01'],[s.fullId,'2025-02'],[s.initialId,'2025-01'],
    [s.fullId,'2025-01'],[s.fullId,'2025-02'],[s.initialId,'2025-01'],
   ]);
   expect(s.state.receipts).toHaveLength(3);expect(onMonth).toHaveBeenCalledTimes(6);
   expect(partial.bundle.findings).toEqual([]);expect(s.state.outbox).toBe(1);
  });
 it('does not acknowledge a missing-source month without the normal monthly receipt',async()=>{
  const s=setup();s.source.documents.splice(1,1);
  const normal=ports.month.getMockImplementation()!;
  ports.month.mockImplementation(async input=>{if(input.month==='2025-02')throw Error('REVIEW_PERSISTENCE_FAILED');return normal(input);});
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('REVIEW_PERSISTENCE_FAILED');
  expect(s.state.receipts).toEqual([s.fullId+':2025-01']);
  expect(ports.complete).not.toHaveBeenCalled();expect(s.state.outbox).toBe(0);
 });
 it('rechecks source admission before an inventory-only month and withholds stale reviews',async()=>{
  const s=setup();s.source.documents.splice(0,s.source.documents.length);
  ports.admit.mockResolvedValueOnce({}).mockRejectedValueOnce(Error('ANALYSIS_INPUT_SUPERSEDED'));
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
 });
 it('keeps earlier committed months through a failure, then retries all scope without duplicating receipts',async()=>{
  const s=setup(),normal=ports.month.getMockImplementation()!;let failed=false;
  ports.month.mockImplementation(async input=>{if(input.month==='2025-02'&&!failed){failed=true;throw new Error('MONTH_FAILED');}return normal(input);});
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('MONTH_FAILED');
  expect(s.state.receipts).toEqual([s.fullId+':2025-01']);expect(ports.complete).not.toHaveBeenCalled();
  await runSavedDraftJob(s.input);expect(s.state.receipts).toHaveLength(3);expect(s.state.outbox).toBe(1);
 });
 it('rolls back an analyzed month when the final in-transaction lease check fails',async()=>{
  const s=setup(),normal=ports.month.getMockImplementation()!;
  ports.month.mockImplementation(async input=>{await normal(input);s.state.heartbeatFails=true;});
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_FENCE');
  expect(s.state.receipts).toEqual([]);expect(ports.complete).not.toHaveBeenCalled();
 });
 it('preserves an unknown provider outcome and never acknowledges the job',async()=>{
  const s=setup();ports.extract.mockRejectedValue(new Error('SAVED_EXTRACTION_OUTCOME_PENDING'));
  await expect(runSavedDraftJob(s.input)).rejects.toThrow('SAVED_EXTRACTION_OUTCOME_PENDING');
  expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
 });
 it('renews while a provider is pending, saves its known outcome, and stops after a failed heartbeat',async()=>{
  vi.useFakeTimers();const s=setup();let release!:()=>void,began!:()=>void,receiptSaved=false;
  const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  ports.extract.mockImplementation(async()=>{began();await held;receiptSaved=true;});
  const result=runSavedDraftJob(s.input).then(value=>({value,error:null}),error=>({value:null,error}));
  await started;await vi.advanceTimersByTimeAsync(1000);expect(s.state.heartbeats).toBe(2);
  s.state.heartbeatFails=true;await vi.advanceTimersByTimeAsync(1000);release();
  expect((await result).error?.message).toBe('SAVED_JOB_FENCE');expect(receiptSaved).toBe(true);
  expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);expect(s.state.heartbeats).toBe(3);
 });
 it('serializes a queued heartbeat with the host single-connection analysis transaction',async()=>{
  vi.useFakeTimers();const s=setup(),normal=ports.month.getMockImplementation()!;
  let release!:()=>void,began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  ports.month.mockImplementationOnce(async input=>{began();await held;return normal(input);});
  const run=runSavedDraftJob(s.input);await started;await vi.advanceTimersByTimeAsync(1000);
  expect(s.state.depth).toBe(1);expect(s.state.heartbeats).toBe(1);release();await run;
  const beats=s.state.heartbeats;await vi.advanceTimersByTimeAsync(10000);expect(s.state.heartbeats).toBe(beats);
 });
 it('stops between units on cancellation without discarding a known extraction receipt',async()=>{
  const s=setup(),controller=new AbortController();ports.extract.mockImplementationOnce(async()=>{controller.abort();});
  await expect(runSavedDraftJob({...s.input,signal:controller.signal})).rejects.toThrow('SAVED_JOB_INTERRUPTED');
  expect(ports.extract).toHaveBeenCalledTimes(1);expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
 });
 it('rejects a heartbeat interval that cannot safely renew its configured lease',async()=>{
  const s=setup();await expect(runSavedDraftJob({...s.input,heartbeat:{intervalMs:5000,leaseMs:10000}})).rejects.toThrow('SAVED_HEARTBEAT_INTERVAL');
  expect(ports.admit).not.toHaveBeenCalled();
 });
});

it.each(['SAVED_EXTRACTION_OUTCOME_PENDING','DOCUMENT_EVIDENCE_PROVIDER_UNCONFIGURED','SAVED_EXTRACTION_RECEIPT_REQUIRED'])('assesses independent purchased months while preserving nonpay hold %s',async code=>{
 const s=setup();ports.evidence.mockRejectedValue(new Error(code));
 const result=await runSavedDraftJob({...s.input,documentEvidence:{}});
 expect(ports.evidence).toHaveBeenCalledTimes(1);expect(ports.month).toHaveBeenCalledTimes(3);
 expect(result).toMatchObject({analyzedMonths:3,deferredEvidence:[{versionId:s.source.documents[3].version_id,code}]});
 expect(s.state.outbox).toBe(1);
});
it.each(['ANALYSIS_INPUT_SUPERSEDED','SAVED_WORKER_SCOPE_FORBIDDEN','SAVED_JOB_FENCE'])('cannot defer nonpay authority failure %s',async code=>{
 const s=setup();ports.evidence.mockRejectedValue(new Error(code));
 await expect(runSavedDraftJob({...s.input,documentEvidence:{}})).rejects.toThrow(code);
 expect(ports.month).not.toHaveBeenCalled();expect(s.state.outbox).toBe(0);
});
