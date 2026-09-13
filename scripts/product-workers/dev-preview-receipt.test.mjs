import {describe,it,expect} from 'vitest';
import {createGithubPreviewReceipt,lifecyclePreview} from './dev-preview-receipt.mjs';
const sha='a'.repeat(40),manifest={gitSha:sha,dirty:false,proofOnly:false};
const url='https://api.github.com/repos/tivdoc/salary/deployments/12';
const d=()=>({id:12,sha,environment:'Preview',production_environment:false,creator:{login:'vercel[bot]'},repository_url:'https://api.github.com/repos/tivdoc/salary',statuses_url:url+'/statuses',created_at:'2026-09-12T10:00:00Z'});
const s=()=>({id:25,state:'success',environment:'Preview',creator:{login:'vercel[bot]'},deployment_url:url,url:url+'/statuses/25',environment_url:'https://salary-synthetic.vercel.app',created_at:'2026-09-12T10:01:00Z'});
const at='2026-09-12T10:02:00Z',receipt=()=>createGithubPreviewReceipt(d(),s(),at);
describe('explicit GitHub Preview evidence without synthetic Vercel READY',()=>{
 it('binds the exact successful application and keeps browser access unproven',()=>{
  const r=receipt();expect(r.browser_access_proven).toBe(false);expect(r).not.toHaveProperty('readyState');
  expect(lifecyclePreview(r,manifest)).toMatchObject({sha,url:'salary-synthetic.vercel.app',evidence:'github_deployment_success'});
 });
 it.each(['pending','failure','error','inactive'])('refuses latest status %s instead of selecting an older success',state=>expect(()=>createGithubPreviewReceipt(d(),{...s(),state},at)).toThrow());
 it('refuses production, other repositories, changed hash and a dirty/proof build',()=>{
  expect(()=>createGithubPreviewReceipt({...d(),production_environment:true},s(),at)).toThrow();
  expect(()=>createGithubPreviewReceipt({...d(),statuses_url:'https://api.github.com/repos/other/repo/deployments/12/statuses'},s(),at)).toThrow();
  expect(()=>createGithubPreviewReceipt(d(),{...s(),deployment_url:url+'3'},at)).toThrow();
  expect(()=>createGithubPreviewReceipt(d(),{...s(),creator:{login:'some-other-app[bot]'}},at)).toThrow();
  const r=receipt();r.status.environment_url='https://salary-changed.vercel.app';expect(()=>lifecyclePreview(r,manifest)).toThrow();
  for(const m of [{...manifest,gitSha:'b'.repeat(40)},{...manifest,dirty:true},{...manifest,proofOnly:true},{gitSha:sha},null])expect(()=>lifecyclePreview(receipt(),m)).toThrow();
 });
 it.each(['http://salary-synthetic.vercel.app','https://salary-synthetic.vercel.app/path','https://salary-synthetic.vercel.app?bypass=x','https://salary-synthetic.vercel.app.evil.invalid','https://user:secret@salary-synthetic.vercel.app'])('refuses an unscoped origin',environment_url=>expect(()=>createGithubPreviewReceipt(d(),{...s(),environment_url},at)).toThrow());
 it('refuses impossible chronology and keeps retained legacy receipts readable',()=>{
  expect(()=>createGithubPreviewReceipt(d(),s(),'2026-09-12T10:00:30Z')).toThrow();
  const old={sha,target:'preview',readyState:'READY',url:'salary-synthetic.vercel.app'};
  expect(lifecyclePreview(old,manifest)).toMatchObject({evidence:'retained_vercel_ready_receipt'});expect(old).not.toHaveProperty('schema_version');
 });
});
