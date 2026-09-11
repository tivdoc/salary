import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createHash} from 'node:crypto';
import {openAiPayslipV2StructuredOutputSchema,type OpenAiPayslipV2StructuredOutput} from '@/server/engine/extraction/providers/openai/v2-schema';

/** Six independently specified candidate readings and eight June declarations.
 * This fixture tests notification orchestration. It is not live OCR, a legal
 * golden, an actual employee or a financial report fixture. */
export async function completionAggregationFixture(){
 const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
 const font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([595,842]);
 const lines=['SYNTHETIC NOTIFICATION WORKFLOW FIXTURE','Period: 01/06/2026 - 30/06/2026','Salary type: hourly','Regular hours: 100',
  'Regular base salary: 3300.00 ILS','Gross salary: 3300.00 ILS','Total deductions: 0.00 ILS','Net salary: 3300.00 ILS',
  'No other earnings. Hourly rate is not printed.','No real employee, payment, legal approval or live OCR claim.'];
 for(const [index,line]of lines.entries())page.drawText(line,{font,x:32,y:790-index*30,size:12});
 const bytes=await pdf.save(),sha256=createHash('sha256').update(bytes).digest('hex');
 const evidence={page:1,region:'earnings' as const,source_label:'Regular base salary'},value=(raw_value:string)=>({raw_value,confidence:'high' as const,evidence,warnings:[]}),empty={rate_candidates:[],amount_candidates:[]};
 const output:OpenAiPayslipV2StructuredOutput={detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
  salary_type:{documented_value:'hourly',documented_raw_value:'hourly',documented_confidence:'high',documented_evidence:{page:1,region:'header',source_label:'Salary type'},inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
  generic_fields:[{field:'salary_period',candidates:[{...value('06/2026'),evidence:{page:1,region:'header',source_label:'Period'}}]},
   {field:'regular_hours',candidates:[{...value('100'),evidence:{page:1,region:'header',source_label:'Regular hours'}}]}],
  payroll_rows:[{source_label:'Regular base salary',semantic_kind:'base_salary',quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:'3300.00',confidence:'high',evidence,warnings:[]}],
  totals:{visible:true,gross_candidates:[{...value('3300.00'),evidence:{page:1,region:'totals',source_label:'Gross salary'}}],deductions_candidates:[{...value('0.00'),evidence:{page:1,region:'totals',source_label:'Total deductions'}}],net_candidates:[{...value('3300.00'),evidence:{page:1,region:'totals',source_label:'Net salary'}}]},
  pension:{visible:false,base_candidates:[],employee:empty,employer:empty,severance:empty},earnings_components_complete:true,warnings:[]};
 return {bytes,sha256,output:openAiPayslipV2StructuredOutputSchema.parse(output),expectedFields:['salary_type','salary_period','regular_hours','base_monthly_salary','gross_salary','net_salary'].sort(),expectedQuestions:14};
}
