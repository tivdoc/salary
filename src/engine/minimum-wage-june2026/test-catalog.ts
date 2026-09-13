import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import type {LegalCatalogSelection,LegalRuleCatalogPort} from '../wave3/contracts.ts';
import {createJune2026MinimumWageCandidate} from './candidate.ts';
import {june2026TestAssessmentSchema,type June2026TestAssessment} from './evidence-admission.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY,JUNE2026_MINIMUM_WAGE_POLICY_SHA256,JUNE2026_SOURCE_SET_SHA256} from './sources.ts';

export const JUNE2026_TEST_READINESS='june2026-isolated-engineering-readiness-v1';
const inputSchema=z.object({assessment:june2026TestAssessmentSchema,mode:z.enum(['real','synthetic_test']),
 topic:z.literal('minimum_wage'),target_date:z.iso.date(),as_of:z.iso.date(),sector:z.string(),population:z.string()}).strict();
/** Explicit test readiness, not a synthetic human signature or an active rule.
 * The caller separately authenticates the DEV registry. Replaying this record
 * proves its calculation policy; it never authenticates a client-supplied grant. */
export function evaluateJune2026TestReadiness(value:unknown){
 const input=inputSchema.parse(value),a=input.assessment,c=createJune2026MinimumWageCandidate(1);
 const reasons:string[]=[];
 if(input.mode!=='synthetic_test')reasons.push('TEST_AUTHORITY_FORBIDDEN_FOR_REAL_SERVICE');
 if(input.target_date!=='2026-06-30'||input.sector!==JUNE2026_MINIMUM_WAGE_POLICY.sector
  ||input.population!==JUNE2026_MINIMUM_WAGE_POLICY.population)reasons.push('TEST_SCOPE_MISMATCH');
 if(a.rule_sha256!==c.rule.content_sha256||a.golden_cases_sha256!==c.goldenCases.content_sha256
  ||a.policy_sha256!==JUNE2026_MINIMUM_WAGE_POLICY_SHA256)reasons.push('TEST_VERSION_MISMATCH');
 if(input.as_of<'2026-09-09')reasons.push('TEST_SOURCE_NOT_YET_AVAILABLE');
 const seed={schema_version:JUNE2026_TEST_READINESS,decision_source:'evaluateJune2026TestReadiness' as const,
  normalized_input:input,normalized_input_sha256:canonicalSha256(input),
  status:reasons.length?'BLOCKED_NOT_READY' as const:'READY' as const,reason_codes:reasons,
  usable_for_rules:reasons.length===0,operative_candidate_source_version_ids:c.rule.source_version_ids,
  test_only_synthetic:true,human_approval:false,legal_activation:false,source_set_sha256:JUNE2026_SOURCE_SET_SHA256,
  rule_sha256:c.rule.content_sha256,parameters_sha256:canonicalSha256(c.parameters),
  calculation_method:'monthly_644385_minor_times_regular_hours_over_182_final_half_up@1.0.0'};
 return deepFreeze({...seed,decision_sha256:canonicalSha256(seed)});
}
export function decodeJune2026TestReadiness(value:unknown){
 const row=z.object({normalized_input:z.unknown()}).passthrough().parse(value);
 const replay=evaluateJune2026TestReadiness(row.normalized_input);
 if(canonicalSha256(replay)!==canonicalSha256(value))throw Error('TEST_READINESS_HASH_MISMATCH');
 return replay;
}
export class June2026IsolatedTestCatalog implements LegalRuleCatalogPort{
 constructor(private readonly assessment:June2026TestAssessment){}
 async resolve(input:Parameters<LegalRuleCatalogPort['resolve']>[0]):Promise<LegalCatalogSelection>{
  const a=june2026TestAssessmentSchema.parse(this.assessment),c=createJune2026MinimumWageCandidate(1);
  const readiness=evaluateJune2026TestReadiness({...input,assessment:a});
  return deepFreeze({catalog_id:'tivdoc.june2026.isolated-test',catalog_version:'1.0.0',
   catalog_sha256:canonicalSha256({assessment:a,rule:c.rule,parameters:c.parameters,source_set_sha256:JUNE2026_SOURCE_SET_SHA256}),
   mode:input.mode,topic:input.topic,source_version_ids:c.rule.source_version_ids,
   parameter_version_ids:c.parameters.map(p=>`${p.parameter_id}@${p.parameter_version}`),
   rule_spec_id:c.rule.rule_spec_id,rule_spec_version:c.rule.rule_spec_version,readiness});
 }
}
