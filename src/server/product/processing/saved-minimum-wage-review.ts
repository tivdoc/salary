import type {CaseAnalysisServiceDependencies} from '@/engine/case-analysis/service';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {JUNE2026_APPLICABILITY_REQUESTS} from '@/engine/minimum-wage-june2026/evidence';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256,JUNE2026_SOURCE_SET_SHA256} from '@/engine/minimum-wage-june2026/sources';
import {JUNE2026_SOURCE_VERSION_IDS} from '@/engine/minimum-wage-june2026/admission';

export const SAVED_JUNE_REVIEW_VERSION='saved-june2026-review-v1';
/** Saved under review_pending by CaseAnalysisService in the current source's
 * existing transaction. This keeps the concrete missing input and row sources
 * with that run, without inventing confirmations from generic questionnaire
 * text or the model's semantic labels. It creates no customer requests yet. */
export const buildSavedJune2026ReviewDiagnostic:NonNullable<CaseAnalysisServiceDependencies['reviewDiagnostics']>=({command,stored,facts,bundle})=>{
 if(command.mode!=='real'||command.period.start_date!=='2026-06-01'||command.period.end_date!=='2026-06-30'||!command.requested_topics.includes('minimum_wage'))return null;
 if(facts.case_id!==command.case_id||facts.analysis_run_id!==bundle.analysis_run_id||canonicalSha256(facts)!==bundle.facts_snapshot_sha256)throw Error('SAVED_JUNE_REVIEW_SNAPSHOT_MISMATCH');
 const documents=stored.documents.map(document=>{
  const extraction=stored.extractions.find(value=>value.document_id===document.document_id);
  if(document.case_id!==command.case_id||!extraction)throw Error('SAVED_JUNE_REVIEW_DOCUMENT_MISMATCH');
  // Saved canonical document IDs are the immutable product version UUIDs.
  // Do not fabricate a numeric version or treat gross as eligible earnings.
  return {version_id:document.document_id,source_sha256:document.content_sha256,
   extraction_id:extraction.extraction_id,extraction_sha256:canonicalSha256(extraction),
   provider_claimed_earnings_complete:extraction.earnings_components_complete,
   earnings_completeness_confirmed:false,
   components:extraction.additional_components.map(component=>({component_id:component.component_id,
    source_label:component.source_label,observed_semantic:component.semantic_kind,
    documented_amount:component.amount,source:component.source,
    classification_status:'missing',classification:null,
   })),
  };
 });
 const minimum=bundle.topic_results.find(result=>result.topic==='minimum_wage');
 return deepFreeze({schema_version:SAVED_JUNE_REVIEW_VERSION,case_id:command.case_id,analysis_run_id:bundle.analysis_run_id,
  period:command.period,input_snapshot_sha256:{documents:bundle.document_snapshot_sha256,extraction:bundle.extraction_snapshot_sha256,declared:bundle.declared_fact_snapshot_sha256,facts:bundle.facts_snapshot_sha256},
  policy_sha256:JUNE2026_MINIMUM_WAGE_POLICY_SHA256,source_set_sha256:JUNE2026_SOURCE_SET_SHA256,source_version_ids:JUNE2026_SOURCE_VERSION_IDS,
  documents,unresolved_fact_inputs:facts.facts.filter(f=>['work.regular_hours','compensation.salary_type','compensation.base_monthly_salary','compensation.gross_salary','documents.period'].includes(f.path)&&f.status!=='confirmed').map(f=>({fact_id:f.fact_id,path:f.path,status:f.status,provenance:f.provenance})),
  required_applicability_assessments:Object.entries(JUNE2026_APPLICABILITY_REQUESTS).map(([field,prompt])=>({field,prompt,status:'missing',value:null})),
  required_component_assessments:documents.flatMap(document=>document.components.map(component=>({version_id:document.version_id,component_id:component.component_id,field:'classification',status:'missing'}))),
  blockers:{technical:['typed_applicability_and_component_answer_transport_not_connected','canonical_component_fact_and_executor_admission_not_connected'],
   evidence:['employee_scope_and_component_substance_unconfirmed','operative_rounding_policy_unresolved','notice_original_origin_authenticity_unattested'],
   policy:minimum?.legal_readiness?.reason_codes??['canonical_legal_readiness_missing']},
  candidate_calculation_performed:false,findings_created:false,customer_requests_created:false,activation_allowed:false,
 });
};
