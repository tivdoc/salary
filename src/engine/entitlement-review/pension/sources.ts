import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';

export const PENSION_SOURCES=deepFreeze({
 order2011:{document_id:'il.pension.general.2011',version_id:'IL_GENERAL_PENSION_EXTENSION_ORDER_2011@review-20260912',
  file_sha256:'2f1c4942e0130c55714801cc4a72aba40f77a2391ba72f6bd2d5b2d7094244d9',page_count:5,
  url:'https://www.gov.il/BlobFolder/guide/labor-wage/he/workers-rights_working-conditions_pension_H096.pdf'},
 order2016:{document_id:'il.pension.increase.2016',version_id:'IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@review-20260912',
  file_sha256:'f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70',page_count:3,
  url:'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extention-order-pension-insurance-2016/he/extention-order-pension-insurance-2016.pdf'},
 average2026:{document_id:'il.btl.average-wage.2026',version_id:'IL_BTL_AVERAGE_WAGE_2026@20260912',
  file_sha256:'457a0327af2240f9e92a9876018beb3bba259a1033dae882b6ce05b12ae5a1a2',page_count:1,
  url:'https://www.btl.gov.il/Mediniyut/GeneralData/Pages/שכר%20ממוצע.aspx'},
});
export const PENSION_SOURCE_REVIEW=deepFreeze({schema_version:'pension-general-source-review-v1',reviewed_at:'2026-09-12',
 reviewer_kind:'ai_source_research',human_attestation:null,real_activation_allowed:false,sources:PENSION_SOURCES,
 supported_period:{from:'2026-05-01',to:'2026-07-31'},
 rules:{ordinary_waiting_months:6,insured_execution_months:3,insured_year_end_earlier:true,
  employee_percent:'6',employer_percent:'6.5',severance_percent:'6',cap_ils:'13769.00'},
 exclusions:['under_21_branch_not_assessed','better_arrangement_not_determined','sector_specific_arrangement',
  'insurance_product_disability_cover','mandatory_retirement_with_non_BTL_pension','early_termination_before_first_insured_execution'],
 rounding_candidate:'half_up_per_component_per_month',remittance_determines_expected_amount:false});
export const PENSION_SOURCE_REVIEW_SHA256=canonicalSha256(PENSION_SOURCE_REVIEW);
export const PENSION_LEGAL_MANIFEST=Object.values(PENSION_SOURCES).map(({url:_url,...s})=>{void _url;return {...s,kind:'legal_source' as const,case_id:null};});
export const PENSION_CATALOG=deepFreeze({catalog_id:'il.review.pension.general.2026',catalog_version:'1.0.0',topic:'pension',
 rule_version:'1.0.0',catalog_boundary:'real_inactive',readiness:'conditional_review_only',interpreter:'executeRuleSpec',
 source_review_sha256:PENSION_SOURCE_REVIEW_SHA256,human_attestation:null,real_activation_allowed:false,
 supported_period:PENSION_SOURCE_REVIEW.supported_period});
export function pensionLegalSource(key:keyof typeof PENSION_SOURCES,page:number,locator:string):DocumentReviewSource{
 const s=PENSION_SOURCES[key];if(page<1||page>s.page_count)throw Error('PENSION_LEGAL_PAGE');
 return {document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page,locator,
  label:key==='average2026'?'ביטוח לאומי — שכר ממוצע לפי סעיף 2, 2026':'צו הרחבה לפנסיה חובה — הוראות המקור',
  reading:'source_research',reading_receipt_sha256:PENSION_SOURCE_REVIEW_SHA256};
}
export function isPinnedPensionLegalSource(source:DocumentReviewSource):boolean{
 return Object.values(PENSION_SOURCES).some(s=>s.document_id===source.document_id&&s.version_id===source.version_id&&s.file_sha256===source.file_sha256
  &&source.page>=1&&source.page<=s.page_count&&source.reading==='source_research'&&source.reading_receipt_sha256===PENSION_SOURCE_REVIEW_SHA256);
}
