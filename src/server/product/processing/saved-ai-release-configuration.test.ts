import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('./ai-release-build',()=>({getCompiledAiReleaseBuild:()=>({verified:'test-build'})}));
vi.mock('./ai-release-configuration',()=>({verifyAiReleaseConfiguration:(configuration:unknown)=>({configuration,trusted_generator_pins:[]})}));
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {loadSavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import type {SourceJob} from './source-dispatch';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {fixture as pensionFixture} from '@/engine/entitlement-review/compose.fixture';
import {AI_RELEASE_BOUND_EVIDENCE_ANCHOR} from './ai-release-evaluation-anchor';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
const sha='a'.repeat(64),dependency='b'.repeat(64);
const job:SourceJob={schema_version:'saved-case-work-v1',case_id:'11111111-1111-4111-8111-111111111111',revision:79,input_sha256:sha,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:dependency};
const window={issued_at:'2026-09-12T01:00:00Z',expires_at:'2026-09-12T22:00:00Z'};
const configured=()=>({state:'configured',configuration:{sha256:sha,policy:{...window},registry:{...window}},configuration_sha256:sha,
 enrollment_id:'22222222-2222-4222-8222-222222222222',dependency_sha256:dependency,evaluated_at:'2026-09-12T10:00:00Z',
 source_created_at:'2026-09-12T02:00:00Z',expires_at:'2026-09-12T20:00:00Z',is_qa:true,environment:'development'});
function context(value:unknown){const query=vi.fn(async()=>({row_count:1,rows:[{context:value}]}));return {query,context:{client:{query}} as unknown as PostgresTransactionContext};}
afterEach(()=>vi.unstubAllEnvs());
describe('server-owned saved AI profile selection',()=>{
 it('loads the versioned test-evidence anchor while keeping the old default profile identity',async()=>{
  vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');const old=configured(),a=runtimeFixture(pensionFixture().input).assessment_input;
  a.test_receipts[0].issued_at='2026-09-12T03:00:00Z';
  const configuration={...old.configuration,evaluation_anchor_policy:AI_RELEASE_BOUND_EVIDENCE_ANCHOR,policy:a.policy,registry:a.registry,
   source_receipts:a.source_receipts,interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts};
  // The mocked static verifier above isolates this SQL/profile boundary; exact
  // sealed receipt verification and chronology have separate unmocked tests.
  const ctx={...old,configuration},p=await loadSavedAiReleaseConfiguration(context(ctx).context,job);
  expect(p?.evaluated_at).toBe('2026-09-12T03:00:00.000Z');expect(p?.evaluation_anchor?.schema_version).toBe(AI_RELEASE_BOUND_EVIDENCE_ANCHOR);
  expect((await loadSavedAiReleaseConfiguration(context({...ctx,evaluated_at:'2026-09-12T11:00:00Z'}).context,job))?.profile_sha256).toBe(p?.profile_sha256);
  const legacy=await loadSavedAiReleaseConfiguration(context(old).context,job);
  expect(legacy?.profile_sha256).toBe(canonicalSha256({schema_version:'saved-ai-release-profile-v1',configuration_sha256:sha,enrollment_id:old.enrollment_id,dependency_sha256:dependency}));
  expect(legacy).not.toHaveProperty('evaluation_anchor');expect(p?.profile_sha256).not.toBe(legacy?.profile_sha256);
  await expect(loadSavedAiReleaseConfiguration(context({...ctx,evaluated_at:'2026-09-12T02:30:00Z'}).context,job)).rejects.toThrow('AI_RELEASE_ANCHOR_FUTURE');
 });
 it('does not query or reinterpret historical runs while disabled',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','0');const c=context(configured());expect(await loadSavedAiReleaseConfiguration(c.context,{...job,processing_profile:undefined})).toBeNull();expect(c.query).not.toHaveBeenCalled();});
 it('a disabled host cannot reinterpret an enrolled AI job as legacy',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','0');const c=context(configured());await expect(loadSavedAiReleaseConfiguration(c.context,job)).rejects.toThrow('AI_RELEASE_DISABLED');expect(c.query).not.toHaveBeenCalled();});
 it('preserves absent enrollment but never falls back after expiry/revocation',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');expect(await loadSavedAiReleaseConfiguration(context({state:'absent'}).context,{...job,processing_profile:undefined})).toBeNull();for(const reason of ['expired','revoked'])await expect(loadSavedAiReleaseConfiguration(context({state:'unavailable',reason,dependency_sha256:dependency}).context,job)).rejects.toThrow('AI_RELEASE_ENROLLMENT_');});
 it('separates stable evaluation anchor from live clock and engine revision',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');const first=await loadSavedAiReleaseConfiguration(context(configured()).context,job);const later=await loadSavedAiReleaseConfiguration(context({...configured(),evaluated_at:'2026-09-12T11:00:00Z'}).context,job);expect(first?.evaluated_at).toBe('2026-09-12T02:00:00.000Z');expect(later?.profile_sha256).toBe(first?.profile_sha256);expect(later?.live_evaluated_at).not.toBe(first?.live_evaluated_at);});
 it('refuses a job from the previous authority generation',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');await expect(loadSavedAiReleaseConfiguration(context(configured()).context,{...job,authority_dependency_sha256:sha})).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');});
 it('checks configuration windows against live DB time even with a stable old anchor',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');await expect(loadSavedAiReleaseConfiguration(context({...configured(),evaluated_at:'2026-09-13T00:00:00Z'}).context,job)).rejects.toThrow('AI_RELEASE_CONFIGURATION_EXPIRED');});
 it('rejects foreign environment, non-QA and non-draft profiles',async()=>{vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');for(const mutation of [{environment:'production'},{is_qa:false},{configuration_sha256:dependency}])await expect(loadSavedAiReleaseConfiguration(context({...configured(),...mutation}).context,job)).rejects.toThrow();await expect(loadSavedAiReleaseConfiguration(context(configured()).context,{...job,mode:'live'})).rejects.toThrow('AI_RELEASE_DEV_DRAFT_REQUIRED');});
});
