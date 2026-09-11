import {describe,it,expect,vi} from 'vitest';
import path from 'node:path';
import {validateLifecycleConfig,main} from '../../../../scripts/product-workers/dev-lifecycle.entry.mts';
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
