import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {aiReleasePolicySchema,aiReleaseAssessmentInputSchema,type AiReleaseAssessmentInput} from './contracts.ts';
import {evaluateAiReleaseAssessment,evaluateOwnerEngineeringAssessment,assertAiReleaseAdmission,assertOwnerEngineeringAdmission} from './policy.ts';
import {ownerEngineeringFixture,repinEngineeringFixture,resealEngineeringFixture} from '../ai-release-runtime/owner-engineering.fixture.ts';
const base=ownerEngineeringFixture();
const fixture=()=>structuredClone(base.assessment_input);
function admit(f=fixture()){const r=evaluateOwnerEngineeringAssessment(f);expect(r.state,JSON.stringify(r)).toBe('admitted');if(r.state!=='admitted')throw Error('SYNTHETIC_ENGINEERING_EXPECTED');return r.receipt;}
function codes(f:unknown){const r=evaluateOwnerEngineeringAssessment(f);return [...r.blockers,...r.branches.flatMap(b=>b.blockers)].map(b=>b.code);}
describe('owner engineering authority, distinct from qualified release',()=>{
 it('preserves unresolved law bytes and issues only an owner engineering capability',()=>{
  const f=fixture(),before=canonicalSha256(f),r=admit(f);expect(canonicalSha256(f)).toBe(before);
  expect(r).toMatchObject({schema_version:'tivdoc-owner-engineering-admission-v1',claim_kind:'owner_engineering_review',owner_scope:f.current.owner_scope,release_authorized:false,publication_allowed:false,notification_allowed:false});
  expect(r.human_law_reviews[0].human_by_law).toEqual(f.interpretation_receipts[0].human_by_law);
  expect(()=>assertOwnerEngineeringAdmission(r,f.current)).not.toThrow();expect(Object.isFrozen(r.human_law_reviews)).toBe(true);
  // An unsafe JS caller cannot pass the new branded capability to the old API.
  expect(()=>Reflect.apply(assertAiReleaseAdmission,undefined,[r])).toThrow('AI_RELEASE_FACTORY_ADMISSION_REQUIRED');
  expect(()=>assertOwnerEngineeringAdmission(JSON.parse(JSON.stringify(r)))).toThrow('OWNER_ENGINEERING_FACTORY_ADMISSION_REQUIRED');
 });
 it('leaves v1 unresolved blocking and its schema exact',()=>{
  const f=fixture();expect(aiReleasePolicySchema.safeParse(f.policy).success).toBe(false);expect(evaluateAiReleaseAssessment(f).state).toBe('blocked');
  const {purpose,owner_scope,...p}=f.policy;void purpose;void owner_scope;
  const policy={...p,schema_version:'tivdoc-ai-release-policy-v1',claim_kind:'qualified_ai_report'};resealEngineeringFixture(policy);
  const registry={...f.registry,policy_sha256:policy.sha256};resealEngineeringFixture(registry);
  const assessment={...f.assessment,policy_sha256:policy.sha256,registry_sha256:registry.sha256};resealEngineeringFixture(assessment);
  const {owner_scope:ignored,...current}=f.current;void ignored;
  const legacy:AiReleaseAssessmentInput=aiReleaseAssessmentInputSchema.parse({...f,policy,registry,assessment,current:{...current,policy_sha256:policy.sha256,registry_sha256:registry.sha256,assessment_sha256:assessment.sha256}});
  const r=evaluateAiReleaseAssessment(legacy);expect(r.branches[0].blockers.map(b=>b.code)).toContain('AI_RELEASE_HUMAN_BY_LAW_UNRESOLVED');
  expect(()=>Reflect.apply(assertOwnerEngineeringAdmission,undefined,[{}])).toThrow('OWNER_ENGINEERING_FACTORY_ADMISSION_REQUIRED');
 });
 it.each(['identity_id','enrollment_id','case_id'] as const)('rejects foreign owner %s',key=>{
  const f=fixture();f.current.owner_scope[key]='44444444-4444-4444-8444-444444444444';expect(evaluateOwnerEngineeringAssessment(f).state).toBe('blocked');
 });
 it.each([{environment:'production'},{environment:'test'},{environment:'preview'},{namespace:'real'},{is_qa:false}])('rejects other environment/scope %j',change=>{
  const f=fixture();expect(evaluateOwnerEngineeringAssessment({...f,current:{...f.current,...change}}).state).toBe('blocked');
 });
 it('still blocks an explicit human requirement',()=>{const f=fixture();f.interpretation_receipts[0].human_by_law.state='required';repinEngineeringFixture(f);expect(codes(f)).toContain('AI_RELEASE_HUMAN_BY_LAW_REQUIRED');});
 it.each(['missing','unknown','conflict'] as const)('does not promote %s interpretation status',status=>{const f=fixture();f.interpretation_receipts[0].status=status;repinEngineeringFixture(f);expect(codes(f)).toContain('AI_RELEASE_INTERPRETATION_'+status.toUpperCase());});
 it.each(['missing','unknown','conflict','stale','unreadable'] as const)('keeps %s required factual evidence blocked',state=>{
  const f=fixture();f.policy.branches[0].required_fact_keys=['actual'];f.assessment.branches[0].facts=[{fact_key:'actual',state,origin:'derived',value_sha256:null,source_pins:[],reading_receipt_sha256:null,derivation_sha256:null}];
  repinEngineeringFixture(f);expect(codes(f)).toContain('AI_RELEASE_FACT_'+state.toUpperCase());
 });
 it('retains missing decisions, failed tests and stale source pins',()=>{
  const f=fixture();f.policy.branches[0].required_decision_ids=['still-required'];f.test_receipts[0].failed=1;repinEngineeringFixture(f);
  expect(codes(f)).toContain('AI_RELEASE_CASE_DECISION_MISSING');expect(codes(f)).toContain('AI_RELEASE_TESTS_NOT_PASSED');
  f.current.scope.input_revision++;expect(codes(f)).toContain('AI_RELEASE_CURRENT_SCOPE_MISMATCH');
 });
 it('fences live expiry and scheduled revocation without rewriting the stable receipt',()=>{
  const f=fixture(),cutoff='2026-09-12T11:00:00Z';f.registry.revocations.push({target_sha256:f.interpretation_receipts[0].sha256,effective_at:cutoff,reason_code:'synthetic-revocation'});repinEngineeringFixture(f);
  const receipt=admit(f);expect(receipt.expires_at).toBe('2026-09-12T11:00:00.000Z');
  expect(()=>assertOwnerEngineeringAdmission(receipt,{...f.current,evaluated_at:cutoff})).toThrow('AI_RELEASE_ADMISSION_EXPIRED');
  expect(codes({...f,current:{...f.current,evaluated_at:cutoff}})).toContain('AI_RELEASE_REVOKED');
 });
});
