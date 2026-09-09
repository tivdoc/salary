import type {LegalCatalogSelection,LegalRuleCatalogPort} from '../wave3/contracts.ts';
import {evaluateLegalReadiness} from '../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts';
import {june2026MinimumWageSourceCandidates,JUNE2026_SOURCE_VERSION_IDS} from '../minimum-wage-june2026/admission.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256,JUNE2026_SOURCE_SET_SHA256} from '../minimum-wage-june2026/sources.ts';
import {LegalOperationsCatalog,REAL_CATALOG_SHA256} from './catalog.ts';
import {frozen,legalOperationsSha256} from './canonical.ts';

/** A pinned review catalog, never an activation override. Only June2026 real
 * analyses gain the newly acquired sources. Existing historical selections are
 * immutable; all topics in one analysis retain a common catalog fingerprint. */
export const JUNE2026_REVIEW_CATALOG_SHA256=legalOperationsSha256({
 catalog:'tivdoc.real.june2026.review-candidate',version:'1.0.0',
 inherited_catalog_sha256:REAL_CATALOG_SHA256,source_set_sha256:JUNE2026_SOURCE_SET_SHA256,
 policy_sha256:JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
 review_diagnostic_version:'saved-june2026-review-v3-authenticated-factual-context',
});
export class June2026ReviewCatalog implements LegalRuleCatalogPort {
 readonly #fallback=new LegalOperationsCatalog();
 async resolve(input:Parameters<LegalRuleCatalogPort['resolve']>[0]):Promise<LegalCatalogSelection>{
  const legacy=await this.#fallback.resolve(input);
  if(input.mode!=='real'||input.target_date<'2026-06-01'||input.target_date>'2026-06-30'||input.as_of<'2026-09-09')return legacy;
  const catalog={catalog_id:'tivdoc.real.june2026.review-candidate',catalog_version:'1.0.0',catalog_sha256:JUNE2026_REVIEW_CATALOG_SHA256};
  if(input.topic!=='minimum_wage')return frozen({...legacy,...catalog});
  const readiness=evaluateLegalReadiness({readinessCase:{
   case_id:'REAL_CATALOG_MINIMUM_WAGE_JUNE2026',topic:input.topic,kind:'historical',
   target_date:input.target_date,as_of:input.as_of,sector:input.sector,population:input.population,
   contract_version:'v0.5.0',use_case:'monetary_rule',
  },candidates:june2026MinimumWageSourceCandidates()});
  if(readiness.status==='READY'||readiness.usable_for_rules)throw Error('UNSIGNED_JUNE2026_CATALOG_UNEXPECTED_READY');
  return frozen({...catalog,mode:'real',topic:input.topic,source_version_ids:JUNE2026_SOURCE_VERSION_IDS,
   parameter_version_ids:[],rule_spec_id:null,rule_spec_version:null,readiness});
 }
}
