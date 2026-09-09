import {existsSync,readFileSync,mkdirSync,writeFileSync,openSync,closeSync,renameSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {NodePostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {statement,type PostgresParameter} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {createSavedWorkerHost} from './saved-worker-host';
import {managedWorkerControlConfig} from './managed-worker-config';
import {managedWorkerCandidateSchema,managedWorkerError} from './managed-worker-contract';
import {managedProofManifestSchema,managedProofPaths} from './managed-worker-proof-contract';
import {runManagedDevCase} from './managed-worker-case';
import {runAutomaticDevMonth} from './automatic-dev-flow';
import {runAutomaticNotificationPass} from './automatic-dev-notifications';
import {postgresCaseAccessDb} from '../case-access/db';
import {normalizeContact} from '../case-access/crypto';
import {payloadDigest,type NotificationProvider} from '../case-access/notifications';
import {devFinancialInputFixture,fixtureSha} from './dev-financial-flow.fixture';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
declare const TIVDOC_MANAGED_WORKER_BUILD_SHA:string;
declare const TIVDOC_MANAGED_WORKER_DIRTY_BUILD:boolean;

/** This entry is intentionally separate from the live executable. It cannot be
 * enabled by the live worker flag and has no real provider transport. */
async function main(){
 if(process.env.NODE_ENV!=='test'||process.env.TIVDOC_MANAGED_SYNTHETIC_PROCESS!=='1'||process.env.VERCEL||process.env.VERCEL_ENV)throw Error('MANAGED_SYNTHETIC_BOUNDARY');
 const paths=managedProofPaths();
 if(!process.env.TIVDOC_MANAGED_DEV_PROOF_MANIFEST||path.resolve(process.env.TIVDOC_MANAGED_DEV_PROOF_MANIFEST)!==paths.manifest)throw Error('MANAGED_SYNTHETIC_MANIFEST_PATH');
 if(!existsSync(paths.manifest)){console.log(JSON.stringify({state:'disabled',reason:'manifest_absent'}));return;}
 const manifest=managedProofManifestSchema.parse(JSON.parse(readFileSync(paths.manifest,'utf8')));
 if(!manifest.enabled){console.log(JSON.stringify({state:'disabled',reason:'proof_stopped'}));return;}
 if(typeof TIVDOC_MANAGED_WORKER_BUILD_SHA==='undefined'||TIVDOC_MANAGED_WORKER_BUILD_SHA!==manifest.git_sha)throw Error('MANAGED_SYNTHETIC_BUILD_MISMATCH');
 const config=managedWorkerControlConfig({NODE_ENV:'test',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_MANAGED_DEV_BUILD_SHA:manifest.git_sha,
  TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:manifest.capability,TIVDOC_WORKER_POSTGRES_URL:manifest.worker_url,NEXT_PUBLIC_SUPABASE_URL:manifest.storage_url});
 if(!config.enabled)throw Error('MANAGED_SYNTHETIC_DISABLED');
 const directory=managedProofPaths(manifest.run_id).receipts!;mkdirSync(directory,{recursive:true});
 const receipt={schema_version:'managed-dev-synthetic-tick-v1',runId:manifest.run_id,gitSha:manifest.git_sha,dirtyBuild:TIVDOC_MANAGED_WORKER_DIRTY_BUILD,
  pid:process.pid,startedAt:new Date().toISOString(),providerKind:'injected_test_provider',providerHashes:[] as string[],faults:[] as string[],items:[] as unknown[],failure:null as string|null,
  notifications:{providerKind:'injected_notification_test',claimPaused:manifest.notification_hold,recipientMismatchRefused:false,accepted:[] as {payloadSha256:string;recipientSha256:string;template:string}[],queued:0,attemptStates:[] as string[],deliveryConfirmed:false}};
 const driver=NodePostgresConnectionFactory.fromConnectionUrl({connection_url:config.connectionUrl,max_connections:2,connection_timeout_ms:15000,application_name:'tivdoc_managed_synthetic_proof',remote_dev_target:config.target},
  options=>new pg.Pool({...options,statement_timeout:30000,query_timeout:35000,ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA}}));
 const controller=new AbortController(),stop=()=>controller.abort(),timer=setTimeout(stop,8*60*1000);
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const inputs=await Promise.all([devFinancialInputFixture(false),devFinancialInputFixture(true)]);
  for(const input of inputs)if(!manifest.inputs.some(i=>i.sha256===input.sha256&&i.missing_hours===input.missingHours))throw Error('MANAGED_SYNTHETIC_ORACLE_HASH');
  const storage=createClient(manifest.storage_url,manifest.storage_key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}).storage.from('salary-documents');
  const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-never-network',model:'synthetic-managed-proof',timeoutMs:1000},{transport:{async parse(request){
   const original=request.input[0].content.find(p=>p.type==='input_file');if(!original||!('file_data'in original))throw Error('MANAGED_SYNTHETIC_PROVIDER_INPUT');
   const hash=fixtureSha(Buffer.from(original.file_data.split(',')[1],'base64')),input=inputs.find(i=>i.sha256===hash);if(!input)throw Error('MANAGED_SYNTHETIC_PROVIDER_SOURCE');
   receipt.providerHashes.push(hash);return {id:`synthetic-managed-${randomUUID()}`,status:'completed',outputParsed:structuredClone(input.output),usage:null};
  }},log:()=>{}});
  const client=await driver.acquire();let rows;
  try{rows=await client.query(statement('managed_synthetic_candidates','select * from private.managed_dev_worker_candidates($1,$2)',[manifest.capability,2]));}finally{await client.release();}
  const candidates=z.array(managedWorkerCandidateSchema).max(2).parse(rows.rows);
  if(new Set(candidates.map(c=>c.case_id)).size!==candidates.length||candidates.some(c=>!manifest.case_ids.includes(c.case_id)))throw Error('MANAGED_SYNTHETIC_CASE_SCOPE');
  for(const candidate of candidates){
   if(controller.signal.aborted)break;
   const host=await createSavedWorkerHost({caseId:candidate.case_id,identity:candidate.identity,buildSha:manifest.git_sha,target:driver.target},driver);
   const transactions:SavedWorkerTransactions=async operation=>{const result=await host(context=>operation({...context,client:{async query(query){
    if(query.name==='dev_financial_save'&&manifest.fault){
     const payload=JSON.parse(String(query.values[0])) as {source?:{version_id?:string}};
     if(payload.source?.version_id===manifest.fault.version_id){
      for(let index=0;index<manifest.fault.limit;index++){
       const faultPath=path.join(directory,`fault-${manifest.fault.version_id}-${index}.used`);
       try{const handle=openSync(faultPath,'wx');closeSync(handle);receipt.faults.push('before_financial_save');throw Error('INJECTED_MANAGED_BEFORE_FINANCIAL_SAVE');}
       catch(error){if(error instanceof Error&&error.message==='INJECTED_MANAGED_BEFORE_FINANCIAL_SAVE')throw error;if((error as {code?:string}).code!=='EEXIST')throw error;}
      }
     }
    }
    return context.client.query(query);
   }}}));
    // The host has already committed the actual claim and released its DB
    // transaction. Abrupt exit intentionally bypasses failure/lease cleanup.
    if(manifest.crash_after_claim_case===candidate.case_id&&result&&typeof result==='object'&&'state'in result&&result.state==='claimed'){
     const marker=path.join(directory,'crash-after-claim.used');
     try{const handle=openSync(marker,'wx');closeSync(handle);
      const crashPath=path.join(directory,'committed-claim-crash.json');writeFileSync(crashPath+'.tmp',JSON.stringify({caseId:candidate.case_id,pid:process.pid,at:new Date().toISOString(),claim:result,gitSha:manifest.git_sha},null,2)+'\n',{flag:'wx'});renameSync(crashPath+'.tmp',crashPath);
      process.exit(86);
     }catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}
    }
    return result;
   };
   try{receipt.items.push(await runManagedDevCase({caseId:candidate.case_id,workerId:candidate.identity.actor_id,transactions,storage,extractor,providerEnabled:true,onMonth:runAutomaticDevMonth,signal:controller.signal}));}
   catch(error){receipt.items.push({caseId:candidate.case_id,state:'unconfirmed',lastError:managedWorkerError(error)});}
  }
  if(!controller.signal.aborted){
   process.env.DELIVERY_RECIPIENT_ALLOWLIST=manifest.case_ids.map(id=>`managed-${id}@example.invalid`).join(',');
   const notificationDb=postgresCaseAccessDb({async query(sql,values){
    // Explicit test pause leaves real generated intentions queued. Releasing
    // it later exercises the unmodified SQL current-source claim guard.
    if(manifest.notification_hold&&sql.startsWith('select * from public.case_notification_managed_claim('))return {rows:[]};
    const connection=await driver.acquire();try{
     const parameters=(values??[]).map(value=>value!==null&&typeof value==='object'&&!(value instanceof Uint8Array)?JSON.stringify(value):value) as PostgresParameter[];
     if(sql.startsWith('select * from public.case_notification_managed_enqueue(')){
      const marker=path.join(directory,'notification-recipient-mismatch.used');let probe=false;
      try{const handle=openSync(marker,'wx');closeSync(handle);probe=true;}catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}
      if(probe){const placeholder=/expected_recipient\s*=>\s*\$(\d+)/u.exec(sql);if(!placeholder)throw Error('MANAGED_SYNTHETIC_NOTIFICATION_BINDING_SIGNATURE');
       const tampered=[...parameters];tampered[Number(placeholder[1])-1]=fixtureSha('foreign-notification-recipient:'+manifest.run_id);
       const refusal=await connection.query(statement('managed_notification_recipient_probe',sql,tampered));
       if(refusal.rows.length!==1||refusal.rows[0].case_notification_managed_enqueue!==null)throw Error('MANAGED_SYNTHETIC_NOTIFICATION_BINDING');receipt.notifications.recipientMismatchRefused=true;
      }
     }
     const result=await connection.query(statement('managed_notification_'+fixtureSha(sql).slice(0,40),sql,parameters));return {rows:[...result.rows]};
    }finally{await connection.release();}
   }});
   const notificationProvider:NotificationProvider={id:'injected_notification_test',async send(message){
    const recipient=normalizeContact(message.to);if(!recipient||!manifest.case_ids.some(id=>message.to===`managed-${id}@example.invalid`))throw Error('MANAGED_SYNTHETIC_NOTIFICATION_RECIPIENT');
    receipt.notifications.accepted.push({payloadSha256:payloadDigest(message),recipientSha256:recipient.hash,template:message.template});return {ok:true,provider_message_id:randomUUID()};
   }};
   const notifications=await runAutomaticNotificationPass({db:notificationDb,capability:manifest.capability,secret:manifest.notification_secret,origin:manifest.notification_origin,provider:notificationProvider});
   receipt.notifications.queued=notifications.queued;receipt.notifications.attemptStates=notifications.attempts.map(attempt=>attempt.state);
  }
 }catch(error){receipt.failure=managedWorkerError(error);process.exitCode=1;}
 finally{
  clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await driver.close();
  const file=path.join(directory,`tick-${Date.now()}-${process.pid}-${randomUUID()}.json`);writeFileSync(file+'.tmp',JSON.stringify({...receipt,finishedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});renameSync(file+'.tmp',file);
  console.log(JSON.stringify({state:receipt.failure?'failed':'finished',runId:manifest.run_id,pid:process.pid,providerPasses:receipt.providerHashes.length,faults:receipt.faults.length,items:receipt.items}));
 }
}
main().catch(()=>{console.log(JSON.stringify({state:'failed',code:'MANAGED_SYNTHETIC_PROOF_FAILED'}));process.exitCode=1;});
