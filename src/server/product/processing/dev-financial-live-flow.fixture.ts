import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {createHash} from 'node:crypto';

// Independent literal source oracle; no calculator, provider result, legal
// catalog, canonical fact or completed report is imported by this fixture.
export const DEV_FINANCIAL_LIVE_ORACLE=Object.freeze({month:'2026-06',regularHours:'100',hourlyRateMinor:3300,
 baseMinor:330000,grossMinor:330000,deductionsMinor:0,netMinor:330000,expectedMinor:354000,gapMinor:24000,
 independentCalculation:'100 * 3540 minor units - 330000 minor units = 24000 minor units',
 humanLegalApproval:false,sourceIsSynthetic:true});
export const liveFinancialSha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** The source has one actual earnings row with distinct columns. There is no
 * prefilled provider response and no second synthetic representation to inject. */
export async function createLiveFinancialInput(missingHours:boolean){
 const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
 pdf.setTitle(`SYNTHETIC DEV LIVE PAYSLIP / ${missingHours?'missing-hours':'clear'}`);
 pdf.setSubject('Fabricated single-row input for actual SDK extraction; no legal finding or report');
 const font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),page=pdf.addPage([595,842]);
 const text=(value:string,x:number,y:number,size=11,strong=false)=>page.drawText(value,{x,y,size,font:strong?bold:font,color:rgb(.12,.16,.2)});
 const right=(value:string,x:number,y:number,size=11)=>text(value,x-font.widthOfTextAtSize(value,size),y,size);
 page.drawRectangle({x:32,y:738,width:531,height:67,color:rgb(.92,.95,.98)});
 text('SYNTHETIC PAYSLIP',44,780,19,true);text('ENGINEERING TEST ONLY - fabricated source',44,757,10);
 text('Employer: Synthetic DEV employer',44,710);text('Employee: Synthetic adult employee',44,684);
 text('Salary period: 06/2026',44,654,12,true);text('Salary type: hourly',44,628,12,true);
 text('Complete earnings table',44,582,12,true);
 page.drawRectangle({x:32,y:534,width:531,height:31,color:rgb(.93,.94,.95)});
 text('Earnings component',44,546,10,true);text('Regular hours',251,546,10,true);
 text('Hourly rate (ILS)',345,546,10,true);text('Paid base (ILS)',466,546,10,true);
 text('Regular hourly base',44,507,11);right(missingHours?'MISSING':'100',319,507,11);
 right('33.00',427,507,11);right('3,300.00',550,507,11);
 page.drawLine({start:{x:32,y:490},end:{x:563,y:490},thickness:.6,color:rgb(.65,.7,.75)});
 text('Gross salary (ILS)',44,446,12,true);right('3,300.00',550,446,12);
 text('Total deductions (ILS)',44,412,12);right('0.00',550,412,12);
 page.drawRectangle({x:32,y:360,width:531,height:33,color:rgb(.92,.96,.93)});
 text('Net salary (ILS)',44,372,12,true);right('3,300.00',550,372,12);
 if(missingHours)text('Regular hours are not documented in this source.',44,319,11);
 text('Only the one earnings row shown above is present.',44,284,10);
 text('All names and amounts were invented for DEV verification.',44,237,10);
 text('This is not an actual employee record or a statement of legal entitlement.',44,218,9);
 right('1 / 1',551,43,9);
 const bytes=await pdf.save({useObjectStreams:false});
 return {bytes,sha256:liveFinancialSha(bytes),name:missingHours?'synthetic-live-table-june-2026-missing-hours.pdf':'synthetic-live-table-june-2026-clear.pdf',missingHours};
}
