import {readFileSync,writeFileSync,existsSync,realpathSync,lstatSync,mkdirSync,renameSync,openSync,closeSync,fsyncSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {lifecyclePreview} from './dev-preview-receipt.mjs';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca';
import {canonicalSha256} from '../../src/engine/rule-runtime/canonical';
import {createRegularServiceTrustFixture} from '../../src/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import {employmentSnapshotSchema} from '../../src/engine/facts/snapshot';
import {hoursConflictDeclarationSchema} from '../../src/engine/extraction/hours-conflict';
import type {June2026AssessmentPacket} from '../../src/engine/minimum-wage-june2026/assessment-packet';
import {managedSolLiveWindowSchema,assertManagedSolLiveLedger,assertManagedSolLiveLedgerTransition,type ManagedSolLiveWindow} from '../../src/server/product/processing/managed-sol-live-window.ts';
import {parseSolComparisonLedger} from '../../src/server/product/processing/live-extraction-sol-comparison-budget.ts';
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const read=(f:string)=>JSON.parse(readFileSync(f,'utf8'));
const repository=path.resolve('.'),privateRoot=path.resolve('../release-work');
const configV1Schema=z.object({version:z.literal('managed-dev-lifecycle-v1'),caseId:z.uuid(),ownerIdentityId:z.uuid(),ownerEmail:z.enum(['tivdoc.com@gmail.com','info@tivdoc.com']),
 authorizationReference:z.string().min(8).max(1000),expiresAt:z.iso.datetime(),databaseEnvFile:z.string(),workerEnvironmentTemplate:z.string(),ledgerPath:z.string(),previewReceiptPath:z.string(),manifestPath:z.string(),taskName:z.string().regex(/^Tivdoc-[A-Za-z0-9-]{3,90}$/u)}).strict();
const configV2Schema=configV1Schema.extend({version:z.literal('managed-dev-live-lifecycle-v2'),liveAuthorization:z.object({templatePath:z.string(),templateSha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()}).strict();
const configSchema=z.discriminatedUnion('version',[configV1Schema,configV2Schema]);
type Config=z.infer<typeof configSchema>;
export const lifecycleLiveTemplateSchema=z.object({version:z.literal('managed-dev-live-lifecycle-template-v2'),epochId:z.uuid(),permit:managedSolLiveWindowSchema.omit({capabilitySha256:true})}).strict();
const liveEpochSchema=z.object({providerPolicy:z.literal('sol_managed_live_window_v2'),templateSha256:z.string().regex(/^[a-f0-9]{64}$/u),permitPath:z.string(),permitSha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export function assertLifecycleCommandPolicy(config:Config,command:string){
 if(config.version==='managed-dev-live-lifecycle-v2'&&['authority','notifications-resume'].includes(command))throw Error('DEV_LIVE_COMMAND_FORBIDDEN');
}
/** The caller supplied epoch ID is part of the approved template. Binding a
 * capability cannot change the source, budget, authorization ID or window. */
export function bindLifecycleLivePermit(raw:unknown,scope:{epochId:string;caseId:string;buildSha:string;capability:string;expiresAt:string;ledgerPath:string},at=Date.now()):ManagedSolLiveWindow{
 const template=lifecycleLiveTemplateSchema.parse(raw),p=template.permit;
 if(template.epochId!==scope.epochId||p.source.caseId!==scope.caseId||p.buildSha!==scope.buildSha||p.expiresAt!==scope.expiresAt
  ||path.resolve(p.ledgerPath)!==path.resolve(scope.ledgerPath)||Date.parse(p.authorizedAt)>at||Date.parse(p.expiresAt)<=at
  ||Date.parse(p.expiresAt)<=Date.parse(p.authorizedAt)||Date.parse(p.expiresAt)-Date.parse(p.authorizedAt)>4*3600000)throw Error('DEV_LIVE_TEMPLATE_SCOPE');
 return managedSolLiveWindowSchema.parse({...p,capabilitySha256:sha(scope.capability)});
}
export function assertLifecycleProviderBinding(config:Config,stored:unknown,authorizationSha256:string|null){
 const expected=config.version==='managed-dev-live-lifecycle-v2'?'sol_managed_live_window_v2':'saved_receipts_only';
 const p=z.object({provider_policy:z.string(),provider_authorization_sha256:z.string().nullable()}).parse(stored);
 if(p.provider_policy!==expected||p.provider_authorization_sha256!==authorizationSha256
  ||(expected==='saved_receipts_only'&&authorizationSha256!==null)||(expected==='sol_managed_live_window_v2'&&!authorizationSha256))throw Error('DEV_EPOCH_RETRY_MISMATCH');
}
export function lifecycleProviderEnvironment(config:Config,original:Readonly<Record<string,unknown>>,permitPath?:string):Record<string,unknown>{
 const env={...original};delete env.OPENAI_API_KEY;delete env.TIVDOC_MANAGED_SOL_PACKAGE_FILE;
 env.TIVDOC_NOTIFICATION_OUTBOX_ENABLED='false';env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED='false';env.TIVDOC_MANAGED_EXTRACTION_MODE='saved_receipts_only';
 if(config.version==='managed-dev-live-lifecycle-v2'){
  if(!permitPath||typeof original.OPENAI_API_KEY!=='string'||!original.OPENAI_API_KEY.trim())throw Error('DEV_LIVE_PROVIDER_KEY_MISSING');
  env.OPENAI_API_KEY=original.OPENAI_API_KEY;env.OPENAI_EXTRACTION_MODEL='gpt-5.6-sol';env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED='true';
  delete env.TIVDOC_MANAGED_EXTRACTION_MODE;env.TIVDOC_MANAGED_SOL_PACKAGE_FILE=permitPath;
 }
 return env;
}
const epochBuildSchema=z.object({schema_version:z.literal('dev-lifecycle-epoch-build-v1'),
 config_sha256:z.string().regex(/^[a-f0-9]{64}$/u),template_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 manifest_sha256:z.string().regex(/^[a-f0-9]{64}$/u),application_sha:z.string().regex(/^[a-f0-9]{40}$/u),
 bundle_sha256:z.string().regex(/^[a-f0-9]{64}$/u),preview_receipt_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 preview_origin:z.string().regex(/^https:\/\/salary-[a-z0-9-]+\.vercel\.app$/u)}).strict();
/** A retry resumes the same immutable epoch. It cannot attest a new build
 * while leaving the old supervisor and environment on disk. */
export function assertLifecycleEpochBuild(expected:unknown,stored:unknown,supervisor?:unknown,environment?:unknown){
 const target=epochBuildSchema.parse(expected),prior=epochBuildSchema.safeParse(stored);
 if(!prior.success||canonicalSha256(prior.data)!==canonicalSha256(target))throw Error('DEV_EPOCH_RETRY_MISMATCH');
 if(supervisor!==undefined){
  const s=z.object({expected_git_sha:z.string(),expected_bundle_sha256:z.string(),expected_manifest_sha256:z.string()}).safeParse(supervisor);
  if(!s.success||s.data.expected_git_sha!==target.application_sha||s.data.expected_bundle_sha256!==target.bundle_sha256||s.data.expected_manifest_sha256!==target.manifest_sha256)throw Error('DEV_EPOCH_RETRY_MISMATCH');
 }
 if(environment!==undefined){
  const e=z.object({TIVDOC_MANAGED_DEV_BUILD_SHA:z.string(),TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN:z.string()}).safeParse(environment);
  if(!e.success||e.data.TIVDOC_MANAGED_DEV_BUILD_SHA!==target.application_sha||e.data.TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN!==target.preview_origin)throw Error('DEV_EPOCH_RETRY_MISMATCH');
 }
}
function lifecycleBuild(c:Config){
 const manifest=read(c.manifestPath),preview=lifecyclePreview(read(c.previewReceiptPath),manifest);
 const bundlePath=path.join(path.dirname(c.manifestPath),'worker.cjs');if(sha(readFileSync(bundlePath))!==manifest.bundleSha256)throw Error('DEV_BUILD_HASH');
 if(c.version==='managed-dev-live-lifecycle-v2')lifecycleProviderEnvironment(c,read(c.workerEnvironmentTemplate),'validated-later-bound-permit');
 const buildPins=epochBuildSchema.parse({schema_version:'dev-lifecycle-epoch-build-v1',config_sha256:canonicalSha256(c),
  template_sha256:sha(readFileSync(c.workerEnvironmentTemplate)),manifest_sha256:sha(readFileSync(c.manifestPath)),
  application_sha:manifest.gitSha,bundle_sha256:manifest.bundleSha256,preview_receipt_sha256:preview.receiptSha256,preview_origin:'https://'+preview.url});
 return {manifest,preview,bundlePath,buildPins};
}
/** A missing predecessor is a first prepare, never an invented renewal. */
export function lifecyclePredecessor(command:string,ownerIdentityId:string,raw:unknown):string|null{
 if(raw===undefined||raw===null){if(command!=='prepare')throw Error('DEV_FIRST_ENROLLMENT_REQUIRES_PREPARE');return null;}
 const previous=z.object({capability_sha256:z.string().regex(/^[a-f0-9]{64}$/u),identity_id:z.uuid()}).parse(raw);
 if(previous.identity_id!==ownerIdentityId)throw Error('DEV_RENEWAL_PREDECESSOR');return previous.capability_sha256;
}
export function assertLifecyclePredecessorStopped(expected:string|null,ownerIdentityId:string,raw:unknown,at=Date.now()){
 if(expected===null){if(raw!==null&&raw!==undefined)throw Error('DEV_EPOCH_PREDECESSOR_CHANGED');return;}
 const prior=z.object({capability_sha256:z.string(),identity_id:z.uuid(),capability_enabled:z.boolean(),revoked_at:z.coerce.date().nullable(),expires_at:z.coerce.date()}).parse(raw);
 if(prior.capability_sha256!==expected||prior.identity_id!==ownerIdentityId)throw Error('DEV_EPOCH_PREDECESSOR_CHANGED');
 if(prior.capability_enabled&&prior.revoked_at===null&&prior.expires_at.getTime()>at)throw Error('DEV_PREDECESSOR_MUST_BE_STOPPED');
}

export function validateLifecycleConfig(raw:unknown){
 const c=configSchema.parse(raw);
 for(const file of [c.databaseEnvFile,c.workerEnvironmentTemplate,c.previewReceiptPath])assertInside(privateRoot,file);
 assertInside(path.join(repository,'output/release-completion'),c.manifestPath);
 if(c.version==='managed-dev-lifecycle-v1')assertInside(path.join(repository,'output/release-completion'),c.ledgerPath);
 else{assertInside(privateRoot,c.liveAuthorization.templatePath);assertLifecycleLivePath(c.ledgerPath);}
 return c;
}
function assertLifecycleLivePath(file:string){
 try{assertInside(privateRoot,file);}catch{assertInside(path.join(repository,'output/release-completion'),file);}
}
/** Resolve existing ancestors as well as future files; a junction must not
 * redirect a scoped private input outside its permitted directory. */
export function assertLifecyclePath(root:string,file:string){
 const inside=(base:string,target:string)=>{const r=path.relative(base,target);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
 const physical=(candidate:string):string=>{let current=path.resolve(candidate);const tail:string[]=[];
  for(;;){try{lstatSync(current);return path.join(realpathSync(current),...tail);}catch(error){
   if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw Error('DEV_LIFECYCLE_PATH_SCOPE');
   const parent=path.dirname(current);if(parent===current)throw Error('DEV_LIFECYCLE_PATH_SCOPE');tail.unshift(path.basename(current));current=parent;
  }}
 };
 if(!inside(path.resolve(root),path.resolve(file))||!inside(physical(root),physical(file)))throw Error('DEV_LIFECYCLE_PATH_SCOPE');
}
const assertInside=assertLifecyclePath;
function atomic(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,file);}
function receipt(directory:string,name:string,value:unknown){mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,name+'-'+Date.now()+'-'+randomUUID()+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
function readLiveTemplate(c:z.infer<typeof configV2Schema>){
 const bytes=readFileSync(c.liveAuthorization.templatePath);if(sha(bytes)!==c.liveAuthorization.templateSha256)throw Error('DEV_LIVE_TEMPLATE_CHANGED');
 const t=lifecycleLiveTemplateSchema.parse(JSON.parse(bytes.toString('utf8')));assertLifecycleLivePath(t.permit.artifactDirectory);assertLifecycleLivePath(t.permit.ledgerPath);return t;
}
function prepareLiveEpoch(c:z.infer<typeof configV2Schema>,epoch:{epochId:string;capability:string},buildSha:string,persist=false){
 const permit=bindLifecycleLivePermit(readLiveTemplate(c),{...epoch,caseId:c.caseId,buildSha,expiresAt:c.expiresAt,ledgerPath:c.ledgerPath});
 const permitPath=path.join(privateRoot,'dev-live-permit-'+epoch.epochId+'.private.json'),bytes=JSON.stringify(permit,null,2)+'\n';
 if(persist){if(existsSync(permitPath)){if(readFileSync(permitPath,'utf8')!==bytes)throw Error('DEV_EPOCH_RETRY_MISMATCH');}
 else writeFileSync(permitPath,bytes,{flag:'wx',mode:0o600});}
 return liveEpochSchema.parse({providerPolicy:'sol_managed_live_window_v2',templateSha256:c.liveAuthorization.templateSha256,permitPath,permitSha256:sha(bytes)});
}
/** Retained local watermarks detect ledger rollback between commands. They
 * contain only the already-existing ledger, never a new budget or authority. */
export function observeLifecycleLiveLedger(epochId:string,permit:ManagedSolLiveWindow,permitSha256:string,bytes:Uint8Array){
 z.uuid().parse(epochId);
 const ledger=parseSolComparisonLedger(JSON.parse(Buffer.from(bytes).toString('utf8')));assertManagedSolLiveLedger(permit,ledger,bytes);
 const directory=path.join(privateRoot,'dev-live-ledger-'+epochId);mkdirSync(directory,{recursive:true});
 const names=readdirSync(directory).sort();let previous:ReturnType<typeof parseSolComparisonLedger>|null=null,previousSha:string|null=null;
 for(let i=0;i<names.length;i++){
  if(names[i]!==String(i).padStart(6,'0')+'.json')throw Error('DEV_LIVE_LEDGER_HISTORY');
  const raw=read(path.join(directory,names[i])),entry=z.object({sequence:z.number().int(),permitSha256:z.string(),previousSha256:z.string().nullable(),ledger:z.unknown(),sha256:z.string()}).strict().parse(raw);
  const {sha256:digest,...body}=entry;
  if(entry.sequence!==i||entry.permitSha256!==permitSha256||entry.previousSha256!==previousSha||canonicalSha256(body)!==digest)throw Error('DEV_LIVE_LEDGER_HISTORY');
  const value=parseSolComparisonLedger(entry.ledger);assertManagedSolLiveLedger(permit,value);
  if(previous)assertManagedSolLiveLedgerTransition(permit,previous,value);previous=value;previousSha=digest;
 }
 if(previous){assertManagedSolLiveLedgerTransition(permit,previous,ledger);if(canonicalSha256(previous)===canonicalSha256(ledger))return;}
 const body={sequence:names.length,permitSha256,previousSha256:previousSha,ledger};
 writeFileSync(path.join(directory,String(names.length).padStart(6,'0')+'.json'),JSON.stringify({...body,sha256:canonicalSha256(body)},null,2)+'\n',{flag:'wx',mode:0o600});
}
function currentLiveEpoch(c:z.infer<typeof configV2Schema>,raw:unknown,environment?:unknown,active=false){
 const epoch=z.object({epochId:z.uuid(),caseId:z.uuid(),capability:z.string(),expiresAt:z.string(),buildPins:epochBuildSchema,live:liveEpochSchema}).parse(raw);
 const live=epoch.live;assertInside(privateRoot,live.permitPath);
 if(live.permitPath!==path.join(privateRoot,'dev-live-permit-'+epoch.epochId+'.private.json')||live.templateSha256!==c.liveAuthorization.templateSha256)throw Error('DEV_EPOCH_RETRY_MISMATCH');
 const bytes=readFileSync(live.permitPath);if(sha(bytes)!==live.permitSha256)throw Error('DEV_LIVE_PERMIT_CHANGED');
 const permit=managedSolLiveWindowSchema.parse(JSON.parse(bytes.toString('utf8')));
 const expected=bindLifecycleLivePermit(readLiveTemplate(c),{epochId:epoch.epochId,caseId:c.caseId,buildSha:epoch.buildPins.application_sha,
  capability:epoch.capability,expiresAt:c.expiresAt,ledgerPath:c.ledgerPath},Date.parse(permit.authorizedAt));
 if(canonicalSha256(permit)!==canonicalSha256(expected))throw Error('DEV_EPOCH_RETRY_MISMATCH');
 if(active&&(Date.parse(permit.authorizedAt)>Date.now()||Date.parse(permit.expiresAt)<=Date.now()))throw Error('DEV_LIVE_WINDOW_EXPIRED');
 if(environment!==undefined){const env=z.record(z.string(),z.unknown()).parse(environment);
  if(env.TIVDOC_MANAGED_SOL_PACKAGE_FILE!==live.permitPath||env.TIVDOC_NOTIFICATION_OUTBOX_ENABLED!=='false'||env.TIVDOC_MANAGED_EXTRACTION_MODE!==undefined
   ||env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED!=='true'||env.OPENAI_EXTRACTION_MODEL!=='gpt-5.6-sol'
   ||env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY!==epoch.capability||env.NODE_ENV!=='development')throw Error('DEV_LIVE_ENVIRONMENT_CHANGED');}
 observeLifecycleLiveLedger(epoch.epochId,permit,live.permitSha256,readFileSync(c.ledgerPath));return {permit,live};
}
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
/** Shutdown authenticates the immutable epoch, never extraction readiness.
 * Commit revocation before touching fallible local scheduler/control files. */
export async function shutdownLifecycleEpoch(db:Pick<pg.Client,'query'>,c:Config,epochId:string,raw:unknown,command:'pause'|'stop',local:{disableTask:()=>void;disableSupervisor:()=>void}){
 const epoch=z.object({epochId:z.uuid(),caseId:z.uuid(),ownerIdentityId:z.uuid(),capability:z.string().min(16),sid:z.string().min(1),authorizationReference:z.string(),buildPins:z.object({config_sha256:z.string()})}).parse(raw);
 if(epoch.epochId!==epochId||epoch.caseId!==c.caseId||epoch.ownerIdentityId!==c.ownerIdentityId||epoch.authorizationReference!==c.authorizationReference
  ||epoch.buildPins.config_sha256!==canonicalSha256(c))throw Error('DEV_SHUTDOWN_EPOCH_SCOPE');
 const capabilitySha=sha(epoch.capability);
 await db.query('begin');
 try{
  const row=(await db.query('select e.case_id,e.owner_identity_id,e.capability_sha256,e.session_sid,e.authorization_reference,s.tenant_id from private.managed_dev_lifecycle_epochs e join public.product_identity_sessions s on s.sid=e.session_sid join private.managed_dev_worker_capabilities b on b.capability_sha256=e.capability_sha256 where e.epoch_id=$1 for update of s,b',[epochId])).rows[0];
  if(!row||row.case_id!==c.caseId||row.owner_identity_id!==c.ownerIdentityId||row.capability_sha256!==capabilitySha||row.session_sid!==epoch.sid
   ||row.authorization_reference!==c.authorizationReference||row.tenant_id!=='saved-case:'+c.caseId)throw Error('DEV_SHUTDOWN_EPOCH_SCOPE');
  await db.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[capabilitySha]);
  await db.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=case when $3 then clock_timestamp() else stopped_at end where case_id=$1 and capability_sha256=$2',[c.caseId,capabilitySha,command==='stop']);
  if(command==='stop'){
   await db.query("select set_config('tivdoc.tenant_id',$1,true)",['saved-case:'+c.caseId]);
   await db.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where sid=$1 and tenant_id=$2',[epoch.sid,'saved-case:'+c.caseId]);
  }
  await db.query('commit');
 }catch(error){await db.query('rollback').catch(()=>{});throw error;}
 const warnings:string[]=[];
 try{local.disableTask();}catch{warnings.push('DEV_LOCAL_TASK_DISABLE_FAILED');}
 try{local.disableSupervisor();}catch{warnings.push('DEV_LOCAL_SUPERVISOR_DISABLE_FAILED');}
 return {state:command==='stop'?'stopped':'paused',epochId,caseId:c.caseId,capabilityDisabled:true,sessionRevoked:command==='stop',warnings,historyPreserved:true};
}
export async function main(args:string[]){
 const [command,configFile,epochId]=args;
 if(!['prepare','start','status','pause','stop','resume','authority','notifications-pause','notifications-resume'].includes(command??'')||!configFile||!epochId||!z.uuid().safeParse(epochId).success||process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV==='production')throw Error('DEV_LIFECYCLE_ARGUMENTS');
 const shutdown=command==='pause'||command==='stop';
 assertInside(privateRoot,configFile);const c=shutdown?configSchema.parse(read(configFile)):validateLifecycleConfig(read(configFile));
 if(shutdown)assertInside(privateRoot,c.databaseEnvFile);
 const epochFile=path.join(privateRoot,'dev-epoch-'+epochId+'.private.json');
 assertLifecycleCommandPolicy(c,command);
 const directory=path.join(repository,'output/release-completion/dev-operations-'+epochId),supervisorFile=path.join(privateRoot,'dev-supervisor-'+epochId+'.private.json'),environmentFile=path.join(privateRoot,'dev-worker-'+epochId+'.private.json'),launcher=path.join(privateRoot,'dev-launch-'+epochId+'.ps1');
 if(shutdown){
  const epoch=read(epochFile),db=await connect(c);
  try{
   const result=await shutdownLifecycleEpoch(db,c,epochId,epoch,command,{disableTask:()=>{task('disable',c,launcher);},disableSupervisor:()=>{
    const control=read(supervisorFile);if(control.control_id!==epochId)throw Error('DEV_SUPERVISOR_SCOPE');atomic(supervisorFile,{...control,enabled:false});}});
   try{if(c.version==='managed-dev-live-lifecycle-v2')currentLiveEpoch(c,epoch,read(environmentFile));
    assertLifecycleEpochBuild(lifecycleBuild(c).buildPins,epoch.buildPins);
    if(c.version==='managed-dev-lifecycle-v1'&&sha(readFileSync(c.ledgerPath))!==epoch.ledgerSha)throw Error('DEV_LEDGER_CHANGED');
   }catch{result.warnings.push('DEV_EXTRACTION_ARTIFACTS_UNAVAILABLE_OR_CHANGED');}
   receipt(directory,command,{at:new Date().toISOString(),...result});console.log(JSON.stringify(result));return;
  }finally{await db.end();}
 }
 const ledgerBefore=sha(readFileSync(c.ledgerPath)),at=new Date().toISOString();
 const db=await connect(c);
 try{
 if(command==='prepare'||command==='resume'){
  if(Date.parse(c.expiresAt)<=Date.now()||Date.parse(c.expiresAt)>Date.now()+4*3600000)throw Error('DEV_WINDOW_EXPIRED_OR_UNBOUNDED');
  const {manifest,preview,bundlePath,buildPins}=lifecycleBuild(c);
  let epoch=existsSync(epochFile)?read(epochFile):null;
  if(epoch)assertLifecycleEpochBuild(buildPins,epoch.buildPins,existsSync(supervisorFile)?read(supervisorFile):undefined,existsSync(environmentFile)?read(environmentFile):undefined);
  if(!epoch){
   const predecessor=(await db.query('select capability_sha256,identity_id from private.managed_dev_worker_cases where case_id=$1',[c.caseId])).rows[0];
   const predecessorSha=lifecyclePredecessor(command,c.ownerIdentityId,predecessor);
   if(!(await db.query("select c.id from public.cases c join public.case_identity_cases ic on ic.case_id=c.id join public.case_identities i on i.id=ic.identity_id where c.id=$1 and c.is_qa and c.contact_verified_at is not null and i.id=$2 and i.channel='email' and i.contact_normalized=$3",[c.caseId,c.ownerIdentityId,c.ownerEmail])).rows.length)throw Error('DEV_OWNER_CASE_SCOPE');
   epoch={epochId,caseId:c.caseId,ownerIdentityId:c.ownerIdentityId,capability:randomBytes(32).toString('base64url'),sid:'dev.epoch:'+epochId,jti:randomUUID(),expiresAt:c.expiresAt,predecessor:predecessorSha,ledgerSha:ledgerBefore,authorizationReference:c.authorizationReference,buildPins};
   if(c.version==='managed-dev-live-lifecycle-v2')epoch.live=prepareLiveEpoch(c,epoch,manifest.gitSha);
   writeFileSync(epochFile,JSON.stringify(epoch,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(epoch.caseId!==c.caseId||epoch.expiresAt!==c.expiresAt||epoch.ownerIdentityId!==c.ownerIdentityId||(c.version==='managed-dev-lifecycle-v1'&&epoch.ledgerSha!==ledgerBefore)||epoch.authorizationReference!==c.authorizationReference)throw Error('DEV_EPOCH_RETRY_MISMATCH');
  if(c.version==='managed-dev-live-lifecycle-v2'){
   const prepared=prepareLiveEpoch(c,epoch,manifest.gitSha);
   if(canonicalSha256(liveEpochSchema.parse(epoch.live))!==canonicalSha256(prepared))throw Error('DEV_EPOCH_RETRY_MISMATCH');
   prepareLiveEpoch(c,epoch,manifest.gitSha,true);
  }
  const liveState=c.version==='managed-dev-live-lifecycle-v2'?currentLiveEpoch(c,epoch,existsSync(environmentFile)?read(environmentFile):undefined,true):null;
  await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['dev-epoch:'+c.caseId]);await db.query('select id from public.cases where id=$1 for update',[c.caseId]);
  const prior=(await db.query('select * from private.managed_dev_lifecycle_epochs where epoch_id=$1',[epochId])).rows[0];
  if(!prior){
   const old=(await db.query('select m.*,b.enabled capability_enabled,s.revoked_at,s.expires_at from private.managed_dev_worker_cases m join private.managed_dev_worker_capabilities b on b.capability_sha256=m.capability_sha256 join public.product_identity_sessions s on s.sid=m.session_sid where m.case_id=$1 for update of m,b,s',[c.caseId])).rows[0];
   assertLifecyclePredecessorStopped(epoch.predecessor,c.ownerIdentityId,old);
   await db.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,$3,$4,now()-interval '1 second',$5,$6,now())",['saved-case:'+c.caseId,epoch.sid,'synthetic.dev.epoch.'+epochId,epoch.jti,c.expiresAt,sha(epoch.sid+'|'+epoch.jti)]);
   await db.query('insert into private.managed_dev_worker_capabilities(capability_sha256,enabled,expires_at,daily_limit,total_limit,notification_recipients) values($1,false,$2,20,20,$3::text[])',[sha(epoch.capability),c.expiresAt,[sha('email|'+c.ownerEmail)]]);
   await db.query('insert into private.managed_dev_lifecycle_epochs(epoch_id,case_id,capability_sha256,session_sid,predecessor_capability_sha256,owner_identity_id,authorization_reference,expires_at,provider_policy,ledger_sha256,provider_authorization_sha256) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[epochId,c.caseId,sha(epoch.capability),epoch.sid,epoch.predecessor,c.ownerIdentityId,c.authorizationReference,c.expiresAt,liveState?'sol_managed_live_window_v2':'saved_receipts_only',epoch.ledgerSha,liveState?.live.permitSha256??null]);
   if(epoch.predecessor===null)await db.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256,enabled) values($1,$2,$3,$4,false)',[c.caseId,c.ownerIdentityId,epoch.sid,sha(epoch.capability)]);
   else await db.query('update private.managed_dev_worker_cases set session_sid=$2,capability_sha256=$3,enabled=false,stopped_at=null,last_error_code=null where case_id=$1',[c.caseId,epoch.sid,sha(epoch.capability)]);
  }else{if(prior.capability_sha256!==sha(epoch.capability)||prior.session_sid!==epoch.sid)throw Error('DEV_EPOCH_RETRY_MISMATCH');assertLifecycleProviderBinding(c,prior,liveState?.live.permitSha256??null);}
  await db.query('commit');
  if(!existsSync(supervisorFile)){
   const env=lifecycleProviderEnvironment(c,read(c.workerEnvironmentTemplate),liveState?.live.permitPath);env.TIVDOC_MANAGED_DEV_WORKER_ENABLED='true';env.NODE_ENV='development';env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY=epoch.capability;env.TIVDOC_MANAGED_DEV_BUILD_SHA=manifest.gitSha;env.TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN='https://'+preview.url;
   if((await db.query('select 1 from private.ai_release_enrollment_events where case_id=$1 limit 1',[c.caseId])).rows.length)env.TIVDOC_AI_RELEASE_ENABLED='1';
   if(typeof env.TIVDOC_WORKER_POSTGRES_URL!=='string')throw Error('DEV_WORKER_DATABASE_URL');const u=new URL(env.TIVDOC_WORKER_POSTGRES_URL);u.search='?sslmode=verify-full';env.TIVDOC_WORKER_POSTGRES_URL=u.toString();atomic(environmentFile,env);
   atomic(supervisorFile,{schema_version:'managed-dev-supervisor-v1',control_id:epochId,enabled:false,expires_at:c.expiresAt,expected_git_sha:manifest.gitSha,expected_bundle_sha256:manifest.bundleSha256,expected_manifest_sha256:sha(readFileSync(c.manifestPath)),working_directory:repository,bundle_path:bundlePath,manifest_path:path.resolve(c.manifestPath),environment_path:environmentFile,output_directory:path.join(directory,'supervisor'),max_ticks:240,child_timeout_ms:480000});
   const ps=(s:string)=>"'"+s.replaceAll("'","''")+"'";writeFileSync(launcher,`$ErrorActionPreference='Stop'\nSet-Location -LiteralPath ${ps(repository)}\n& ${ps(process.execPath)} ${ps(path.join(repository,'scripts/product-workers/managed-dev-supervisor.mjs'))} --control ${ps(supervisorFile)}\nexit $LASTEXITCODE\n`,{flag:'wx'});
  }
  if(!prior||JSON.parse(task('status',c,launcher)).state==='absent')task('prepare',c,launcher);
  receipt(directory,'prepare',{at,epochId,caseId:c.caseId,replayed:!!prior,providerPolicy:liveState?'sol_managed_live_window_v2':'saved_receipts_only',...(liveState?{providerAuthorizationSha256:liveState.live.permitSha256}:{}),ledgerSha256:ledgerBefore,calculationAuthorityRenewed:false,buildSha:manifest.gitSha,preview:preview.url,previewEvidence:preview.evidence,previewReceiptSha256:preview.receiptSha256});
  if(command==='prepare'){console.log(JSON.stringify({state:'prepared',epochId,replayed:!!prior,providerCalls:0}));return;}
 }
 if(command==='authority'){
  const ttl=Number(args[3]),requestId=args[4];if(!Number.isSafeInteger(ttl)||ttl<30||ttl>7200||!requestId||!z.uuid().safeParse(requestId).success)throw Error('DEV_AUTHORITY_ARGUMENTS');
  const epoch=read(epochFile),enrolled=(await db.query('select c.is_qa,m.capability_sha256 from public.cases c join private.managed_dev_worker_cases m on m.case_id=c.id where c.id=$1',[c.caseId])).rows[0];
  if((await db.query('select 1 from private.ai_release_enrollment_events where case_id=$1 limit 1',[c.caseId])).rows.length)throw Error('DEV_AI_USE_CONFIGURATION_CONTROL');
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
 if(c.version==='managed-dev-live-lifecycle-v2'){
  const liveState=currentLiveEpoch(c,epoch,read(environmentFile),command==='start'||command==='resume');
  const row=(await db.query('select provider_policy,provider_authorization_sha256 from private.managed_dev_lifecycle_epochs where epoch_id=$1 and case_id=$2 and capability_sha256=$3',[epochId,c.caseId,capabilitySha])).rows[0];
  assertLifecycleProviderBinding(c,row,liveState.live.permitSha256);
  assertLifecycleEpochBuild(lifecycleBuild(c).buildPins,epoch.buildPins,read(supervisorFile),read(environmentFile));
 }
 if(command==='notifications-pause'||command==='notifications-resume'){
  const env=read(environmentFile),current=(await db.query('select m.capability_sha256,s.revoked_at,s.expires_at from private.managed_dev_worker_cases m join public.product_identity_sessions s on s.sid=m.session_sid where m.case_id=$1',[c.caseId])).rows[0];
  if(current?.capability_sha256!==capabilitySha||current.revoked_at!==null||Date.parse(current.expires_at)<=Date.now())throw Error('DEV_REVOKED_EPOCH_REQUIRES_NEW_ID');
  atomic(environmentFile,{...env,TIVDOC_NOTIFICATION_OUTBOX_ENABLED:command==='notifications-resume'?'true':'false'});
  receipt(directory,command,{at,epochId,ownerOnly:true});
 }
 if(command==='start'||command==='resume'){
  const control=read(supervisorFile);if(Date.parse(control.expires_at)<=Date.now())throw Error('DEV_WINDOW_EXPIRED');
  assertLifecycleEpochBuild(lifecycleBuild(c).buildPins,epoch.buildPins,control,read(environmentFile));
  const current=(await db.query('select m.capability_sha256,s.revoked_at,s.expires_at from private.managed_dev_worker_cases m join public.product_identity_sessions s on s.sid=m.session_sid where m.case_id=$1',[c.caseId])).rows[0];
  if(current?.capability_sha256!==capabilitySha||current.revoked_at!==null||Date.parse(current.expires_at)<=Date.now())throw Error('DEV_REVOKED_EPOCH_REQUIRES_NEW_ID');
  await db.query('begin');await db.query('update private.managed_dev_worker_capabilities set enabled=true where capability_sha256=$1 and expires_at>now()',[capabilitySha]);await db.query('update private.managed_dev_worker_cases set enabled=true where case_id=$1 and capability_sha256=$2',[c.caseId,capabilitySha]);await db.query('commit');
  atomic(supervisorFile,{...control,enabled:true});task('start',c,launcher);receipt(directory,'start',{at,epochId,providerCalls:0,ledgerSha256:ledgerBefore,calculationAuthorityRenewed:false});
 }

 const notificationStatus=(await db.query("select o.state,count(*)::int count,count(*) filter(where r.dispatch_started_at is not null and o.provider_message_id is null)::int dispatch_without_receipt from private.case_notification_outbox o left join private.managed_dev_completion_rounds r on r.delivery_id=o.delivery_id where o.case_id=$1 group by o.state order by o.state",[c.caseId])).rows;
 const aiAuthority=(await db.query("select 'qualified_ai_v1' profile,e.event_id,e.sequence,e.configuration_sha256,e.kind,e.expires_at,least(e.expires_at,(c.payload#>>'{policy,expires_at}')::timestamptz,(c.payload#>>'{registry,expires_at}')::timestamptz) usable_until,case when e.kind='revoked' then 'revoked' when least(e.expires_at,(c.payload#>>'{policy,expires_at}')::timestamptz,(c.payload#>>'{registry,expires_at}')::timestamptz)<=clock_timestamp() then 'expired' else 'record_present' end state from private.ai_release_enrollment_events e join private.ai_release_configurations c on c.payload_sha256=e.configuration_sha256 where e.case_id=$1 order by e.sequence desc limit 1",[c.caseId])).rows[0];
 const result={at:new Date().toISOString(),epochId,caseId:c.caseId,notificationStatus,task:JSON.parse(task('status',c,launcher)),latestTick:existsSync(path.join(directory,'supervisor/latest.json'))?read(path.join(directory,'supervisor/latest.json')):null,epoch:(await db.query('select e.epoch_id,b.enabled,b.expires_at,s.revoked_at from private.managed_dev_lifecycle_epochs e join private.managed_dev_worker_capabilities b on b.capability_sha256=e.capability_sha256 join public.product_identity_sessions s on s.sid=e.session_sid where e.epoch_id=$1',[epochId])).rows[0],ledgerSha256:sha(readFileSync(c.ledgerPath)),calculationAuthority:aiAuthority??(await db.query("select id,assessment_revision,payload#>>'{payload,expires_at}' expires_at,revoked_at,case when revoked_at is not null then 'revoked' when (payload#>>'{payload,expires_at}')::timestamptz<=clock_timestamp() then 'expired' else 'record_present' end state from private.june2026_regular_assessments where case_id=$1 order by input_revision desc,assessment_revision desc limit 1",[c.caseId])).rows[0]};
 if(c.version==='managed-dev-lifecycle-v1'){if(ledgerBefore!==result.ledgerSha256)throw Error('DEV_LEDGER_CHANGED');}
 else currentLiveEpoch(c,epoch,read(environmentFile));
 receipt(directory,command,result);console.log(JSON.stringify(result));
 }catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
}
