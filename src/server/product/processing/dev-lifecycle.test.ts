import {describe,it,expect,vi} from 'vitest';
import path from 'node:path';
import {validateLifecycleConfig,main,lifecyclePredecessor,assertLifecyclePredecessorStopped} from '../../../../scripts/product-workers/dev-lifecycle.entry.mts';
vi.mock('server-only',()=>({}));
const config=()=>({version:'managed-dev-lifecycle-v1',caseId:'33f41e2f-56b5-420c-8ee2-310201813d35',ownerIdentityId:'dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a',ownerEmail:'tivdoc.com@gmail.com',authorizationReference:'synthetic authorization reference',expiresAt:'2026-09-11T10:00:00.000Z',databaseEnvFile:path.resolve('../release-work/synthetic.env'),workerEnvironmentTemplate:path.resolve('../release-work/synthetic.private.json'),ledgerPath:path.resolve('output/release-completion/synthetic-ledger.json'),previewReceiptPath:path.resolve('../release-work/synthetic-preview.json'),manifestPath:path.resolve('output/release-completion/synthetic-manifest.json'),taskName:'Tivdoc-Synthetic-Test'});
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
