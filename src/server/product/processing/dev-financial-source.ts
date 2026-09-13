import type {NormalizedPayslipExtraction} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

/** Only the existing synthetic single-base engineering scenario is supported.
 * This is not classification/admission for the ordinary legal rule. */
export function assertDevFinancialExtractionSource(extraction:NormalizedPayslipExtraction,versionId:string){
 const bases=extraction.additional_components.filter(c=>c.semantic_kind==='base_salary');
 const hourly=extraction.additional_components.filter(c=>c.semantic_kind==='hourly_base');
 const baseValue=extraction.fields.find(f=>f.field==='base_monthly_salary')?.normalized_value;
 const paidHourly=bases.length===0&&hourly.length===1&&extraction.additional_components.length===1
  &&hourly[0].amount_raw!==null&&hourly[0].amount!==null&&hourly[0].percentage_raw===null;
 const separateBase=bases.length===1&&hourly.length<=1&&bases.length+hourly.length===extraction.additional_components.length
  &&hourly.every(c=>c.amount_raw===null&&c.amount===null&&c.percentage_raw===null);
 const paid=paidHourly?hourly[0]:bases[0];
 if(extraction.document_id!==versionId||!extraction.earnings_components_complete
  ||(!paidHourly&&!separateBase)
  ||!paid?.amount||canonicalSha256(paid.amount)!==canonicalSha256(baseValue??null)
  ||extraction.additional_components.some(c=>c.confidence<0.94||c.warning_flags.length||c.normalization_warnings.length)
  ||extraction.fields.find(f=>f.field==='salary_type')?.normalized_value!=='hourly')throw Error('DEV_FINANCIAL_SCENARIO_UNSUPPORTED');
}

/** Separate v2 admission for an identified reading/classification of the sole
 * unknown paid row. This does not mutate the row or approve a legal component. */
export function assertDevFinancialCompletionSource(extraction:NormalizedPayslipExtraction,versionId:string,componentId:string,amount:unknown,salaryType:unknown){
 const paid=extraction.additional_components[0];
 if(extraction.document_id!==versionId||salaryType!=='hourly'||!extraction.earnings_components_complete
  ||extraction.additional_components.length!==1||!paid||paid.component_id!==componentId||paid.semantic_kind!=='unknown'
  ||paid.source.document_id!==versionId||paid.source.page>extraction.quality_metrics.page_count
  ||paid.amount_raw===null||paid.amount===null||paid.amount.currency!=='ILS'||paid.amount.minor_units<0
  ||paid.percentage_raw!==null||paid.percentage!==null||paid.confidence<0.94||paid.warning_flags.length||paid.normalization_warnings.length
  ||canonicalSha256(amount)!==canonicalSha256(paid.amount)
  ||extraction.fields.some(f=>(f.field==='salary_type'||f.field==='base_monthly_salary')&&f.normalized_value!==null))throw Error('DEV_FINANCIAL_COMPLETION_SOURCE_UNSUPPORTED');
}
