import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';

export const VACATION_SOURCES=deepFreeze({
 law:{document_id:'il.annual-vacation.law',version_id:'IL_ANNUAL_VACATION_LAW@review-20260912',
  file_sha256:'280b2d6c2e4fba81b02263a78cf4fc6ff6c0b22e05218228bea643b32ae0d791',page_count:6,
  url:'https://www.btl.gov.il/Laws1/02_0082_000000.pdf'},
 amendment15:{document_id:'il.annual-vacation.amendment15',version_id:'IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@review-20260912',
  file_sha256:'ed2b522eec191c2a6d4b86967936762d4ce43598fd055c15fce98af6191ddeeb',page_count:2,
  url:'https://fs.knesset.gov.il/20/law/20_lsr_321785.pdf'},
});
export const VACATION_SOURCE_REVIEW=deepFreeze({schema_version:'vacation-general-source-review-v1',reviewed_at:'2026-09-12',
 reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,sources:VACATION_SOURCES,
 supported_period:{from:'2026-05-01',to:'2026-07-31'},population:'general_private_adult_21_59_conditionally_assessed',
 source_boundary:{law_copy_last_listed_amendment:2013,amendment15_effective:'2017-01-01',
  amendment17_2026_full_promulgation_not_acquired:true,choice_day_calendar_assessed:false},
 rules:{gross_days_years_1_to_5:16,year6:18,year7:21,annual_increment_from_year8:1,cap:28,
  full_year_workday_threshold:200,part_year_workday_threshold:240,final_annual_rounding:'floor_whole_calendar_day',
  hourly_leave_pay_denominator:90,monthly_leave_pay:'identified_wage_for_same_leave_period'},
 exclusions:['automatic_net_5_or_6_day_conversion','monthly_accrual_by_dividing_annual_quota_by_12',
  'termination_redemption','section4_temporary_worker','special_sector_or_better_arrangement_unresolved',
  'emergency_or_reservist_special_provisions_unresolved','automatic_quarter_selection'],
 payroll_balance_is_annual_entitlement:false,monetary_rounding_candidate:'half_up_once_at_period_total',
});
export const VACATION_SOURCE_REVIEW_SHA256=canonicalSha256(VACATION_SOURCE_REVIEW);
export const VACATION_LEGAL_MANIFEST=Object.values(VACATION_SOURCES).map(({url:_url,...pin})=>{void _url;return {...pin,kind:'legal_source' as const,case_id:null};});
export const VACATION_CATALOG=deepFreeze({catalog_id:'il.review.vacation.general.2026',catalog_version:'1.0.0',topic:'vacation',
 rule_version:'1.0.0',catalog_boundary:'real_inactive',readiness:'conditional_review_only',interpreter:'executeRuleSpec',
 source_review_sha256:VACATION_SOURCE_REVIEW_SHA256,human_attestation:null,real_activation_allowed:false,
 supported_period:VACATION_SOURCE_REVIEW.supported_period});
export function vacationLegalSource(key:keyof typeof VACATION_SOURCES,page:number,locator:string):DocumentReviewSource{
 const s=VACATION_SOURCES[key];if(page<1||page>s.page_count)throw Error('VACATION_LEGAL_PAGE');
 return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page,locator,
  label:key==='amendment15'?'תיקון 15 לחוק חופשה שנתית — רשומות':'חוק חופשה שנתית — סעיפים שנבדקו עם תיקון 15',
  reading:'source_research',reading_receipt_sha256:VACATION_SOURCE_REVIEW_SHA256};
}
export function isPinnedVacationLegalSource(s:DocumentReviewSource):boolean{
 return Object.values(VACATION_SOURCES).some(p=>p.document_id===s.document_id&&p.version_id===s.version_id&&p.file_sha256===s.file_sha256
  &&s.page>=1&&s.page<=p.page_count&&s.reading==='source_research'&&s.reading_receipt_sha256===VACATION_SOURCE_REVIEW_SHA256);
}
