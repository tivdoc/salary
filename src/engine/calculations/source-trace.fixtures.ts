import {employmentSnapshotSchema,type EmploymentSnapshot} from '../facts/snapshot.ts';
import {createSourceCalculationTrace} from './source-trace.ts';
import {buildSyntheticLegalFixture} from '../legal-operations/synthetic-fixtures.ts';
import {createRuleSpecPackage} from '../legal-operations/rulespec.ts';
import {legalOperationsSha256} from '../legal-operations/canonical.ts';
import {parameterCandidateSchema} from '../legal-operations/contracts.ts';

/** Arithmetic fixture only. The rule adds one synthetic minor unit; it has no
 * legal entitlement, readiness, active catalog or genuine golden approval. */
export function sourceTraceFixture(provided?:EmploymentSnapshot,analysisRunId?:string){
 const facts=provided??employmentSnapshotSchema.parse({snapshot_id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',analysis_run_id:'33333333-3333-4333-8333-333333333333',schema_version:'1.0.0',created_at:'2040-01-01T00:00:00Z',facts:[{
  fact_id:'44444444-4444-4444-8444-444444444444',case_id:'22222222-2222-4222-8222-222222222222',path:'compensation.base_monthly_salary',value:{currency:'XTS',minor_units:500},status:'confirmed',confidence:1,conflicting_fact_ids:[],resolution:null,created_at:'2040-01-01T00:00:00Z',provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'55555555-5555-4555-8555-555555555555'}}],
 }]});
 const fact=facts.facts.find(f=>f.path==='compensation.base_monthly_salary');if(!fact?.value)throw Error('SYNTHETIC_MONEY_FACT_MISSING');
 const fixture=buildSyntheticLegalFixture('minimum_wage');
 const {content_sha256:_oldHash,...draft}=fixture.rule;void _oldHash;
 const rule=createRuleSpecPackage({...draft,facts:[{ref_id:'fact.salary',value_kind:'money',unit:'currency.'+fact.value.currency.toLowerCase()}],parameters:[{...fixture.rule.parameters[0],unit:'currency.'+fact.value.currency.toLowerCase()}],nodes:[{node_id:'result.amount',operation:'add',refs:['fact.salary','parameter.amount']}],output_ref:'result.amount'});
 const {candidate_sha256:_oldCandidate,...parameterSeed}=fixture.parameter;void _oldCandidate;
 const seed={...parameterSeed,value:{kind:'money' as const,value:{currency:fact.value.currency,minor_units:1}},unit:'currency.'+fact.value.currency.toLowerCase(),bindings:{...parameterSeed.bindings,rule_spec_sha256:rule.content_sha256}};
 const parameter=parameterCandidateSchema.parse({...seed,candidate_sha256:legalOperationsSha256(seed)});
 const input={calculationId:'66666666-6666-4666-8666-666666666666',caseId:facts.case_id,analysisRunId:analysisRunId??facts.analysis_run_id,calculatedAt:facts.created_at,catalogSha256:'a'.repeat(64),facts,rule,parameters:[parameter],bindings:[{input_id:'fact.salary',source:{kind:'fact' as const,fact_id:fact.fact_id,value_path:[]}},{input_id:'parameter.amount',source:{kind:'parameter' as const,parameter_id:parameter.parameter_id,parameter_version:parameter.parameter_version}}]};
 return {input,trace:createSourceCalculationTrace(input)};
}
