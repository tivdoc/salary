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
import {reviewInputFromPayslips,PAYSLIP_FINANCIAL_SOURCE_POLICY,PAYSLIP_FINANCIAL_SOURCE_FACT,type PayslipFinancialSourceProof} from './payslip-adapter.ts';
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
 const build=(financial_source_proofs?:readonly PayslipFinancialSourceProof[])=>reviewInputFromPayslips({financial_source_proofs,case_id:d.case_id,period,purchased_scope:{order_id:'synthetic-paid-order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics:['minimum_wage','working_time','pension','travel','convalescence','bonuses']},snapshot:{...f.stored,documents:[d],extractions:[e]}});
 const run=()=>runDocumentReview(documentReviewInputSchema.parse(build()),'synthetic-normal-review-run');
 const identify=(candidates:NormalizedCandidateField[],includeDeductions=false)=>{
  const {customer_readings:_,...machine}=e;void _;
  const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,input_sha256:d.content_sha256,expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256({final_extraction:machine}),run:{result:{final_extraction:machine}}};
  const answers=candidates.filter(c=>includeDeductions||c.field!=='total_deductions').map(c=>{const target=documentFieldTarget({checkpoint,policyVersion:'synthetic-adapter-reading-v1',candidateId:c.candidate_id});return {id:randomUUID(),case_id:d.case_id,scope_month:'2026-06',code:`document_field:${target.target_sha256}`,answer_kind:'choice',answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2026-07-03T12:00:00Z',field_target:target};});
  e.customer_readings=[...savedDocumentFieldReadings({caseId:d.case_id,month:'2026-06',policyVersion:'synthetic-adapter-reading-v1',journal:{answers},checkpoint})];
 };
 const totals=(confidence=1)=>[money('gross_salary','100.00',confidence),money('total_deductions','10.00'),money('net_salary','90.00',confidence)];
 return {d,e,p,build,run,money,row,identify,totals};
}
function financialFixture(){
 const f=fixture(),cells=[f.p,...f.totals(.94)];
 for(const c of cells)c.source={...c.source,text_fragment:`Synthetic current ${c.field}: ${c.raw_value}`,source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'חודש נוכחי'}};
 const proof=():PayslipFinancialSourceProof=>{
  const {customer_readings:ignored,...original}=f.e;void ignored;
  return {policy_version:PAYSLIP_FINANCIAL_SOURCE_POLICY,case_id:f.d.case_id,document_id:f.d.document_id,source_sha256:f.d.content_sha256,
   normalized_extraction_sha256:canonicalSha256(original),provider_receipt_sha256:'b'.repeat(64),source_page_count:f.e.quality_metrics!.page_count,complete_original_source:true};
 };
 return {...f,cells,proof,confirm:()=>f.identify(cells,true)};
}
describe('narrow requested financial source receipt',()=>{
 it('accepts four identified current cells and physical source proof without marking the whole payslip reviewed',()=>{
  const f=financialFixture();f.confirm();const original=structuredClone(f.e),input=documentReviewInputSchema.parse(f.build([f.proof()]));
  const completion=input.completion_input as {documents:{review:string;review_completed_fact_keys:string[]}[];evidence:{fact_key:string;value:string}[]};
  expect(completion.documents[0]).toMatchObject({review:'partial',review_completed_fact_keys:[PAYSLIP_FINANCIAL_SOURCE_FACT]});
  expect(completion.evidence).toHaveLength(1);expect(completion.evidence[0].fact_key).toBe(PAYSLIP_FINANCIAL_SOURCE_FACT);
  expect(JSON.parse(completion.evidence[0].value).cells).toHaveLength(4);
  expect(f.e).toEqual(original);expect(f.e.earnings_components_complete).toBe(false);expect(f.e.fields.some(c=>c.field==='pension_base')).toBe(false);
 });
 it.each(['no_physical_proof','no_readings','missing_cell','one_unconfirmed','unknown_scope','cumulative_scope','cropped','partial','foreign_period','conflict'])(
  'does not emit positive source evidence for %s',kind=>{
   const f=financialFixture();
   if(kind==='missing_cell')f.e.fields=f.e.fields.filter(c=>c.field!=='total_deductions');
   if(kind==='unknown_scope'||kind==='cumulative_scope')f.cells[1].source.source_scope!.period_kind=kind==='unknown_scope'?'unknown':'cumulative';
   if(kind==='cropped')f.e.warnings.push('cropped_content');
   if(kind==='partial')f.e.status='partial';
   if(kind==='foreign_period')f.d.document_period={start_date:'2026-05-01',end_date:'2026-05-31'};
   if(kind==='conflict')f.money('gross_salary','110.00');
   if(kind!=='no_readings')f.identify(f.e.fields, true);
   if(kind==='one_unconfirmed')f.e.customer_readings=f.e.customer_readings!.filter(r=>r.candidate_id!==f.cells[2].candidate_id);
   const input=f.build(kind==='no_physical_proof'?undefined:[f.proof()]);
   const completion=input.completion_input as {documents:{review_completed_fact_keys?:string[]}[];evidence:unknown[]};
   expect(completion.evidence).toEqual([]);expect(completion.documents[0].review_completed_fact_keys).toBeUndefined();
  });
 it.each(['source','case','receipt_binding','page_count'])( 'rejects altered physical proof %s',kind=>{
  const f=financialFixture();f.confirm();const proof={...f.proof()};
  if(kind==='source')proof.source_sha256='f'.repeat(64);
  if(kind==='case')proof.case_id=randomUUID();
  if(kind==='receipt_binding')proof.normalized_extraction_sha256='e'.repeat(64);
  if(kind==='page_count')proof.source_page_count++;
  expect(()=>f.build([proof])).toThrow('DOCUMENT_REVIEW_FINANCIAL_SOURCE_PROOF_BINDING');
 });
});

describe('saved extraction to ordinary source review',()=>{
 it('admits each exact mapped row cell separately and never confirms its siblings or a different source label',()=>{
  const f=fixture(),row=f.row();row.confidence=.94;row.source.text_fragment=row.source_label;
  const rate=f.money('hourly_rate',row.rate_raw!,.94),amount=f.money('base_monthly_salary',row.amount_raw!,.94);
  const quantity:NormalizedCandidateField={...structuredClone(rate),candidate_id:randomUUID(),field:'regular_hours',raw_value:row.quantity_raw!,normalized_value:{amount:row.quantity!,unit:'hours_per_month'}};
  f.e.fields.push(quantity);
  for(const candidate of [rate,amount,quantity])candidate.source.text_fragment=`${row.source_label}: ${candidate.raw_value}`;
  f.identify([rate]);let result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('blocked');expect(result.input.operands.map(o=>o.state)).toEqual(['observed','unknown','unknown']);
  f.identify([rate,amount,quantity]);result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('calculated');expect(result.difference).toMatchObject({minor_units:0});
  expect(result.input.operands.every(o=>o.source.reading==='identified_document_reading')).toBe(true);expect(row.confidence).toBe(.94);
  const headerRate={...structuredClone(rate),candidate_id:randomUUID(),source:{...rate.source,text_fragment:`תעריף שעה: ${rate.raw_value}`}};
  f.e.fields.push(headerRate);f.identify([rate,headerRate,amount,quantity]);
  expect(f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation.state).toBe('calculated');
  // A new saved source hash and genuine reading still cannot turn a different
  // labeled scalar into this row's quantity merely because the number agrees.
  quantity.source.text_fragment=`תווית אחרת: ${quantity.raw_value}`;f.identify([rate,headerRate,amount,quantity]);
  result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('blocked');expect(result.input.operands.find(o=>o.id==='quantity')?.state).toBe('unknown');
 });
 it('uses a separately identified corrected cell through the normal engine while preserving provider observations',()=>{
  const f=fixture(),fields=f.totals(.94),gross=fields[0];gross.raw_value='99.00';gross.normalized_value=normalizeMoney('99.00');
  f.identify(fields);const reading=f.e.customer_readings!.find(r=>r.candidate_id===gross.candidate_id)!;
  reading.correction={schema_version:'document-field-correction-v1',raw_value:'100.00',normalized_value:normalizeMoney('100.00'),verification_sha256:'e'.repeat(64)};
  const before=structuredClone(f.e),result=f.run(),check=result.checks[0].calculation;
  expect(check.state).toBe('calculated');expect(check.difference).toMatchObject({minor_units:0});
  expect(check.input.operands[0]).toMatchObject({printed_value:'100.00',source:{reading:'identified_document_reading'}});
  expect(gross).toMatchObject({raw_value:'99.00',confidence:.94,normalized_value:{minor_units:9900}});expect(f.e).toEqual(before);
  f.e.customer_readings=f.e.customer_readings!.filter(r=>r.candidate_id!==gross.candidate_id);
  expect(f.run().checks[0].calculation.state).toBe('blocked');expect(gross.raw_value).toBe('99.00');
 });
 it('keeps the corrected scalar and its exact copied row cell consistent without changing the saved row',()=>{
  const f=fixture(),row=f.row('hourly_base','2','50.00','99.00');row.confidence=.94;row.source.text_fragment=row.source_label;
  const amount=f.money('base_monthly_salary','99.00',.94),rate=f.money('hourly_rate','50.00',.94);
  const quantity:NormalizedCandidateField={...structuredClone(rate),candidate_id:randomUUID(),field:'regular_hours',raw_value:'2',normalized_value:{amount:'2',unit:'hours_per_month'}};f.e.fields.push(quantity);
  for(const c of [amount,rate,quantity])c.source.text_fragment=`${row.source_label}: ${c.raw_value}`;
  f.identify([amount,rate,quantity]);const r=f.e.customer_readings!.find(r=>r.candidate_id===amount.candidate_id)!;
  r.correction={schema_version:'document-field-correction-v1',raw_value:'100.00',normalized_value:normalizeMoney('100.00'),verification_sha256:'a'.repeat(64)};
  const original=structuredClone(f.e),result=f.run().checks.find(c=>c.check_id.includes('.row.'))!.calculation;
  expect(result.state).toBe('calculated');expect(result.difference).toMatchObject({minor_units:0});
  expect(result.input.operands.find(o=>o.id==='amount')).toMatchObject({printed_value:'100.00',source:{reading:'identified_document_reading'}});
  expect(result.input.operands.find(o=>o.id==='amount')?.source.locator).toContain('99.00');expect(f.e).toEqual(original);expect(row.amount?.minor_units).toBe(9900);
 });
 it.each(['value','currency','month'] as const)('rejects a forged corrected %s instead of trusting the proposed normalized value',kind=>{
  const f=fixture(),fields=f.totals(.94);f.identify(fields);const r=f.e.customer_readings![0];
  r.correction={schema_version:'document-field-correction-v1',raw_value:kind==='currency'?'USD 100':'100.00',normalized_value:kind==='value'?normalizeMoney('900.00'):normalizeMoney('100.00'),verification_sha256:'e'.repeat(64)};
  if(kind==='month')r.month='2026-07';
  expect(f.build).toThrow(/DOCUMENT_READING_(?:CORRECTION_INVALID|BINDING_MISMATCH)/u);
 });
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
