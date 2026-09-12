import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';

/** Opt-in successor. The historical explicit-obligations-policy-v1 and its
 * empty legal manifest remain unchanged. This is an AI method, not a legal
 * presumption that every uploaded document is an enforceable agreement. */
export const OBLIGATIONS_CASE_POLICY='explicit-obligations-case-policy-v2' as const;
export const OBLIGATIONS_SOURCE_REVIEW=deepFreeze({schema_version:OBLIGATIONS_CASE_POLICY,reviewed_at:'2026-09-12',
 actor_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,
 supported_work_period:{from:'2026-05-01',to:'2026-07-31'},
 sources:[
  {key:'prior',document_id:'il.contracts-general.official-compendium-2025',version_id:'IL_CONTRACTS_GENERAL@official-compendium-2025-v1',
   file_sha256:'090f0cb9a4f6388e54abc1dea61197436ec0082f85a19a5f8ff7dfcdae7d65f5',page_count:828,
   url:"https://www.gov.il/BlobFolder/legalinfo/rules_and_guidelines/he/ספר קובץ חיקוקים והנחיות לבתי הדין הרבניים - התשפ''ה 5.6.2025 שעה 23.00.pdf",
   label:'חוק החוזים (חלק כללי) — קובץ ממשלתי מאוחד מיוני 2025',acquisition:'official_consolidated_compendium_not_original_promulgation',
   verified_pdf_pages:[381,383,384],sections:['1–6','23–25','27']},
  {key:'amendment2',document_id:'il.contracts-general-amendment2.2011',version_id:'IL_CONTRACTS_GENERAL_AMENDMENT2@official-2011-v1',
   file_sha256:'4dd53104c2a023bed2fd12573b77c95017c941b58c77d75f0f1b3ba9a6a302ef',page_count:2,
   url:'https://fs.knesset.gov.il/18/law/18_lsr_301084.pdf',label:'חוק החוזים (חלק כללי), תיקון 2 — הפרסום הרשמי 26.1.2011',
   acquisition:'official_original_publication',verified_pdf_pages:[1,2],sections:['1:25(a)','1:25(b1)']},
  {key:'amendment3',document_id:'il.contracts-general-amendment3.2026',version_id:'IL_CONTRACTS_GENERAL_AMENDMENT3@official-2026-v1',
   file_sha256:'344446bf0a08b4e36df848f061a68811c671ee1a7fe1220539a447b96c91783d',page_count:2,
   url:'https://fs.knesset.gov.il/25/law/25_lsr_10622519.pdf',label:'חוק החוזים (חלק כללי), תיקון 3 — הפרסום הרשמי 7.1.2026',
   acquisition:'official_original_publication',verified_pdf_pages:[2],sections:['1:25(a)(4)','2']},
 ],
 method_boundaries:['employment_context_not_literal_only','formation_or_renewal_date_not_payroll_month',
  'positive_source_agreement_witness_not_signature_appearance_or_negative_awareness',
  'positive_source_condition_inventory_not_empty_extraction','exact_whole_month_no_proration',
  'fixed_or_linear_agora_exact_no_rounding_choice','source_promise_not_statutory_minimum_or_verified_debt'],
 interpretation_transition:{prior_formation_from:'2011-01-27',prior_formation_through:'2026-01-06',
  new_formation_from:'2026-01-08',boundary_day:'2026-01-07',boundary_day_treatment:'requires_separate_effective_time_assessment'},
});
export const OBLIGATIONS_SOURCE_REVIEW_SHA256=canonicalSha256(OBLIGATIONS_SOURCE_REVIEW);
export const OBLIGATIONS_PINNED_LEGAL_DOCUMENTS=deepFreeze(OBLIGATIONS_SOURCE_REVIEW.sources.map(s=>({
 document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'legal_source' as const,case_id:null,
})));
export function obligationLegalSource(key:'prior'|'amendment2'|'amendment3',page:number,locator:string):DocumentReviewSource{
 const s=OBLIGATIONS_SOURCE_REVIEW.sources.find(s=>s.key===key)!;
 if(!s.verified_pdf_pages.includes(page)||locator.length>500)throw Error('OBLIGATION_VERIFIED_LEGAL_LOCATOR');
 return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page,locator,label:s.label,
  reading:'source_research',reading_receipt_sha256:OBLIGATIONS_SOURCE_REVIEW_SHA256};
}
export function obligationLegalDocuments(caseId:string){return OBLIGATIONS_SOURCE_REVIEW.sources.map(s=>({
 case_id:caseId,document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:s.page_count,kind:'other' as const,
 label:s.label,period:null,reading_origin:'ai_document_review' as const,reading_sha256:OBLIGATIONS_SOURCE_REVIEW_SHA256,
}));}
