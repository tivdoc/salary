import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {validateLifecycleConfig,bindLifecycleLivePermit,assertLifecycleCommandPolicy,assertLifecycleProviderBinding,lifecycleProviderEnvironment,observeLifecycleLiveLedger,main} from '../../../../scripts/product-workers/dev-lifecycle.entry.mts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {newSolComparisonLedger,reserveSolRequest,recordSolCount,recordSolReceipt} from './live-extraction-sol-comparison-budget';
const db=vi.hoisted(()=>({construct:vi.fn(),connect:vi.fn(),query:vi.fn(),end:vi.fn(),task:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('pg',()=>({default:{Client:class{constructor(){db.construct();}connect=db.connect;query=db.query;end=db.end;}}}));
vi.mock('node:child_process',()=>({execFileSync:db.task}));
const hash=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const root=path.resolve('../release-work'),cleanup:string[]=[],outputCleanup:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();db.construct.mockClear();db.connect.mockClear();db.query.mockReset();db.end.mockReset();db.task.mockReset();for(const p of cleanup.splice(0)){
 if(path.dirname(p)!==root||!/^synthetic-lifecycle-live-|^dev-live-ledger-|^dev-epoch-/.test(path.basename(p)))throw Error('TEST_CLEANUP_SCOPE');
 if(existsSync(p))rmSync(p,{recursive:true,force:true});
}for(const p of outputCleanup.splice(0)){
 if(path.dirname(p)!==path.resolve('output/release-completion')||!path.basename(p).startsWith('dev-operations-'))throw Error('TEST_CLEANUP_SCOPE');
 if(existsSync(p))rmSync(p,{recursive:true,force:true});
}});
function config(){return validateLifecycleConfig({version:'managed-dev-live-lifecycle-v2',caseId:'11111111-1111-4111-8111-111111111111',ownerIdentityId:'22222222-2222-4222-8222-222222222222',ownerEmail:'info@tivdoc.com',
 authorizationReference:'synthetic explicit live authorization',expiresAt:'2026-09-12T13:00:00Z',databaseEnvFile:path.join(root,'synthetic.env'),workerEnvironmentTemplate:path.join(root,'synthetic-worker.json'),
 ledgerPath:path.join(root,'synthetic-ledger.json'),previewReceiptPath:path.join(root,'synthetic-preview.json'),manifestPath:path.resolve('output/release-completion/synthetic-manifest.json'),taskName:'Tivdoc-Synthetic-Live',
 liveAuthorization:{templatePath:path.join(root,'synthetic-live-template.json'),templateSha256:'a'.repeat(64)}});}
function fixture(){
 const c=config(),epochId=randomUUID(),scope={epochId,caseId:c.caseId,buildSha:'a'.repeat(40),capability:'synthetic-capability-no-authority',expiresAt:c.expiresAt,ledgerPath:c.ledgerPath};
 let ledger=newSolComparisonLedger();const reservation={sourceSha256:'b'.repeat(64),requestSha256:'c'.repeat(64),codeRevision:'d'.repeat(40),attempt:1,now:'2026-09-12T11:00:00Z'};
 ledger=recordSolCount(reserveSolRequest({ledger,...reservation,kind:'input_tokens'}),reservation.requestSha256,1000);
 ledger=reserveSolRequest({ledger,...reservation,kind:'generation'});
 const prior=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'openai_live',case_id:c.caseId,analysis_run_id:randomUUID(),document_id:randomUUID(),extraction_id:randomUUID(),
  source_sha256:reservation.sourceSha256,source_size_bytes:500,source_mime_type:'application/pdf',source_page_count:1,request_sha256:reservation.requestSha256,raw_extraction_sha256:'e'.repeat(64),pass_kind:'first_pass',
  requested_model:'gpt-5.6-sol',actual_model:'gpt-5.6-sol',extractor_version:'payslip-extraction-v2.1',prompt_version:'payslip-extraction-openai-v2-first-r7-fp1',provider_response_id:'synthetic-history-only',provider_request_id:null,
  provider_attempted:true,status:'completed',error_code:null,http_status:200,duration_ms:1,token_usage:{input_tokens:1000,output_tokens:10,total_tokens:1010},cost:{status:'not_returned_by_provider',amount_usd:null},created_at:'2026-09-12T11:00:01Z'});
 ledger=recordSolReceipt(ledger,prior);const bytes=JSON.stringify(ledger,null,2)+'\n';
 const template={version:'managed-dev-live-lifecycle-template-v2',epochId,permit:{version:'sol-managed-live-window-v2',enabled:true,authorizationId:randomUUID(),authorizedAt:'2026-09-12T12:00:00Z',expiresAt:c.expiresAt,
  buildSha:scope.buildSha,ledgerPath:c.ledgerPath,artifactDirectory:path.join(root,'synthetic-artifacts'),
  baseline:{fileSha256:hash(bytes),reservationsSha256:canonicalSha256(ledger.reservations),contentRequests:2,reservedMicroUsd:ledger.reservations.reduce((s,r)=>s+r.reservedMicroUsd,0),acknowledgedUnknownReceiptSha256s:[]},
  source:{caseId:c.caseId,versionId:prior.document_id,sha256:reservation.sourceSha256,sizeBytes:500,mimeType:'application/pdf'},maxContentRequests:2,maxGenerations:1,maxReservedMicroUsd:712000,recovery:'disabled',retry:'disabled',
  policyRevalidation:{purpose:'policy_revalidation',reason:'explicit-source-scope-r8',priorReceiptSha256:prior.receipt_sha256,fromPromptVersion:'payslip-extraction-openai-v2-first-r7-fp1',toPromptVersion:'payslip-extraction-openai-v2-first-r8-fp1'}}};
 return {c,scope,template,ledger,bytes,permit:bindLifecycleLivePermit(template,scope,Date.parse('2026-09-12T12:00:01Z'))};
}
describe('versioned lifecycle live permit',()=>{
 it('requires explicit opt-in and private pinned template while preserving the v1 schema',()=>{
  const c=config();expect(c.version).toBe('managed-dev-live-lifecycle-v2');
  expect(()=>validateLifecycleConfig({...c,liveAuthorization:{templatePath:path.resolve('leaked.json'),templateSha256:'a'.repeat(64)}})).toThrow('DEV_LIFECYCLE_PATH_SCOPE');
  expect(()=>validateLifecycleConfig({...c,version:'managed-dev-lifecycle-v1'})).toThrow();
  expect(()=>validateLifecycleConfig({...c,liveAuthorization:{templatePath:path.join(root,'ok.json'),templateSha256:'bad'}})).toThrow();
 });
 it('binds a fixed epoch capability without mutating or renewing the approved template',()=>{
  const f=fixture(),before=canonicalSha256(f.template);expect(f.permit.capabilitySha256).toBe(hash(f.scope.capability));
  expect(bindLifecycleLivePermit(f.template,f.scope,Date.parse('2026-09-12T12:20:00Z'))).toEqual(f.permit);
  expect(canonicalSha256(f.template)).toBe(before);expect(f.permit.authorizationId).toBe(f.template.permit.authorizationId);
 });
 it.each(['epochId','caseId','buildSha','expiresAt','ledgerPath'] as const)('cannot rebind %s',key=>{
  const f=fixture();expect(()=>bindLifecycleLivePermit(f.template,{...f.scope,[key]:key==='expiresAt'?'2026-09-12T13:30:00Z':'foreign'},Date.parse('2026-09-12T12:01:00Z'))).toThrow('DEV_LIVE_TEMPLATE_SCOPE');
 });
 it.each(['2026-09-12T11:59:59Z','2026-09-12T13:00:00Z'])('does not issue a future/expired permit at %s',at=>{
  const f=fixture();expect(()=>bindLifecycleLivePermit(f.template,f.scope,Date.parse(at))).toThrow('DEV_LIVE_TEMPLATE_SCOPE');
 });
 it('rejects budget, recovery, client capability and long-window escalation',()=>{
  const f=fixture(),at=Date.parse('2026-09-12T12:01:00Z');
  for(const patch of [{maxContentRequests:3},{recovery:'enabled'},{capabilitySha256:'f'.repeat(64)}])expect(()=>bindLifecycleLivePermit({...f.template,permit:{...f.template.permit,...patch}},f.scope,at)).toThrow();
  expect(()=>bindLifecycleLivePermit({...f.template,permit:{...f.template.permit,expiresAt:'2026-09-12T17:00:00Z'}},{...f.scope,expiresAt:'2026-09-12T17:00:00Z'},at)).toThrow('DEV_LIVE_TEMPLATE_SCOPE');
 });
 it('requires both policy and permit hash on DB epoch replay',()=>{
  const f=fixture(),digest='e'.repeat(64);expect(()=>assertLifecycleProviderBinding(f.c,{provider_policy:'sol_managed_live_window_v2',provider_authorization_sha256:digest},digest)).not.toThrow();
  for(const row of [{provider_policy:'saved_receipts_only',provider_authorization_sha256:null},{provider_policy:'sol_managed_live_window_v2',provider_authorization_sha256:'f'.repeat(64)}])expect(()=>assertLifecycleProviderBinding(f.c,row,digest)).toThrow('DEV_EPOCH_RETRY_MISMATCH');
 });
 it('keeps provider key private, forces live flags and never enables notifications',()=>{
  const f=fixture(),original={OPENAI_API_KEY:'synthetic-only',TIVDOC_NOTIFICATION_OUTBOX_ENABLED:'true',TIVDOC_MANAGED_EXTRACTION_MODE:'saved_receipts_only'};
  const env=lifecycleProviderEnvironment(f.c,original,'private-permit');expect(env).toMatchObject({OPENAI_API_KEY:'synthetic-only',TIVDOC_NOTIFICATION_OUTBOX_ENABLED:'false',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',OPENAI_EXTRACTION_MODEL:'gpt-5.6-sol',TIVDOC_MANAGED_SOL_PACKAGE_FILE:'private-permit'});
  expect(env).not.toHaveProperty('TIVDOC_MANAGED_EXTRACTION_MODE');expect(original.TIVDOC_NOTIFICATION_OUTBOX_ENABLED).toBe('true');
  expect(()=>lifecycleProviderEnvironment(f.c,{},'private-permit')).toThrow('DEV_LIVE_PROVIDER_KEY_MISSING');
 });
 it.each(['authority','notifications-resume'])('refuses %s in the actual command before any DB connection',async command=>{
  vi.stubEnv('VERCEL','');vi.stubEnv('VERCEL_ENV','');vi.stubEnv('NODE_ENV','development');
  const c=config(),directory=path.join(root,'synthetic-lifecycle-live-'+randomUUID());mkdirSync(directory);cleanup.push(directory);
  const file=path.join(directory,'config.json');writeFileSync(file,JSON.stringify(c));
  await expect(main([command,file,randomUUID()])).rejects.toThrow('DEV_LIVE_COMMAND_FORBIDDEN');expect(db.construct).not.toHaveBeenCalled();
 });
 it('retains all ordinary control commands without granting fixture authority',()=>{
  for(const command of ['prepare','start','status','pause','stop','resume','notifications-pause'])expect(()=>assertLifecycleCommandPolicy(config(),command)).not.toThrow();
 });
 it('retains ledger watermarks across restarts and rejects shrinking or rewritten history',()=>{
  const f=fixture(),id=f.scope.epochId,dir=path.join(root,'dev-live-ledger-'+id),digest='f'.repeat(64);cleanup.push(dir);
  observeLifecycleLiveLedger(id,f.permit,digest,Buffer.from(f.bytes));expect(readdirSync(dir)).toEqual(['000000.json']);
  const next=reserveSolRequest({ledger:f.ledger,sourceSha256:f.permit.source.sha256,requestSha256:'f'.repeat(64),codeRevision:f.scope.buildSha,attempt:2,kind:'input_tokens',now:'2026-09-12T12:01:00Z',policyRevalidation:f.permit.policyRevalidation});
  const nextBytes=Buffer.from(JSON.stringify(next));observeLifecycleLiveLedger(id,f.permit,digest,nextBytes);observeLifecycleLiveLedger(id,f.permit,digest,nextBytes);
  expect(readdirSync(dir)).toEqual(['000000.json','000001.json']);
  expect(()=>observeLifecycleLiveLedger(id,f.permit,digest,Buffer.from(f.bytes))).toThrow('SOL_LIVE_WINDOW_LEDGER_ROLLBACK');
  const file=path.join(dir,'000001.json'),stored=JSON.parse(readFileSync(file,'utf8'));stored.previousSha256='0'.repeat(64);writeFileSync(file,JSON.stringify(stored));
  expect(()=>observeLifecycleLiveLedger(id,f.permit,digest,nextBytes)).toThrow('DEV_LIVE_LEDGER_HISTORY');
 });
});


describe('ordinary shutdown survives unavailable extraction artifacts',()=>{
 function shutdownFixture(){
  vi.stubEnv('VERCEL','');vi.stubEnv('VERCEL_ENV','');vi.stubEnv('NODE_ENV','development');
  const directory=path.join(root,'synthetic-lifecycle-live-'+randomUUID());mkdirSync(directory);cleanup.push(directory);
  const c={...config(),databaseEnvFile:path.join(directory,'database.env')},epochId=randomUUID(),file=path.join(directory,'config.json');
  writeFileSync(file,JSON.stringify(c));
  writeFileSync(c.databaseEnvFile,'TIVDOC_DEV_DATABASE_URL=postgres://tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu:synthetic-not-a-secret@aws-0-eu-central-1.pooler.supabase.com/tivdoc_release_replay_20260907');
  const epoch={epochId,caseId:c.caseId,ownerIdentityId:c.ownerIdentityId,capability:'synthetic-no-authority-capability',sid:'dev.epoch:'+epochId,
   authorizationReference:c.authorizationReference,buildPins:{config_sha256:canonicalSha256(c)}};
  const epochFile=path.join(root,'dev-epoch-'+epochId+'.private.json');writeFileSync(epochFile,JSON.stringify(epoch));cleanup.push(epochFile);
  const row={case_id:c.caseId,owner_identity_id:c.ownerIdentityId,capability_sha256:hash(epoch.capability),session_sid:epoch.sid,
   authorization_reference:c.authorizationReference,tenant_id:'saved-case:'+c.caseId};
  db.query.mockImplementation(async(sql:string)=>({rows:sql.includes('current_database()')?[{db:'tivdoc_release_replay_20260907',principal:'tivdoc_dev_migrator'}]:sql.includes('for update of s,b')?[row]:[]}));
  outputCleanup.push(path.resolve('output/release-completion/dev-operations-'+epochId));
  return {file,epochId,row,c};
 }
 it.each(['pause','stop'])('%s disables DB authority even with missing permit, ledger, build and supervisor',async command=>{
  const f=shutdownFixture();db.task.mockImplementation(()=>{throw Error('synthetic scheduler unavailable');});
  const output=vi.spyOn(console,'log').mockImplementation(()=>{});
  try{
   await main([command,f.file,f.epochId]);
   const sql=db.query.mock.calls.map(c=>String(c[0]));
   expect(sql.some(s=>s.includes('managed_dev_worker_capabilities set enabled=false'))).toBe(true);
   expect(sql.some(s=>s.includes('managed_dev_worker_cases set enabled=false'))).toBe(true);
   expect(sql.some(s=>s.includes('set revoked_at=coalesce'))).toBe(command==='stop');
   expect(sql.filter(s=>s==='commit')).toHaveLength(1);
   expect(db.query.mock.invocationCallOrder[sql.indexOf('commit')]).toBeLessThan(db.task.mock.invocationCallOrder[0]);
   const result=JSON.parse(String(output.mock.calls.at(-1)?.[0]));
   expect(result.state).toBe(command==='stop'?'stopped':'paused');expect(result.capabilityDisabled).toBe(true);
   expect(result.warnings).toEqual(['DEV_LOCAL_TASK_DISABLE_FAILED','DEV_LOCAL_SUPERVISOR_DISABLE_FAILED','DEV_EXTRACTION_ARTIFACTS_UNAVAILABLE_OR_CHANGED']);
  }finally{output.mockRestore();}
 });
 it.each(['case_id','owner_identity_id','capability_sha256','session_sid','tenant_id'])('refuses foreign stored %s before disabling anything',async field=>{
  const f=shutdownFixture();f.row[field as keyof typeof f.row]='foreign';
  await expect(main(['stop',f.file,f.epochId])).rejects.toThrow('DEV_SHUTDOWN_EPOCH_SCOPE');
  expect(db.query.mock.calls.some(c=>String(c[0]).startsWith('update '))).toBe(false);expect(db.task).not.toHaveBeenCalled();
 });
 it('still blocks start on missing ledger before DB or scheduler access',async()=>{
  const f=shutdownFixture();await expect(main(['start',f.file,f.epochId])).rejects.toThrow();
  expect(db.construct).not.toHaveBeenCalled();expect(db.task).not.toHaveBeenCalled();
 });
});
