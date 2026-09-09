import 'server-only';
import pg from 'pg';
import {z} from 'zod';
import {createClient} from '@supabase/supabase-js';
import {NodePostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {statement} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {createLiveExtractionRuntime} from './live-extraction-runtime';
import {createSavedWorkerHost} from './saved-worker-host';
import {managedWorkerConfig,managedWorkerControlConfig} from './managed-worker-config';
import {managedWorkerCandidateSchema,managedWorkerStatusSchema,managedWorkerError} from './managed-worker-contract';
import {runManagedDevCase} from './managed-worker-case';
import type {SavedMonthCompletion} from './saved-job-runner';

type Environment=Readonly<Record<string,string|undefined>>;
type Config=Extract<ReturnType<typeof managedWorkerControlConfig>,{enabled:true}>;
function driverFor(config:Config){
 return NodePostgresConnectionFactory.fromConnectionUrl({connection_url:config.connectionUrl,max_connections:2,
  connection_timeout_ms:15000,application_name:'tivdoc_managed_dev_worker',remote_dev_target:config.target},
 options=>new pg.Pool({...options,statement_timeout:30000,query_timeout:35000,ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA}}));
}
/** The scheduler capability permits ONLY the owner-enrolled QA registry.
 * Tenant context is installed separately for each actual processing operation. */
async function queryControl(driver:NodePostgresConnectionFactory,name:string,sql:string,values:Parameters<typeof statement>[2]){
 const client=await driver.acquire();
 try{return await client.query(statement(name,sql,values));}finally{await client.release();}
}

export async function readManagedDevStatus(env:Environment=process.env){
 const config=managedWorkerControlConfig(env);if(!config.enabled)return [];
 const driver=driverFor(config);
 try{
  const result=await queryControl(driver,'managed_worker_status','select * from private.managed_dev_worker_status($1)',[config.capability]);
  return z.array(managedWorkerStatusSchema).max(20).parse(result.rows);
 }finally{await driver.close();}
}
export async function retryManagedDevJob(input:{caseId:string;jobId:string;expectedRevision:number},env:Environment=process.env){
 z.object({caseId:z.uuid(),jobId:z.string().min(1).max(160),expectedRevision:z.number().int().positive()}).strict().parse(input);
 const config=managedWorkerControlConfig(env);if(!config.enabled)throw Error('MANAGED_DEV_DISABLED');
 const driver=driverFor(config);
 try{
  const result=await queryControl(driver,'managed_worker_retry','select * from private.managed_dev_worker_retry($1,$2::uuid,$3,$4)',[config.capability,input.caseId,input.jobId,input.expectedRevision]);
  return z.array(z.object({job_id:z.literal(input.jobId),job_revision:z.coerce.number().int().positive(),replayed:z.boolean()}).strict()).length(1).parse(result.rows)[0];
 }finally{await driver.close();}
}

/** One scheduler tick, at most two cases sequentially. It never retries inside
 * this invocation; authoritative eligibility/backoff and global budget are DB
 * responsibilities. A stopped process leaves an expiring durable lease. */
export async function runManagedDevTick(env:Environment,buildSha:string,onMonth:SavedMonthCompletion,signal?:AbortSignal){
 const control=managedWorkerControlConfig({...env,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha});
 if(!control.enabled)return {worker:'managed_dev',state:'disabled' as const,items:[]};
 const provider=createLiveExtractionRuntime(env);
 if(provider.state==='blocked')return {worker:'managed_dev',state:'blocked' as const,code:provider.code,items:[]};
 const config=managedWorkerConfig({...env,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha});
 if(!config.enabled)return {worker:'managed_dev',state:'disabled' as const,items:[]};
 if(config.buildSha!==buildSha)throw Error('MANAGED_DEV_BUILD_MISMATCH');
 if(signal?.aborted)return {worker:'managed_dev',state:'interrupted' as const,items:[]};
 const driver=driverFor(config),items:Awaited<ReturnType<typeof runManagedDevCase>>[]=[];
 try{
  const rows=await queryControl(driver,'managed_worker_candidates','select * from private.managed_dev_worker_candidates($1,$2)',[config.capability,2]);
  const candidates=z.array(managedWorkerCandidateSchema).max(2).parse(rows.rows);
  if(new Set(candidates.map(c=>c.case_id)).size!==candidates.length)throw Error('MANAGED_DEV_CANDIDATE_DUPLICATE');
  const storage=createClient(config.storageUrl,config.storageKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}).storage.from('salary-documents');
  // At most two bounded V2/V2.1 passes per immutable input. Unknown outcomes
  // remain reconciliation holds in the existing extraction receipt protocol.
  const extractor=provider.extractor;
  for(const candidate of candidates){
   if(signal?.aborted)break;
   try{
    const transactions=await createSavedWorkerHost({caseId:candidate.case_id,identity:candidate.identity,buildSha,target:driver.target},driver);
    items.push(await runManagedDevCase({caseId:candidate.case_id,workerId:candidate.identity.actor_id,transactions,storage,extractor,providerEnabled:true,onMonth,signal}));
   }catch(error){items.push({caseId:candidate.case_id,state:'unconfirmed',jobId:'unclaimed',lastError:managedWorkerError(error)});}
  }
  return {worker:'managed_dev',state:signal?.aborted?'interrupted' as const:'finished' as const,buildSha,items};
 }finally{await driver.close();}
}
