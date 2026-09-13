import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';

export const WORKING_TIME_SOURCE_REVIEW=deepFreeze({schema_version:'working-time-source-review-v1',reviewed_at:'2026-09-12',
 reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,
 supported_work_period:{from:'2026-05-01',to:'2026-07-31'},
 sources:[
  {key:'law',document_id:'il.hours-work-rest-law.1951',version_id:'IL_HOURS_WORK_REST_LAW@discovery-v0',
   file_sha256:'ca770f73436663094f546e53bed93aeca867bbed7124991fecfa1a8d750fdcd9',page_count:6,
   url:'https://fs.knesset.gov.il/1/law/1_lsr_209133.PDF',label:'חוק שעות עבודה ומנוחה — הפרסום הרשמי',acquisition:'official_original_publication'},
  {key:'week',document_id:'il.short-work-week.2018',version_id:'IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1',
   file_sha256:'fa27b689656194ef65d207fd6f68ec7c54c2c78d4362b2a5a2a5d3a207831a4b',page_count:2,
   url:'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extention-order-short-week-2018/he/extention-order-short-week-2018.pdf',label:'צו הרחבה לקיצור שבוע העבודה — 2018',acquisition:'retained_official_publication_current_endpoint_403'},
  {key:'rest',document_id:'il.ilan-38313-03-18.2020',version_id:'IL_ILAN_38313_03_18@third-party-copy-v1',
   file_sha256:'5ef51ac55e012ccee582c2ffdcb0eb2489436bf747ec9cee59fdbf549f4a5b2d',page_count:51,
   url:'https://jshnitman.co.il/wp-content/uploads/2025/04/%D0%90%D0%BB%D0%B5%D0%BA%D1%81%D0%B0%D0%BD%D0%B4%D1%80.pdf',label:'פסק דין איל״ן — עותק פסק הדין, סעיף 50',acquisition:'third_party_judgment_copy_not_court_authenticated'},
  {key:'weekly_judgment',document_id:'il.sami-188-06.2010',version_id:'IL_SAMI_188_06@third-party-copy-v1',
   file_sha256:'8c4723675f4da6479ac0d69135083c3f80fafb523bc591b4ea8f3de668d0c28e',page_count:33,
   url:'https://img1.wsimg.com/blobby/go/b8e07f27-2ee4-40df-9e9a-8a2c26157fd7/%D7%A7%D7%9C%20%D7%91%D7%A0%D7%99%D7%9F%20-%20%D7%A1%D7%9E%D7%99%20%D7%91%D7%95%D7%92_%D7%95%20-%20%D7%90%D7%A8%D7%A6%D7%99%20(4).pdf',
   label:'פסק דין בוג׳ו — עותק פסק הדין, סעיף 35',acquisition:'third_party_judgment_copy_not_court_authenticated'},
 ],
 interpretation_dependencies:['section_30_and_special_arrangements','source_daily_limit_not_42_divided_by_days',
  'workday_assignment_not_automatic_short_break_merge','weekly_prefix_excludes_daily_overtime_and_union_first_two_per_workday',
  'rest_additive_statutory_premium_not_contractual_night_wage','source_payment_allocation','half_up_per_day_and_per_allocated_rate_group'],
 original_publication_only:true,consolidated_text_claim:false,
 amendment_index:'src/server/engine/legal-knowledge/hours-law-section-amendment-index.v1.json',
});
export const WORKING_TIME_SOURCE_REVIEW_SHA256=canonicalSha256(WORKING_TIME_SOURCE_REVIEW);
export const WORKING_TIME_CATALOG=deepFreeze({schema_version:'working-time-candidate-catalog-v1',catalog_id:'il.review.working-time.week-and-rest',
 catalog_version:'1.0.0',rule_spec_id:'il.review.working-time.required-versus-allocated',rule_spec_version:'1.0.0',
 catalog_boundary:'real_inactive',readiness:'conditional_review_only',interpreter:'executeRuleSpec',
 source_review_sha256:WORKING_TIME_SOURCE_REVIEW_SHA256,supported_work_period:WORKING_TIME_SOURCE_REVIEW.supported_work_period,
 real_activation_allowed:false,human_attestation:null,actual_remittance_proven:false});
export const WORKING_TIME_PINNED_LEGAL_DOCUMENTS=deepFreeze(WORKING_TIME_SOURCE_REVIEW.sources.map(s=>({
 document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'legal_source' as const,case_id:null,
})));
export function workingTimeLegalSource(key:'law'|'week'|'rest',page:number,locator:string):DocumentReviewSource{
 const s=WORKING_TIME_SOURCE_REVIEW.sources.find(s=>s.key===key)!;
 if(page<1||page>s.page_count)throw Error('WORKING_TIME_LEGAL_PAGE');
 return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page,locator,label:s.label,
  reading:'source_research',reading_receipt_sha256:WORKING_TIME_SOURCE_REVIEW_SHA256};
}
export function workingTimeLegalDocuments(caseId:string){return WORKING_TIME_SOURCE_REVIEW.sources.map(s=>({case_id:caseId,
 document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'other' as const,
 label:s.label,period:null,reading_origin:'ai_document_review' as const,reading_sha256:WORKING_TIME_SOURCE_REVIEW_SHA256,
 accepted_reading_sha256:[WORKING_TIME_SOURCE_REVIEW_SHA256]}));}
export function isPinnedWorkingTimeLegalDocument(candidate:unknown,caseId:string){return workingTimeLegalDocuments(caseId).some(d=>canonicalSha256(d)===canonicalSha256(candidate));}
