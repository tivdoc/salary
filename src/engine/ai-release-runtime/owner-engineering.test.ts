import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {prepareAiReleaseRuntime} from './generator-manifest.ts';
import {ownerEngineeringFixture,repinEngineeringFixture} from './owner-engineering.fixture.ts';
import {runOwnerEngineeringRuntime,replayOwnerEngineeringRuntime} from './owner-engineering.ts';
import {runAiReleaseRuntime} from './runtime.ts';
import {composeAutomaticOwnerEngineeringAssessment} from './automatic-assessment.ts';
import {runtimeFixture,nineTopicRuntimeSource} from './runtime.fixture.ts';
const base=ownerEngineeringFixture();
describe('ordinary generated rules → owner engineering projection',()=>{
 it('keeps independently known pension arithmetic while disclosing unresolved law',()=>{
  const i=structuredClone(base),before=canonicalSha256(i),r=runOwnerEngineeringRuntime(i);
  expect(r.findings.map(f=>f.expected)).toEqual([30000,32500,30000].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  expect(r.findings.every(f=>f.outcome==='expected_only'&&f.recorded===null&&f.difference===null&&f.trace?.status==='succeeded')).toBe(true);
  expect(r.findings.every(f=>f.human_law_review?.human_by_law.state==='unresolved'&&f.claim_kind==='owner_engineering_review')).toBe(true);
  expect(r).toMatchObject({state:'partial',release_authorized:false,publication_allowed:false,notification_allowed:false,verified_debt:false,legal_debt_total:null,combined_amount:null});
  expect(r.review.checks.every(c=>!c.calculation.real_activation_allowed)).toBe(true);expect(canonicalSha256(i)).toBe(before);
  expect(replayOwnerEngineeringRuntime(JSON.parse(JSON.stringify(r)),i)).toEqual(r);
  expect(()=>Reflect.apply(runAiReleaseRuntime,undefined,[i])).toThrow();
 });
 it('uses the identical candidate execution receipts as v1, with no second calculator',()=>{
  const source=nineTopicRuntimeSource(),engineering=runOwnerEngineeringRuntime(ownerEngineeringFixture(source)),legacy=runAiReleaseRuntime(runtimeFixture(source));
  expect(engineering.review).toEqual(legacy.review);
  expect(engineering.findings.map(f=>[f.check_id,f.expected,f.recorded,f.difference,f.trace])).toEqual(legacy.findings.map(f=>[f.check_id,f.expected,f.recorded,f.difference,f.trace]));
  expect(engineering.families).toHaveLength(9);
 });
 it('keeps required legal review blocked even with already calculated candidates',()=>{
  const i=structuredClone(base);i.assessment_input.interpretation_receipts[0].human_by_law.state='required';repinEngineeringFixture(i.assessment_input);
  const r=runOwnerEngineeringRuntime(i);expect(r.findings).toEqual([]);expect(r.checks.every(c=>c.expected===null)).toBe(true);
 });
 it('blocks an actual unknown operand instead of inventing zero',()=>{
  const source=structuredClone(base.source),p=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);p.pensionable_wage!.state='unknown';p.pensionable_wage!.printed_value=null;source.entitlement_evidence!.pension=p;
  const r=runOwnerEngineeringRuntime(ownerEngineeringFixture(source));expect(r.findings).toEqual([]);expect(r.checks.every(c=>c.expected===null)).toBe(true);
 });
 it('rejects changed source bytes, current pins, and rehashed financial tampering',()=>{
  const i=structuredClone(base),r=runOwnerEngineeringRuntime(i);i.assessment_input.current.source_pins[0].source_sha256='0'.repeat(64);
  expect(()=>runOwnerEngineeringRuntime(i)).toThrow('AI_RUNTIME_CURRENT_SOURCE_MISMATCH');
  const expected=r.findings[0].expected;if(expected?.kind!=='money')throw Error('SYNTHETIC_AMOUNT');
  const {sha256,...oldBody}=r;void sha256;const body={...oldBody,findings:[{...r.findings[0],expected:{...expected,minor_units:expected.minor_units+1}},...r.findings.slice(1)]};
  expect(()=>replayOwnerEngineeringRuntime({...body,sha256:canonicalSha256(body)},base)).toThrow('OWNER_ENGINEERING_REPLAY_MISMATCH');
 });
 it('automatically derives only source manifests and retains explicit missing case requirements',()=>{
  const i=structuredClone(base),f=i.assessment_input;f.policy.branches[0].required_fact_keys=['generated.case_evidence','unanswered'];f.policy.branches[0].required_decision_ids=['unresolved-case'];repinEngineeringFixture(f);
  const {assessment_sha256,expected_generated_rules,...current}=f.current;void assessment_sha256;void expected_generated_rules;
  const {policy,registry,source_receipts,interpretation_receipts,test_receipts}=f;
  const result=composeAutomaticOwnerEngineeringAssessment({configuration:{policy,registry,source_receipts,interpretation_receipts,test_receipts},source:i.source,
   prepared:prepareAiReleaseRuntime({source:i.source,analysis_run_id:i.analysis_run_id,trusted_generator_pins:i.trusted_generator_pins}),trusted_generator_pins:i.trusted_generator_pins,
   current,issuance:{issued_at:current.evaluated_at,expires_at:'2026-09-12T12:00:00Z',reviewer_id:'synthetic-ai',reviewer_version:'1'}});
  expect(result.missing_requirements.map(r=>r.dependency_id)).toEqual(['unanswered','unresolved-case']);
  expect(result.provenance.manifests.every(m=>!m.document_reading_performed&&!m.legal_case_decision_performed)).toBe(true);
  expect(result.assessment_input.interpretation_receipts).toEqual(interpretation_receipts);
  expect(runOwnerEngineeringRuntime({...i,assessment_input:result.assessment_input}).findings).toEqual([]);
 });
});
