import {describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {mapOpenAiV2Output} from './v2-mapper';
import {openAiPayslipV2StructuredOutputSchema,openAiPayslipV2R5StructuredOutputSchema} from './v2-schema';
import {checkLiveExtractionCorpus,loadLiveExtractionCorpus} from '@/server/product/processing/live-extraction-corpus';
vi.mock('server-only',()=>({}));

const retainedConflict='docs/release-evidence/sol-canonical-20260910/conflicting-hours/provider/210b4896-structured.json';
const retainedComplex='docs/release-evidence/sol-comparison-20260910/sol-clear-structured.json';
function retained(file:string){
 const bytes=readFileSync(file),diagnostic=JSON.parse(bytes.toString('utf8'));
 expect(diagnostic.origin).toBe('openai_live');
 expect(canonicalSha256(diagnostic.structured_output)).toBe(diagnostic.structured_output_sha256);
 return {bytes,diagnostic,output:openAiPayslipV2StructuredOutputSchema.parse(diagnostic.structured_output)};
}
function map(output:unknown){
 const parsed=openAiPayslipV2StructuredOutputSchema.parse(output);
 const extraction=normalizePayslipExtraction(mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output:parsed,
  model:'offline-mapping-only',extractorVersion:'2.1',durationMs:0,providerResponseId:'offline-not-a-provider-call',
  tokenUsage:null,extractedAt:'2026-09-11T00:19:48Z'}).extraction);
 return {extraction,validation:validatePayslipGate0(extraction,{reference_year:2026,critical_context:{hourly_analysis_implied:true}})};
}
const observation=(raw_value:string,source_label:string)=>({raw_value,confidence:'high',
 evidence:{page:1,region:'header',source_label},warnings:[]});

describe('source observations and semantic classification have separate contracts',()=>{
 it('reproduces the actual retained omission without manufacturing either missing number',()=>{
  const saved=retained(retainedConflict),before=canonicalSha256(saved.output),mapped=map(saved.output);
  expect(saved.output.generic_fields.some(group=>String(group.field)==='regular_hours')).toBe(false);
  expect(saved.output.payroll_rows.every(row=>row.quantity_raw===null)).toBe(true);
  expect(mapped.extraction.fields.filter(field=>field.field==='regular_hours')).toEqual([]);
  expect(mapped.extraction.warnings).toContain('conflicting_values');
  expect(mapped.validation.issues.some(issue=>issue.field_keys.includes('regular_hours'))).toBe(true);
  expect(canonicalSha256(saved.output)).toBe(before);expect(readFileSync(retainedConflict)).toEqual(saved.bytes);
 });
 it('accepts separately printed hours and rate observations without making them payroll components',()=>{
  // These are explicit synthetic contract observations, NOT additions to the
  // retained provider response and NOT evidence of improved live OCR recall.
  const original=retained(retainedConflict).output;
  const candidate={...original,generic_fields:[...original.generic_fields,
   {field:'regular_hours',candidates:[observation('100','שעות רגילות בכותרת'),observation('120','שעות רגילות בסיכום נוכחות')]},
   {field:'hourly_rate',candidates:[observation('33.00','תעריף שעה')]}]};
  expect(openAiPayslipV2StructuredOutputSchema.safeParse(candidate).success).toBe(true);
  expect(openAiPayslipV2R5StructuredOutputSchema.safeParse(candidate).success).toBe(false);
  const {extraction,validation}=map(candidate),hours=extraction.fields.filter(field=>field.field==='regular_hours');
  expect(hours.map(field=>field.raw_value)).toEqual(['100','120']);
  expect(hours.map(field=>field.normalized_value)).toEqual([{amount:'100',unit:'hours_per_month'},{amount:'120',unit:'hours_per_month'}]);
  expect(hours.map(field=>field.source.text_fragment)).toEqual(['שעות רגילות בכותרת: 100','שעות רגילות בסיכום נוכחות: 120']);
  expect(hours.every(field=>field.confidence===0.94&&field.source.page===1&&field.source.document_id===extraction.document_id)).toBe(true);
  expect(new Set(hours.map(field=>field.candidate_id)).size).toBe(2);
  expect(validation.issues.find(issue=>issue.code==='conflicting_candidates')?.field_candidate_ids).toEqual(hours.map(field=>field.candidate_id));
  expect(extraction.additional_components).toHaveLength(1);
  expect(extraction.additional_components[0].quantity).toBeNull();
  expect(extraction.fields.find(field=>field.field==='hourly_rate')?.normalized_value).toEqual({currency:'ILS',minor_units:3300});
 });
 it('reproduces the two retained complex-PDF label defects and leaves the raw labels intact',()=>{
  const saved=retained(retainedComplex),mapped=map(saved.output),entry=loadLiveExtractionCorpus('hebrew-june2026','he-clear')[0];
  expect(checkLiveExtractionCorpus({entry,...mapped}).failures).toEqual(['ROW_overtime_125','ROW_overtime_150']);
  // הפרשות means contributions, not הפרשים (prior-period differences).
  // Keep the source-backed base in current candidates without changing R5 bytes.
  const base=mapped.extraction.fields.find(field=>field.field==='pension_base');
  expect(base).toMatchObject({raw_value:'3,540.00',normalized_value:{currency:'ILS',minor_units:354000}});
  expect(base?.source.text_fragment).toContain('בסיס להפרשות');
  expect(mapped.extraction.source_scope_observations?.some(observation=>observation.candidate.candidate_id===base?.candidate_id)??false).toBe(false);
  expect(mapped.extraction.additional_components.filter(row=>row.semantic_kind==='overtime_125'||row.semantic_kind==='overtime_150')
   .map(row=>[row.source_label,row.semantic_kind,row.percentage_raw])).toEqual([
    ['שעות נוספות 125%','overtime_125','125%'],['שעות נוספות 150%','overtime_150','150%']]);
  expect(readFileSync(retainedComplex)).toEqual(saved.bytes);
 });
 it('preserves historical r5 parsed bytes and does not silently reinterpret source labels',()=>{
  for(const file of [retainedConflict,retainedComplex]){
   const {output}=retained(file);
   expect(canonicalSha256(openAiPayslipV2R5StructuredOutputSchema.parse(output))).toBe(canonicalSha256(openAiPayslipV2StructuredOutputSchema.parse(output)));
  }
  const original=retained(retainedComplex).output;
  const source={...original,payroll_rows:original.payroll_rows.map(row=>row.semantic_kind==='overtime_125'
   ?{...row,source_label:'שעות נוספות',evidence:{...row.evidence,source_label:'שעות נוספות'}}:row)};
  const row=map(source).extraction.additional_components.find(row=>row.semantic_kind==='overtime_125')!;
  expect(row.source_label).toBe('שעות נוספות');expect(row.normalized_label).toBe('overtime_125');expect(row.percentage_raw).toBe('125%');
 });
});
