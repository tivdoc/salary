import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {createOpenAiDocumentEvidenceExtractor} from '@/server/engine/extraction/providers/openai/document-evidence-adapter';
import {runSavedWorkerDocumentEvidence} from './saved-document-evidence-worker';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
const ports=vi.hoisted(()=>({admit:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-extraction-worker',()=>({admitSavedExtractionLease:ports.admit}));
beforeEach(()=>vi.resetAllMocks());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
const hash=createHash('sha256').update(bytes).digest('hex');
type Invocation={invocation_id:string;case_id:string;version_id:string;expected_month:string;input_sha256:string;source_revision:number;dispatched_at:string;result:unknown};
function setup(){
 const caseId=id(1),versionId=id(2),doc={id:id(3),case_id:caseId,version_id:versionId,document_type:'attendance',storage_path:`cases/${caseId}/versions/${versionId}.png`,original_filename:'synthetic-dot.png',mime_type:'image/png',size:bytes.length,content_sha256:hash,created_at:'2026-09-12T00:00:00Z'};
 const job={schema_version:'saved-case-work-v1' as const,case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft' as const};
 const state:{invocation:Invocation|null;checkpoint:unknown;depth:number;stale:boolean;failCheckpoint:boolean;principal:string;sourceMissing:boolean;retained:Record<string,unknown>|null;sourceOverride:Record<string,unknown>|null}={invocation:null,checkpoint:null,depth:0,stale:false,failCheckpoint:false,principal:'tivdoc_worker_runtime',sourceMissing:false,retained:null,sourceOverride:null};
 ports.admit.mockImplementation(async()=>{if(state.stale)throw Error('ANALYSIS_INPUT_SUPERSEDED');return {job,document:doc,month:'2026-06',requestedMonths:['2026-06','2026-07']};});
 const sql:string[]=[],context:PostgresTransactionContext={transaction_id:'synthetic',client:{async query(q){
  expect(state.depth).toBe(1);sql.push(q.name);let rows:Record<string,unknown>[]=[];
  switch(q.name){
   case 'document_evidence_cached':case 'document_evidence_checkpoint_read':rows=state.checkpoint?[{result:state.checkpoint}]:[];break;
   case 'document_evidence_dispatch_lock':break;
   case 'document_evidence_invocation_read':rows=state.invocation?.version_id===q.values[1]?[state.invocation]:[];break;
   case 'document_evidence_receipt_lock':rows=state.invocation?.invocation_id===q.values[0]?[state.invocation]:[];break;
   case 'document_evidence_dispatch_once':state.invocation={invocation_id:String(q.values[0]),case_id:caseId,version_id:versionId,expected_month:'2026-06',input_sha256:hash,source_revision:1,dispatched_at:'2026-09-12T00:00:00Z',result:null};break;
   case 'document_evidence_receipt_authority':rows=[{principal:state.principal,tenant_id:`saved-case:${caseId}`}];break;
   case 'document_evidence_receipt_source':{
    expect(q.values).toEqual([state.invocation!.invocation_id]);
    expect(q.text).toBe('select private.document_evidence_receipt_source($1::uuid) as source');
    const metadata=state.sourceOverride??(doc.version_id===state.invocation!.version_id?doc:state.retained);
    rows=[{source:state.sourceMissing?null:metadata}];break;
   }
   case 'document_evidence_receipt_record':state.invocation!.result=JSON.parse(String(q.values[1]));rows=[{invocation_id:state.invocation!.invocation_id}];break;
   case 'document_evidence_checkpoint_insert':if(state.failCheckpoint)throw Error('CHECKPOINT_FAILURE');state.checkpoint??=JSON.parse(String(q.values[6]));break;
   default:throw Error('UNEXPECTED_SQL:'+q.name);
  }return {rows,row_count:rows.length};
 }}};
 const transactions:SavedWorkerTransactions=async f=>{expect(state.depth).toBe(0);state.depth++;try{return await f(context);}finally{state.depth--;}};
 const parse=vi.fn(async()=>{expect(state.depth).toBe(0);expect(state.invocation).not.toBeNull();return {id:'resp_synthetic',status:'completed',requestId:'req_synthetic',model:'gpt-5.6-sol',usage:null,outputParsed:{schema_version:'document-evidence-provider-v1',detected_document_type:'attendance',page_count:1,pages:[{page:1,coverage:'partial',missing_regions:['Synthetic fixture, no real attendance']}],observations:[],warnings:['synthetic_only']}};});
 const extractor=createOpenAiDocumentEvidenceExtractor({model:'gpt-5.6-sol',origin:'injected_test_provider',authorize:async()=>{},transport:{parse}});
 const input={jobId:'synthetic-job',workerId:'synthetic-worker',fencingToken:1,versionId,transactions,storage:{download:async()=>({data:new Blob([bytes],{type:'image/png'}),error:null})},providerEnabled:true,extractor};
 return {input,state,parse,sql,job,doc};
}
describe('non-payroll document receipts in the existing durable worker protocol',()=>{
 it('records dispatch before I/O, receipt before checkpoint, and reuses without a second request',async()=>{
  const s=setup(),first=await runSavedWorkerDocumentEvidence(s.input),retry=await runSavedWorkerDocumentEvidence({...s.input,providerEnabled:false,extractor:undefined});
  expect(first.reused).toBe(false);expect(retry.reused).toBe(true);expect(s.parse).toHaveBeenCalledTimes(1);expect(retry.result).toEqual(first.result);
  expect(s.sql.indexOf('document_evidence_receipt_record')).toBeLessThan(s.sql.indexOf('document_evidence_checkpoint_insert'));
  expect(first.result.dispatch_month).toBe('2026-06');expect(first.result.run.result.normalized?.observations).toEqual([]);
 });
 it('retains the original receipt after checkpoint failure and restart without re-extraction',async()=>{
  const s=setup();s.state.failCheckpoint=true;await expect(runSavedWorkerDocumentEvidence(s.input)).rejects.toThrow('CHECKPOINT_FAILURE');
  const original=canonicalSha256(s.state.invocation!.result);s.state.failCheckpoint=false;
  await runSavedWorkerDocumentEvidence({...s.input,receiptOnly:true,extractor:undefined,providerEnabled:false});
  expect(canonicalSha256(s.state.checkpoint)).toBe(original);expect(s.parse).toHaveBeenCalledTimes(1);
 });
 it('saves a late provider result but cannot checkpoint a replaced source',async()=>{
  const s=setup(),original=s.parse.getMockImplementation()!;s.parse.mockImplementation(async()=>{const r=await original();
   s.state.retained={...s.doc};s.doc.version_id=id(9);s.doc.content_sha256='f'.repeat(64);
   s.doc.storage_path=`cases/${s.doc.case_id}/versions/${id(9)}.png`;s.state.stale=true;return r;});
  await expect(runSavedWorkerDocumentEvidence(s.input)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  expect(s.state.invocation?.result).not.toBeNull();expect(s.state.checkpoint).toBeNull();expect(s.parse).toHaveBeenCalledTimes(1);
  const preserved=canonicalSha256(s.state.invocation!.result);
  await expect(runSavedWorkerDocumentEvidence({...s.input,receiptOnly:true})).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  // A new current source needs its own invocation. The old retained receipt
  // cannot be repurposed merely because it is in the same logical document.
  s.state.stale=false;s.job.revision=2;
  await expect(runSavedWorkerDocumentEvidence({...s.input,versionId:id(9),receiptOnly:true})).rejects.toThrow('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  expect(canonicalSha256(s.state.invocation!.result)).toBe(preserved);expect(s.parse).toHaveBeenCalledTimes(1);expect(s.state.checkpoint).toBeNull();
 });
 it('does not save a late receipt when neither exact current nor retained source metadata exists',async()=>{
  const s=setup();s.state.sourceMissing=true;
  await expect(runSavedWorkerDocumentEvidence(s.input)).rejects.toThrow('DOCUMENT_EVIDENCE_RECEIPT_SOURCE');
  expect(s.state.invocation?.result).toBeNull();expect(s.state.checkpoint).toBeNull();
 });
 it.each(['case_id','version_id','content_sha256','size'] as const)('rejects incompatible retained %s before persisting a receipt',async key=>{
  const s=setup();s.state.sourceOverride={...s.doc,[key]:key==='size'?bytes.length+1:key==='content_sha256'?'f'.repeat(64):id(8)};
  await expect(runSavedWorkerDocumentEvidence(s.input)).rejects.toThrow();
  expect(s.state.invocation?.result).toBeNull();expect(s.state.checkpoint).toBeNull();
 });
 it('holds an uncertain dispatch across retry rather than spending again',async()=>{
  const s=setup(),extract=vi.fn(async()=>{throw Error('process interrupted before receipt');});
  await expect(runSavedWorkerDocumentEvidence({...s.input,extractor:{extract}})).rejects.toThrow('process interrupted');
  await expect(runSavedWorkerDocumentEvidence({...s.input,extractor:{extract}})).rejects.toThrow('SAVED_EXTRACTION_OUTCOME_PENDING');expect(extract).toHaveBeenCalledTimes(1);
 });
 it('rejects a foreign machine principal and never checkpoints its response',async()=>{
  const s=setup();s.state.principal='tivdoc_web_runtime';await expect(runSavedWorkerDocumentEvidence(s.input)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');expect(s.state.checkpoint).toBeNull();
 });
});

it('a known provider failure remains a failed receipt on retry, never a successful extraction',async()=>{
 const s=setup();s.parse.mockRejectedValueOnce(Error('connection lost'));
 const failed=await runSavedWorkerDocumentEvidence(s.input),retry=await runSavedWorkerDocumentEvidence(s.input);
 expect(failed.result.run.result.status).toBe('failed');expect(failed.result.run.result.normalized).toBeNull();
 expect(retry.result).toEqual(failed.result);expect(s.parse).toHaveBeenCalledTimes(1);
});
