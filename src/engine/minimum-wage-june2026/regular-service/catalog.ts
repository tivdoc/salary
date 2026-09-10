import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {evaluateLegalReadiness,type LegalReadinessCandidate} from '../../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts';
import type {LegalRuleCatalogPort,LegalCatalogSelection} from '../../wave3/contracts.ts';
import {createJune2026MinimumWageCandidate} from '../candidate.ts';
import {JUNE2026_MINIMUM_WAGE_SOURCES} from '../sources.ts';
import {assertJune2026RegularAuthority,type June2026RegularAuthority} from './authority.ts';

/** Both environments use the ordinary readiness evaluator after signature and
 * lifecycle verification. Namespace separation is an authority requirement,
 * never a fixture-specific shortcut in the evaluator or RuleSpec. */
export class June2026RegularCatalog implements LegalRuleCatalogPort{
 constructor(private readonly authority:June2026RegularAuthority){assertJune2026RegularAuthority(authority);}
 async resolve(input:Parameters<LegalRuleCatalogPort['resolve']>[0]):Promise<LegalCatalogSelection>{
  const a=this.authority;assertJune2026RegularAuthority(a);
  if(input.mode!==a.mode||input.topic!=='minimum_wage'||input.target_date!=='2026-06-30'
   ||input.sector!=='general_private'||input.population!=='adult_general'||input.as_of<a.legal_available_from
   ||input.as_of<a.assessment.issued_at.slice(0,10))throw Error('JUNE_REGULAR_CATALOG_SCOPE');
  const candidates:LegalReadinessCandidate[]=JUNE2026_MINIMUM_WAGE_SOURCES.filter(s=>s.role==='primary_binding').map(s=>({
   source_id:s.source_id,source_version_id:s.source_version_id,topics:['minimum_wage'],parse_succeeded:true,citation_verified:true,
   operative_role_eligible:true,human_reviewed:true,effective_interval_verified:true,verified_sectors:['general_private'],verified_populations:['adult_general'],
   active:true,acquisition_status:'available',technical_parse_status:'parsed',instrument_boundary_status:'resolved',publication_status:'review_candidate',
   retrieval_visibility:'visible',retrieval_surface:'canonical_review',source_role:'binding_role_candidate',monetary_support_eligibility:'eligible',
   citation:{citation_id:`${s.source_id}.june2026.pinned.locators`,verified:true,source_version_id:s.source_version_id},
   review_attestation:{attestation_id:a.authority_sha256,status:'reviewed',source_version_id:s.source_version_id,reviewed_at:a.legal_available_from},
   valid_time:{from:'2026-06-01',to:'2026-06-30',verified:true},knowledge_time:{available_from:a.legal_available_from,unavailable_from:null},
   sector_status:'verified',population_status:'verified',activation_status:'active',bound_source_version_id:s.source_version_id,
  }));
  const readiness=evaluateLegalReadiness({readinessCase:{case_id:a.assessment.case_id,topic:input.topic,kind:a.mode==='real'?'historical':'synthetic',
   target_date:input.target_date,as_of:input.as_of,sector:input.sector,population:input.population,contract_version:'v0.5.0',use_case:'monetary_rule'},candidates});
  const c=createJune2026MinimumWageCandidate(1),ready=readiness.status==='READY'&&readiness.usable_for_rules;
  return deepFreeze({catalog_id:`tivdoc.june2026.regular.${a.registry.namespace}`,catalog_version:'1.0.0',
   catalog_sha256:canonicalSha256({authority_sha256:a.authority_sha256,rule:c.rule,parameters:c.parameters}),mode:input.mode,topic:input.topic,
   source_version_ids:c.rule.source_version_ids,parameter_version_ids:ready?c.parameters.map(p=>`${p.parameter_id}@${p.parameter_version}`):[],
   rule_spec_id:ready?c.rule.rule_spec_id:null,rule_spec_version:ready?c.rule.rule_spec_version:null,readiness});
 }
}
