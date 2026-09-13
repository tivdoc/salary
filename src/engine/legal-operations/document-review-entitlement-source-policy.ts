import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';

/** A conditional review catalog, never a legal-authority/ready-catalog entry. */
export const NIGHT_ENTITLEMENT_SOURCE_REVIEW=deepFreeze({
 schema_version:'night-entitlement-source-review-v1',reviewed_at:'2026-09-11',
 reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,
 source_version_id:'IL_HOURS_WORK_REST_LAW@discovery-v0',
 artifact_sha256:'ca770f73436663094f546e53bed93aeca867bbed7124991fecfa1a8d750fdcd9',
 artifact_url:'https://fs.knesset.gov.il/1/law/1_lsr_209133.PDF',page_count:6,
 sections:{night_definition:{page:1,section:'1',minimum_minutes:120,start_hour:22,end_hour:6},
  night_daily_threshold:{page:1,section:'2(b)',hours:7},
  first_overtime_band:{page:4,section:'16(a)',hours:2,rate_numerator:5,rate_denominator:4},
  later_overtime_band:{page:4,section:'16(a)',rate_numerator:3,rate_denominator:2},
  regular_wage:{page:4,section:'18'},break_classification:{page:4,section:'20(c)'}},
 // This is the bounded period researched for this candidate, not a new law's effective date.
 supported_work_period:{from:'2026-05-01',to:'2026-07-31'},
 original_publication_only:true,consolidated_text_claim:false,
 amendment_evidence:'src/server/engine/legal-knowledge/hours-law-section-amendment-index.v1.json',
 qualifications:['actual_work_not_presence','same_workday','section_30_coverage','section_4_or_5_variation',
  'ordinary_day_not_weekly_rest','regular_wage_components','weekly_daily_overlap','payroll_allocation','explicit_rounding'],
});
export const NIGHT_ENTITLEMENT_SOURCE_REVIEW_SHA256=canonicalSha256(NIGHT_ENTITLEMENT_SOURCE_REVIEW);
export const NIGHT_ENTITLEMENT_CATALOG=deepFreeze({
 schema_version:'document-review-entitlement-catalog-v1',catalog_id:'il.review.night-work',catalog_version:'1.0.0',
 rule_spec_id:'il.review.rulespec.night-work.required-versus-allocated',rule_spec_version:'1.0.0',
 topic:'working_time',catalog_boundary:'real_inactive',readiness:'conditional_review_only',
 source_review_sha256:NIGHT_ENTITLEMENT_SOURCE_REVIEW_SHA256,
 interpreter:'executeRuleSpec',human_attestation:null,real_activation_allowed:false,
 supported_work_period:NIGHT_ENTITLEMENT_SOURCE_REVIEW.supported_work_period,
 rounding:'half_up_per_day_total_candidate',actual_remittance_proven:false,
});
export function nightEntitlementLegalSource(page:1|4,locator:string):DocumentReviewSource{
 return {document_id:'il.hours-work-rest-law.1951',version_id:NIGHT_ENTITLEMENT_SOURCE_REVIEW.source_version_id,
  file_sha256:NIGHT_ENTITLEMENT_SOURCE_REVIEW.artifact_sha256,page,locator,
  label:'חוק שעות עבודה ומנוחה — נוסח הפרסום הרשמי והוראות החישוב',reading:'source_research',
  reading_receipt_sha256:NIGHT_ENTITLEMENT_SOURCE_REVIEW_SHA256};
}
export const NIGHT_ENTITLEMENT_LEGAL_MANIFEST={document_id:'il.hours-work-rest-law.1951',
 version_id:NIGHT_ENTITLEMENT_SOURCE_REVIEW.source_version_id,file_sha256:NIGHT_ENTITLEMENT_SOURCE_REVIEW.artifact_sha256,
 page_count:6,kind:'legal_source' as const,case_id:null};
