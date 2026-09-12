import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import {fixture} from './compose.fixture.ts';
import {questionnaireAgeRangeEvidence,assertQuestionnaireAgeRangeProof,ageRangeBirthDateConsistency} from './questionnaire-age-range.ts';

function sample(year=1980,month='06'){
 const {input}=fixture();input.period={from:`2026-${month}-01`,to:`2026-${month}-${month==='06'?'30':'31'}`};
 const fact=canonicalFactSchema.parse({fact_id:'00000000-0000-4000-8000-000000000001',case_id:input.case_id,path:'person.birth_year',value:year,status:'confirmed',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'44444444-4444-4444-8444-444444444444'}}],conflicting_fact_ids:[],resolution:null,created_at:'2026-09-12T00:00:00Z'});
 input.entitlement_declarations={schema_version:'entitlement-questionnaire-evidence-v1',snapshot_id:'synthetic.year',snapshot_sha256:canonicalSha256([fact]),period:input.period,facts:[fact]};return input;
}
function reseal(input:ReturnType<typeof sample>){input.entitlement_declarations!.snapshot_sha256=canonicalSha256(input.entitlement_declarations!.facts);}
describe('source-bound questionnaire age interval, without an invented birthday',()=>{
 it('proves every nonboundary year across all three release months and retains exact declared origin',()=>{
  for(const month of ['05','06','07'])for(let year=1967;year<=2004;year++){
   const input=sample(year,month),before=canonicalSha256(input),result=questionnaireAgeRangeEvidence(input),proof=result.proof!;
   expect(result.state).toBe('proven');expect(proof.age_at_period_start).toEqual({minimum:2025-year,maximum:2026-year});
   expect(proof.origin.reading).toBe('questionnaire_declaration');expect(proof.transforms.map(t=>t.value)).toEqual([true,true]);
   expect(assertQuestionnaireAgeRangeProof(input,proof)).toEqual(proof);expect(canonicalSha256(input)).toBe(before);
   expect('birth_date'in proof).toBe(false);expect('applicability'in proof).toBe(false);
  }
 });
 it.each([1966,2005])('keeps %i as a boundary in every release month',year=>{
  for(const month of ['05','06','07']){const result=questionnaireAgeRangeEvidence(sample(year,month));expect(result.state).toBe('boundary');expect(result.proof!.transforms).toHaveLength(1);expect(result.reason).toBe('actual_birth_date_required_at_age_boundary');}
 });
 it.each([1965,1900,2006,2026])('does not promote out-of-scope year %i',year=>{expect(questionnaireAgeRangeEvidence(sample(year)).state).toBe('outside_scope');});
 it('preserves missing, conflicting and duplicate declarations instead of selecting one',()=>{
  const absent=sample();delete absent.entitlement_declarations;expect(questionnaireAgeRangeEvidence(absent).state).toBe('missing');
  const conflict=sample();conflict.entitlement_declarations={...conflict.entitlement_declarations!,facts:[{...conflict.entitlement_declarations!.facts[0],status:'conflicted',value:null,conflicting_fact_ids:['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']}]};reseal(conflict);expect(questionnaireAgeRangeEvidence(conflict).state).toBe('conflict');
  const duplicate=sample();duplicate.entitlement_declarations={...duplicate.entitlement_declarations!,facts:[...duplicate.entitlement_declarations!.facts,{...duplicate.entitlement_declarations!.facts[0],fact_id:'00000000-0000-4000-8000-000000000002'}]};reseal(duplicate);expect(questionnaireAgeRangeEvidence(duplicate).state).toBe('conflict');
 });
 it('rejects foreign case, snapshot hash and mismatched declaration period',()=>{
  const foreign=sample();foreign.entitlement_declarations={...foreign.entitlement_declarations!,facts:[{...foreign.entitlement_declarations!.facts[0],case_id:'55555555-5555-4555-8555-555555555555'}]};reseal(foreign);expect(()=>questionnaireAgeRangeEvidence(foreign)).toThrow('AGE_RANGE_DECLARATION_SCOPE');
  const hash=sample();hash.entitlement_declarations!.snapshot_sha256='f'.repeat(64);expect(()=>questionnaireAgeRangeEvidence(hash)).toThrow('ENTITLEMENT_DECLARATION_SNAPSHOT_HASH');
  const period=sample();period.entitlement_declarations!.period={from:'2026-05-01',to:'2026-05-31'};expect(()=>questionnaireAgeRangeEvidence(period)).toThrow('AGE_RANGE_DECLARATION_SCOPE');
 });
 it('rejects stale proof and a forged interval even when the attacker recomputes its outer hash',()=>{
  const input=sample(),proof=questionnaireAgeRangeEvidence(input).proof!;expect(()=>assertQuestionnaireAgeRangeProof(sample(1981),proof)).toThrow('AGE_RANGE_PROOF_REPLAY');
  const changed=structuredClone(proof);changed.age_at_period_start.minimum=21;const {sha256:_,...body}=changed;void _;changed.sha256=canonicalSha256(body);
  expect(()=>assertQuestionnaireAgeRangeProof(input,changed)).toThrow('AGE_RANGE_PROOF_REPLAY');
 });
 it('detects contradiction with a separately admitted date without upgrading boundary evidence',()=>{
  const proof=questionnaireAgeRangeEvidence(sample()).proof!;expect(ageRangeBirthDateConsistency(proof,'1980-12-31')).toBe('consistent');expect(ageRangeBirthDateConsistency(proof,'1981-01-01')).toBe('conflict');
  const result=questionnaireAgeRangeEvidence(sample(2005));expect(ageRangeBirthDateConsistency(result.proof!,'2005-01-01')).toBe('consistent');expect(result.state).toBe('boundary');
  expect(()=>ageRangeBirthDateConsistency(proof,'1980-02-30')).toThrow();
 });
 it('does not extrapolate the release policy to a different period',()=>{const input=sample();input.period={from:'2026-08-01',to:'2026-08-31'};expect(questionnaireAgeRangeEvidence(input).state).toBe('unsupported');});
});
