import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {buildSupervisorEnvironment,runManagedSupervisor,summarizeSupervisorOutput,validateSupervisorControl} from './managed-dev-supervisor.mjs';

const owned=[];
afterEach(()=>{for(const directory of owned.splice(0)){expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));expect(path.basename(directory)).toMatch(/^tivdoc-managed-supervisor-/u);rmSync(directory,{recursive:true,force:true});}});
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(program=`console.log(JSON.stringify({worker:'managed_dev',state:'finished',items:[],privateKey:'do-not-save',notifications:{state:'finished',deliveryConfirmed:false,attempts:[]}}));`){
 const directory=mkdtempSync(path.join(tmpdir(),'tivdoc-managed-supervisor-'));owned.push(directory);
 const repositoryRoot=path.join(directory,'repo'),privateRoot=path.join(directory,'release-work'),out=path.join(repositoryRoot,'output/release-completion/synthetic-supervisor');
 mkdirSync(privateRoot,{recursive:true});mkdirSync(out,{recursive:true});
 const bundle=path.join(out,'worker.cjs'),manifest=path.join(out,'manifest.json'),environment=path.join(privateRoot,'env.private.json'),controlPath=path.join(privateRoot,'control.private.json');
 writeFileSync(bundle,program);writeFileSync(manifest,JSON.stringify({gitSha:'a'.repeat(40),dirty:false,proofOnly:false,bundleSha256:hash(program)}));
 writeFileSync(environment,JSON.stringify({NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',OPENAI_API_KEY:'synthetic-secret'}));
 const control={schema_version:'managed-dev-supervisor-v1',control_id:randomUUID(),enabled:true,expires_at:new Date(Date.now()+60000).toISOString(),
  expected_git_sha:'a'.repeat(40),expected_bundle_sha256:hash(program),expected_manifest_sha256:hash(readFileSync(manifest)),working_directory:repositoryRoot,bundle_path:bundle,manifest_path:manifest,environment_path:environment,
  output_directory:path.join(out,'receipts'),max_ticks:2,child_timeout_ms:3000};
 const save=()=>writeFileSync(controlPath,JSON.stringify(control));save();
 return {directory,repositoryRoot,control,controlPath,save,run:()=>runManagedSupervisor(controlPath,{repositoryRoot,parentEnvironment:{...process.env,NODE_ENV:'development',VERCEL:undefined,VERCEL_ENV:undefined}})};
}
describe('local managed supervisor, injected subprocess only',()=>{
 it('runs a pinned child, retains safe evidence and supports a separate process restart with no persistent child',async()=>{
  const f=fixture();const first=await f.run(),second=await f.run();
  expect(first.state).toBe('finished');expect(second.state).toBe('finished');expect(second.tick).toBe(2);expect(first.child_pid).not.toBe(second.child_pid);
  expect(existsSync(path.join(f.control.output_directory,'supervisor.lock'))).toBe(false);
  expect((await f.run()).state).toBe('tick_limit_reached');
  const receipts=readdirSync(f.control.output_directory).filter(file=>file.endsWith('.json')).map(file=>readFileSync(path.join(f.control.output_directory,file),'utf8')).join('');
  expect(receipts).not.toContain('do-not-save');expect(receipts).not.toContain('synthetic-secret');
 });
 it('refuses another concurrent supervisor before spawning a second child',async()=>{
  const f=fixture(`setTimeout(()=>console.log(JSON.stringify({worker:'managed_dev',state:'finished',items:[]})),300);`);
  const first=f.run();await expect(f.run()).rejects.toThrow('SUPERVISOR_ALREADY_RUNNING');expect((await first).state).toBe('finished');
 });
 it('stops only its child when the enabled kill switch changes and records the reason',async()=>{
  const f=fixture('setInterval(()=>{},1000);');const pending=f.run();const timer=setTimeout(()=>{f.control.enabled=false;f.save();},80);
  try{expect(await pending).toMatchObject({state:'stopped',stop_reason:'kill_switch'});}finally{clearTimeout(timer);}
  expect(existsSync(path.join(f.control.output_directory,'supervisor.lock'))).toBe(false);
 });
 it('enforces a running child deadline without starting another worker',async()=>{
  const f=fixture('setInterval(()=>{},1000);');f.control.expires_at=new Date(Date.now()+400).toISOString();f.save();
  expect(await f.run()).toMatchObject({state:'stopped',stop_reason:'expired'});
 });
 it('refuses bundle tampering before creating process receipts or reading provider configuration',async()=>{
  const f=fixture();writeFileSync(f.control.bundle_path,'throw Error("tampered")');await expect(f.run()).rejects.toThrow('SUPERVISOR_BUILD_MISMATCH');
  expect(existsSync(f.control.output_directory)).toBe(false);
 });
 it('a disabled or expired control creates no child even when the bundle is absent',async()=>{
  const f=fixture();f.control.enabled=false;f.save();expect(await f.run()).toEqual({state:'disabled',providerStarted:false});
  f.control.enabled=true;f.control.expires_at=new Date(Date.now()-1).toISOString();f.save();expect(await f.run()).toEqual({state:'expired',providerStarted:false});
 });
 it('isolates inherited secrets, startup hooks and cloud targets from the child environment',()=>{
  const env=buildSupervisorEnvironment({NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',OPENAI_API_KEY:'owned'},
   {SystemRoot:'C:/Windows',NODE_OPTIONS:'--require private',OPENAI_API_KEY:'foreign',VERCEL:'1',PGPASSWORD:'foreign',HTTPS_PROXY:'private'},'a'.repeat(40));
  expect(env).toEqual({SystemRoot:'C:/Windows',NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',OPENAI_API_KEY:'owned',TIVDOC_MANAGED_DEV_BUILD_SHA:'a'.repeat(40)});
  expect(()=>buildSupervisorEnvironment({...env,RESEND_WEBHOOK_SECRET:'unneeded'}, {},'a'.repeat(40))).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
 });
 it('passes only the explicit lifecycle AI flag to a pinned saved-receipt worker',async()=>{
  const f=fixture(`if(process.env.TIVDOC_AI_RELEASE_ENABLED!=='1'||process.env.TIVDOC_MANAGED_EXTRACTION_MODE!=='saved_receipts_only'||process.env.OPENAI_API_KEY)process.exit(3);console.log(JSON.stringify({worker:'managed_dev',state:'finished',items:[]}));`);
  writeFileSync(f.control.environment_path,JSON.stringify({NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_AI_RELEASE_ENABLED:'1',TIVDOC_MANAGED_EXTRACTION_MODE:'saved_receipts_only',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'false',TIVDOC_NOTIFICATION_OUTBOX_ENABLED:'false'}));
  expect(await f.run()).toMatchObject({state:'finished',exit_code:0});
  const raw={NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true'};
  expect(buildSupervisorEnvironment(raw,{TIVDOC_AI_RELEASE_ENABLED:'1'},'a'.repeat(40))).not.toHaveProperty('TIVDOC_AI_RELEASE_ENABLED');
  expect(buildSupervisorEnvironment({...raw,TIVDOC_AI_RELEASE_ENABLED:'0'},{},'a'.repeat(40)).TIVDOC_AI_RELEASE_ENABLED).toBe('0');
  expect(()=>buildSupervisorEnvironment({...raw,TIVDOC_AI_RELEASE_ENABLED:'true'},{},'a'.repeat(40))).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
  expect(()=>buildSupervisorEnvironment({...raw,TIVDOC_AI_RELEASE_BYPASS:'1'},{},'a'.repeat(40))).toThrow('SUPERVISOR_ENVIRONMENT_INVALID');
 });
 it('refuses a control path escaping the release output/private roots and an unlimited lifetime',()=>{
  const f=fixture();expect(()=>validateSupervisorControl({...f.control,environment_path:path.join(f.directory,'foreign.json')},f.repositoryRoot)).toThrow('SUPERVISOR_ENVIRONMENT_SCOPE');
  expect(()=>validateSupervisorControl({...f.control,output_directory:f.directory},f.repositoryRoot)).toThrow('SUPERVISOR_OUTPUT_SCOPE');
  expect(()=>validateSupervisorControl({...f.control,expires_at:new Date(Date.now()+5*3600000).toISOString()},f.repositoryRoot)).toThrow('SUPERVISOR_EXPIRY_INVALID');
 });
 it('does not retain arbitrary error strings or falsely promote provider acceptance to delivery',()=>{
  const output=summarizeSupervisorOutput(JSON.stringify({worker:'managed_dev',state:'blocked',code:'sk_private_secret',unexpected:'secret',notifications:{state:'finished',deliveryConfirmed:false,attempts:[{state:'provider_accepted',provider:'resend',provider_message_id:'11111111-1111-4111-8111-111111111111',error_code:'secret_key'}]}}));
  expect(output.code).toBeNull();expect(output.notifications.deliveryConfirmed).toBe(false);expect(output.notifications.attempts[0].error_code).toBeNull();expect(JSON.stringify(output)).not.toContain('secret');
 });
});
