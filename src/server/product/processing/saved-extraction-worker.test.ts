import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {runSavedWorkerExtraction,recordSavedExtractionResult,type SavedWorkerTransactions} from './saved-extraction-worker';
import {SOURCE_JOB_KIND,type SourceJob} from './source-dispatch';
const ports=vi.hoisted(()=>({extract:vi.fn(),checkpoint:vi.fn(),admit:vi.fn(),fields:vi.fn(),june:vi.fn(),transcriptions:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/engine/extraction/saved-payslip',()=>({extractSavedPayslip:ports.extract}));
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:ports.admit}));
vi.mock('./extraction-checkpoint',()=>({saveExtractionCheckpoint:ports.checkpoint}));
vi.mock('./saved-field-requests',()=>({openSavedDocumentFieldRequests:ports.fields}));
vi.mock('./saved-june2026-collection',()=>({openSavedJune2026Collection:ports.june}));
vi.mock('./saved-transcription-requests',()=>({openSavedTranscriptionRequests:ports.transcriptions}));
vi.mock('./saved-order-scope',()=>({readSavedOrders:async()=>[{}],purchasedMonths:()=>['2025-01']}));
beforeEach(()=>{vi.resetAllMocks();ports.admit.mockResolvedValue({});});

// In-memory recording harness isolates transaction/external-call sequencing.
// SQL concurrency/RLS is a separate actual PostgreSQL proof, not claimed here.
function setup(){
 const caseId=randomUUID(),versionId=randomUUID();let depth=0;
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const jobRow={job_kind:SOURCE_JOB_KIND,payload:job,payload_sha256:canonicalSha256(job),tenant_id:`saved-case:${caseId}`,canonical_case_id:caseId,state:'running',lease_owner:'worker',fencing_token:1,lease_valid:true,cancellation_requested:false};
 const document={id:randomUUID(),case_id:caseId,version_id:versionId,expected_month:'2025-01',content_sha256:'b'.repeat(64),created_at:'2025-02-01T00:00:00Z'};
 const run={result:{final_extraction:{document_id:versionId}}};
 const result={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:document.id,version_id:versionId,input_sha256:document.content_sha256,expected_month:'2025-01',result_sha256:canonicalSha256(run.result),run};
 type Invocation={invocation_id:string;case_id:string;version_id:string;expected_month:string;input_sha256:string;dispatched_at:string;result:typeof result|null};
 const state:{invocation:Invocation|null;cached:typeof result|null;failCheckpoint:boolean;principal:string;documentMissing:boolean}={invocation:null,cached:null,failCheckpoint:false,principal:'tivdoc_worker_runtime',documentMissing:false};
 const calls:string[]=[];
 const context:PostgresTransactionContext={transaction_id:'unit-transaction',client:{async query(s){
  expect(depth).toBe(1);calls.push(s.name);let rows:Record<string,unknown>[]=[];
  switch(s.name){
   case 'extraction_job_read':case 'extraction_job_lock':rows=[jobRow];break;
   case 'extraction_pinned_document':rows=state.documentMissing?[]:[document];break;
   case 'extraction_existing_checkpoint':rows=state.cached?[{result:state.cached}]:[];break;
   case 'extraction_dispatch_once':if(!state.invocation){state.invocation={invocation_id:String(s.values[0]),case_id:caseId,version_id:versionId,expected_month:'2025-01',input_sha256:document.content_sha256,dispatched_at:'2026-09-08T00:00:00Z',result:null};rows=[{invocation_id:state.invocation.invocation_id}];}break;
   case 'extraction_saved_receipt_only':case 'extraction_invocation_read':case 'extraction_receipt_lock':rows=state.invocation?[state.invocation]:[];break;
   case 'extraction_receipt_authority':rows=[{principal:state.principal,tenant_id:`saved-case:${caseId}`}];break;
   case 'extraction_receipt_source':rows=[{matched:1}];break;
   case 'extraction_receipt_record':state.invocation!.result=JSON.parse(String(s.values[1]));rows=[{invocation_id:state.invocation!.invocation_id}];break;
   default:throw new Error(`UNEXPECTED_SQL:${s.name}`);
  }
  return {rows,row_count:rows.length};
 }}};
 const transactions:SavedWorkerTransactions=async operation=>{expect(depth).toBe(0);depth++;try{return await operation(context);}finally{depth--;}};
 ports.extract.mockImplementation(async()=>{expect(depth).toBe(0);expect(state.invocation?.result).toBeNull();return result;});
 ports.checkpoint.mockImplementation(async()=>{expect(depth).toBe(1);if(state.failCheckpoint)throw new Error('CHECKPOINT_WRITE_FAILED');return {result,reused:false};});
 ports.transcriptions.mockImplementation(async(currentContext,currentJob,currentCheckpoint)=>{
  expect(depth).toBe(1);expect(currentContext).toBe(context);expect(currentJob).toEqual(job);expect(currentCheckpoint).toBe(result);return [];
 });
 const input={transactions,storage:{download:vi.fn()},extractor:{} as NonNullable<Parameters<typeof runSavedWorkerExtraction>[0]['extractor']>,providerEnabled:true,jobId:'saved-job',workerId:'worker',fencingToken:1,versionId};
 return {input,state,calls,result,jobRow,document,context,transactions};
}
describe('durable saved extraction orchestration',()=>{
 it('receipt-only mode reuses a bound checkpoint without credentials, dispatch or SDK',async()=>{
  const s=setup();s.state.cached=s.result;
  expect((await runSavedWorkerExtraction({...s.input,extractor:undefined,providerEnabled:false,receiptOnly:true})).reused).toBe(true);
  expect(ports.extract).not.toHaveBeenCalled();expect(s.calls).not.toContain('extraction_dispatch_once');
 });
 it('receipt-only mode refuses a missing receipt before recording dispatch or spending',async()=>{
  const s=setup();await expect(runSavedWorkerExtraction({...s.input,extractor:undefined,providerEnabled:false,receiptOnly:true})).rejects.toThrow('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  expect(ports.extract).not.toHaveBeenCalled();expect(s.calls).not.toContain('extraction_dispatch_once');expect(s.state.invocation).toBeNull();
 });
 it('receipt-only recovery preserves the actual saved invocation after checkpoint failure',async()=>{
  const s=setup();s.state.failCheckpoint=true;await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow();
  s.state.failCheckpoint=false;ports.extract.mockClear();
  expect((await runSavedWorkerExtraction({...s.input,extractor:undefined,providerEnabled:false,receiptOnly:true})).reused).toBe(true);
  expect(ports.extract).not.toHaveBeenCalled();
 });

 it.each(['retained invocation','existing checkpoint'])('qualified %s keeps the seven ordinary field requests without dispatching historical June collection or transcription',async source=>{
  const s=setup();s.jobRow.payload.processing_profile='qualified_ai_v1';
  s.jobRow.payload_sha256=canonicalSha256(s.jobRow.payload);
  if(source==='existing checkpoint')s.state.cached=s.result;
  else s.state.invocation={invocation_id:randomUUID(),case_id:s.result.case_id,version_id:s.result.version_id,
   expected_month:s.result.expected_month,input_sha256:s.result.input_sha256,dispatched_at:'2026-09-08T00:00:00Z',result:s.result};
  const requestIds=Array.from({length:7},()=>randomUUID());
  ports.fields.mockImplementation(async(context,job,checkpoint)=>{
   expect(context).toBe(s.context);expect(job).toEqual(s.jobRow.payload);expect(checkpoint).toBe(s.result);
   return requestIds;
  });
  ports.june.mockRejectedValue(Error('JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED'));
  ports.transcriptions.mockRejectedValue(Error('HISTORICAL_TRANSCRIPTION_MUST_NOT_RUN'));
  const before=canonicalSha256(s.result);
  const recovered=await runSavedWorkerExtraction({...s.input,extractor:undefined,providerEnabled:false,receiptOnly:true});
  expect(recovered.reused).toBe(true);expect(recovered.result).toBe(s.result);
  expect(ports.checkpoint).toHaveBeenCalledTimes(1);expect(ports.fields).toHaveBeenCalledTimes(1);
  expect(await ports.fields.mock.results[0].value).toEqual(requestIds);
  expect(ports.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(ports.fields.mock.invocationCallOrder[0]);
  expect(ports.june).not.toHaveBeenCalled();expect(ports.transcriptions).not.toHaveBeenCalled();
  expect(ports.extract).not.toHaveBeenCalled();expect(s.input.storage.download).not.toHaveBeenCalled();
  expect(s.calls).not.toContain('extraction_dispatch_once');expect(s.calls).not.toContain('extraction_receipt_record');
  expect(canonicalSha256(s.result)).toBe(before);
 });

 it('commits dispatch before the external call and receipt before checkpoint; exact retry never invokes twice',async()=>{
  const s=setup(),first=await runSavedWorkerExtraction(s.input),retry=await runSavedWorkerExtraction(s.input);
  expect(first.reused).toBe(false);expect(retry.reused).toBe(true);expect(first.invocationId).toBe(retry.invocationId);
  expect(ports.extract).toHaveBeenCalledTimes(1);expect(ports.checkpoint).toHaveBeenCalledTimes(2);
  expect(ports.fields).toHaveBeenCalledTimes(2);expect(ports.fields.mock.calls[0][2]).toBe(s.result);
  expect(ports.june).toHaveBeenCalledTimes(2);expect(ports.june.mock.calls[0][2]).toBe(s.result);
  expect(ports.transcriptions).toHaveBeenCalledTimes(2);
  expect(ports.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(ports.fields.mock.invocationCallOrder[0]);
  expect(ports.fields.mock.invocationCallOrder[0]).toBeLessThan(ports.june.mock.invocationCallOrder[0]);
  expect(ports.june.mock.invocationCallOrder[0]).toBeLessThan(ports.transcriptions.mock.invocationCallOrder[0]);
  expect(ports.extract.mock.calls[0][0].context.created_at).toBe('2026-09-08T00:00:00.000Z');
 });
 it('reuses a legacy checkpoint without inventing a new invocation or provider expense',async()=>{
  const s=setup();s.state.cached=s.result;const result=await runSavedWorkerExtraction(s.input);
  expect(result.reused).toBe(true);expect(result.invocationId).toBeNull();expect(ports.extract).not.toHaveBeenCalled();
  expect(s.calls).not.toContain('extraction_dispatch_once');
 });
 it('keeps a committed receipt when checkpointing fails and retries it without external work',async()=>{
  const s=setup();s.state.failCheckpoint=true;await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow('CHECKPOINT_WRITE_FAILED');
  expect(ports.transcriptions).not.toHaveBeenCalled();
  expect(s.state.invocation?.result).toEqual(s.result);s.state.failCheckpoint=false;
  expect((await runSavedWorkerExtraction(s.input)).reused).toBe(true);expect(ports.extract).toHaveBeenCalledTimes(1);
 });
 it('propagates a refused transcription write while preserving the committed provider receipt for retry',async()=>{
  const s=setup();ports.transcriptions.mockRejectedValueOnce(Error('TRANSCRIPTION_SOURCE_OR_SCOPE_CHANGED'));
  await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow('TRANSCRIPTION_SOURCE_OR_SCOPE_CHANGED');
  expect(s.state.invocation?.result).toEqual(s.result);expect(ports.extract).toHaveBeenCalledTimes(1);
  const retried=await runSavedWorkerExtraction(s.input);expect(retried.reused).toBe(true);
  expect(ports.extract).toHaveBeenCalledTimes(1);expect(ports.transcriptions).toHaveBeenCalledTimes(2);
 });
 it('an uncertain external result blocks a second call and remains recoverable by its exact receipt',async()=>{
  const s=setup();ports.extract.mockRejectedValueOnce(new Error('NETWORK_OUTCOME_UNKNOWN'));
  await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow('NETWORK_OUTCOME_UNKNOWN');
  await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow('SAVED_EXTRACTION_OUTCOME_PENDING');
  expect(ports.extract).toHaveBeenCalledTimes(1);
  await s.transactions(context=>recordSavedExtractionResult(context,s.state.invocation!.invocation_id,s.result as Parameters<typeof recordSavedExtractionResult>[2]));
  expect((await runSavedWorkerExtraction(s.input)).reused).toBe(true);expect(ports.extract).toHaveBeenCalledTimes(1);
 });
 it('a second caller while the first provider call is active refuses without another call',async()=>{
  const s=setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
  ports.extract.mockImplementationOnce(async()=>{started();await gate;return s.result;});
  const first=runSavedWorkerExtraction(s.input);await began;
  await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow('SAVED_EXTRACTION_OUTCOME_PENDING');release();await first;
  expect(ports.extract).toHaveBeenCalledTimes(1);
 });
 it.each(['cancelled','expired','foreign worker','stale fence','foreign tenant','missing document','unpaid source','wrong month'])('refuses %s before any provider dispatch',async(reason)=>{
  const s=setup();if(reason==='cancelled')s.jobRow.cancellation_requested=true;if(reason==='expired')s.jobRow.lease_valid=false;
  if(reason==='foreign worker')s.jobRow.lease_owner='other';if(reason==='stale fence')s.jobRow.fencing_token=2;
  if(reason==='foreign tenant')s.jobRow.tenant_id='saved-case:'+randomUUID();if(reason==='missing document')s.state.documentMissing=true;
  if(reason==='unpaid source')ports.admit.mockRejectedValueOnce(new Error('SAVED_PAID_SOURCE_REQUIRED'));
  if(reason==='wrong month')s.document.expected_month='2025-02';
  await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow();expect(ports.extract).not.toHaveBeenCalled();expect(s.state.invocation).toBeNull();
 });
 it('records a response arriving after lease loss but never checkpoints under the stale fence',async()=>{
  const s=setup();ports.extract.mockImplementationOnce(async()=>{s.jobRow.lease_valid=false;return s.result;});
  await expect(runSavedWorkerExtraction(s.input)).rejects.toThrow('SAVED_JOB_FENCE');expect(s.state.invocation?.result).toEqual(s.result);
  expect(ports.transcriptions).not.toHaveBeenCalled();
  expect(ports.checkpoint).not.toHaveBeenCalled();s.jobRow.lease_valid=true;
  await runSavedWorkerExtraction(s.input);expect(ports.extract).toHaveBeenCalledTimes(1);
 });
 it.each(['foreign result','changed result','wrong authority'])('refuses %s without overwriting the recorded response',async(reason)=>{
  const s=setup();await runSavedWorkerExtraction(s.input);const changed=structuredClone(s.result);
  if(reason==='foreign result')changed.case_id=randomUUID();if(reason==='changed result')changed.run.result.final_extraction.document_id=randomUUID();
  if(reason==='wrong authority')s.state.principal='tivdoc_web_runtime';
  await expect(s.transactions(context=>recordSavedExtractionResult(context,s.state.invocation!.invocation_id,changed as Parameters<typeof recordSavedExtractionResult>[2]))).rejects.toThrow();
  expect(s.state.invocation?.result).toEqual(s.result);
 });
 it('disabled provider cannot dispatch or perform any I/O',async()=>{
  const s=setup();await expect(runSavedWorkerExtraction({...s.input,providerEnabled:false})).rejects.toThrow('SAVED_EXTRACTION_PROVIDER_DISABLED');
  expect(s.calls).toEqual([]);expect(ports.extract).not.toHaveBeenCalled();
 });
});
