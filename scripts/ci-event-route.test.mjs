import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {routeCiEvent} from './ci-event-route.mjs';
const input={eventName:'push',event:{repository:{default_branch:'main'}},repository:'tivdoc/salary',sha:'a'.repeat(40),ref:'refs/heads/codex/topic',token:'synthetic-read-only'};
const pr={number:2,state:'open',head:{sha:input.sha,ref:'codex/topic',repo:{full_name:input.repository}},base:{repo:{full_name:input.repository}}};
const fetcher=rows=>vi.fn(async()=>({ok:true,json:async()=>rows}));
it('avoids only the duplicate branch suite for the exact same-repository open PR commit',async()=>{
 expect(await routeCiEvent(input,fetcher([pr]))).toEqual({run:false,reason:'exact_open_pr_merge_event',pr:2});
});
it.each(['pull_request','merge_group','workflow_dispatch'])('always verifies %s without a dependency on the routing API',async eventName=>{
 const api=vi.fn();expect((await routeCiEvent({...input,eventName},api)).run).toBe(true);expect(api).not.toHaveBeenCalled();
});
it.each([{ref:'refs/heads/main'},{ref:'refs/tags/v1'},{token:undefined}])('retains verification for a published ref or unavailable router %j',async change=>{
 expect((await routeCiEvent({...input,...change},fetcher([pr]))).run).toBe(true);
});
it.each([[],[{...pr,state:'closed'}],[{...pr,head:{...pr.head,sha:'b'.repeat(40)}}],[{...pr,head:{...pr.head,repo:{full_name:'foreign/salary'}}}]])('never drops verification for absent, closed, stale or foreign PR context',async rows=>{
 expect((await routeCiEvent(input,fetcher(rows))).run).toBe(true);
});
it('falls back to the full suite on API failures',async()=>{
 for(const api of [vi.fn(async()=>{throw Error('network');}),vi.fn(async()=>({ok:false})),fetcher({invalid:true})])expect((await routeCiEvent(input,api)).run).toBe(true);
});
it('keeps merge verification named verify and gives duplicate push skips a different check name',()=>{
 const yaml=readFileSync('.github/workflows/ci.yml','utf8');
 expect(yaml).toContain('pull_request:');expect(yaml).toContain('merge_group:');expect(yaml).toContain("name: ${{ needs.route.outputs.run == 'false' && 'PR coverage (no duplicate suite)' || 'verify' }}");
 expect(yaml).toContain('scripts/ai-release-build-manifest.mjs --check');expect(yaml).toContain('scripts/production-closure/prove.mts');
 expect(yaml).not.toContain('paths-ignore:');expect(yaml).not.toContain('continue-on-error:');
});
