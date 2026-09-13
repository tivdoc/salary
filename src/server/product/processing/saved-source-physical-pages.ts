import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {UploadExtractionStorage} from '@/server/engine/extraction/verified-upload-source';
import {inspectSourcePhysicalPages} from '../documents/physical-pages';
import {admitSavedSource} from './saved-admission';
import type {SourceJob} from './source-dispatch';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
const rowSchema=z.object({document_id:z.uuid(),version_id:z.uuid(),source_sha256:z.string().regex(/^[a-f0-9]{64}$/),
 byte_size:z.coerce.number().int().min(1).max(10*1024*1024),mime_type:z.enum(['application/pdf','image/jpeg','image/png']),storage_path:z.string()}).strict();
type Input={job:SourceJob;jobId:string;workerId:string;fencingToken:number;transactions:SavedWorkerTransactions;storage:UploadExtractionStorage;
 purpose?:'legacy_source_intake'|'contract_transcription'};
async function admitted(context:PostgresTransactionContext,input:Input,expected?:z.infer<typeof rowSchema>){
 await admitSavedSource(context,input.job);
 const contract=input.purpose==='contract_transcription';
 const r=await context.client.query(statement(contract?'source_contract_physical_lease':'source_physical_lease',
  `select job_id from public.engine_durable_jobs where job_id=$1 and canonical_case_id=$2 and payload=$3::jsonb
   and state='running' and lease_owner=$4 and fencing_token=$5 and lease_expires_at>clock_timestamp() and not cancellation_requested`,
  [input.jobId,input.job.case_id,JSON.stringify(input.job),input.workerId,input.fencingToken]));
 if(r.rows.length!==1)throw Error('SAVED_JOB_FENCE');
 if(!contract)return null;
 // The actor helper is private to security-definer operations. This narrow
 // RPC verifies actor, source, paid scope and lease on every admission,
 // including after storage I/O; worker LOGIN needs no broader privileges.
 const pending=await context.client.query(statement('source_contract_physical_pending',
  'select private.contract_transcription_physical_pages_pending($1::uuid,$2,$3,$4,$5,$6) value',
  [input.job.case_id,input.job.revision,input.job.input_sha256,input.jobId,input.workerId,input.fencingToken]));
 if(pending.row_count!==1)throw Error('SOURCE_INTAKE_PHYSICAL_CONTEXT');
 const rows=z.array(rowSchema).max(24).parse(pending.rows[0]?.value);
 if(expected&&!rows.some(row=>row.document_id===expected.document_id&&row.version_id===expected.version_id
  &&row.source_sha256===expected.source_sha256&&row.byte_size===expected.byte_size&&row.mime_type===expected.mime_type
  &&row.storage_path===expected.storage_path))throw Error('SOURCE_INTAKE_PHYSICAL_CHANGED');
 return rows;
}
/** Reads physical bytes only. Neither provider output nor document metadata is
 * rewritten. Replacement during I/O is rejected before storing the receipt. */
export async function ensureSavedSourcePhysicalPages(input:Input){
 const rows=await input.transactions(async context=>{
  const contracts=await admitted(context,input);if(contracts)return contracts;
  const r=await context.client.query(statement('source_physical_pending','select private.source_physical_pages_pending($1::uuid,$2,$3) value',
    [input.job.case_id,input.job.revision,input.job.input_sha256]));
  if(r.row_count!==1)throw Error('SOURCE_INTAKE_PHYSICAL_CONTEXT');
  return z.array(rowSchema).max(24).parse(r.rows[0]?.value);
 });
 let recorded=0;const unreadableVersions:string[]=[];
 for(const row of rows){
  await input.transactions(context=>admitted(context,input,row));
  const ext=row.mime_type==='application/pdf'?'pdf':row.mime_type==='image/png'?'png':'jpg';
  if(row.storage_path!==`cases/${input.job.case_id}/versions/${row.version_id}.${ext}`)throw Error('SOURCE_INTAKE_PHYSICAL_SCOPE');
  const {data,error}=await input.storage.download(row.storage_path);
  if(error||!data)throw Error('SOURCE_INTAKE_PHYSICAL_UNAVAILABLE');
  const bytes=new Uint8Array(await data.arrayBuffer());
  if(bytes.length!==row.byte_size||createHash('sha256').update(bytes).digest('hex')!==row.source_sha256)throw Error('SOURCE_INTAKE_PHYSICAL_CHANGED');
  let pages:number;
  try{pages=await inspectSourcePhysicalPages(bytes,row.mime_type);}
  catch{
   await input.transactions(context=>admitted(context,input,row));
   unreadableVersions.push(row.version_id);continue;
  }
  await input.transactions(async context=>{
   await admitted(context,input,row);
   await context.client.query(statement('source_physical_record','select private.document_physical_pages_record($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)',
    [input.job.case_id,row.document_id,row.version_id,row.source_sha256,row.byte_size,row.mime_type,pages]));
  });recorded++;
 }
 return {recorded,unreadableVersions};
}
