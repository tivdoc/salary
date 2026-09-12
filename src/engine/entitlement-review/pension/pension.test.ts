import {describe,it,expect} from 'vitest';
import {calculateDocumentReview,replayDocumentReviewCalculation,documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import {pensionEntitlementInputSchema,resolvePensionEntitlement,resolvePensionEligibility,PENSION_APPLICABILITY,pensionLegalSource,type PensionEntitlementInput} from './index.ts';
import {pensionRecordedFixture} from './recorded-fixture.ts';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';

const sha='a'.repeat(64),source={document_id:'synthetic-pension-document',version_id:'synthetic.pension.v1',file_sha256:sha,page:1,locator:'synthetic wage and employment declaration',label:'synthetic pension source',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
function input():PensionEntitlementInput{
 const known=<T>(value:T)=>({state:'known',value,source,basis:'identified_document_reading'});
 return pensionEntitlementInputSchema.parse({schema_version:'pension-entitlement-input-v1',catalog_id:'il.review.pension.general.2026',catalog_version:'1.0.0',case_id:'synthetic-case',run_id:'synthetic-run',check_prefix:'synthetic.pension',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:'synthetic-case'}],
  facts:{employment_start:known('2025-01-01'),employment_end:known('ongoing'),prior_coverage_at_start:known(false),continuous_employment:known(true),aged_21_or_more:known(true),under_60:known(true)},
  pensionable_wage:{id:'insured.wage',observation_id:'synthetic.wage',state:'observed',printed_value:'5000.00',representation:'money_ils',quantity_unit:null,precision:'printed_precision',source},eligible_interval_wage:null,
  applicability:Object.keys(PENSION_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic source-scoped assessment, no human approval and no service activation',sources:[pensionLegalSource('order2011',4,decision_id)],valid_until:null})),recorded:[],remittance_status:'missing'});
}
const outputs=(i:PensionEntitlementInput)=>resolvePensionEntitlement(i).checks.map(c=>calculateDocumentReview(c.calculation));
describe('bounded general pension entitlement through the existing RuleSpec runtime',()=>{
 it('calculates employee, employer and severance independently of missing remittance and recorded links',()=>{
  const i=input(),r=resolvePensionEntitlement(i),out=outputs(i);
  expect(out.map(c=>c.expected)).toEqual([30000,32500,30000].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  expect(r.gaps.map(g=>g.dependency_id)).toEqual(['pension.recorded.employee','pension.recorded.employer','pension.recorded.severance']);
  for(const c of out){expect(c.state).toBe('calculated');expect(c.claim).toBe('conditional_entitlement_candidate');expect(c.remittance_status).toBe('missing');expect(replayDocumentReviewCalculation(c)).toEqual(c);}
  expect(r.rule_metadata).toMatchObject({expected_is_cash_debt:false,recorded_is_fund_transfer:false,combined_employer_is_split:false,human_attestation:null,real_activation_allowed:false});
 });
 it('applies section 2 cap and independently specified per-component rounding',()=>{
  const i=input();i.pensionable_wage!.printed_value='20000.00';
  expect(outputs(i).map(c=>c.expected)).toEqual([82614,89499,82614].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  const r=outputs(i)[1];expect(r.input.operands.find(o=>o.id==='pension.cap')?.printed_value).toBe('13769.00');
  expect(r.input.operation.kind).toBe('candidate_rule');
 });
 it('keeps a sourced zero different from missing wage',()=>{
  const i=input();i.pensionable_wage!.printed_value='0.00';expect(outputs(i).every(c=>c.state==='calculated'&&c.expected?.kind==='money'&&c.expected.minor_units===0)).toBe(true);
  i.pensionable_wage=null;const r=resolvePensionEntitlement(i);expect(r.checks).toHaveLength(0);expect(r.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'pension.pensionable_wage',state:'missing'})]));
 });
 it.each(['missing','unknown','conflict','stale','expired','unreadable'] as const)('keeps %s eligibility evidence separate and asks only dependent checks',state=>{
  const i=input();i.facts.employment_start.value='2026-05-01';i.facts.prior_coverage_at_start={...i.facts.prior_coverage_at_start,state,value:null};const r=resolvePensionEntitlement(i);
  expect(r.checks).toHaveLength(0);expect(r.eligibility.state).toBe('unknown');expect(r.gaps[0]).toMatchObject({dependency_id:'pension.prior_coverage_at_start',state,dependent_check_ids:expect.arrayContaining(['synthetic.pension.employee.expected'])});
 });
 it('does not promote a customer declaration or missing assessment into legal applicability',()=>{
  const i=input();i.applicability=[];expect(outputs(i).every(c=>c.state==='blocked')).toBe(true);
  const j=input();j.applicability[0].basis='customer_declaration';expect(outputs(j).every(c=>c.state==='blocked')).toBe(true);
 });
 it('does not ask prior-coverage facts that cannot change the current month after six continuous months',()=>{
  const i=input();i.facts.prior_coverage_at_start={...i.facts.prior_coverage_at_start,state:'unknown',value:null};const r=resolvePensionEntitlement(i);
  expect(outputs(i).every(c=>c.state==='calculated')).toBe(true);expect(r.eligibility).toMatchObject({state:'eligible',accrual_from:null,first_execution_due:null,retroactive_to_start:null});
  expect(r.gaps.some(g=>g.dependency_id.includes('prior_coverage'))).toBe(false);
 });
 it('pins consumed eligibility values and sources without changing checks for an irrelevant prior-coverage answer',()=>{
  const i=input(),before=resolvePensionEntitlement(i);i.facts.prior_coverage_at_start.value=true;const after=resolvePensionEntitlement(i);
  expect(after.input_sha256).not.toBe(before.input_sha256);expect(canonicalSha256(after.checks)).toBe(canonicalSha256(before.checks));
  const op=documentReviewCalculationInputSchema.parse(after.checks[0].calculation).operation;if(op.kind!=='candidate_rule')throw Error('synthetic candidate');
  const evidence=op.decisions.find(d=>d.decision_id==='pension.factual_eligibility')!;expect(evidence.sources).toEqual([source]);
  const trace=JSON.parse(evidence.explanation);expect(trace).toMatchObject({legal_applicability_approved:false,values:{employment_start:'2025-01-01',aged_21_or_more:true}});expect(trace.values).not.toHaveProperty('prior_coverage_at_start');
  i.facts.employment_start.value='2024-01-01';expect(canonicalSha256(resolvePensionEntitlement(i).checks)).not.toBe(canonicalSha256(after.checks));
 });
 it('computes an explicit base-composition scenario without accepting the unknown assessment',()=>{
  const i=input(),d=i.applicability.find(d=>d.decision_id==='pension.pensionable_wage')!;d.state='unknown';i.conditional_assumptions=[{decision_id:'pension.pensionable_wage',explanation:'Only if the documented amount is the governing insured wage for this month.'}];
  const r=outputs(i)[0];expect(r).toMatchObject({state:'calculated',counterfactual_only:true,expected:{minor_units:30000},unresolved_conditions:[{decision:{state:'unknown'}}]});
  expect(d.state).toBe('unknown');
  d.state='conflict';expect(()=>outputs(i)).toThrow('DOCUMENT_REVIEW_ASSUMPTION_NOT_UNRESOLVED_SOURCED_DECISION');
 });
 it('blocks expired and contradictory applicability decisions',()=>{
  const i=input();i.applicability[0].valid_until='2026-09-11T00:00:00Z';expect(outputs(i).every(c=>c.state==='blocked')).toBe(true);
  i.applicability[0].valid_until=null;i.applicability[0].state='conflict';expect(outputs(i).every(c=>c.state==='blocked')).toBe(true);
 });
 it('waits six months without treating the absence of eligibility as a financial zero',()=>{
  const i=input();i.facts.employment_start.value='2026-01-01';const r=resolvePensionEntitlement(i);
  expect(r.eligibility).toMatchObject({state:'waiting_period',accrual_from:'2026-07-01',retroactive_to_start:false});expect(r.checks).toHaveLength(0);
  i.period={from:'2026-07-01',to:'2026-07-31'};expect(outputs(i).every(c=>c.state==='calculated')).toBe(true);
 });
 it('separates day-one accrual from first execution and year-end timing',()=>{
  const i=input();i.facts.employment_start.value='2026-05-10';i.facts.prior_coverage_at_start.value=true;
  expect(resolvePensionEligibility(i).eligibility).toMatchObject({state:'eligible',accrual_from:'2026-05-10',first_execution_due:'2026-08-10',retroactive_to_start:true});
  i.facts.employment_start.value='2025-11-20';expect(resolvePensionEligibility(i).eligibility.first_execution_due).toBe('2025-12-31');
 });
 it('requires source wage for the eligible interval without inventing a prorated monthly base',()=>{
  const i=input();i.facts.employment_start.value='2025-12-15';const r=resolvePensionEntitlement(i);expect(r.eligibility.partial_waiting_month).toBe(true);expect(r.checks).toHaveLength(0);
  expect(r.gaps.some(g=>g.dependency_id==='pension.eligible_interval_wage')).toBe(true);
  i.eligible_interval_wage={period:{from:'2026-06-15',to:'2026-06-30'},operand:{...i.pensionable_wage!,printed_value:'1200.00'}};
  expect(outputs(i)[0].expected).toMatchObject({minor_units:7200});
  i.applicability=i.applicability.filter(d=>d.decision_id!=='pension.cap_interval');expect(outputs(i)[0].state).toBe('blocked');
  i.eligible_interval_wage.period.from='2026-06-14';expect(resolvePensionEntitlement(i).checks).toHaveLength(0);
 });
 it.each([['250.00',5000],['300.00',0],['350.00',-5000]] as const)('compares the exact %s recorded source without splitting or calling the difference a cash debt',(recorded,difference)=>{
  const i=input(),r=pensionRecordedFixture(recorded);i.case_id=r.case_id;i.source_manifest=r.source_manifest;i.pensionable_wage={...i.pensionable_wage!,source:r.operands[1].source};
  for(const f of Object.values(i.facts))f.source=r.operands[1].source;i.recorded=[{share:'employee',relationship_check:r}];
  const resolved=resolvePensionEntitlement(i),check=resolved.checks.find(c=>c.check_id.endsWith('employee.comparison'))!;
  expect(calculateDocumentReview(check.calculation)).toMatchObject({state:'calculated',expected:{minor_units:30000},recorded:{minor_units:Number(recorded)*100},difference:{minor_units:difference}});
  expect(documentReviewCalculationInputSchema.parse(check.calculation).operation).toHaveProperty('recorded_source_evidence.calculation_sha256');expect(resolved.comparison_evidence).toHaveLength(1);
 });
 it('retains an unknown relationship and rejects a forged source proof instead of silently comparing',()=>{
  const i=input(),r=pensionRecordedFixture('300.00',false);i.case_id=r.case_id;i.source_manifest=r.source_manifest;i.pensionable_wage={...i.pensionable_wage!,source:r.operands[1].source};for(const f of Object.values(i.facts))f.source=r.operands[1].source;i.recorded=[{share:'employee',relationship_check:r}];
  expect(resolvePensionEntitlement(i).checks).toHaveLength(3);expect(resolvePensionEntitlement(i).gaps.some(g=>g.dependency_id==='pension.relationship.employee')).toBe(true);
  if(r.source_structure?.kind!=='source_relationship'||r.source_structure.entry.subject.kind!=='source_relationship')throw Error('synthetic relationship');
  r.source_structure.entry.subject.base.sha256='b'.repeat(64);expect(()=>resolvePensionEntitlement(i)).toThrow('REVIEW_SOURCE_STRUCTURE_BINDING');
 });
 it('preserves a combined employer amount without assigning it to either obligation and rejects duplicate slots',()=>{
  const i=input(),r=pensionRecordedFixture('625.00',true,true);i.case_id=r.case_id;i.source_manifest=r.source_manifest;i.pensionable_wage={...i.pensionable_wage!,source:r.operands[1].source};for(const f of Object.values(i.facts))f.source=r.operands[1].source;i.recorded=[{share:'combined_employer',relationship_check:r}];
  const resolved=resolvePensionEntitlement(i);expect(resolved.checks).toHaveLength(3);expect(resolved.comparison_evidence).toEqual([]);expect(resolved.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'pension.combined_employer_split'})]));
  i.recorded.push(i.recorded[0]);expect(()=>resolvePensionEntitlement(i)).toThrow('PENSION_DUPLICATE_RECORDED_SHARE');
 });
 it('does not decide early insured termination or unsupported age/continuity',()=>{
  const i=input();i.facts.employment_start.value='2026-05-01';i.facts.prior_coverage_at_start.value=true;i.facts.employment_end.value='2026-06-15';
  expect(resolvePensionEntitlement(i).eligibility).toMatchObject({state:'unknown',termination_before_initial_execution:true});
  for(const key of ['aged_21_or_more','under_60','continuous_employment'] as const){const j=input();j.facts[key].value=false;expect(resolvePensionEntitlement(j).eligibility.state).toBe('unknown');}
 });
 it('rejects foreign source, tampered legal pin, invalid dates and unversioned period widening',()=>{
  const i=input();i.source_manifest[0].case_id='foreign-case';expect(()=>resolvePensionEntitlement(i)).toThrow('PENSION_CASE_SOURCE_BINDING');
  const j=input();j.applicability[0].sources[0].file_sha256='b'.repeat(64);expect(()=>resolvePensionEntitlement(j)).toThrow('PENSION_DECISION_LEGAL_SOURCE');
  const k=input();k.facts.employment_end.value='2024-01-01';expect(resolvePensionEntitlement(k)).toMatchObject({checks:[],eligibility:{state:'unknown'},gaps:expect.arrayContaining([expect.objectContaining({dependency_id:'pension.employment_dates',state:'conflict'})])});
  const l=input();l.period={from:'2026-04-01',to:'2026-04-30'};expect(()=>resolvePensionEntitlement(l)).toThrow('PENSION_SUPPORTED_MONTH_REQUIRED');
 });
});
