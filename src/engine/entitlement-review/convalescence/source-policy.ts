import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';

export const CONVALESCENCE_SOURCE_REVIEW=deepFreeze({schema_version:'convalescence-entitlement-source-review-v1',reviewed_at:'2026-09-12',
 reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,
 supported_payroll_period:{from:'2026-05-01',to:'2026-07-31'},knowledge_available_from:'2026-08-18',benefit_year:2026,
 daily_rate_minor:45150,automatic_july_june_year:false,automatic_2026_day_reduction:false,
 methods:{seniority:'employment_anniversary_bands_2016',proration:'explicitly_assessed_calendar_days_within_each_employment_year',
  fte:'source_bound_constant_fte_segments',rounding:'half_up_final_agora_after_all_segments'},
 bands:[{from:1,to:2,days:5},{from:2,to:4,days:6},{from:4,to:11,days:7},{from:11,to:16,days:8},{from:16,to:20,days:9},{from:20,to:null,days:10}],
 sources:[
  {document_id:'il.review.convalescence.2016',version_id:'IL_CONVALESCENCE_ORDER_2016@yp7417-ai-review-20260912',file_sha256:'948c9293772da0b38b6156d73602cb9b2abebd12f2c7465c68a2201c953a5768',page_count:16,
   url:'https://olaw.org.il/yalkut/yalkut-7417.pdf',origin:'third_party_copy_of_primary_gazette',published_at:'2017-01-08',page:4,
   locator:'YP7417 p1434: applicability, sections4,5(a-d),6; 2016 rate378 is not used'},
  {document_id:'il.review.convalescence.2026',version_id:'IL_CONVALESCENCE_ORDER_2026@yp14863-ai-review-20260912',file_sha256:'a6e530b57ffd0f66c27e8f7947d242e73b9baf44ab62e19dfbc9879a8a63dcde',page_count:8,
   url:'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/order14863/he/workers-rights_order14863.pdf',origin:'retained_official_primary_gazette',published_at:'2026-08-18',page:2,
   locator:'YP14863 p9132: applicability; supplement3 year2026 rate451.50, supplement4 May2026 index'},
  {document_id:'il.review.convalescence.freeze2025',version_id:'IL_CONVALESCENCE_FREEZE_2025@sh3384-ai-review-20260912',file_sha256:'eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa',page_count:40,
   url:'https://fs.knesset.gov.il/25/law/25_lsr_6133485.pdf',origin:'official_primary_gazette_acquired_20260912',published_at:'2025-03-27',page:20,
   locator:'SH3384 p404: section2(b) update obligation2026; section3 reduction payments2025'},
 ],
 restrictions:['explicit_2026_benefit_year_interpretation','later_publication_knowledge_visible','no_monthly_payment_absence_as_zero',
  'continuous_qualifying_service_only','first_year_completed_by_sourced_due_date','source_bound_payment_coverage',
  'public_pegged_protected_and_better_arrangements_require_other_rule','no_unpaid_absence_clock_assumption','no_total_debt_claim'],
 source_chain_is_not_human_attested:true,calendar_proration_is_candidate_interpretation:true,
});
export const CONVALESCENCE_SOURCE_REVIEW_SHA256=canonicalSha256(CONVALESCENCE_SOURCE_REVIEW);
export const CONVALESCENCE_CATALOG=deepFreeze({schema_version:'convalescence-entitlement-catalog-v1',catalog_id:'il.review.convalescence.general-2026',catalog_version:'1.0.0',
 source_review_sha256:CONVALESCENCE_SOURCE_REVIEW_SHA256,catalog_boundary:'real_inactive',readiness:'conditional_review_only',interpreter:'executeRuleSpec',
 supported_work_period:CONVALESCENCE_SOURCE_REVIEW.supported_payroll_period,human_attestation:null,real_activation_allowed:false});
export const CONVALESCENCE_PINNED_LEGAL_DOCUMENTS=deepFreeze(CONVALESCENCE_SOURCE_REVIEW.sources.map(s=>({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'legal_source' as const,case_id:null})));
export function convalescenceLegalSource(index:number,locator?:string):DocumentReviewSource{
 const s=CONVALESCENCE_SOURCE_REVIEW.sources[index];if(!s)throw Error('CONVALESCENCE_LEGAL_LOCATOR');
 return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page:s.page,locator:locator??s.locator,
  label:index===0?'צו הבראה — מכסת ימים, ותק וחלקיות':index===1?'צו הבראה לשנת 2026 — פורסם באוגוסט 2026':'חוק הקפאה והפחתה 2025 — גבול התחולה לשנת 2026',
  reading:'source_research',reading_receipt_sha256:CONVALESCENCE_SOURCE_REVIEW_SHA256};
}
export function isPinnedConvalescenceLegalSource(s:DocumentReviewSource){return s.reading==='source_research'&&s.reading_receipt_sha256===CONVALESCENCE_SOURCE_REVIEW_SHA256&&CONVALESCENCE_SOURCE_REVIEW.sources.some(d=>d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&d.page===s.page);}
export function convalescenceLegalDocuments(caseId:string){return CONVALESCENCE_SOURCE_REVIEW.sources.map((s,i)=>({case_id:caseId,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,
 page_count:s.page_count,kind:'other' as const,label:convalescenceLegalSource(i).label,period:null,reading_origin:'ai_document_review' as const,
 reading_sha256:CONVALESCENCE_SOURCE_REVIEW_SHA256,accepted_reading_sha256:[CONVALESCENCE_SOURCE_REVIEW_SHA256]}));}
export function isPinnedConvalescenceLegalDocument(candidate:unknown,caseId:string){return convalescenceLegalDocuments(caseId).some(d=>canonicalSha256(candidate)===canonicalSha256(d));}
