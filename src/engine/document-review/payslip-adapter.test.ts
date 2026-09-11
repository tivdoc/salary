import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import type {NormalizedCandidateField,NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {normalizeMoney,normalizeDecimal,normalizePercentage} from '../extraction/normalization.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../../server/product/reports/document-field-confirmation.ts';
import {savedDocumentFieldReadings} from '../../server/product/processing/saved-field-readings.ts';
import {documentReviewInputSchema} from './contracts.ts';
import {runDocumentReview} from './service.ts';
import {reviewInputFromPayslips} from './payslip-adapter.ts';
import type {DocumentReviewCalculationInput} from './calculations.ts';

type Mutable<T>={-readonly [K in keyof T]:T[K]};
function fixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-normal-document-adapter',mode:'real'}),d={...structuredClone(f.stored.documents[0])},e={...structuredClone(f.stored.extractions[0]),fields:f.stored.extractions[0].fields.map(field=>({...structuredClone(field)}))};
 const period={from:'2026-06-01',to:'2026-06-30'};d.document_period={start_date:period.from,end_date:period.to};e.extracted_at='2026-07-02T12:00:00.000Z';
 const p=e.fields.find(f=>f.field==='salary_period')!;
 if(p.field!=='salary_period')throw Error('synthetic period');
 p.normalized_value={year:2026,month:6,start_date:period.from,end_date:period.to};p.raw_value='06/2026';
 e.fields=[p];e.additional_components=[];e.earnings_components_complete=false;
 const money=(field:NormalizedCandidateField['field'],raw:string,confidence=1)=>{
  const candidate={candidate_id:randomUUID(),field,raw_value:raw,normalized_value:normalizeMoney(raw),confidence,source:{document_id:d.document_id,page:1,text_fragment:`${field}: ${raw}`},extraction_method:'fixture',warning_flags:[]} as Mutable<NormalizedCandidateField>;
  e.fields.push(candidate);return candidate;
 };
 const row=(semantic_kind:NormalizedPayslipExtraction['additional_components'][number]['semantic_kind']='hourly_base',quantity='2',rate='50.00',amount='100.00',percentage:string|null=null)=>{
  const r:NormalizedPayslipExtraction['additional_components'][number]={component_id:randomUUID(),source_label:'שכר סינתטי',normalized_label:'synthetic.pay',semantic_kind,quantity_raw:quantity,rate_raw:rate,percentage_raw:percentage,amount_raw:amount,
   quantity:normalizeDecimal(quantity),rate:normalizeMoney(rate),percentage:percentage===null?null:normalizePercentage(percentage),amount:normalizeMoney(amount),confidence:1,
   source:{document_id:d.document_id,page:1,text_fragment:'Synthetic unique row quantity and unit price'},extraction_method:'fixture',warning_flags:[],normalization_warnings:[]};
  e.additional_components.push(r);return r;
 };
 const build=()=>reviewInputFromPayslips({case_id:d.case_id,period,purchased_scope:{order_id:'synthetic-paid-order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics:['minimum_wage','working_time','pension','travel','convalescence','bonuses']},snapshot:{...f.stored,documents:[d],extractions:[e]}});
 const run=()=>runDocumentReview(documentReviewInputSchema.parse(build()),'synthetic-normal-review-run');
 const identify=(candidates:NormalizedCandidateField[])=>{
  const {customer_readings:_,...machine}=e;void _;
  const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,input_sha256:d.content_sha256,expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256({final_extraction:machine}),run:{result:{final_extraction:machine}}};
  const answers=candidates.filter(c=>c.field!=='total_deductions').map(c=>{const target=documentFieldTarget({checkpoint,policyVersion:'synthetic-adapter-reading-v1',candidateId:c.candidate_id});return {id:randomUUID(),case_id:d.case_id,scope_month:'2026-06',code:`document_field:${target.target_sha256}`,answer_kind:'choice',answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2026-07-03T12:00:00Z',field_target:target};});
  e.customer_readings=[...savedDocumentFieldReadings({caseId:d.case_id,month:'2026-06',policyVersion:'synthetic-adapter-reading-v1',journal:{answers},checkpoint})];
 };
 const totals=(confidence=1)=>[money('gross_salary','100.00',confidence),money('total_deductions','10.00'),money('net_salary','90.00',confidence)];
 return {d,e,p,build,run,money,row,identify,totals};
}
describe('saved extraction to ordinary source review',()=>{
 it('uses canonical identified .94 readings without modifying source confidence or identity',()=>{
  const f=fixture(),fields=f.totals(.94);expect(f.run().checks[0].calculation.state).toBe('blocked');
  f.identify(fields);const original=canonicalSha256(f.e),r=f.run(),c=r.checks[0].calculation;
  expect(c.state).toBe('calculated');expect(c.difference).toMatchObject({minor_units:0});
  expect(c.input.operands[0].observation_id).toBe(fields[0].candidate_id);expect(c.input.operands[0].source.reading_receipt_sha256).toBe(original);
  expect(c.input.operands[0].source.locator).toContain('100.00');expect(fields[0].confidence).toBe(.94);expect(canonicalSha256(f.e)).toBe(original);
  expect(r.publication_authority).toBe(false);expect(c.legal_requirement_status).toBe('not_determined');
 });
 it('does not turn confidence alone into a verified reading',()=>{
  const f=fixture();f.totals(.94);const r=f.run();expect(r.checks[0].calculation.state).toBe('blocked');expect(r.completions.customer_requests.length).toBeGreaterThan(0);
  expect(f.build().answer_bindings).toHaveLength(2);
 });
 it('accepts only independently identified agreeing scalar observations',()=>{
  const f=fixture(),fields=f.totals(.94),duplicate={...structuredClone(fields[0]),candidate_id:randomUUID()};f.e.fields.push(duplicate);f.identify([...fields,duplicate]);
  const calculation=f.run().checks[0].calculation;expect(calculation.state).toBe('calculated');expect(calculation.input.operands[0].source.locator).toContain(duplicate.candidate_id);
 });
 it.each(['source','candidate','extraction'] as const)('rejects altered identified %s bindings',kind=>{
  const f=fixture();f.identify(f.totals(.94));const r=f.e.customer_readings![0];
  if(kind==='source')r.source_sha256='f'.repeat(64);if(kind==='candidate')r.candidate_sha256='f'.repeat(64);if(kind==='extraction')r.normalized_extraction_sha256='f'.repeat(64);
  expect(f.build).toThrow('DOCUMENT_READING_BINDING_MISMATCH');
 });
 it('keeps contradictory observed values blocked even when both have identified readings',()=>{
  const f=fixture(),fields=f.totals(.94),conflict=f.money('gross_salary','110.00',.94);f.identify([...fields,conflict]);
  const calculation=f.run().checks[0].calculation;expect(calculation).toMatchObject({state:'blocked',difference:null});expect(calculation.input.operands[0].state).toBe('conflict');
 });
 it.each(['currency','raw mapping','low quality','failed'] as const)('blocks %s instead of returning financial zero',kind=>{
  const f=fixture(),fields=f.totals();if(kind==='currency'&&fields[0].field==='gross_salary'&&fields[0].normalized_value)fields[0].normalized_value.currency='XTS';
  if(kind==='raw mapping')fields[0].raw_value='1000.00';if(kind==='low quality')f.e.document_quality_confidence=.5;if(kind==='failed')f.e.status='failed';
  const r=f.run();expect(r.checks.every(c=>c.calculation.state==='blocked')).toBe(true);expect(r.checks.every(c=>c.calculation.difference===null)).toBe(true);
 });
 it('does not let identified readings discharge low document quality',()=>{
  const f=fixture(),fields=f.totals(.94);f.e.document_quality_confidence=.5;f.identify([...fields,f.p]);
  expect(f.run().checks[0].calculation.state).toBe('blocked');
 });
 it('rejects a foreign candidate source rather than repinning it to the current file',()=>{
  const f=fixture();f.totals()[0].source.document_id=randomUUID();expect(f.build).toThrow('DOCUMENT_REVIEW_EXTRACTION_IDENTITY');
 });
 it('keeps non-payslip inventory and a targeted financial source gap without calculations',()=>{
  const f=fixture();f.totals();f.e.detected_document_type='unknown';const r=f.run();
  expect(r.documents[0].kind).toBe('other');expect(r.checks).toHaveLength(0);expect(r.coverage_gaps[0].kind).toBe('missing_source');
 });
 it('refuses period mismatch rather than silently assigning the requested month',()=>{
  const f=fixture();f.totals();if(f.p.field==='salary_period'&&f.p.normalized_value){f.p.normalized_value.month=7;f.p.normalized_value.start_date='2026-07-01';f.p.normalized_value.end_date='2026-07-31';}
  const r=f.run();expect(r.checks).toHaveLength(0);expect(r.coverage_gaps[0].check_id).toContain('period');
 });
});
describe('bounded source rows through the existing RuleSpec runtime',()=>{
 it('computes a located source row and labels a discrepancy arithmetic only',()=>{
  const f=fixture();f.row('hourly_base','2','50.00','99.99');const r=f.run(),c=r.checks[0].calculation;
  expect(c.state).toBe('calculated');expect(c.expected).toMatchObject({minor_units:10000});expect(c.difference).toMatchObject({minor_units:1});expect(c.claim).toBe('document_arithmetic');
  expect(r.legal_debt_total).toBeNull();expect(c.input.operands[0].source.label).toContain('שכר סינתטי');
 });
 it('does not multiply an already-priced OT unit rate again',()=>{
  const f=fixture();f.money('hourly_rate','60.00');f.row('overtime_125','2','75.00','150.00','125%');
  const c=f.run().checks[0].calculation;expect(c.state).toBe('calculated');expect(c.expected).toMatchObject({minor_units:15000});expect(c.input.operation).toMatchObject({factor_refs:['quantity']});
 });
 it('applies an explicit displayed percentage only to an identified matching base rate',()=>{
  const f=fixture();f.money('hourly_rate','60.00');f.row('overtime_125','2','60.00','150.00','125%');
  const c=f.run().checks[0].calculation;expect(c.expected).toMatchObject({minor_units:15000});expect(c.input.operation).toMatchObject({factor_refs:['quantity','percentage']});
 });
 it('deduplicates the same physical source row while preserving observation IDs',()=>{
  const f=fixture(),r=f.row(),copy={...structuredClone(r),component_id:randomUUID()};f.e.additional_components.push(copy);
  const result=f.run();expect(result.checks).toHaveLength(1);expect(result.checks[0].calculation.input.operands[0].source.locator).toContain(copy.component_id);
 });
 it('retains rows on different pages and never constructs an unproven aggregate',()=>{
  const f=fixture(),r=f.row(),copy={...structuredClone(r),component_id:randomUUID(),source:{...r.source,page:2}};f.e.additional_components.push(copy);
  expect(f.run().checks).toHaveLength(2);expect(f.run().checks.every(c=>c.calculation.input.operation.kind==='product')).toBe(true);
 });
 it('blocks conflicting observations of the same row without selecting a convenient amount',()=>{
  const f=fixture(),r=f.row(),copy={...structuredClone(r),component_id:randomUUID(),amount_raw:'101.00',amount:normalizeMoney('101.00')};f.e.additional_components.push(copy);
  const checks=f.run().checks;expect(checks).toHaveLength(1);expect(checks[0].calculation.state).toBe('blocked');expect(checks[0].calculation.input.operands.every(o=>o.state==='conflict')).toBe(true);
 });
 it.each(['blank quantity','XTS','wrong mapping','confidence','warning'] as const)('keeps %s row as explicit completion rather than success',kind=>{
  const f=fixture(),r=f.row();if(kind==='blank quantity'){r.quantity_raw=null;r.quantity=null;}if(kind==='XTS'&&r.rate)r.rate.currency='XTS';if(kind==='wrong mapping')r.quantity='3';if(kind==='confidence')r.confidence=.94;if(kind==='warning')r.warning_flags=['ocr_ambiguous'];
  expect(f.run().checks[0].calculation.state).toBe('blocked');expect(f.run().completions.customer_requests.length).toBeGreaterThan(0);
 });
 it('does not calculate an unknown row semantic or invent absent operands',()=>{
  const f=fixture();f.row('unknown');expect(f.run().checks).toHaveLength(0);
 });
});
describe('pension ratios need a supported base/component relationship',()=>{
 it('blocks arbitrary normalized labels without a source relationship',()=>{
  const f=fixture();f.money('pension_base','5000.00');f.money('pension_employee_contribution','300.00');
  expect(f.run().checks[0].calculation.state).toBe('blocked');expect(f.run().coverage_gaps[0].check_id).toContain('relationship');
 });
 it('computes 6% only when the source explicitly connects the base and contribution',()=>{
  const f=fixture(),b=f.money('pension_base','5000.00'),c=f.money('pension_employee_contribution','300.00');
  b.source.text_fragment=c.source.text_fragment='pension base 5000.00; employee pension contribution 300.00';
  const r=f.run().checks[0].calculation;expect(r.state).toBe('calculated');expect(r.observed_ratio).toMatchObject({numerator:'3',denominator:'50'});expect(r.remittance_status).toBe('not_assessed');
 });
 it('refuses a study fund relabelled as pension',()=>{
  const f=fixture(),b=f.money('pension_base','5000.00'),c=f.money('pension_employee_contribution','300.00');b.source.text_fragment=c.source.text_fragment='pension base 5000.00 study fund 300.00';
  const op=(f.build().checks[0].calculation as DocumentReviewCalculationInput).operation;expect(op).toMatchObject({kind:'observed_ratio',same_period_and_base:false});
 });
});
