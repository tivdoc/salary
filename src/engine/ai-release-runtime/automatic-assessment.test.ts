import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts';
import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {aiReleasePolicySchema,aiReleaseRegistrySchema} from '../ai-release/contracts.ts';
import {runtimeFixture,nineTopicRuntimeSource} from './runtime.fixture.ts';
import {prepareAiReleaseRuntime} from './generator-manifest.ts';
import {runAiReleaseRuntime} from './runtime.ts';
import {composeAutomaticAiReleaseAssessment,type AutomaticAiReleaseAssessmentInput} from './automatic-assessment.ts';

const seal=<T extends {sha256:string}>(input:T)=>{const {sha256:old,...body}=input;void old;return {...body,sha256:canonicalSha256(body)};};
function fixture(source=nineTopicRuntimeSource()):AutomaticAiReleaseAssessmentInput{
 const runtime=runtimeFixture(source),{policy:oldPolicy,registry:oldRegistry,source_receipts,interpretation_receipts,test_receipts,current:oldCurrent}=runtime.assessment_input;
 const policy=aiReleasePolicySchema.parse(seal({...oldPolicy,branches:oldPolicy.branches.map(b=>({...b,required_fact_keys:['generated.case_evidence']}))}));
 const registry=aiReleaseRegistrySchema.parse(seal({...oldRegistry,policy_sha256:policy.sha256}));
 const {assessment_sha256,expected_generated_rules,...current}=oldCurrent;void assessment_sha256;void expected_generated_rules;
 return {configuration:{policy,registry,source_receipts,interpretation_receipts,test_receipts},source:runtime.source,
  prepared:prepareAiReleaseRuntime({source:runtime.source,analysis_run_id:runtime.analysis_run_id,trusted_generator_pins:runtime.trusted_generator_pins}),trusted_generator_pins:runtime.trusted_generator_pins,
  current:{...current,policy_sha256:policy.sha256,registry_sha256:registry.sha256},
  issuance:{issued_at:current.evaluated_at,expires_at:'2026-09-12T12:00:00Z',reviewer_id:'synthetic-ai',reviewer_version:'1'}};
}
function relink(input:AutomaticAiReleaseAssessmentInput){
 input.configuration.policy=aiReleasePolicySchema.parse(seal(input.configuration.policy));
 input.configuration.registry=aiReleaseRegistrySchema.parse(seal({...input.configuration.registry,policy_sha256:input.configuration.policy.sha256}));
 input.current.policy_sha256=input.configuration.policy.sha256;input.current.registry_sha256=input.configuration.registry.sha256;
}
function run(input:AutomaticAiReleaseAssessmentInput){
 const result=composeAutomaticAiReleaseAssessment(input);
 return {automatic:result,runtime:runAiReleaseRuntime({source:input.source,analysis_run_id:input.prepared.analysis_run_id,
  trusted_generator_pins:[...input.trusted_generator_pins],assessment_input:result.assessment_input})};
}
describe('automatic derived-manifest assessment',()=>{
 it('uses authenticated scope and deterministic manifests without a customer packet or document-reading claim',()=>{
  const input=fixture(),before=canonicalSha256(input),{automatic,runtime}=run(input);
  expect(runtime.findings.length).toBeGreaterThan(0);expect(automatic.missing_requirements).toEqual([]);
  expect(automatic.assessment_input.assessment.scope).toEqual(input.current.scope);
  expect(automatic.provenance.actor.kind).toBe('deterministic_application_of_ai_reviewed_rules');
  expect(automatic.assessment_input.assessment.branches.every(b=>b.decisions.length===0&&b.facts.every(f=>f.origin==='derived'&&f.reading_receipt_sha256===null))).toBe(true);
  expect(automatic.provenance.manifests.every(m=>!m.document_reading_performed&&!m.legal_case_decision_performed)).toBe(true);
  expect(composeAutomaticAiReleaseAssessment(input)).toEqual(automatic);expect(canonicalSha256(input)).toBe(before);
 });
 it('leaves additional policy facts and decisions missing rather than deriving approval',()=>{
  const input=fixture(),branch=input.configuration.policy.branches.find(b=>b.topic==='pension')!;
  branch.required_fact_keys.push('document.pension_base');branch.required_decision_ids.push('agreement.applies');relink(input);
  const {automatic,runtime}=run(input);
  expect(automatic.missing_requirements).toEqual(expect.arrayContaining([
   {branch_id:branch.branch_id,kind:'fact',dependency_id:'document.pension_base',reason:'explicit_case_fact_required'},
   {branch_id:branch.branch_id,kind:'decision',dependency_id:'agreement.applies',reason:'explicit_case_decision_required'}]));
  const pension=runtime.families.find(f=>f.topic==='pension')!;
  expect(pension.checks.every(c=>c.state==='blocked'&&c.expected===null)).toBe(true);
  expect(pension.blockers.map(b=>b.code)).toContain('AI_RELEASE_CASE_DECISION_MISSING');
 });
 it.each(['missing','conflict'] as const)('keeps actual %s operands blocked despite a known manifest proof',state=>{
  const source=nineTopicRuntimeSource(),pension=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension!);
  const operand=pension.pensionable_wage!; // Preserve the actual fact state in the ordinary preparation.
  operand.state=state;operand.printed_value=null;source.entitlement_evidence!.pension=pension;
  const input=fixture(source),{automatic,runtime}=run(input);
  expect(automatic.assessment_input.assessment.branches.find(b=>b.branch_id==='entitlement.pension')?.facts[0].state).toBe('known');
  const family=runtime.families.find(f=>f.topic==='pension')!;
  expect(family.state).toBe('blocked');
  expect(family.checks.every(c=>c.state==='blocked'&&c.expected===null)).toBe(true);
  expect(family.coverage_gaps.length).toBeGreaterThan(0);
  expect(canonicalSha256(source)).toBe(canonicalSha256(input.source));
 });
 it('rejects using a manifest proof as an identified document reading',()=>{
  const input=fixture();input.configuration.policy.branches[0].document_reading_fact_keys=['generated.case_evidence'];relink(input);
  expect(()=>composeAutomaticAiReleaseAssessment(input)).toThrow('AI_AUTOMATIC_MANIFEST_NOT_DOCUMENT_READING');
 });
 it('rejects foreign current source pins and a mismatched saved scope',()=>{
  const foreign=fixture();foreign.current.source_pins[0].case_id='foreign';
  expect(()=>composeAutomaticAiReleaseAssessment(foreign)).toThrow('AI_AUTOMATIC_FOREIGN_SOURCE');
  const wrong=fixture();wrong.current.scope.order_id='different-order';
  expect(()=>composeAutomaticAiReleaseAssessment(wrong)).toThrow('AI_AUTOMATIC_SCOPE_MISMATCH');
 });
 it('rejects replaced source bytes and forged preparation values',()=>{
  const changed=fixture();changed.current.source_pins[0].source_sha256='f'.repeat(64);
  expect(()=>composeAutomaticAiReleaseAssessment(changed)).toThrow('AI_AUTOMATIC_SOURCE_MISMATCH');
  const forged=fixture();forged.prepared={...forged.prepared,source_input_sha256:'f'.repeat(64)};
  expect(()=>composeAutomaticAiReleaseAssessment(forged)).toThrow('AI_AUTOMATIC_PREPARATION_MISMATCH');
 });
 it('rejects invalid configuration hashes and stale issuance without extending the registry',()=>{
  const bad=fixture();bad.configuration.policy.sha256='f'.repeat(64);
  expect(()=>composeAutomaticAiReleaseAssessment(bad)).toThrow();
  const stale=fixture();stale.issuance.expires_at=stale.current.evaluated_at;
  expect(()=>composeAutomaticAiReleaseAssessment(stale)).toThrow('AI_AUTOMATIC_ISSUANCE_STALE');
  const extension=fixture();extension.issuance.expires_at='2026-09-14T00:00:00Z';
  expect(()=>composeAutomaticAiReleaseAssessment(extension)).toThrow('AI_AUTOMATIC_CONFIGURATION_NOT_CURRENT');
 });
});
