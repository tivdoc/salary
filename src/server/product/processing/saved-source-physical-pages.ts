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
type Input={job:SourceJob;jobId:string;workerId:string;fencingToken:number;transactions:SavedWorkerTransactions;storage:UploadExtractionStorage};
async function admitted(context:PostgresTransactionContext,input:Input){
 await admitSavedSource(context,input.job);
 const r=await context.client.query(statement('source_physical_lease',
  `select job_id from public.engine_durable_jobs where job_id=$1 and canonical_case_id=$2 and payload=$3::jsonb
   and state='running' and lease_owner=$4 and fencing_token=$5 and lease_expires_at>clock_timestamp() and not cancellation_requested`,
  [input.jobId,input.job.case_id,JSON.stringify(input.job),input.workerId,input.fencingToken]));
 if(r.rows.length!==1)throw Error('SAVED_JOB_FENCE');
}
/** Reads physical bytes only. Neither provider output nor document metadata is
 * rewritten. Replacement during I/O is rejected before storing the receipt. */
export async function ensureSavedSourcePhysicalPages(input:Input){
 const rows=await input.transactions(async context=>{
  await admitted(context,input);
  const r=await context.client.query(statement('source_physical_pending','select private.source_physical_pages_pending($1::uuid,$2,$3) value',
   [input.job.case_id,input.job.revision,input.job.input_sha256]));
  return z.array(rowSchema).max(24).parse(r.rows[0]?.value);
 });
 let recorded=0;const unreadableVersions:string[]=[];
 for(const row of rows){
  await input.transactions(context=>admitted(context,input));
  const ext=row.mime_type==='application/pdf'?'pdf':row.mime_type==='image/png'?'png':'jpg';
  if(row.storage_path!==`cases/${input.job.case_id}/versions/${row.version_id}.${ext}`)throw Error('SOURCE_INTAKE_PHYSICAL_SCOPE');
  const {data,error}=await input.storage.download(row.storage_path);
  if(error||!data)throw Error('SOURCE_INTAKE_PHYSICAL_UNAVAILABLE');
  const bytes=new Uint8Array(await data.arrayBuffer());
  if(bytes.length!==row.byte_size||createHash('sha256').update(bytes).digest('hex')!==row.source_sha256)throw Error('SOURCE_INTAKE_PHYSICAL_CHANGED');
  let pages:number;
  try{pages=await inspectSourcePhysicalPages(bytes,row.mime_type);}
  catch{
   await input.transactions(context=>admitted(context,input));
   unreadableVersions.push(row.version_id);continue;
  }
  await input.transactions(async context=>{
   await admitted(context,input);
   await context.client.query(statement('source_physical_record','select private.document_physical_pages_record($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)',
    [input.job.case_id,row.document_id,row.version_id,row.source_sha256,row.byte_size,row.mime_type,pages]));
  });recorded++;
 }
 return {recorded,unreadableVersions};
}
