import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {createJune2026MinimumWageCandidate} from './candidate.ts';
import {evaluateJune2026TestReadiness,decodeJune2026TestReadiness,June2026IsolatedTestCatalog,JUNE2026_TEST_READINESS} from './test-catalog.ts';
import {resolveJune2026Evidence} from './evidence-admission.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY,JUNE2026_SOURCE_SET_SHA256,JUNE2026_MINIMUM_WAGE_SOURCES} from './sources.ts';
import {createAdmissionTestFixture,createTestAssessment,admissionTestNow} from './evidence-admission.test-fixtures.ts';

const selectionInput={mode:'synthetic_test' as const,topic:'minimum_wage' as const,target_date:'2026-06-30',as_of:'2026-09-10',
 sector:JUNE2026_MINIMUM_WAGE_POLICY.sector,population:JUNE2026_MINIMUM_WAGE_POLICY.population};
function fixture(){
 const f=createAdmissionTestFixture(),packet=f.packet(),assessment=createTestAssessment(packet);
 return {...f,packet,assessment,input:{...selectionInput,assessment}};
}
function rehash<T extends {decision_sha256:string}>(value:T){
 const {decision_sha256,...body}=value;void decision_sha256;return {...body,decision_sha256:canonicalSha256(body)};
}

describe('June2026 isolated test catalog and replayable readiness',()=>{
 it('selects the unchanged exact-method candidate and retains its inactive source and authority boundaries',async()=>{
  const f=fixture(),candidate=createJune2026MinimumWageCandidate(1),before=JSON.stringify({rule:candidate.rule,parameters:candidate.parameters,sources:JUNE2026_MINIMUM_WAGE_SOURCES});
  const selection=await new June2026IsolatedTestCatalog(f.assessment).resolve(selectionInput);
  const readiness=decodeJune2026TestReadiness(selection.readiness);
  expect(selection).toMatchObject({catalog_id:'tivdoc.june2026.isolated-test',mode:'synthetic_test',topic:'minimum_wage',
   rule_spec_id:candidate.rule.rule_spec_id,rule_spec_version:candidate.rule.rule_spec_version});
  expect(selection.parameter_version_ids).toEqual(candidate.parameters.map(parameter=>`${parameter.parameter_id}@${parameter.parameter_version}`));
  expect(selection.source_version_ids).toEqual(candidate.rule.source_version_ids);
  expect(readiness).toMatchObject({schema_version:JUNE2026_TEST_READINESS,status:'READY',usable_for_rules:true,test_only_synthetic:true,
   human_approval:false,legal_activation:false,source_set_sha256:JUNE2026_SOURCE_SET_SHA256,rule_sha256:candidate.rule.content_sha256,
   parameters_sha256:canonicalSha256(candidate.parameters),calculation_method:'monthly_644385_minor_times_regular_hours_over_182_final_half_up@1.0.0'});
  expect(readiness.reason_codes).toEqual([]);
  expect(candidate.rule.catalog_boundary).toBe('real_inactive');
  expect(candidate).toMatchObject({humanApproved:false,activationAllowed:false});
  expect(JUNE2026_MINIMUM_WAGE_SOURCES.every(source=>!source.human_reviewed&&source.activation_state==='inactive')).toBe(true);
  expect(JSON.stringify({rule:candidate.rule,parameters:candidate.parameters,sources:JUNE2026_MINIMUM_WAGE_SOURCES})).toBe(before);
  expect(Object.isFrozen(selection)).toBe(true);
 });

 it('refuses test authority for real service even with a perfectly matching assessment',async()=>{
  const f=fixture(),input={...selectionInput,mode:'real' as const};
  const selection=await new June2026IsolatedTestCatalog(f.assessment).resolve(input);
  const readiness=decodeJune2026TestReadiness(selection.readiness);
  expect(readiness).toMatchObject({status:'BLOCKED_NOT_READY',usable_for_rules:false,human_approval:false,legal_activation:false});
  expect(readiness.reason_codes).toContain('TEST_AUTHORITY_FORBIDDEN_FOR_REAL_SERVICE');
  const resolution=resolveJune2026Evidence({packet:f.packet,facts:f.facts,assessment:f.assessment,evaluatedAt:admissionTestNow,mode:'real'});
  expect(resolution.execution_allowed).toBe(false);
 });

 it.each([
  ['target_date','2026-07-31'],['target_date','2026-06-01'],['sector','construction'],['population','youth'],
 ] as const)('refuses unsupported %s=%s',(field,value)=>{
  const f=fixture(),result=evaluateJune2026TestReadiness({...f.input,[field]:value});
  expect(result.status).toBe('BLOCKED_NOT_READY');expect(result.usable_for_rules).toBe(false);
  expect(result.reason_codes).toContain('TEST_SCOPE_MISMATCH');
 });

 it.each(['policy_sha256','rule_sha256','golden_cases_sha256'] as const)('refuses a changed %s instead of silently choosing another method',field=>{
  const f=fixture(),result=evaluateJune2026TestReadiness({...f.input,assessment:{...f.assessment,[field]:'f'.repeat(64)}});
  expect(result.status).toBe('BLOCKED_NOT_READY');expect(result.usable_for_rules).toBe(false);
  expect(result.reason_codes).toContain('TEST_VERSION_MISMATCH');
 });

 it('requires source availability as of the historical catalog date',()=>{
  const f=fixture();
  const before=evaluateJune2026TestReadiness({...f.input,as_of:'2026-09-08'});
  expect(before.status).toBe('BLOCKED_NOT_READY');expect(before.reason_codes).toContain('TEST_SOURCE_NOT_YET_AVAILABLE');
  expect(evaluateJune2026TestReadiness({...f.input,as_of:'2026-09-09'}).status).toBe('READY');
 });

 it('keeps static catalog readiness separate from expired runtime assessment authority',()=>{
  const f=fixture(),historical=evaluateJune2026TestReadiness(f.input);
  expect(historical.status).toBe('READY');
  const resolution=resolveJune2026Evidence({packet:f.packet,facts:f.facts,assessment:f.assessment,mode:'synthetic_test',evaluatedAt:f.assessment.expires_at});
  expect(resolution.execution_allowed).toBe(false);
  expect(resolution.decisions.every(decision=>decision.state==='expired')).toBe(true);
  // The saved historical policy does not acquire or renew current authority.
  expect(decodeJune2026TestReadiness(historical)).toEqual(historical);
 });

 it('requires an explicit test assessment and rejects a document reading or human-approval-shaped substitute',()=>{
  const f=fixture();
  expect(()=>evaluateJune2026TestReadiness({...f.input,assessment:null})).toThrow();
  expect(()=>evaluateJune2026TestReadiness({...f.input,assessment:f.facts.facts[0]})).toThrow();
  expect(()=>evaluateJune2026TestReadiness({...f.input,assessment:{...f.assessment,human_approval:true}})).toThrow();
  expect(()=>evaluateJune2026TestReadiness({...f.input,topic:'travel'})).toThrow();
 });

 it('pins assessment scope into the catalog fingerprint rather than treating grants as interchangeable',async()=>{
  const f=fixture(),first=await new June2026IsolatedTestCatalog(f.assessment).resolve(selectionInput);
  const otherAssessment={...f.assessment,assessment_id:randomUUID(),order_id:randomUUID(),document_sha256:'f'.repeat(64)};
  const other=await new June2026IsolatedTestCatalog(otherAssessment).resolve(selectionInput);
  expect(first.catalog_sha256).not.toBe(other.catalog_sha256);
  const resolution=resolveJune2026Evidence({packet:f.packet,facts:f.facts,assessment:otherAssessment,evaluatedAt:admissionTestNow,mode:'synthetic_test'});
  expect(resolution.execution_allowed).toBe(false);
  expect(resolution.decisions.every(decision=>decision.state==='stale')).toBe(true);
 });

 it.each(['source_set_sha256','rule_sha256','parameters_sha256','calculation_method','human_approval','legal_activation'] as const)(
  'refuses edited readiness %s after outer rehash',field=>{
   const original=evaluateJune2026TestReadiness(fixture().input);
   const changed={...original,[field]:field==='human_approval'||field==='legal_activation'?true:field==='calculation_method'?'rounded_hourly_rate_times_hours':'f'.repeat(64)};
   expect(()=>decodeJune2026TestReadiness(rehash(changed))).toThrow('TEST_READINESS_HASH_MISMATCH');
  });

 it('replays policy instead of accepting a rehashed READY label on a real-service refusal',()=>{
  const f=fixture(),blocked=evaluateJune2026TestReadiness({...f.input,mode:'real'});
  const fabricated=rehash({...blocked,status:'READY' as const,usable_for_rules:true,reason_codes:[]});
  expect(()=>decodeJune2026TestReadiness(fabricated)).toThrow('TEST_READINESS_HASH_MISMATCH');
 });

 it('rejects a changed nested normalized input even when its envelope hash is recomputed',()=>{
  const original=evaluateJune2026TestReadiness(fixture().input);
  const changed=rehash({...original,normalized_input:{...original.normalized_input,sector:'construction'}});
  expect(()=>decodeJune2026TestReadiness(changed)).toThrow('TEST_READINESS_HASH_MISMATCH');
  expect(decodeJune2026TestReadiness(JSON.parse(JSON.stringify(original)))).toEqual(original);
 });
});
