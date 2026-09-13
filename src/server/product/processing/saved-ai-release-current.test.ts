import {beforeAll,describe,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runtimeFixture,nineTopicRuntimeSource} from '@/engine/ai-release-runtime/runtime.fixture';
import {AI_RELEASE_RUNTIME_FAMILIES,type AiReleaseRuntimeInput} from '@/engine/ai-release-runtime/contracts';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {pensionEntitlementInputSchema} from '@/engine/entitlement-review/pension/contracts';
import {aiReleaseConfigurationSchema} from './ai-release-configuration';
import type {SavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import {assertSavedAiReleaseCurrent} from './saved-ai-release';

vi.mock('server-only',()=>({}));
const h=(label:string)=>canonicalSha256({synthetic_currentness:label});
const cutoff='2026-09-12T11:00:00.000Z';
function reseal(value:{sha256:string}){const {sha256,...body}=value;void sha256;value.sha256=canonicalSha256(body);}
/** Re-link only synthetic immutable receipts before constructing an envelope.
 * No test edits an already produced historical report or its timestamps. */
function relink(input:AiReleaseRuntimeInput){
 const a=input.assessment_input,sourceHashes=new Map<string,string>(),interpretationHashes=new Map<string,string>(),testHashes=new Map<string,string>();
 for(const receipt of a.source_receipts){const old=receipt.sha256;reseal(receipt);sourceHashes.set(old,receipt.sha256);}
 const sources=(hashes:string[])=>hashes.map(sha=>sourceHashes.get(sha)??sha);
 for(const receipt of a.interpretation_receipts){const old=receipt.sha256;receipt.source_receipt_sha256s=sources(receipt.source_receipt_sha256s);
  receipt.human_by_law.source_receipt_sha256s=sources(receipt.human_by_law.source_receipt_sha256s);reseal(receipt);interpretationHashes.set(old,receipt.sha256);}
 for(const receipt of a.test_receipts){const old=receipt.sha256;receipt.source_receipt_sha256s=sources(receipt.source_receipt_sha256s);
  receipt.interpretation_receipt_sha256=interpretationHashes.get(receipt.interpretation_receipt_sha256)??receipt.interpretation_receipt_sha256;reseal(receipt);testHashes.set(old,receipt.sha256);}
 for(const branch of a.policy.branches){branch.source_receipt_sha256s=sources(branch.source_receipt_sha256s);
  branch.interpretation_receipt_sha256=interpretationHashes.get(branch.interpretation_receipt_sha256)??branch.interpretation_receipt_sha256;
  branch.test_receipt_sha256s=branch.test_receipt_sha256s.map(sha=>testHashes.get(sha)??sha);}
 reseal(a.policy);a.registry.policy_sha256=a.policy.sha256;reseal(a.registry);
 a.assessment.policy_sha256=a.policy.sha256;a.assessment.registry_sha256=a.registry.sha256;reseal(a.assessment);
 a.current.policy_sha256=a.policy.sha256;a.current.registry_sha256=a.registry.sha256;a.current.assessment_sha256=a.assessment.sha256;
}
function setup(input:AiReleaseRuntimeInput){
 const a=input.assessment_input,scope=a.current.scope;
 const envelope=createCaseAnalysisAiRelease(input,{engine_case_revision:8,source_journal:{case_id:scope.case_id,input_revision:scope.input_revision,input_sha256:scope.input_sha256}});
 const configurationBody={schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:'00000000-0000-4000-8000-000000000001',revision:1,
  population:scope.population,build_manifest_sha256:h('synthetic build'),policy:a.policy,registry:a.registry,
  source_receipts:a.source_receipts,interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts};
 // The production loader independently authenticates this configuration and
 // build. This fixture exercises only the final currentness boundary.
 const profile:SavedAiReleaseConfiguration={configuration:aiReleaseConfigurationSchema.parse({...configurationBody,sha256:canonicalSha256(configurationBody)}),
  trusted_generator_pins:input.trusted_generator_pins.map(pin=>{const family=AI_RELEASE_RUNTIME_FAMILIES.find(f=>f.family_id===pin.family_id);if(!family||pin.generator.id!==family.generator_id||pin.generator.version!==family.generator_version)throw Error('TEST_FAMILY_UNKNOWN');return {family_id:family.family_id,generator:{id:family.generator_id,version:family.generator_version,code_sha256:pin.generator.code_sha256}};}),enrollment_id:'00000000-0000-4000-8000-000000000002',
  dependency_sha256:scope.authority_dependency_sha256,evaluated_at:a.current.evaluated_at,live_evaluated_at:a.current.evaluated_at,
  expires_at:'2026-09-13T00:00:00Z',profile_sha256:h('synthetic profile'),environment:'development',is_qa:true};
 return {envelope,profile};
}
let baseline:AiReleaseRuntimeInput;
beforeAll(()=>{baseline=runtimeFixture();});
describe('saved qualified AI results retain historical bytes while checking live validity',()=>{
 it.each(['source','interpretation','test','reviewer'] as const)('rejects %s expiry at the live instant despite the stable evaluation anchor',kind=>{
  const input=structuredClone(baseline),a=input.assessment_input;
  if(kind==='source')a.source_receipts[0].expires_at=cutoff;
  if(kind==='interpretation')a.interpretation_receipts[0].expires_at=cutoff;
  if(kind==='test')a.test_receipts[0].expires_at=cutoff;
  if(kind==='reviewer')a.registry.reviewers[0].expires_at=cutoff;
  relink(input);const {envelope,profile}=setup(input),original=canonicalSha256(envelope);
  expect(envelope.result.admission.state).toBe('admitted');
  if(envelope.result.admission.state!=='admitted')throw Error('TEST_ADMISSION_REQUIRED');
  expect(envelope.result.admission.receipt.expires_at).toBe(cutoff);
  expect(()=>assertSavedAiReleaseCurrent(envelope,{...profile,live_evaluated_at:'2026-09-12T10:59:59Z'})).not.toThrow();
  expect(()=>assertSavedAiReleaseCurrent(envelope,{...profile,live_evaluated_at:cutoff})).toThrow('AI_RELEASE_ADMISSION_EXPIRED');
  expect(canonicalSha256(envelope)).toBe(original);expect(profile.evaluated_at).toBe('2026-09-12T10:00:00Z');
 });
 it('honors a future revocation captured at the original anchor',()=>{
  const input=structuredClone(baseline);input.assessment_input.registry.revocations.push({target_sha256:input.assessment_input.source_receipts[0].sha256,effective_at:cutoff,reason_code:'synthetic_source_withdrawal'});
  relink(input);const {envelope,profile}=setup(input),original=canonicalSha256(envelope);
  expect(()=>assertSavedAiReleaseCurrent(envelope,profile)).not.toThrow();
  expect(()=>assertSavedAiReleaseCurrent(envelope,{...profile,live_evaluated_at:cutoff})).toThrow('AI_RELEASE_ADMISSION_EXPIRED');
  expect(canonicalSha256(envelope)).toBe(original);
 });
 it('rejects expiry of a consumed case-method decision independently of longer-lived global admission',()=>{
  const source=nineTopicRuntimeSource(),pension=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);
  pension.applicability[0].valid_until=cutoff;source.entitlement_evidence!.pension=pension;
  const {envelope,profile}=setup(runtimeFixture(source));
  expect(envelope.result.checks.some(c=>c.topic==='pension'&&c.state==='calculated')).toBe(true);
  expect(()=>assertSavedAiReleaseCurrent(envelope,profile)).not.toThrow();
  expect(()=>assertSavedAiReleaseCurrent(envelope,{...profile,live_evaluated_at:cutoff})).toThrow('AI_RELEASE_CASE_DECISION_EXPIRED');
 });
 it.each(['policy','registry','generator','dependency','population','evaluation_anchor'] as const)('rejects changed current %s',kind=>{
  const {envelope,profile}=setup(structuredClone(baseline)),changed=structuredClone(profile);
  if(kind==='policy')changed.configuration.policy.sha256=h('other policy');
  if(kind==='registry')changed.configuration.registry.sha256=h('other registry');
  if(kind==='generator')changed.trusted_generator_pins=[{...changed.trusted_generator_pins[0],generator:{...changed.trusted_generator_pins[0].generator,code_sha256:h('other generator')}},...changed.trusted_generator_pins.slice(1)];
  if(kind==='dependency')changed.dependency_sha256=h('other enrollment dependency');
  if(kind==='population')changed.configuration.population='different_population';
  if(kind==='evaluation_anchor')changed.evaluated_at='2026-09-12T10:00:01Z';
  expect(()=>assertSavedAiReleaseCurrent(envelope,changed)).toThrow('AI_RELEASE_CURRENT_PROFILE_MISMATCH');
 });
 it('keeps a valid zero distinct from missing and preserves a blocked partial family',()=>{
  const zeroSource=nineTopicRuntimeSource(),zeroPension=pensionEntitlementInputSchema.parse(zeroSource.entitlement_evidence!.pension);
  zeroPension.pensionable_wage!.printed_value='0.00';zeroSource.entitlement_evidence!.pension=zeroPension;
  const zero=setup(runtimeFixture(zeroSource));
  expect(zero.envelope.result.checks.some(c=>c.topic==='pension'&&c.state==='calculated'&&c.expected?.kind==='money'&&c.expected.minor_units===0)).toBe(true);
  expect(()=>assertSavedAiReleaseCurrent(zero.envelope,zero.profile)).not.toThrow();
  const source=nineTopicRuntimeSource(),pension=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);
  pension.pensionable_wage!.state='unknown';pension.pensionable_wage!.printed_value=null;source.entitlement_evidence!.pension=pension;
  const partial=setup(runtimeFixture(source)),before=canonicalSha256(partial.envelope);
  const result=assertSavedAiReleaseCurrent(partial.envelope,partial.profile);
  expect(result.result.state).toBe('partial');expect(result.result.checks.filter(c=>c.topic==='pension').every(c=>c.state==='blocked'&&c.expected===null)).toBe(true);
  expect(result.result.checks.some(c=>c.topic!=='pension'&&c.state==='calculated')).toBe(true);
  expect(canonicalSha256(partial.envelope)).toBe(before);
 });
 it('can inspect an already fully blocked historical envelope without promoting it or writing a new assessment',()=>{
  const input=structuredClone(baseline);input.assessment_input.assessment.expires_at='2026-09-12T09:00:00Z';relink(input);
  const {envelope,profile}=setup(input),before=canonicalSha256(envelope);
  const inspected=assertSavedAiReleaseCurrent(envelope,profile);
  expect(inspected.result.state).toBe('blocked');expect(inspected.result.findings).toEqual([]);expect(inspected.result.admission.state).toBe('blocked');
  expect(canonicalSha256(envelope)).toBe(before);
 });
});
