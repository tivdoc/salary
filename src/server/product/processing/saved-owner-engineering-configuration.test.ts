import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('./ai-release-build',()=>({getCompiledAiReleaseBuild:()=>({test:'static-verifier-tested-separately'})}));
vi.mock('./ai-release-configuration',()=>({verifyOwnerEngineeringConfiguration:(configuration:unknown)=>({configuration,trusted_generator_pins:[]})}));
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {loadSavedOwnerEngineeringConfiguration,resolveSavedOwnerEngineeringProfile} from './saved-owner-engineering-configuration';
import type {SourceJob} from './source-dispatch';
import {ownerEngineeringFixture,repinEngineeringFixture} from '@/engine/ai-release-runtime/owner-engineering.fixture';
import {AI_RELEASE_BOUND_EVIDENCE_ANCHOR} from './ai-release-evaluation-anchor';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
const id='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',grant='33333333-3333-4333-8333-333333333333';
const sha='a'.repeat(64),dependency='b'.repeat(64),window={issued_at:'2026-09-12T01:00:00Z',expires_at:'2026-09-12T22:00:00Z'};
const configured=()=>({state:'configured',configuration:{schema_version:'tivdoc-owner-engineering-configuration-v1',sha256:sha,
 policy:{...window,owner_scope:{case_id:id,identity_id:owner,enrollment_id:grant}},registry:{...window}},configuration_sha256:sha,
 enrollment_id:grant,owner_identity_id:owner,dependency_sha256:dependency,evaluated_at:'2026-09-12T10:00:00Z',
 source_created_at:'2026-09-12T02:00:00Z',expires_at:'2026-09-12T20:00:00Z',is_qa:true,environment:'development'});
const job:SourceJob={schema_version:'saved-case-work-v1',case_id:id,revision:9,input_sha256:sha,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:dependency};
const context=(value:unknown)=>({client:{query:vi.fn(async()=>({row_count:1,rows:[{context:value}]}))}} as unknown as PostgresTransactionContext);
afterEach(()=>vi.unstubAllEnvs());
describe('authenticated owner purpose loading',()=>{
 it('uses the opt-in measured evidence anchor for owner loading and retains the historical profile hash exactly',()=>{
  const old=configured(),owner_scope=old.configuration.policy.owner_scope;
  expect(resolveSavedOwnerEngineeringProfile(old).profile_sha256).toBe(canonicalSha256({schema_version:'saved-owner-engineering-profile-v1',configuration_sha256:sha,enrollment_id:grant,dependency_sha256:dependency,owner_scope}));
  const a=ownerEngineeringFixture().assessment_input;a.test_receipts[0].issued_at='2026-09-12T03:00:00Z';repinEngineeringFixture(a);
  const configuration={...old.configuration,evaluation_anchor_policy:AI_RELEASE_BOUND_EVIDENCE_ANCHOR,policy:{...a.policy,owner_scope},registry:a.registry,
   source_receipts:a.source_receipts,interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts};
  const ctx={...old,configuration},p=resolveSavedOwnerEngineeringProfile(ctx);
  expect(p.evaluated_at).toBe('2026-09-12T03:00:00.000Z');expect(p.evaluation_anchor?.schema_version).toBe(AI_RELEASE_BOUND_EVIDENCE_ANCHOR);
  expect(p.profile_sha256).not.toBe(resolveSavedOwnerEngineeringProfile(old).profile_sha256);
  expect(resolveSavedOwnerEngineeringProfile({...ctx,evaluated_at:'2026-09-12T11:00:00Z'}).profile_sha256).toBe(p.profile_sha256);
  expect(()=>resolveSavedOwnerEngineeringProfile({...ctx,evaluated_at:'2026-09-12T02:30:00Z'})).toThrow('AI_RELEASE_ANCHOR_FUTURE');
  expect(()=>resolveSavedOwnerEngineeringProfile({...ctx,evaluated_at:old.expires_at})).toThrow('OWNER_ENGINEERING_ENROLLMENT_EXPIRED');
 });
 it('does not create a fallback owner profile while disabled',async()=>{
  vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','0');const c=context(configured());expect(await loadSavedOwnerEngineeringConfiguration(c,job)).toBeNull();expect(c.client.query).not.toHaveBeenCalled();
 });
 it('returns non-owner contexts to the existing strict qualified loader',async()=>{
  vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');for(const value of [{state:'absent'},{state:'unavailable',reason:'expired'},{state:'configured',configuration:{schema_version:'tivdoc-ai-release-configuration-v1'}}])
   expect(await loadSavedOwnerEngineeringConfiguration(context(value),job)).toBeNull();
 });
 it('binds owner and enrollment separately from the queue generation',async()=>{
  vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');const p=await loadSavedOwnerEngineeringConfiguration(context(configured()),job);
  expect(p?.owner_scope).toEqual({case_id:id,identity_id:owner,enrollment_id:grant});expect(p?.evaluated_at).toBe('2026-09-12T02:00:00.000Z');
  for(const mutation of [{owner_identity_id:grant},{enrollment_id:owner},{configuration_sha256:dependency}])
   await expect(loadSavedOwnerEngineeringConfiguration(context({...configured(),...mutation}),job)).rejects.toThrow('OWNER_ENGINEERING_ENROLLMENT_SCOPE');
 });
 it('refuses foreign case, old dependency and missing profile',async()=>{
  vi.stubEnv('TIVDOC_AI_RELEASE_ENABLED','1');for(const mutation of [{case_id:owner},{authority_dependency_sha256:sha},{processing_profile:undefined}])
   await expect(loadSavedOwnerEngineeringConfiguration(context(configured()),{...job,...mutation})).rejects.toThrow('OWNER_ENGINEERING_JOB_SCOPE');
 });
 it('does not use a historical evaluation anchor to extend admission',()=>{
  for(const evaluated_at of ['2026-09-12T20:00:00Z','2026-09-13T00:00:00Z','2026-09-12T00:00:00Z'])
   expect(()=>resolveSavedOwnerEngineeringProfile({...configured(),evaluated_at})).toThrow('OWNER_ENGINEERING_ENROLLMENT_EXPIRED');
 });
 it('preserves retry identity while the live DB clock advances',()=>{
  const first=resolveSavedOwnerEngineeringProfile(configured()),next=resolveSavedOwnerEngineeringProfile({...configured(),evaluated_at:'2026-09-12T11:00:00Z'});
  expect(first.profile_sha256).toBe(next.profile_sha256);expect(first.live_evaluated_at).not.toBe(next.live_evaluated_at);
 });
 it('refuses production and non-QA metadata',()=>{for(const change of [{environment:'production'},{is_qa:false}])expect(()=>resolveSavedOwnerEngineeringProfile({...configured(),...change})).toThrow();});
});
