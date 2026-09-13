import {beforeAll,describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {ownerEngineeringFixture,repinEngineeringFixture,resealEngineeringFixture as reseal} from '@/engine/ai-release-runtime/owner-engineering.fixture';
import {evaluateOwnerEngineeringAssessment} from '@/engine/ai-release/policy';
import {AI_RELEASE_BOUND_EVIDENCE_ANCHOR,aiEvaluationAnchorDependency,savedAiEvaluationAnchor} from './ai-release-evaluation-anchor';
import {ownerEngineeringConfigurationSchema,type OwnerEngineeringConfiguration} from './ai-release-configuration';

vi.mock('server-only',()=>({}));
const sourceAt='2026-09-12T01:00:00Z',testAt='2026-09-12T03:00:00Z',liveAt='2026-09-12T10:00:00Z';
let base:ReturnType<typeof ownerEngineeringFixture>;
beforeAll(()=>{base=ownerEngineeringFixture();});
function fixture(){
 const runtime=structuredClone(base),a=runtime.assessment_input;
 a.test_receipts[0].issued_at=testAt;repinEngineeringFixture(a);
 const body={schema_version:'tivdoc-owner-engineering-configuration-v1',configuration_id:'11111111-1111-4111-8111-111111111111',revision:1,
  population:a.current.scope.population,build_manifest_sha256:canonicalSha256('synthetic build'),evaluation_anchor_policy:AI_RELEASE_BOUND_EVIDENCE_ANCHOR,
  policy:a.policy,registry:a.registry,source_receipts:a.source_receipts,interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts};
 const configuration=ownerEngineeringConfigurationSchema.parse({...body,sha256:canonicalSha256(body)});
 return {runtime,configuration};
}
function assessAt(runtime:ReturnType<typeof ownerEngineeringFixture>,at:string){
 const input=structuredClone(runtime.assessment_input);input.assessment.issued_at=at;reseal(input.assessment);
 input.current.evaluated_at=at;input.current.assessment_sha256=input.assessment.sha256;
 return evaluateOwnerEngineeringAssessment(input);
}
describe('versioned bound evidence evaluation anchor',()=>{
 it('fixes measured-test chronology through the ordinary evaluator without changing receipt time or status',()=>{
  const {runtime,configuration}=fixture(),original=JSON.stringify(configuration);
  const legacy=structuredClone(configuration);delete legacy.evaluation_anchor_policy;reseal(legacy);
  const old=savedAiEvaluationAnchor(legacy,sourceAt,liveAt),blocked=assessAt(runtime,old.evaluated_at);
  expect(blocked.state).toBe('blocked');expect(blocked.branches.flatMap(b=>b.blockers).map(b=>b.code)).toContain('AI_RELEASE_TEST_CHRONOLOGY');
  const fixed=savedAiEvaluationAnchor(configuration,sourceAt,liveAt);
  expect(fixed.evaluated_at).toBe('2026-09-12T03:00:00.000Z');
  const admitted=assessAt(runtime,fixed.evaluated_at);expect(admitted.state).toBe('admitted');
  if(admitted.state!=='admitted')throw Error('expected synthetic admission');
  expect(admitted.receipt.release_authorized).toBe(false);expect(admitted.receipt.human_attestation).toBeNull();
  expect(admitted.receipt.human_law_reviews[0].human_by_law.state).toBe('unresolved');
  expect(JSON.stringify(configuration)).toBe(original);
 });
 it('is stable across restart/live clock changes and binds the policy in new profile dependencies only',()=>{
  const {configuration}=fixture(),first=savedAiEvaluationAnchor(configuration,sourceAt,liveAt);
  expect(savedAiEvaluationAnchor(configuration,sourceAt,'2026-09-12T20:00:00Z')).toEqual(first);
  expect(aiEvaluationAnchorDependency(first)).toEqual({evaluation_anchor_policy:AI_RELEASE_BOUND_EVIDENCE_ANCHOR,evaluation_anchor_sha256:first.evaluation_anchor?.sha256});
  const receipt=first.evaluation_anchor;if(!receipt)throw Error('fixture');const {sha256,...body}=receipt;expect(sha256).toBe(canonicalSha256(body));
  expect(Object.isFrozen(receipt.dependencies)).toBe(true);
  const old=structuredClone(configuration);delete old.evaluation_anchor_policy;
  expect(savedAiEvaluationAnchor(old,sourceAt,liveAt)).toEqual({evaluated_at:'2026-09-12T01:00:00.000Z'});
  expect(aiEvaluationAnchorDependency(savedAiEvaluationAnchor(old,sourceAt,liveAt))).toEqual({});
 });
 it('includes exactly bound source, interpretation, test, reviewer and method starts',()=>{
  const {configuration:c}=fixture(),i=c.interpretation_receipts[0],s=c.source_receipts[0];
  c.methods=[{recipe_id:'synthetic.anchor.method',recipe_version:'1',recipe_sha256:canonicalSha256('recipe'),source_policy_sha256:canonicalSha256('source policy'),
   interpretation_receipt_sha256:i.sha256,source_receipts:[{receipt_sha256:s.sha256,source_version_id:s.source_version_id,artifact_sha256:s.artifact_sha256}],
   issued_at:'2026-09-12T04:00:00Z',expires_at:c.policy.expires_at}];
  // Static compiled-method verification belongs to the configuration verifier;
  // this synthetic unit tests only which already-bound descriptors affect time.
  const anchor=savedAiEvaluationAnchor(c,sourceAt,liveAt);expect(anchor.evaluated_at).toBe('2026-09-12T04:00:00.000Z');
  expect(new Set(anchor.evaluation_anchor?.dependencies.map(d=>d.kind))).toEqual(new Set(['policy','registry','source','interpretation','test','reviewer','method']));
  const originalActor=c.registry.reviewers[0];c.registry.reviewers.push({...originalActor,actor_id:'unused-future-actor',issued_at:'2026-09-12T23:00:00Z'});
  expect(savedAiEvaluationAnchor(c,sourceAt,liveAt)).toEqual(anchor);
 });
 it('selects a later source head without changing evidence validity',()=>{
  const {configuration}=fixture();expect(savedAiEvaluationAnchor(configuration,'2026-09-12T06:00:00Z',liveAt).evaluated_at).toBe('2026-09-12T06:00:00.000Z');
 });
 it.each(['source','interpretation','test','actor','duplicate','foreign-test'] as const)('rejects missing or foreign exact %s binding',kind=>{
  const {configuration:c}=fixture();
  if(kind==='source')c.source_receipts=[];
  if(kind==='interpretation')c.interpretation_receipts=[];
  if(kind==='test')c.test_receipts=[];
  if(kind==='actor')c.registry.reviewers=[];
  if(kind==='duplicate')c.test_receipts.push(c.test_receipts[0]);
  if(kind==='foreign-test')c.test_receipts[0].interpretation_receipt_sha256='f'.repeat(64);
  expect(()=>savedAiEvaluationAnchor(c,sourceAt,liveAt)).toThrow('AI_RELEASE_ANCHOR_EVIDENCE_BINDING');
 });
 it('rejects future evidence rather than rewriting the measured timestamp or using wall clock',()=>{
  const {configuration}=fixture(),before=JSON.stringify(configuration);
  expect(()=>savedAiEvaluationAnchor(configuration,sourceAt,'2026-09-12T02:59:59Z')).toThrow('AI_RELEASE_ANCHOR_FUTURE');
  expect(JSON.stringify(configuration)).toBe(before);
 });
 it('does not extend expired tests or bypass effective revocation in the existing evaluator',()=>{
  const {runtime,configuration}=fixture();const anchor=savedAiEvaluationAnchor(configuration,sourceAt,liveAt);
  expect(assessAt(runtime,anchor.evaluated_at).state).toBe('admitted');
  const a=runtime.assessment_input;a.test_receipts[0].expires_at='2026-09-12T05:00:00Z';repinEngineeringFixture(a);
  const expired=assessAt(runtime,liveAt);expect(expired.state).toBe('blocked');
  expect(expired.branches.flatMap(b=>b.blockers).map(b=>b.code)).toContain('AI_RELEASE_EXPIRED');
  a.registry.revocations.push({target_sha256:a.test_receipts[0].sha256,effective_at:'2026-09-12T03:00:00Z',reason_code:'synthetic-test-revocation'});repinEngineeringFixture(a);
  const revoked=assessAt(runtime,anchor.evaluated_at);expect(revoked.state).toBe('blocked');
  expect(revoked.branches.flatMap(b=>b.blockers).map(b=>b.code)).toContain('AI_RELEASE_REVOKED');
 });
 it('refuses an invalid bound interval even when its start is before live time',()=>{
  const {configuration:c}=fixture();c.test_receipts[0].expires_at=testAt;
  expect(()=>savedAiEvaluationAnchor(c,sourceAt,liveAt)).toThrow('AI_RELEASE_ANCHOR_WINDOW');
 });
 it('rejects foreign method source pins while retaining the configuration untouched',()=>{
  const {configuration:c}=fixture();const fake:NonNullable<OwnerEngineeringConfiguration['methods']>[number]={recipe_id:'synthetic',recipe_version:'1',recipe_sha256:'a'.repeat(64),
   source_policy_sha256:'b'.repeat(64),interpretation_receipt_sha256:c.interpretation_receipts[0].sha256,source_receipts:[{receipt_sha256:'c'.repeat(64),source_version_id:'foreign',artifact_sha256:'d'.repeat(64)}],
   issued_at:sourceAt,expires_at:c.policy.expires_at};c.methods=[fake];
  expect(()=>savedAiEvaluationAnchor(c,sourceAt,liveAt)).toThrow('AI_RELEASE_ANCHOR_EVIDENCE_BINDING');
 });
});
