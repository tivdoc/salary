import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hex=/^[a-f0-9]{64}$/u;
const keys=['schema_version','control_id','enabled','expires_at','expected_git_sha','expected_bundle_sha256','expected_manifest_sha256','working_directory','bundle_path','manifest_path','environment_path','output_directory','max_ticks','child_timeout_ms'];
const inheritedNames=['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','PATH','Path','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)'];
const environmentNames=new Set(['NODE_ENV','TIVDOC_MANAGED_DEV_WORKER_ENABLED','TIVDOC_MANAGED_DEV_WORKER_CAPABILITY','TIVDOC_MANAGED_DEV_BUILD_SHA',
 'TIVDOC_WORKER_POSTGRES_URL','NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED',
 'TIVDOC_MANAGED_EXTRACTION_MODE','OPENAI_API_KEY','OPENAI_EXTRACTION_MODEL','OPENAI_EXTRACTION_TIMEOUT_MS','TIVDOC_MANAGED_SOL_PACKAGE_FILE',
 'TIVDOC_NOTIFICATION_PROVIDER','RESEND_API_KEY','TIVDOC_NOTIFICATION_FROM','TIVDOC_NOTIFICATION_OUTBOX_ENABLED',
 'TIVDOC_NOTIFICATION_ENCRYPTION_KEY','DELIVERY_RECIPIENT_ALLOWLIST','TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN']);
const fail=code=>{throw new Error(code);};
const inside=(root,target)=>{const relative=path.relative(path.resolve(root),path.resolve(target));return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const readJson=file=>JSON.parse(readFileSync(file,'utf8'));

export function validateSupervisorControl(value,repositoryRoot,now=Date.now()){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))fail('SUPERVISOR_CONTROL_INVALID');
 if(value.schema_version!=='managed-dev-supervisor-v1'||!uuid.test(value.control_id)||typeof value.enabled!=='boolean'
  ||!/^[a-f0-9]{40}$/u.test(value.expected_git_sha)||!hex.test(value.expected_bundle_sha256)||!hex.test(value.expected_manifest_sha256))fail('SUPERVISOR_CONTROL_INVALID');
 const expiry=Date.parse(value.expires_at);
 if(!Number.isFinite(expiry)||expiry>now+4*3600000)fail('SUPERVISOR_EXPIRY_INVALID');
 if(!Number.isSafeInteger(value.max_ticks)||value.max_ticks<1||value.max_ticks>240||!Number.isSafeInteger(value.child_timeout_ms)||value.child_timeout_ms<1000||value.child_timeout_ms>480000)fail('SUPERVISOR_LIMIT_INVALID');
 if(path.resolve(value.working_directory)!==path.resolve(repositoryRoot))fail('SUPERVISOR_REPOSITORY_INVALID');
 const outputRoot=path.join(repositoryRoot,'output/release-completion');
 for(const key of ['bundle_path','manifest_path','output_directory'])if(typeof value[key]!=='string'||!path.isAbsolute(value[key])||!inside(outputRoot,value[key]))fail('SUPERVISOR_OUTPUT_SCOPE');
 if(typeof value.environment_path!=='string'||!path.isAbsolute(value.environment_path)||!inside(path.resolve(repositoryRoot,'../release-work'),value.environment_path))fail('SUPERVISOR_ENVIRONMENT_SCOPE');
 return {...value,expiry};
}

export function buildSupervisorEnvironment(raw,parent,buildSha){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.entries(raw).some(([key,value])=>!environmentNames.has(key)||typeof value!=='string'))fail('SUPERVISOR_ENVIRONMENT_INVALID');
 if(raw.NODE_ENV!=='development'||raw.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true'
  ||raw.TIVDOC_MANAGED_DEV_BUILD_SHA&&raw.TIVDOC_MANAGED_DEV_BUILD_SHA!==buildSha)fail('SUPERVISOR_ENVIRONMENT_INVALID');
 // Never inherit NODE_OPTIONS, cloud credentials, a second database URL,
 // proxy settings, or provider keys from the launching shell.
 return {...Object.fromEntries(inheritedNames.filter(key=>typeof parent[key]==='string').map(key=>[key,parent[key]])),...raw,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha};
}

const safeTokens=new Set(['disabled','blocked','finished','failed','interrupted','status','available','unavailable','waiting','processing','awaiting_input','complete','claimed','succeeded','busy','held','unconfirmed','queued','retry_wait','dead_letter','cancelled',
 'provider_accepted','unconfirmed_test_acceptance','sent','refused','suppressed','processing_failed','notification_processing_failed','managed_health_unavailable',
 'provider_receipt_required','provider_outcome_unknown','provider_disabled','provider_unconfigured','period_confirmation_required','purchased_document_missing','entitlement_unavailable','payment_unavailable','source_superseded','authority_superseded','worker_interrupted','worker_lease_lost','worker_scope_forbidden','scope_unsupported','scenario_unsupported','canonical_confirmation_required','canonical_activation_blocked','daily_budget_exhausted','worker_budget_exhausted','authority_expired',
 'provider_budget_unconfigured','provider_budget_exhausted','provider_budget_expired','provider_budget_locked','provider_budget_invalid','provider_pricing_expired','provider_outcome_requires_review','provider_source_not_allowed','provider_case_not_allowed',
 'notification_provider_unconfigured','notification_encryption_unconfigured','notification_recipient_unconfigured','notification_preview_origin_unconfigured',
 'MANAGED_DEV_CLEAN_BUILD_REQUIRED','MANAGED_DEV_CONFIGURATION_INVALID','MANAGED_DEV_PROVIDER_UNCONFIGURED','MANAGED_DEV_STORAGE_UNCONFIGURED','MANAGED_DEV_BUILD_MISMATCH','MANAGED_DEV_SOL_BUDGET_UNCONFIGURED','MANAGED_DEV_EXECUTION_FAILED','MANAGED_DEV_ARGUMENT_INVALID','LIVE_EXTRACTION_PROVIDER_UNCONFIGURED','LIVE_EXTRACTION_CONFIG_INVALID']);
function safeCode(value){return safeTokens.has(value)?value:null;}
const safeTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
/** Persist only reviewed operational fields. Raw stdout/stderr are never
 * saved, including when a dependency prints a private error unexpectedly. */
export function summarizeSupervisorOutput(stdout){
 let raw;try{raw=JSON.parse(stdout.trim());}catch{return {state:'invalid_output'};}
 if(!raw||typeof raw!=='object'||!['managed_dev',undefined].includes(raw.worker))return {state:'invalid_output'};
 const states=new Set(['disabled','blocked','finished','failed','interrupted','status']);
 if(!states.has(raw.state))return {state:'invalid_output'};
 const summary={state:raw.state,code:safeCode(raw.code),buildSha:typeof raw.buildSha==='string'&&/^[a-f0-9]{40}$/u.test(raw.buildSha)?raw.buildSha:null,
  items:Array.isArray(raw.items)?raw.items.slice(0,2).map(item=>({caseId:uuid.test(item.caseId)?item.caseId:null,state:safeCode(item.state),lastError:safeCode(item.lastError),jobId:typeof item.jobId==='string'&&/^saved_[a-f0-9]{64}$/u.test(item.jobId)?item.jobId:null})):[]};
 if(raw.budget&&typeof raw.budget==='object')summary.budget=Object.fromEntries(['contentRequests','generations','countRequests','reservedUpperBoundUsd','unknownOutcomes'].map(key=>[key,safeNumber(raw.budget[key])]));
 if(raw.notifications&&typeof raw.notifications==='object')summary.notifications={state:safeCode(raw.notifications.state),code:safeCode(raw.notifications.code),queued:safeNumber(raw.notifications.queued),deliveryConfirmed:false,
  attempts:Array.isArray(raw.notifications.attempts)?raw.notifications.attempts.slice(0,2).map(item=>({state:safeCode(item.state),provider:item.provider==='resend'?'resend':null,provider_message_id:uuid.test(item.provider_message_id)?item.provider_message_id:null,error_code:safeCode(item.error_code)})):[]};
 if(raw.health&&typeof raw.health==='object'){
  const h=raw.health.data;summary.health={state:safeCode(raw.health.state),code:safeCode(raw.health.code)};
  if(h&&typeof h==='object')summary.health.data={checked_at:safeTime(h.checked_at),last_activity_at:safeTime(h.last_activity_at),capability_expires_at:safeTime(h.capability_expires_at),
   ...Object.fromEntries(['daily_claims','total_claims','daily_limit','total_limit'].map(key=>[key,safeNumber(h[key])])),
   cases:Array.isArray(h.cases)?h.cases.slice(0,20).map(item=>({case_id:uuid.test(item.case_id)?item.case_id:null,pending_requests:safeNumber(item.pending_requests),authority_state:['missing','record_present','expired','revoked','invalidated'].includes(item.authority_state)?item.authority_state:null,authority_expires_at:safeTime(item.authority_expires_at)})):[]};
 }
 return summary;
}

function atomicJson(file,value){const temporary=file+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,file);}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(error){return error?.code!=='ESRCH';}}
function acquireLock(file,controlId){
 const nonce=randomUUID();
 try{const fd=openSync(file,'wx');try{writeFileSync(fd,JSON.stringify({control_id:controlId,pid:process.pid,nonce}));fsyncSync(fd);}finally{closeSync(fd);}return nonce;}
 catch(error){
  if(error?.code!=='EEXIST')throw error;
  const prior=readJson(file);
  if(prior.control_id!==controlId||!uuid.test(prior.nonce)||alive(prior.pid)||prior.child_pid&&alive(prior.child_pid))fail('SUPERVISOR_ALREADY_RUNNING');
  // A read-then-unlink "CAS" is not atomic against two restarters. Retain
  // unexpected crash locks for an owner cleanup with scheduling disabled.
  // Provider ledger locks are never inspected or removed by this supervisor.
  fail('SUPERVISOR_STALE_LOCK');
 }
}

export async function runManagedSupervisor(controlPath,{repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),parentEnvironment=process.env}={}){
 if(parentEnvironment.VERCEL||parentEnvironment.VERCEL_ENV||parentEnvironment.NODE_ENV==='production')fail('SUPERVISOR_LOCAL_DEV_ONLY');
 if(!inside(path.resolve(repositoryRoot,'../release-work'),controlPath))fail('SUPERVISOR_CONTROL_SCOPE');
 const bytes=readFileSync(controlPath),control=validateSupervisorControl(JSON.parse(bytes.toString('utf8')),repositoryRoot);
 if(!control.enabled||control.expiry<=Date.now())return {state:control.enabled?'expired':'disabled',providerStarted:false};
 const manifestBytes=readFileSync(control.manifest_path),manifest=JSON.parse(manifestBytes.toString('utf8'));
 if(sha(manifestBytes)!==control.expected_manifest_sha256||sha(readFileSync(control.bundle_path))!==control.expected_bundle_sha256
  ||manifest.gitSha!==control.expected_git_sha||manifest.dirty!==false||manifest.proofOnly!==false||manifest.bundleSha256!==control.expected_bundle_sha256)fail('SUPERVISOR_BUILD_MISMATCH');
 const env=buildSupervisorEnvironment(readJson(control.environment_path),parentEnvironment,control.expected_git_sha);
 mkdirSync(control.output_directory,{recursive:true});
 const lockPath=path.join(control.output_directory,'supervisor.lock'),nonce=acquireLock(lockPath,control.control_id);
 const started=new Date().toISOString(),runId=randomUUID();let child=null;
 try{
  const counterPath=path.join(control.output_directory,'supervisor-counter.json');let prior={control_id:control.control_id,ticks:0};
  try{prior=readJson(counterPath);}catch(error){if(error?.code!=='ENOENT')throw error;}
  if(prior.control_id!==control.control_id||!Number.isSafeInteger(prior.ticks)||prior.ticks<0)fail('SUPERVISOR_COUNTER_INVALID');
  if(prior.ticks>=control.max_ticks)return {state:'tick_limit_reached',providerStarted:false};
  atomicJson(counterPath,{control_id:control.control_id,ticks:prior.ticks+1});
  let stdout=Buffer.alloc(0),stderrBytes=0,stopReason=null;
  child=spawn(process.execPath,[control.bundle_path],{cwd:control.working_directory,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  if(child.pid)atomicJson(lockPath,{control_id:control.control_id,pid:process.pid,child_pid:child.pid,nonce});
  const stop=reason=>{if(stopReason)return;stopReason=reason;child.kill('SIGTERM');};
  child.stdout.on('data',chunk=>{if(stdout.length+chunk.length>65536){stop('output_limit');return;}stdout=Buffer.concat([stdout,chunk]);});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('output_limit');});
  const signalStop=()=>stop('supervisor_interrupted');process.once('SIGINT',signalStop);process.once('SIGTERM',signalStop);
  const startMs=Date.now();let stoppedMs=null;
  const timer=setInterval(()=>{
   try{
    const changed=readFileSync(controlPath);
    if(JSON.parse(changed.toString('utf8')).enabled!==true)stop('kill_switch');
    else if(!changed.equals(bytes))stop('control_changed');
   }catch{stop('control_unavailable');}
   if(Date.now()>=control.expiry)stop('expired');
   else if(Date.now()-startMs>=control.child_timeout_ms)stop('child_timeout');
   if(stopReason){stoppedMs??=Date.now();if(Date.now()-stoppedMs>=1000&&child.exitCode===null&&child.pid){
    // The PID comes only from the child spawned above, never a configuration
    // value. Terminate its process tree after the bounded grace period.
    try{if(process.platform==='win32')execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:3000});else child.kill('SIGKILL');}catch{/* close/exit is checked below */}
   }}
  },250);
  let outcome;
  try{outcome=await new Promise(resolve=>{child.once('error',()=>resolve({exitCode:null,signal:null,spawnFailed:true}));child.once('close',(exitCode,signal)=>resolve({exitCode,signal,spawnFailed:false}));});}
  finally{clearInterval(timer);process.removeListener('SIGINT',signalStop);process.removeListener('SIGTERM',signalStop);}
  const receipt={schema_version:'managed-dev-supervisor-receipt-v1',control_id:control.control_id,run_id:runId,pid:process.pid,child_pid:child.pid??null,
   started_at:started,finished_at:new Date().toISOString(),build_sha:control.expected_git_sha,bundle_sha256:control.expected_bundle_sha256,
   tick:prior.ticks+1,state:outcome.spawnFailed?'spawn_failed':stopReason?'stopped':outcome.exitCode===0?'finished':'worker_failed',stop_reason:stopReason,
   exit_code:outcome.exitCode,stdout_sha256:sha(stdout),stdout_bytes:stdout.length,stderr_bytes:stderrBytes,summary:summarizeSupervisorOutput(stdout.toString('utf8'))};
  atomicJson(path.join(control.output_directory,`${runId}.json`),receipt);atomicJson(path.join(control.output_directory,'latest.json'),receipt);
  return receipt;
 }finally{
  try{const current=readJson(lockPath);if(current.nonce===nonce&&current.pid===process.pid)unlinkSync(lockPath);}catch{/* A changed ownership lock is retained. */}
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4||process.argv[2]!=='--control'){console.log(JSON.stringify({state:'failed',code:'SUPERVISOR_ARGUMENT_INVALID'}));process.exitCode=1;}
 else runManagedSupervisor(path.resolve(process.argv[3])).then(result=>{console.log(JSON.stringify(result));if(!['finished','disabled','expired','tick_limit_reached'].includes(result.state))process.exitCode=1;})
  .catch(error=>{const message=error instanceof Error?error.message:'';console.log(JSON.stringify({state:'failed',code:/^SUPERVISOR_[A-Z_]+$/u.test(message)?message:'SUPERVISOR_EXECUTION_FAILED'}));process.exitCode=1;});
}
