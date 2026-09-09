import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createHash} from 'node:crypto';
import type {OpenAiPayslipV2StructuredOutput} from '@/server/engine/extraction/providers/openai/v2-schema';

// Hand-set oracle, independent of the calculator/policy/renderer imports.
// 100 regular hours * 35.40 ILS = 3540.00 ILS; 3540.00 - 3300.00 = 240.00.
// This arithmetic fixture is not a legal golden or evidence of live OCR.
export const DEV_FINANCIAL_ORACLE={month:'2026-06',regularHours:'100',baseMinor:330000,expectedMinor:354000,gapMinor:24000,
 independentCalculation:'100 * 3540 minor units - 330000 minor units = 24000 minor units',humanLegalApproval:false} as const;
export const fixtureSha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

export async function devFinancialInputFixture(missingHours:boolean){
 const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
 const font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([595,842]);
 const lines=['SYNTHETIC PAYSLIP - ENGINEERING TEST ONLY','Period: June 2026 (01/06/2026 - 30/06/2026)',
  'Synthetic adult hourly employee; general 182-hour framework.','Salary type: hourly',
  `Regular hours: ${missingHours?'MISSING / UNREADABLE':'100'}`,'Hourly rate: 33.00 ILS','Regular base salary: 3300.00 ILS',
  'Gross salary: 3300.00 ILS','Total deductions: 0.00 ILS','Net salary: 3300.00 ILS',
  'No other earnings components; no overtime.','This is fabricated input, not an actual employee record.'];
 for(const [i,line]of lines.entries())page.drawText(line,{font,x:34,y:790-i*29,size:12});
 const bytes=await pdf.save(),sha256=fixtureSha(bytes);
 const evidence={page:1,region:'earnings' as const,source_label:'Synthetic regular base salary'};
 const value=(raw_value:string)=>({raw_value,confidence:'high' as const,evidence,warnings:[]});
 const empty={rate_candidates:[],amount_candidates:[]};
 const output:OpenAiPayslipV2StructuredOutput={detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
  salary_type:{documented_value:'hourly',documented_raw_value:'hourly',documented_confidence:'high',documented_evidence:{page:1,region:'header',source_label:'Salary type'},inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
  generic_fields:[{field:'salary_period',candidates:[{...value('06/2026'),evidence:{page:1,region:'header',source_label:'Period'}}]}],
  // V2 maps base amounts and hourly quantities from separate semantic rows.
  // The hourly detail has no amount, so it is not a second paid component.
  payroll_rows:[{source_label:'Regular base salary',semantic_kind:'base_salary',quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:'3300.00',confidence:'high',evidence,warnings:[]},
   {source_label:'Hourly details',semantic_kind:'hourly_base',quantity_raw:missingHours?null:'100',rate_raw:'33.00',percentage_raw:null,amount_raw:null,confidence:'high',evidence,warnings:[]}],
  totals:{visible:true,gross_candidates:[value('3300.00')],deductions_candidates:[value('0.00')],net_candidates:[value('3300.00')]},
  pension:{visible:false,base_candidates:[],employee:empty,employer:empty,severance:empty},earnings_components_complete:true,warnings:[]};
 return {bytes,sha256,output,name:missingHours?'synthetic-june-2026-missing-hours.pdf':'synthetic-june-2026-100-hours.pdf',missingHours};
}
