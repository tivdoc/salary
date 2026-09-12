import {describe,it,expect,vi} from 'vitest';
import path from 'node:path';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {validateLifecycleConfig,main,lifecyclePredecessor,assertLifecyclePredecessorStopped,assertLifecyclePath,assertLifecycleEpochBuild} from '../../../../scripts/product-workers/dev-lifecycle.entry.mts';
vi.mock('server-only',()=>({}));
const config=()=>({version:'managed-dev-lifecycle-v1',caseId:'33f41e2f-56b5-420c-8ee2-310201813d35',ownerIdentityId:'dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a',ownerEmail:'tivdoc.com@gmail.com',authorizationReference:'synthetic authorization reference',expiresAt:'2026-09-11T10:00:00.000Z',databaseEnvFile:path.resolve('../release-work/synthetic.env'),workerEnvironmentTemplate:path.resolve('../release-work/synthetic.private.json'),ledgerPath:path.resolve('output/release-completion/synthetic-ledger.json'),previewReceiptPath:path.resolve('../release-work/synthetic-preview.json'),manifestPath:path.resolve('output/release-completion/synthetic-manifest.json'),taskName:'Tivdoc-Synthetic-Test'});
describe('immutable DEV epoch build and deployment',()=>{
 const pins=()=>({schema_version:'dev-lifecycle-epoch-build-v1',config_sha256:'1'.repeat(64),template_sha256:'2'.repeat(64),manifest_sha256:'3'.repeat(64),application_sha:'a'.repeat(40),bundle_sha256:'4'.repeat(64),preview_receipt_sha256:'5'.repeat(64),preview_origin:'https://salary-synthetic.vercel.app'});
 const control=()=>({expected_git_sha:pins().application_sha,expected_bundle_sha256:pins().bundle_sha256,expected_manifest_sha256:pins().manifest_sha256});
 const environment=()=>({TIVDOC_MANAGED_DEV_BUILD_SHA:pins().application_sha,TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN:pins().preview_origin});
 it('retries the identical epoch and permits recovery before control files were written',()=>{
  expect(()=>assertLifecycleEpochBuild(pins(),pins(),control(),environment())).not.toThrow();
  expect(()=>assertLifecycleEpochBuild(pins(),pins())).not.toThrow();
 });
 it.each(['config_sha256','template_sha256','manifest_sha256','bundle_sha256','preview_receipt_sha256'] as const)('requires a new epoch when %s changes',field=>{
  expect(()=>assertLifecycleEpochBuild({...pins(),[field]:'f'.repeat(64)},pins(),control(),environment())).toThrow('DEV_EPOCH_RETRY_MISMATCH');
 });
 it('does not validate new build B while leaving supervisor or environment from build A',()=>{
  const current={...pins(),application_sha:'b'.repeat(40)};
  expect(()=>assertLifecycleEpochBuild(current,current,control(),environment())).toThrow('DEV_EPOCH_RETRY_MISMATCH');
  expect(()=>assertLifecycleEpochBuild(current,current,{...control(),expected_git_sha:current.application_sha},environment())).toThrow('DEV_EPOCH_RETRY_MISMATCH');
  expect(()=>assertLifecycleEpochBuild(pins(),pins(),control(),{...environment(),TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN:'https://salary-other.vercel.app'})).toThrow('DEV_EPOCH_RETRY_MISMATCH');
 });
 it('requires a new prepare identity for historical epochs without build pins',()=>{
  expect(()=>assertLifecycleEpochBuild(pins(),undefined)).toThrow('DEV_EPOCH_RETRY_MISMATCH');
 });
});

describe('DEV lifecycle configuration boundary',()=>{
 it('keeps database secrets and worker settings outside the repository',()=>{
  expect(validateLifecycleConfig(config()).ownerEmail).toBe('tivdoc.com@gmail.com');
  expect(()=>validateLifecycleConfig({...config(),databaseEnvFile:path.resolve('leaked.env')})).toThrow('DEV_LIFECYCLE_PATH_SCOPE');
 });
 it.each(['skyview.co.il@gmail.com','unrelated@example.invalid'])('refuses non-owner email %s',ownerEmail=>{expect(()=>validateLifecycleConfig({...config(),ownerEmail})).toThrow();});
 it('rejects shell syntax in task names, unrelated output and extra fields',()=>{
  expect(()=>validateLifecycleConfig({...config(),taskName:"Tivdoc-X'; Write-Output x"})).toThrow();
  expect(()=>validateLifecycleConfig({...config(),ledgerPath:path.resolve('../unrelated-ledger.json')})).toThrow();
  expect(()=>validateLifecycleConfig({...config(),resetBudget:true})).toThrow();
 });
 it('requires a supported command and caller-supplied idempotency ID before private reads',async()=>{
  await expect(main(['reset-budget','missing','invalid'])).rejects.toThrow('DEV_LIFECYCLE_ARGUMENTS');
 });
});


describe('separate first preparation and renewal',()=>{
 const owner=config().ownerIdentityId,sha='a'.repeat(64),now=Date.parse('2026-09-12T10:00:00Z');
 const old=()=>({identity_id:owner,capability_sha256:sha,capability_enabled:false,revoked_at:null,expires_at:new Date(now+60000)});
 it('accepts a verified-owner configuration without a hardcoded identity id',()=>{
  expect(validateLifecycleConfig({...config(),ownerIdentityId:'11111111-1111-4111-8111-111111111111',ownerEmail:'info@tivdoc.com'}).ownerEmail).toBe('info@tivdoc.com');
 });
 it('first preparation keeps a null predecessor; resume cannot invent one',()=>{
  expect(lifecyclePredecessor('prepare',owner,undefined)).toBeNull();
  expect(()=>lifecyclePredecessor('resume',owner,undefined)).toThrow('DEV_FIRST_ENROLLMENT_REQUIRES_PREPARE');
  expect(()=>assertLifecyclePredecessorStopped(null,owner,undefined,now)).not.toThrow();
 });
 it('retains the exact predecessor and checks its owner',()=>{
  expect(lifecyclePredecessor('resume',owner,old())).toBe(sha);
  expect(()=>lifecyclePredecessor('resume','11111111-1111-4111-8111-111111111111',old())).toThrow('DEV_RENEWAL_PREDECESSOR');
 });
 it('refuses a concurrent predecessor change after private preparation',()=>{
  expect(()=>assertLifecyclePredecessorStopped(null,owner,old(),now)).toThrow('DEV_EPOCH_PREDECESSOR_CHANGED');
  expect(()=>assertLifecyclePredecessorStopped('b'.repeat(64),owner,old(),now)).toThrow('DEV_EPOCH_PREDECESSOR_CHANGED');
 });
 it('cannot replace a running capability; a stopped/expired one is only a reference',()=>{
  expect(()=>assertLifecyclePredecessorStopped(sha,owner,{...old(),capability_enabled:true},now)).toThrow('DEV_PREDECESSOR_MUST_BE_STOPPED');
  for(const previous of [old(),{...old(),capability_enabled:true,revoked_at:new Date(now-1000)},{...old(),capability_enabled:true,expires_at:new Date(now-1)}]){
   const before=JSON.stringify(previous);expect(()=>assertLifecyclePredecessorStopped(sha,owner,previous,now)).not.toThrow();expect(JSON.stringify(previous)).toBe(before);
  }
 });
});


describe('lifecycle real paths and hosted refusal',()=>{
 it('refuses every hosted environment before reading private configuration',async()=>{
  for(const name of ['VERCEL','VERCEL_ENV','NODE_ENV']){
   vi.stubEnv(name,name==='NODE_ENV'?'production':name==='VERCEL_ENV'?'preview':'1');
   try{await expect(main(['prepare','unread-private-config','11111111-1111-4111-8111-111111111111'])).rejects.toThrow('DEV_LIFECYCLE_ARGUMENTS');}
   finally{vi.unstubAllEnvs();}
  }
 });
 it('rejects a directory junction escape while allowing a future file within scope',()=>{
  const fixture=mkdtempSync(path.join(tmpdir(),'tivdoc-lifecycle-path-')),inside=path.join(fixture,'private'),outside=path.join(fixture,'outside');
  mkdirSync(inside);mkdirSync(outside);
  try{
   expect(()=>assertLifecyclePath(inside,path.join(inside,'future','config.json'))).not.toThrow();
   symlinkSync(outside,path.join(inside,'linked'),process.platform==='win32'?'junction':'dir');
   expect(()=>assertLifecyclePath(inside,path.join(inside,'linked','secret.json'))).toThrow('DEV_LIFECYCLE_PATH_SCOPE');
   expect(()=>assertLifecyclePath(inside,inside)).toThrow('DEV_LIFECYCLE_PATH_SCOPE');
  }finally{if(path.dirname(path.resolve(fixture))!==path.resolve(tmpdir())||!path.basename(fixture).startsWith('tivdoc-lifecycle-path-'))throw Error('TEST_CLEANUP_SCOPE');rmSync(fixture,{recursive:true,force:true});}
 });
});
