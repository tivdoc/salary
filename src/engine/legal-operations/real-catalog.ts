import type {LegalCatalogSelection,LegalRuleCatalogPort} from '../wave3/contracts.ts';
import {evaluateLegalReadiness,type LegalReadinessCandidate} from '../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts';
import {CORPUS_LIFECYCLE,type CorpusLifecycleEntry} from '../wave23/corpus-trust/lifecycle.ts';
import {frozen} from './canonical.ts';
import {REAL_CATALOG_BOUNDARY,REAL_CATALOG_SHA256} from './real-catalog-fingerprint.ts';

function realCandidate(entry:CorpusLifecycleEntry):LegalReadinessCandidate{
 return frozen({source_id:entry.source_version_id.split('@')[0],source_version_id:entry.source_version_id,topics:[entry.topic],
  parse_succeeded:entry.technical_parse_status==='parsed',citation_verified:false,operative_role_eligible:entry.source_role==='binding_role_candidate',
  human_reviewed:false,effective_interval_verified:false,verified_sectors:[],verified_populations:[],active:false,
  acquisition_status:entry.acquisition_status,technical_parse_status:entry.technical_parse_status,
  instrument_boundary_status:entry.instrument_boundary_status==='resolved'?'resolved':entry.instrument_boundary_status==='unresolved'?'unresolved':'ambiguous',
  publication_status:entry.publication_status,retrieval_visibility:entry.retrieval_visibility,retrieval_surface:entry.retrieval_surface,
  source_role:entry.source_role,monetary_support_eligibility:'ineligible',citation:undefined,review_attestation:undefined,valid_time:undefined,knowledge_time:undefined,
  sector_status:'unverified',population_status:'unverified',activation_status:'inactive',bound_source_version_id:entry.source_version_id});
}

/** Existing REAL selection bytes, isolated from the synthetic fixture catalog.
 * This split grants no source activation or reviewed rule. */
export class RealLegalOperationsCatalog implements LegalRuleCatalogPort{
 async resolve(input:Parameters<LegalRuleCatalogPort['resolve']>[0]):Promise<LegalCatalogSelection>{
  if(input.mode!=='real')throw Error('LEGAL_CATALOG_MODE_FORBIDDEN');
  const topicSources=CORPUS_LIFECYCLE.filter(entry=>entry.topic===input.topic),candidates=topicSources.map(realCandidate);
  const readiness=evaluateLegalReadiness({readinessCase:frozen({case_id:`REAL_CATALOG_${input.topic.toUpperCase()}`,topic:input.topic,kind:'current',
   target_date:input.target_date,as_of:input.as_of,sector:input.sector,population:input.population,contract_version:'v0.5.0',use_case:'monetary_rule'}),candidates});
  if(readiness.status==='READY')throw Error('REAL_CATALOG_UNEXPECTED_READY');
  return frozen({catalog_id:REAL_CATALOG_BOUNDARY.catalog_id,catalog_version:REAL_CATALOG_BOUNDARY.catalog_version,catalog_sha256:REAL_CATALOG_SHA256,
   mode:'real',topic:input.topic,source_version_ids:topicSources.map(entry=>entry.source_version_id),parameter_version_ids:[],rule_spec_id:null,rule_spec_version:null,readiness});
 }
}
