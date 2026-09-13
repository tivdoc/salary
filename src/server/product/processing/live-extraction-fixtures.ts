import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {createHash} from 'node:crypto';

/** Independent literal source truth. This module imports no calculator,
 * RuleSpec, parameter registry, precomputed finding or provider response. */
export const LIVE_EXTRACTION_ORACLES=[
 {id:'clear',hours:['100'],baseMinor:330000,hourlyRateMinor:3300,expectedMinor:354000,gapMinor:24000,outcome:'readable',
  equation:'100 * 3540 - 330000 = 24000'},
 {id:'missing-hours',hours:[],baseMinor:330000,hourlyRateMinor:3300,expectedMinor:null,gapMinor:null,outcome:'essential_input_missing',
  equation:'No monetary result before the missing-hours answer; an identified answer of 100 implies 24000 minor units.'},
 {id:'ambiguous-hours',hours:['100','110'],baseMinor:330000,hourlyRateMinor:3300,expectedMinor:null,gapMinor:null,outcome:'conflicting_observations',
  equation:'No monetary result while two regular-hours observations disagree.'},
 {id:'zero-gap',hours:['100'],baseMinor:354000,hourlyRateMinor:3540,expectedMinor:354000,gapMinor:0,outcome:'readable',
  equation:'100 * 3540 - 354000 = 0'},
 {id:'replacement',hours:['120'],baseMinor:396000,hourlyRateMinor:3300,expectedMinor:424800,gapMinor:28800,outcome:'readable',
  equation:'120 * 3540 - 396000 = 28800'},
] as const;
export type LiveExtractionOracle=typeof LIVE_EXTRACTION_ORACLES[number];
export const liveFixtureSha=(input:Uint8Array|string)=>createHash('sha256').update(input).digest('hex');

export async function createLiveExtractionFixture(oracle:LiveExtractionOracle){
 const pdf=await PDFDocument.create();
 pdf.setTitle(`SYNTHETIC DEV PAYSLIP - ${oracle.id}`);
 pdf.setSubject('Synthetic engineering input; not an actual employee record or legal golden case');
 pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
 const page=pdf.addPage([595,842]),font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 page.drawRectangle({x:28,y:747,width:539,height:62,color:rgb(0.92,0.95,0.98)});
 page.drawText('SYNTHETIC PAYSLIP',{x:42,y:781,font:bold,size:18,color:rgb(0.12,0.2,0.29)});
 page.drawText(`ENGINEERING TEST ONLY / ${oracle.id}`,{x:42,y:762,font,size:10});
 const money=(minor:number)=>(minor/100).toFixed(2)+' ILS';
 const rows:[string,string][]=[
  ['Employer','Synthetic DEV employer'],['Employee','Synthetic adult hourly employee'],
  ['Salary period','01/06/2026 - 30/06/2026'],['Salary type','hourly'],
  ['Scenario assumption','General 182-hour framework'],
  ...oracle.hours.map((hours,index)=>[oracle.hours.length>1?`Regular hours - observation ${index+1}`:'Regular hours',hours] as [string,string]),
  ...(oracle.hours.length===0?[['Regular hours','NOT DOCUMENTED'] as [string,string]]:[]),
  ['Hourly rate',money(oracle.hourlyRateMinor)],['Regular base salary',money(oracle.baseMinor)],
  ['Gross salary',money(oracle.baseMinor)],['Total deductions','0.00 ILS'],['Net salary',money(oracle.baseMinor)],
 ];
 for(let i=0;i<rows.length;i++){
  const y=707-i*35;
  page.drawText(rows[i][0],{x:42,y,font,size:11});
  page.drawText(rows[i][1],{x:281,y,font:rows[i][0]==='Regular base salary'?bold:font,size:11});
  page.drawLine({start:{x:42,y:y-12},end:{x:550,y:y-12},thickness:0.4,color:rgb(0.8,0.83,0.87)});
 }
 page.drawText('No other earnings components; no overtime.',{x:42,y:212,font,size:11});
 page.drawText('Fabricated source for DEV verification. No actual employee data.',{x:42,y:193,font,size:10});
 page.drawText('The independent arithmetic oracle is stored separately from this document.',{x:42,y:174,font,size:10});
 page.drawText('1 / 1',{x:524,y:40,font,size:9});
 const bytes=await pdf.save({useObjectStreams:false});
 return {id:oracle.id,name:`live-ocr-${oracle.id}-june-2026.pdf`,mimeType:'application/pdf' as const,bytes,sha256:liveFixtureSha(bytes),oracle};
}
