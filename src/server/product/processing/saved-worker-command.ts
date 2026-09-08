import 'server-only';
import pg from 'pg';
import {z} from 'zod';
import {createClient} from '@supabase/supabase-js';
import {NodePostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {createOpenAiPayslipV21ExtractorFromEnv} from '@/server/engine/extraction/providers/openai/v21-adapter';
import {DEFAULT_OPENAI_EXTRACTION_MODEL} from '@/server/engine/extraction/providers/openai/config';
import {createSavedWorkerHost} from './saved-worker-host';
import {claimSavedDraftJob,runSavedDraftOnce} from './saved-job-runtime';
import {runSavedDraftJob} from './saved-job-runner';
import {savedCaseTenant} from './saved-admission';

const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u);
const identitySchema=z.object({session_id:opaque,token_id:opaque,tenant_id:opaque,actor_id:opaque,
 reviewer_organization_id:z.null(),rotation_counter:z.number().int().nonnegative()}).strict();
const targetSchema=z.object({host:z.string().min(1),port:z.number().int().min(1).max(65535),
 database:z.string().min(1),project_ref:z.string().regex(/^[a-z0-9]+$/u)}).strict();
type Environment=Readonly<Record<string,string|undefined>>;

/** Explicit DEV-only command configuration. Parse before constructing clients;
 * never include raw credential/identity input in an outward error. */
export function savedWorkerCommandConfig(env:Environment,buildSha:string){
 if(env.TIVDOC_SAVED_DRAFT_WORKER_ENABLED!=='true')return {enabled:false as const};
 try{
  if([env.NODE_ENV,env.VERCEL_ENV].some(v=>['production','preview'].includes(v?.trim().toLowerCase()??'')))throw new Error();
  z.string().regex(/^[a-f0-9]{40}$/u).parse(buildSha);
  const caseId=z.uuid().parse(env.TIVDOC_SAVED_WORKER_CASE_ID),identity=identitySchema.parse(JSON.parse(env.TIVDOC_SAVED_WORKER_IDENTITY??''));
  if(identity.tenant_id!==savedCaseTenant(caseId))throw new Error();
  const target=targetSchema.parse(JSON.parse(env.TIVDOC_SAVED_WORKER_DEV_TARGET??''));
  const connection=new URL(env.TIVDOC_WORKER_POSTGRES_URL??'');
  if(decodeURIComponent(connection.username)!==`tivdoc_worker_runtime.${target.project_ref}`||connection.hash||connection.search)throw new Error();
  // The driver also validates the actual URL against this exact DEV target.
  const replayOnly=env.TIVDOC_SAVED_WORKER_REPLAY_ONLY==='true';
  if(!replayOnly&&(env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED!=='true'||!env.OPENAI_API_KEY?.trim()))throw new Error();
  if(!replayOnly&&(env.OPENAI_EXTRACTION_MODEL??DEFAULT_OPENAI_EXTRACTION_MODEL)!==DEFAULT_OPENAI_EXTRACTION_MODEL)throw new Error();
  const storageUrl=env.NEXT_PUBLIC_SUPABASE_URL,storageKey=env.SUPABASE_SERVICE_ROLE_KEY;
  if(!replayOnly&&(storageUrl!==`https://${target.project_ref}.supabase.co`||!storageKey?.trim()))throw new Error();
  return {enabled:true as const,caseId,identity,target,connectionUrl:connection.toString(),replayOnly,storageUrl,storageKey,buildSha};
 }catch{throw new Error('SAVED_HOST_CONFIGURATION_INVALID');}
}

/** One invocation, no global scan or in-process recurring schedule. A replay
 * may read only already-completed work and never constructs a provider client. */
export async function runSavedWorkerCommand(env:Environment,buildSha:string,signal?:AbortSignal){
 const config=savedWorkerCommandConfig(env,buildSha);if(!config.enabled)return {worker:'saved_draft',state:'disabled'};
 if(signal?.aborted)throw new Error('SAVED_JOB_INTERRUPTED');
 const driver=NodePostgresConnectionFactory.fromConnectionUrl({connection_url:config.connectionUrl,max_connections:2,
  connection_timeout_ms:15000,application_name:'tivdoc_saved_draft_worker',remote_dev_target:config.target},
  options=>new pg.Pool({...options,ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA}}));
 try{
  const transactions=await createSavedWorkerHost({caseId:config.caseId,identity:config.identity,buildSha,target:driver.target},driver);
  const workerId=config.identity.actor_id;
  if(config.replayOnly){
   const claim=await transactions(async context=>{
    const result=await claimSavedDraftJob(context,{caseId:config.caseId,workerId,leaseMs:60000});
    // Throw INSIDE the transaction: dispatch/claim of any unfinished source is
    // rolled back, so a diagnostic replay cannot leave a newly running job.
    if(result.state!=='succeeded')throw new Error('SAVED_REPLAY_NOT_COMPLETE');return result;
   });
   const result=await runSavedDraftJob({transactions,workerId,jobId:claim.jobId,fencingToken:claim.fencingToken,
    providerEnabled:false,signal,storage:{async download(){throw new Error('SAVED_REPLAY_EXTERNAL_IO_FORBIDDEN');}}});
   return {worker:'saved_draft',state:'succeeded',replayOnly:true,manifestSha256:result.completion.sha256};
  }
  const storage=createClient(config.storageUrl!,config.storageKey!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}).storage.from('salary-documents');
  const extractor=createOpenAiPayslipV21ExtractorFromEnv(env,{log:()=>{}});
  const result=await runSavedDraftOnce({transactions,caseId:config.caseId,workerId,enabled:true,providerEnabled:true,storage,extractor,signal});
  return {worker:'saved_draft',state:result.state,...(result.state==='succeeded'?{manifestSha256:result.result.completion.sha256}:{}),...('reason' in result?{reason:result.reason}:{})};
 }finally{await driver.close();}
}
