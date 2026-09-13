import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {JUNE2026_MINIMUM_WAGE_SOURCES} from '../../minimum-wage-june2026/sources.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';

export const MINIMUM_WAGE_SOURCE_REVIEW=deepFreeze({schema_version:'minimum-wage-entitlement-source-review-v1',reviewed_at:'2026-09-12',
 reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,supported_work_period:{from:'2026-05-01',to:'2026-07-31'},
 rate_effective_from:'2026-04-01',monthly_floor_minor:644385,published_hourly_182_minor:3540,
 methods:{published_hourly_182:{version:'1.0.0',calculation:'published_3540_minor_times_identified_ordinary_hours',rounding:'half_up_final_agora'},
  monthly_exact_div182:{version:'1.0.0',calculation:'644385_minor_times_identified_ordinary_hours_divided_by_182',rounding:'half_up_final_agora'},
  full_monthly:{version:'1.0.0',calculation:'644385_minor_for_documented_full_month_full_time',rounding:'exact'}},
 method_selection_required:true,operative_rounding_dispute_resolved:false,
 sources:JUNE2026_MINIMUM_WAGE_SOURCES.map((s,i)=>({document_id:'il.review.minimum-wage.source.'+i,version_id:s.source_version_id,file_sha256:s.artifact_sha256,
  page_count:[5,8,2,1][i],url:s.url,origin:s.origin,role:s.role,locators:s.locators,retained_acquisition_date:'2026-09-09'})),
 restrictions:['adult_general','same_month','ordinary_work_only','eligible_component_inventory_complete','no_inferred_partial_month_proration',
  'published_hourly_not_silently_exact_monthly_division','not_total_employer_debt'],
});
export const MINIMUM_WAGE_SOURCE_REVIEW_SHA256=canonicalSha256(MINIMUM_WAGE_SOURCE_REVIEW);
export const MINIMUM_WAGE_CATALOG=deepFreeze({schema_version:'minimum-wage-entitlement-catalog-v1',catalog_id:'il.review.minimum-wage.may-july-2026',catalog_version:'1.0.0',
 source_review_sha256:MINIMUM_WAGE_SOURCE_REVIEW_SHA256,catalog_boundary:'real_inactive',readiness:'conditional_review_only',interpreter:'executeRuleSpec',
 supported_work_period:MINIMUM_WAGE_SOURCE_REVIEW.supported_work_period,human_attestation:null,real_activation_allowed:false,actual_remittance_proven:false});
export const MINIMUM_WAGE_PINNED_LEGAL_DOCUMENTS=deepFreeze(MINIMUM_WAGE_SOURCE_REVIEW.sources.map(s=>({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'legal_source' as const,case_id:null})));
export function minimumWageLegalSource(index:number,page:number,locator:string):DocumentReviewSource{
 const s=MINIMUM_WAGE_SOURCE_REVIEW.sources[index];if(!s||page<1||page>s.page_count)throw Error('MINIMUM_WAGE_LEGAL_LOCATOR');
 return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page,locator,label:index===3?'שכר מינימום — טבלת הביטוח הלאומי':'מקור שכר מינימום — חוק, צו או הודעה ברשומות',
  reading:'source_research',reading_receipt_sha256:MINIMUM_WAGE_SOURCE_REVIEW_SHA256};
}
export function minimumWageLegalDocuments(caseId:string){return MINIMUM_WAGE_SOURCE_REVIEW.sources.map(s=>({case_id:caseId,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,
 page_count:s.page_count,kind:'other' as const,label:'מקור לשכר מינימום',period:null,reading_origin:'ai_document_review' as const,reading_sha256:MINIMUM_WAGE_SOURCE_REVIEW_SHA256,accepted_reading_sha256:[MINIMUM_WAGE_SOURCE_REVIEW_SHA256]}));}
export function isPinnedMinimumWageLegalDocument(candidate:unknown,caseId:string){return minimumWageLegalDocuments(caseId).some(d=>canonicalSha256(candidate)===canonicalSha256(d));}
