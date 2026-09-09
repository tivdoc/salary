import type {NormalizedPayslipExtraction} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

/** Only the existing synthetic single-base engineering scenario is supported.
 * This is not classification/admission for the ordinary legal rule. */
export function assertDevFinancialExtractionSource(extraction:NormalizedPayslipExtraction,versionId:string){
 const bases=extraction.additional_components.filter(c=>c.semantic_kind==='base_salary');
 const hourly=extraction.additional_components.filter(c=>c.semantic_kind==='hourly_base');
 const baseValue=extraction.fields.find(f=>f.field==='base_monthly_salary')?.normalized_value;
 if(extraction.document_id!==versionId||!extraction.earnings_components_complete
  ||bases.length!==1||hourly.length>1||bases.length+hourly.length!==extraction.additional_components.length
  ||!bases[0].amount||canonicalSha256(bases[0].amount)!==canonicalSha256(baseValue??null)
  ||hourly.some(c=>c.amount_raw!==null||c.amount!==null||c.percentage_raw!==null)
  ||extraction.additional_components.some(c=>c.confidence<0.94||c.warning_flags.length||c.normalization_warnings.length)
  ||extraction.fields.find(f=>f.field==='salary_type')?.normalized_value!=='hourly')throw Error('DEV_FINANCIAL_SCENARIO_UNSUPPORTED');
}
