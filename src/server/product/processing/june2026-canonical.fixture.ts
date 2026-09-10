import {PDFDocument,StandardFonts} from 'pdf-lib';
import {devFinancialInputFixture,fixtureSha} from './dev-financial-flow.fixture';

/** Independent synthetic zero-difference document. The hourly-rate cell is
 * explicitly absent; the documented full-month base is6443.85. Neither the
 * current law catalog nor calculator is imported to generate these values. */
export async function june2026NoGapFixture(){
 const original=await devFinancialInputFixture(false),pdf=await PDFDocument.create();
 pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
 const font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([595,842]);
 const lines=['SYNTHETIC PAYSLIP - ISOLATED ENGINEERING TEST','Period: June 2026 (01/06/2026 - 30/06/2026)',
  'Synthetic adult hourly employee; general 182-hour framework.','Salary type: hourly','Regular hours: 182',
  'Hourly rate: NOT SHOWN','Regular base salary: 6443.85 ILS','Gross salary: 6443.85 ILS',
  'Total deductions: 0.00 ILS','Net salary: 6443.85 ILS','No other earnings components; no overtime.',
  'No hourly-rate reading may be inferred from base divided by hours.','Fabricated input; no real employee or professional approval.'];
 for(const [i,line]of lines.entries())page.drawText(line,{font,x:34,y:790-i*29,size:11});
 const bytes=await pdf.save(),output={...original.output,
  payroll_rows:[{...original.output.payroll_rows[0],semantic_kind:'hourly_base' as const,quantity_raw:'182',rate_raw:null,amount_raw:'6443.85'}],
  totals:{...original.output.totals,
   gross_candidates:original.output.totals.gross_candidates.map(c=>({...c,raw_value:'6443.85'})),
   net_candidates:original.output.totals.net_candidates.map(c=>({...c,raw_value:'6443.85'}))}};
 return {...original,bytes,sha256:fixtureSha(bytes),output,name:'synthetic-june-2026-no-gap.pdf'};
}
