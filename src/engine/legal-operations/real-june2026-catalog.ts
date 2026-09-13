import type {LegalCatalogSelection,LegalRuleCatalogPort} from '../wave3/contracts.ts';
import {evaluateLegalReadiness} from '../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts';
import {june2026MinimumWageSourceCandidates,JUNE2026_SOURCE_VERSION_IDS} from '../minimum-wage-june2026/admission.ts';
import {RealLegalOperationsCatalog} from './real-catalog.ts';
import {frozen} from './canonical.ts';
import {JUNE2026_REVIEW_CATALOG_SHA256} from './june2026-catalog-fingerprint.ts';

/** Same REAL June selection as the historical mixed wrapper. Rejects synthetic
 * mode and never imports its fixtures. Fingerprints and source bytes are shared. */
export class RealJune2026ReviewCatalog implements LegalRuleCatalogPort{
 readonly #fallback=new RealLegalOperationsCatalog();
 async resolve(input:Parameters<LegalRuleCatalogPort['resolve']>[0]):Promise<LegalCatalogSelection>{
  if(input.mode!=='real')throw Error('LEGAL_CATALOG_MODE_FORBIDDEN');
  const legacy=await this.#fallback.resolve(input);
  if(input.target_date<'2026-06-01'||input.target_date>'2026-06-30'||input.as_of<'2026-09-09')return legacy;
  const catalog={catalog_id:'tivdoc.real.june2026.review-candidate',catalog_version:'1.0.0',catalog_sha256:JUNE2026_REVIEW_CATALOG_SHA256};
  if(input.topic!=='minimum_wage')return frozen({...legacy,...catalog});
  const readiness=evaluateLegalReadiness({readinessCase:{case_id:'REAL_CATALOG_MINIMUM_WAGE_JUNE2026',topic:input.topic,kind:'historical',
   target_date:input.target_date,as_of:input.as_of,sector:input.sector,population:input.population,contract_version:'v0.5.0',use_case:'monetary_rule'},
   candidates:june2026MinimumWageSourceCandidates()});
  if(readiness.status==='READY'||readiness.usable_for_rules)throw Error('UNSIGNED_JUNE2026_CATALOG_UNEXPECTED_READY');
  return frozen({...catalog,mode:'real',topic:input.topic,source_version_ids:JUNE2026_SOURCE_VERSION_IDS,
   parameter_version_ids:[],rule_spec_id:null,rule_spec_version:null,readiness});
 }
}
