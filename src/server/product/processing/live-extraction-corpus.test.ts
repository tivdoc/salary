import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import type {PayslipFieldKey} from '@/engine/extraction/contracts';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';

// A hand-built normalized observation contract used only to challenge the
// oracle checker. No provider is replaced, called or credited by these tests.
function observed(){
 const source={...structuredClone(syntheticPayslipFixtures[0].extraction)},uuid=(i:number)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
 const pairs:[PayslipFieldKey,string][]=[['salary_period','06/2026'],['salary_type','שעתי'],['employment_start_date','15/01/2025'],
  ['base_monthly_salary','3,540.00'],['regular_hours','100'],['hourly_rate','35.40'],['overtime_125_hours','10'],['overtime_150_hours','2'],
  ['travel_amount','220.00'],['gross_salary','4,608.70'],['total_deductions','412.40'],['net_salary','4,196.30'],['pension_base','3,540.00'],
  ['pension_employee_rate','6.00%'],['pension_employee_contribution','212.40'],['pension_employer_rate','6.50%'],
  ['pension_employer_contribution','230.10'],['severance_rate','6.00%'],['severance_contribution','212.40']];
 source.fields=pairs.map(([field,raw_value],index)=>({candidate_id:uuid(index+20),field,raw_value,confidence:0.94,
  source:{document_id:source.document_id,page:1,text_fragment:`${field}: ${raw_value}`},extraction_method:'ai_vision',warning_flags:[]}));
 const rows=[['hourly_base','שכר יסוד שעתי','100','35.40','3,540.00'],['overtime_125','שעות נוספות','10','44.25','442.50'],
  ['overtime_150','שעות נוספות','2','53.10','106.20'],['travel','החזר נסיעות','20','11.00','220.00'],['bonus','בונוס חד פעמי',null,null,'300.00']] as const;
 source.additional_components=rows.map(([semantic_kind,source_label,quantity_raw,rate_raw,amount_raw],index)=>({component_id:uuid(index+60),
  source_label,normalized_label:semantic_kind,semantic_kind,quantity_raw,rate_raw,amount_raw,percentage_raw:null,confidence:0.94,
  source:{document_id:source.document_id,page:1,text_fragment:source_label},extraction_method:'ai_vision',warning_flags:[]}));
 for(const [index,[source_label,amount_raw]] of [['פנסיה עובד','212.40'],['ביטוח לאומי','80.00'],['ביטוח בריאות','120.00'],['מס הכנסה','0.00']].entries()){
  source.additional_components.push({component_id:uuid(index+70),source_label,normalized_label:'deduction',semantic_kind:'deduction',
   quantity_raw:null,rate_raw:null,amount_raw,percentage_raw:null,confidence:0.94,
   source:{document_id:source.document_id,page:1,text_fragment:source_label},extraction_method:'ai_vision',warning_flags:[]});
 }
 source.earnings_components_complete=true;return normalizePayslipExtraction(source);
}
const compare=(extraction=observed(),id='he-clear')=>checkLiveExtractionCorpus({entry:loadLiveExtractionCorpus().find(e=>e.id===id)!,extraction,
 validation:validatePayslipGate0(extraction,{reference_year:2026,critical_context:{hourly_analysis_implied:true}})});

describe('authored Hebrew source corpus and independent literal oracle',()=>{
 it('contains four disjoint source versions and preserves all seven prior inputs as a separate corpus',()=>{
  expect(loadLiveExtractionCorpus().map(e=>e.id)).toEqual(['he-clear','he-missing-hours','he-conflicting-hours','he-scan-clear']);
  expect(loadLiveExtractionCorpus('all')).toHaveLength(11);
  expect(()=>loadLiveExtractionCorpus('hebrew-june2026','he-clear,he-clear')).toThrow('LIVE_CORPUS_ID_INVALID');
  expect(()=>loadLiveExtractionCorpus('hebrew-june2026','../foreign')).toThrow('LIVE_CORPUS_ID_INVALID');
 });
 it('checks the exact authored bytes, one-page PDFs and a genuine raster without text layer',async()=>{
  for(const entry of loadLiveExtractionCorpus()){
   const bytes=readFileSync(entry.path);expect(bytes.length).toBe(entry.sizeBytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
   if(entry.mimeType==='application/pdf'){
    const pdf=await PDFDocument.load(bytes);expect(pdf.getPageCount()).toBe(1);expect(pdf.getPages()[0].getWidth()).toBeCloseTo(595.28,1);
   }else{const raster=await sharp(bytes).metadata();expect(raster.format).toBe('png');expect(raster.width).toBeGreaterThan(1200);}
  }
 });
 it('keeps source totals independent of the narrow financial calculator',()=>{
  const oracle=loadLiveExtractionCorpus()[0].oracle;
  expect('language' in oracle).toBe(true);if(!('language' in oracle))throw Error('missing Hebrew oracle');
  expect(oracle.components.map(c=>c.amountMinor)).toEqual([354000,44250,10620,22000,30000]);
  expect(354000+44250+10620+22000+30000).toBe(460870);expect(460870-41240).toBe(419630);
  expect(oracle.expectedMinor).toBeNull();expect(oracle.gapMinor).toBeNull();
 });
 it('accepts literal source observations while proving neither OCR nor legal readiness',()=>{
  expect(compare()).toMatchObject({passed:true,failures:[],financialResultGenerated:false,legalReadinessProved:false});
 });
 it.each(['amount-column','missing-bonus','pension-column','source-page'] as const)('detects a new corpus error: %s',change=>{
  const extraction=observed();
  if(change==='amount-column')extraction.additional_components[0].amount={currency:'ILS',minor_units:3540};
  if(change==='missing-bonus')extraction.additional_components.splice(4,1);
  if(change==='pension-column'){
   const field=extraction.fields.find(f=>f.field==='pension_employee_contribution')!;field.normalized_value={currency:'ILS',minor_units:23010};
  }
  if(change==='source-page')extraction.fields[0].source.page=2;
  expect(compare(extraction).passed).toBe(false);
 });
 it('rejects a missing or misread deduction row instead of dropping deductions to pass earnings checks',()=>{
  const extraction=observed();extraction.additional_components.pop();
  expect(compare(extraction).failures).toContain('DEDUCTION_ROW_COUNT');
  const misread=observed();misread.additional_components[5].amount={currency:'ILS',minor_units:23010};
  expect(compare(misread).failures).toContain('DEDUCTION_ROW_0');
 });
 it('requires the missing-hours observation to stay missing instead of dividing known rate and amount',()=>{
  const initial=observed(),extraction={...initial,fields:initial.fields.filter(f=>f.field!=='regular_hours')};
  extraction.additional_components[0].quantity=null;extraction.additional_components[0].quantity_raw=null;
  expect(compare(extraction,'he-missing-hours').passed).toBe(true);
  expect(compare(observed(),'he-missing-hours').failures).toContain('FIELD_regular_hours');
 });
 it('requires both contradictory observations and retains the mismatching printed base row',()=>{
  const extraction=observed(),hours=structuredClone(extraction.fields.find(f=>f.field==='regular_hours')!);
  hours.candidate_id='00000000-0000-4000-8000-000000000099';hours.raw_value='110';hours.normalized_value={amount:'110',unit:'hours_per_month'};
  extraction.fields.push(hours);extraction.additional_components[0].quantity='110';extraction.additional_components[0].quantity_raw='110';
  expect(compare(extraction,'he-conflicting-hours').passed).toBe(true);
  expect(compare(observed(),'he-conflicting-hours').failures).toContain('FIELD_regular_hours');
 });
});
