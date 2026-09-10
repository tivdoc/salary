import type {OpenAiPayslipV2StructuredOutput} from './v2-schema';

export const OPENAI_V2_HOURLY_ROW_EVIDENCE_POLICY='payslip-v2-explicit-hourly-row-cells-v1' as const;
export const HOURLY_ROW_READING_WARNING='hourly_row_cells_require_confirmation' as const;
type Row=OpenAiPayslipV2StructuredOutput['payroll_rows'][number];
const positiveCell=(value:string|null)=>value!==null&&/^\d+(?:\.\d+)?$/u.test(value.trim())&&Number.isFinite(Number(value))&&Number(value)>0;
const comparable=(value:string)=>value.normalize('NFKC').replace(/[\u200e-\u202e\u2066-\u2069]/gu,'').trim().replace(/\s+/gu,' ').toLowerCase();

/** A provider can classify a visibly hourly base row under its broader
 * base_salary enum while returning the actual quantity/rate cells. Preserve
 * those explicit cells as unconfirmed readings. This does not classify the
 * component legally, infer hours from pay/rate, repair a label or overwrite an
 * existing candidate. Both the header and the row's own evidence must agree. */
export function explicitHourlyBaseCells(output:OpenAiPayslipV2StructuredOutput,row:Row){
 const salary=output.salary_type;
 if(row.semantic_kind!=='base_salary'||salary.documented_value!=='hourly'||!salary.documented_raw_value
  ||salary.warnings.length!==0||row.warnings.length!==0||row.percentage_raw!==null
  ||row.evidence.region!=='earnings'||row.evidence.page===null||row.evidence.page<1||row.evidence.page>output.page_count
  ||!positiveCell(row.quantity_raw)||!positiveCell(row.rate_raw)||row.amount_raw===null||row.amount_raw.trim()==='')return null;
 const header=comparable(salary.documented_raw_value);
 if(!/^(?:(?:salary type|סוג שכר)\s*:?\s*)?(?:hourly|שעתי)$/u.test(header))return null;
 const label=row.evidence.source_label===null?'':comparable(row.evidence.source_label);
 if(!['שכר יסוד שעתי','שכר בסיס שעתי','hourly base salary','hourly base wage','hourly base pay'].includes(label))return null;
 return {quantity_raw:row.quantity_raw!,rate_raw:row.rate_raw!,warning:HOURLY_ROW_READING_WARNING};
}
