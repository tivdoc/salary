import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca';
import {canonicalSha256} from '../../src/engine/rule-runtime/canonical';
import {createRegularServiceTrustFixture} from '../../src/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import {employmentSnapshotSchema} from '../../src/engine/facts/snapshot';
import {hoursConflictDeclarationSchema} from '../../src/engine/extraction/hours-conflict';
import type {June2026AssessmentPacket} from '../../src/engine/minimum-wage-june2026/assessment-packet';
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const read=(f:string)=>JSON.parse(readFileSync(f,'utf8'));
const repository=path.resolve('.'),privateRoot=path.resolve('../release-work');
const configSchema=z.object({version:z.literal('managed-dev-lifecycle-v1'),caseId:z.uuid(),ownerIdentityId:z.literal('dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a'),ownerEmail:z.literal('tivdoc.com@gmail.com'),
 authorizationReference:z.string().min(8).max(1000),expiresAt:z.iso.datetime(),databaseEnvFile:z.string(),workerEnvironmentTemplate:z.string(),ledgerPath:z.string(),previewReceiptPath:z.string(),manifestPath:z.string(),taskName:z.string().regex(/^Tivdoc-[A-Za-z0-9-]{3,90}$/u)}).strict();
type Config=z.infer<typeof configSchema>;
export function validateLifecycleConfig(raw:unknown){
 const c=configSchema.parse(raw);
 for(const file of [c.databaseEnvFile,c.workerEnvironmentTemplate,c.previewReceiptPath])assertInside(privateRoot,file);
 for(const file of [c.ledgerPath,c.manifestPath])assertInside(path.join(repository,'output/release-completion'),file);
 return c;
}
function assertInside(root:string,file:string){const r=path.relative(root,path.resolve(file));if(!r||r.startsWith('..')||path.isAbsolute(r))throw Error('DEV_LIFECYCLE_PATH_SCOPE');}
function atomic(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,file);}
function receipt(directory:string,name:string,value:unknown){mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,name+'-'+Date.now()+'-'+randomUUID()+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
function task(command:'start'|'disable'|'status'|'prepare',c:Config,launcher:string){
 const escaped=(v:string)=>"'"+v.replaceAll("'","''")+"'";
 const script=command==='prepare'?`$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${escaped('-NoProfile -NonInteractive -WindowStyle Hidden -File "'+launcher+'"')}; $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Seconds ${Math.max(1,Math.floor((Date.parse(c.expiresAt)-Date.now())/1000))}); $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Register-ScheduledTask -TaskName ${escaped(c.taskName)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null; Disable-ScheduledTask -TaskName ${escaped(c.taskName)} | Out-Null`:
 command==='start'?`Enable-ScheduledTask -TaskName ${escaped(c.taskName)} | Out-Null; Start-ScheduledTask -TaskName ${escaped(c.taskName)}`:
 command==='disable'?`Disable-ScheduledTask -TaskName ${escaped(c.taskName)} | Out-Null`:
 `$t=Get-ScheduledTask -TaskName ${escaped(c.taskName)} -ErrorAction SilentlyContinue; if($t){$i=Get-ScheduledTaskInfo -TaskName ${escaped(c.taskName)}; @{state=[string]$t.State;lastResult=$i.LastTaskResult;lastRun=$i.LastRunTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress}else{'{"state":"absent"}'}`;
 return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}).trim();
}
async function connect(c:Config){
 const env=new Map(readFileSync(c.databaseEnvFile,'utf8').split(/\r?\n/u).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
 const u=new URL(env.get('TIVDOC_DEV_DATABASE_URL')??'');
 if(u.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||u.pathname!=='/tivdoc_release_replay_20260907'||u.username!=='tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu')throw Error('EXACT_DEV_OWNER_REQUIRED');u.search='';
 const db=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:20000});await db.connect();
 const identity=(await db.query('select current_database() db,session_user principal')).rows[0];if(identity.db!=='tivdoc_release_replay_20260907'||identity.principal!=='tivdoc_dev_migrator')throw Error('EXACT_DEV_OWNER_REQUIRED');return db;
}
export async function main(args:string[]){
 const [command,configFile,epochId]=args;
 if(!['prepare','start','status','pause','stop','resume','authority','notifications-pause','notifications-resume'].includes(command??'')||!configFile||!epochId||!z.uuid().safeParse(epochId).success||process.env.VERCEL||process.env.NODE_ENV==='production')throw Error('DEV_LIFECYCLE_ARGUMENTS');
 assertInside(privateRoot,configFile);const c=validateLifecycleConfig(read(configFile)),epochFile=path.join(privateRoot,'dev-epoch-'+epochId+'.private.json');
 const directory=path.join(repository,'output/release-completion/dev-operations-'+epochId),supervisorFile=path.join(privateRoot,'dev-supervisor-'+epochId+'.private.json'),environmentFile=path.join(privateRoot,'dev-worker-'+epochId+'.private.json'),launcher=path.join(privateRoot,'dev-launch-'+epochId+'.ps1');
 const ledgerBefore=sha(readFileSync(c.ledgerPath)),at=new Date().toISOString();
 const db=await connect(c);
 try{
 if(command==='prepare'||command==='resume'){
  if(Date.parse(c.expiresAt)<=Date.now()||Date.parse(c.expiresAt)>Date.now()+4*3600000)throw Error('DEV_WINDOW_EXPIRED_OR_UNBOUNDED');
  const manifest=read(c.manifestPath),preview=read(c.previewReceiptPath);
  if(manifest.dirty||manifest.proofOnly||manifest.gitSha!==preview.sha||preview.target!=='preview'||preview.readyState!=='READY'||!/^salary-[a-z0-9-]+\.vercel\.app$/u.test(preview.url))throw Error('MATCHING_READY_PREVIEW_REQUIRED');
  const bundlePath=path.join(path.dirname(c.manifestPath),'worker.cjs');if(sha(readFileSync(bundlePath))!==manifest.bundleSha256)throw Error('DEV_BUILD_HASH');
  let epoch=existsSync(epochFile)?read(epochFile):null;
  if(!epoch){
   const predecessor=(await db.query('select capability_sha256,identity_id from private.managed_dev_worker_cases where case_id=$1',[c.caseId])).rows[0];
   if(!predecessor||predecessor.identity_id!==c.ownerIdentityId)throw Error('DEV_RENEWAL_PREDECESSOR');
   epoch={epochId,caseId:c.caseId,ownerIdentityId:c.ownerIdentityId,capability:randomBytes(32).toString('base64url'),sid:'dev.epoch:'+epochId,jti:randomUUID(),expiresAt:c.expiresAt,predecessor:predecessor.capability_sha256,ledgerSha:ledgerBefore,authorizationReference:c.authorizationReference};
   writeFileSync(epochFile,JSON.stringify(epoch,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(epoch.caseId!==c.caseId||epoch.expiresAt!==c.expiresAt||epoch.ownerIdentityId!==c.ownerIdentityId||epoch.ledgerSha!==ledgerBefore||epoch.authorizationReference!==c.authorizationReference)throw Error('DEV_EPOCH_RETRY_MISMATCH');
  await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['dev-epoch:'+c.caseId]);
  const prior=(await db.query('select * from private.managed_dev_lifecycle_epochs where epoch_id=$1',[epochId])).rows[0];
  if(!prior){
   const old=(await db.query('select m.*,b.enabled capability_enabled,s.revoked_at,s.expires_at from private.managed_dev_worker_cases m join private.managed_dev_worker_capabilities b on b.capability_sha256=m.capability_sha256 join public.product_identity_sessions s on s.sid=m.session_sid where m.case_id=$1 for update of m,b,s',[c.caseId])).rows[0];
   if(!old||old.capability_sha256!==epoch.predecessor||old.capability_enabled&&old.revoked_at===null&&Date.parse(old.expires_at)>Date.now())throw Error('DEV_PREDECESSOR_MUST_BE_STOPPED');
   await db.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,$3,$4,now()-interval '1 second',$5,$6,now())",['saved-case:'+c.caseId,epoch.sid,'synthetic.dev.epoch.'+epochId,epoch.jti,c.expiresAt,sha(epoch.sid+'|'+epoch.jti)]);
   await db.query('insert into private.managed_dev_worker_capabilities(capability_sha256,enabled,expires_at,daily_limit,total_limit,notification_recipients) values($1,false,$2,20,20,$3::text[])',[sha(epoch.capability),c.expiresAt,[sha('email|'+c.ownerEmail)]]);
   await db.query('insert into private.managed_dev_lifecycle_epochs(epoch_id,case_id,capability_sha256,session_sid,predecessor_capability_sha256,owner_identity_id,authorization_reference,expires_at,provider_policy,ledger_sha256) values($1,$2,$3,$4,$5,$6,$7,$8,\'saved_receipts_only\',$9)',[epochId,c.caseId,sha(epoch.capability),epoch.sid,epoch.predecessor,c.ownerIdentityId,c.authorizationReference,c.expiresAt,ledgerBefore]);
   await db.query('update private.managed_dev_worker_cases set session_sid=$2,capability_sha256=$3,enabled=false,stopped_at=null,last_error_code=null where case_id=$1',[c.caseId,epoch.sid,sha(epoch.capability)]);
  }else if(prior.capability_sha256!==sha(epoch.capability)||prior.session_sid!==epoch.sid)throw Error('DEV_EPOCH_RETRY_MISMATCH');
  await db.query('commit');
  if(!existsSync(supervisorFile)){
   const env=read(c.workerEnvironmentTemplate);delete env.OPENAI_API_KEY;delete env.TIVDOC_MANAGED_SOL_PACKAGE_FILE;env.TIVDOC_NOTIFICATION_OUTBOX_ENABLED='false';env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED='false';env.TIVDOC_MANAGED_EXTRACTION_MODE='saved_receipts_only';env.TIVDOC_MANAGED_DEV_WORKER_ENABLED='true';env.NODE_ENV='development';env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY=epoch.capability;env.TIVDOC_MANAGED_DEV_BUILD_SHA=manifest.gitSha;env.TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN='https://'+preview.url;
   const u=new URL(env.TIVDOC_WORKER_POSTGRES_URL);u.search='?sslmode=verify-full';env.TIVDOC_WORKER_POSTGRES_URL=u.toString();atomic(environmentFile,env);
   atomic(supervisorFile,{schema_version:'managed-dev-supervisor-v1',control_id:epochId,enabled:false,expires_at:c.expiresAt,expected_git_sha:manifest.gitSha,expected_bundle_sha256:manifest.bundleSha256,expected_manifest_sha256:sha(readFileSync(c.manifestPath)),working_directory:repository,bundle_path:bundlePath,manifest_path:path.resolve(c.manifestPath),environment_path:environmentFile,output_directory:path.join(directory,'supervisor'),max_ticks:240,child_timeout_ms:480000});
   const ps=(s:string)=>"'"+s.replaceAll("'","''")+"'";writeFileSync(launcher,`$ErrorActionPreference='Stop'\nSet-Location -LiteralPath ${ps(repository)}\n& ${ps(process.execPath)} ${ps(path.join(repository,'scripts/product-workers/managed-dev-supervisor.mjs'))} --control ${ps(supervisorFile)}\nexit $LASTEXITCODE\n`,{flag:'wx'});
  }
  if(!prior||JSON.parse(task('status',c,launcher)).state==='absent')task('prepare',c,launcher);
  receipt(directory,'prepare',{at,epochId,caseId:c.caseId,replayed:!!prior,providerPolicy:'saved_receipts_only',ledgerSha256:ledgerBefore,calculationAuthorityRenewed:false,buildSha:manifest.gitSha,preview:preview.url});
  if(command==='prepare'){console.log(JSON.stringify({state:'prepared',epochId,replayed:!!prior,providerCalls:0}));return;}
 }
 if(command==='authority'){
  const ttl=Number(args[3]),requestId=args[4];if(!Number.isSafeInteger(ttl)||ttl<30||ttl>7200||!requestId||!z.uuid().safeParse(requestId).success)throw Error('DEV_AUTHORITY_ARGUMENTS');
  const epoch=read(epochFile),enrolled=(await db.query('select c.is_qa,m.capability_sha256 from public.cases c join private.managed_dev_worker_cases m on m.case_id=c.id where c.id=$1',[c.caseId])).rows[0];
  if(!enrolled?.is_qa||enrolled.capability_sha256!==sha(epoch.capability)||Date.parse(epoch.expiresAt)<=Date.now())throw Error('DEV_AUTHORITY_SCOPE');
  const authorityFile=path.join(directory,'authority-'+requestId+'.json');
  await db.query('begin');await db.query('select id from public.cases where id=$1 for update',[c.caseId]);
  const h=(await db.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[c.caseId])).rows[0];
  const registryKey='isolated.dev.renewal.'+requestId;
  const prior=(await db.query('select id,case_id,input_revision,input_sha256,payload from private.june2026_regular_assessments where registry_key=$1',[registryKey])).rows[0];
  if(prior){if(prior.case_id!==c.caseId||prior.input_revision!==h.revision||prior.input_sha256!==h.input_sha256||(Date.parse(prior.payload.payload.expires_at)-Date.parse(prior.payload.payload.issued_at))/1000!==ttl)throw Error('DEV_AUTHORITY_RETRY_SOURCE_CHANGED');await db.query('commit');console.log(JSON.stringify({state:'authority_recorded',replayed:true,assessmentId:prior.id,expiresAt:prior.payload.payload.expires_at}));return;}
  const review=(await db.query(`select a.canonical_analysis_run_id,s.payload from public.analysis_runs a join public.engine_analysis_stage_versions s on s.analysis_run_id=a.id and s.stage='review_pending' where a.canonical_case_id=$1 and a.tenant_id=$2 and a.command_payload->>'document_snapshot_id'=$3 and s.payload#>>'{diagnostics,factual_context,state}'='context_loaded' order by a.created_at desc limit 1`,[c.caseId,'saved-case:'+c.caseId,'saved-documents:2026-06:'+h.input_sha256])).rows[0];
  if(!review)throw Error('DEV_CURRENT_FACTS_REQUIRED');
  const context=review.payload.diagnostics.factual_context,facts=employmentSnapshotSchema.parse(context.facts),packet=context.admission_assessment as June2026AssessmentPacket;
  if(packet.current.input_revision!==h.revision||packet.current.input_sha256!==h.input_sha256||packet.current.case_id!==c.caseId)throw Error('DEV_CURRENT_FACTS_BINDING');
  const declaration=context.hours_conflict_declaration?hoursConflictDeclarationSchema.parse(context.hours_conflict_declaration):undefined;
  const fixture=createRegularServiceTrustFixture(new Date().toISOString(),ttl),assessment=fixture.assessment(packet,facts,declaration),{registry_sha256:ignored,...identity}=fixture.registry;void ignored;
  const registry={registry:identity,trust_journal:fixture.journal,legal:fixture.legal};
  const revision=Number((await db.query('select coalesce(max(assessment_revision),0)+1 revision from private.june2026_regular_assessments where case_id=$1 and order_id=$2 and input_revision=$3',[c.caseId,packet.current.order_id,h.revision])).rows[0].revision);
  await db.query("insert into private.june2026_authority_registries(registry_key,revision,namespace,payload,payload_sha256) values($1,1,'isolated_test',$2,$3)",[registryKey,registry,canonicalSha256(registry)]);
  await db.query('insert into private.june2026_regular_assessments(id,case_id,order_id,input_revision,input_sha256,registry_key,payload,payload_sha256,assessment_revision) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[assessment.payload.assessment_id,c.caseId,packet.current.order_id,h.revision,h.input_sha256,registryKey,assessment,canonicalSha256(assessment),revision]);
  await db.query('commit');mkdirSync(directory,{recursive:true});writeFileSync(authorityFile,JSON.stringify({at,epochId,requestId,syntheticOnly:true,registry,assessment,reviewRunId:review.canonical_analysis_run_id},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({state:'authority_recorded',replayed:false,assessmentId:assessment.payload.assessment_id,expiresAt:assessment.payload.expires_at,assessmentRevision:revision}));return;
 }
 const epoch=read(epochFile),capabilitySha=sha(epoch.capability);
 if(epoch.caseId!==c.caseId||epoch.ownerIdentityId!==c.ownerIdentityId||epoch.expiresAt!==c.expiresAt)throw Error('DEV_EPOCH_SCOPE');
 if(command==='notifications-pause'||command==='notifications-resume'){
  const env=read(environmentFile),current=(await db.query('select m.capability_sha256,s.revoked_at,s.expires_at from private.managed_dev_worker_cases m join public.product_identity_sessions s on s.sid=m.session_sid where m.case_id=$1',[c.caseId])).rows[0];
  if(current?.capability_sha256!==capabilitySha||current.revoked_at!==null||Date.parse(current.expires_at)<=Date.now())throw Error('DEV_REVOKED_EPOCH_REQUIRES_NEW_ID');
  atomic(environmentFile,{...env,TIVDOC_NOTIFICATION_OUTBOX_ENABLED:command==='notifications-resume'?'true':'false'});
  receipt(directory,command,{at,epochId,ownerOnly:true});
 }
 if(command==='start'||command==='resume'){
  const control=read(supervisorFile);if(Date.parse(control.expires_at)<=Date.now())throw Error('DEV_WINDOW_EXPIRED');
  const current=(await db.query('select m.capability_sha256,s.revoked_at,s.expires_at from private.managed_dev_worker_cases m join public.product_identity_sessions s on s.sid=m.session_sid where m.case_id=$1',[c.caseId])).rows[0];
  if(current?.capability_sha256!==capabilitySha||current.revoked_at!==null||Date.parse(current.expires_at)<=Date.now())throw Error('DEV_REVOKED_EPOCH_REQUIRES_NEW_ID');
  await db.query('begin');await db.query('update private.managed_dev_worker_capabilities set enabled=true where capability_sha256=$1 and expires_at>now()',[capabilitySha]);await db.query('update private.managed_dev_worker_cases set enabled=true where case_id=$1 and capability_sha256=$2',[c.caseId,capabilitySha]);await db.query('commit');
  atomic(supervisorFile,{...control,enabled:true});task('start',c,launcher);receipt(directory,'start',{at,epochId,providerCalls:0,ledgerSha256:ledgerBefore,calculationAuthorityRenewed:false});
 }else if(command==='pause'||command==='stop'){
  task('disable',c,launcher);const control=read(supervisorFile);atomic(supervisorFile,{...control,enabled:false});
  await db.query('begin');await db.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[capabilitySha]);await db.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=case when $3 then clock_timestamp() else stopped_at end where case_id=$1 and capability_sha256=$2',[c.caseId,capabilitySha,command==='stop']);
  if(command==='stop'){await db.query("select set_config('tivdoc.tenant_id',$1,true)",['saved-case:'+c.caseId]);await db.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where sid=$1 and tenant_id=$2',[epoch.sid,'saved-case:'+c.caseId]);}await db.query('commit');receipt(directory,command,{at,epochId,ledgerSha256:ledgerBefore,historyPreserved:true});
 }
 const notificationStatus=(await db.query("select o.state,count(*)::int count,count(*) filter(where r.dispatch_started_at is not null and o.provider_message_id is null)::int dispatch_without_receipt from private.case_notification_outbox o left join private.managed_dev_completion_rounds r on r.delivery_id=o.delivery_id where o.case_id=$1 group by o.state order by o.state",[c.caseId])).rows;
 const result={at:new Date().toISOString(),epochId,caseId:c.caseId,notificationStatus,task:JSON.parse(task('status',c,launcher)),latestTick:existsSync(path.join(directory,'supervisor/latest.json'))?read(path.join(directory,'supervisor/latest.json')):null,epoch:(await db.query('select e.epoch_id,b.enabled,b.expires_at,s.revoked_at from private.managed_dev_lifecycle_epochs e join private.managed_dev_worker_capabilities b on b.capability_sha256=e.capability_sha256 join public.product_identity_sessions s on s.sid=e.session_sid where e.epoch_id=$1',[epochId])).rows[0],ledgerSha256:sha(readFileSync(c.ledgerPath)),calculationAuthority:(await db.query("select id,assessment_revision,payload#>>'{payload,expires_at}' expires_at,revoked_at,case when revoked_at is not null then 'revoked' when (payload#>>'{payload,expires_at}')::timestamptz<=clock_timestamp() then 'expired' else 'record_present' end state from private.june2026_regular_assessments where case_id=$1 order by input_revision desc,assessment_revision desc limit 1",[c.caseId])).rows[0]};
 if(ledgerBefore!==result.ledgerSha256)throw Error('DEV_LEDGER_CHANGED');receipt(directory,command,result);console.log(JSON.stringify(result));
 }catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
}
