import {describe,it,expect} from 'vitest';
import {calculateDocumentReview,replayDocumentReviewCalculation,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {resolveVacationEntitlement,vacationEntitlementInputSchema,VACATION_APPLICABILITY,vacationLegalSource,type VacationEntitlementInput} from './index.ts';

const source={document_id:'synthetic-document',version_id:'synthetic-version',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic annual register; no actual customer',label:'Synthetic source',reading:'identified_document_reading' as const,reading_receipt_sha256:'b'.repeat(64)};
const known=<T>(value:T)=>({state:'known' as const,value,source,basis:'identified_document_reading' as const});
const number=(value:string,unit:'count'|'days'|'calendar_days'|null):DocumentReviewOperand=>({id:'synthetic.value',observation_id:`synthetic.${unit??'money'}`,state:'observed',printed_value:value,representation:unit===null?'money_ils':'integer',quantity_unit:unit,precision:'source_exact',source});
function fixture():VacationEntitlementInput{return vacationEntitlementInputSchema.parse({schema_version:'vacation-entitlement-input-v1',catalog_id:'il.review.vacation.general.2026',catalog_version:'1.0.0',
 case_id:'synthetic-case',run_id:'synthetic-run',check_prefix:'synthetic.vacation',period:{from:'2026-06-01',to:'2026-06-30'},calendar_year:2026,evaluated_at:'2026-09-12T08:00:00Z',
 source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic-case'}],
 facts:{aged_21_or_more:known(true),under_60:known(true)},seniority_year:number('1','count'),
 annual_basis:{employment_start:known('2026-01-01'),employment_end:known('2026-06-30'),complete_year_evidence:known(true),covered_through:known('2026-06-30'),actual_workdays:number('100','days')},
 leave_pay:null,applicability:Object.keys(VACATION_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic source-scoped AI assessment; not human attestation',sources:[vacationLegalSource('law',1,decision_id)],valid_until:null})),remittance_status:'missing'});}
function pay(i:VacationEntitlementInput){i.leave_pay={mode:'hourly_quarter',leave_period:{from:'2026-06-01',to:'2026-06-05'},quarter_period:{from:'2026-03-01',to:'2026-05-31'},wage:number('9000.00',null),leave_calendar_days:number('5','calendar_days'),recorded:null};return i;}
const results=(i:VacationEntitlementInput)=>resolveVacationEntitlement(i).checks.map(c=>calculateDocumentReview(c.calculation));
const output=(i:VacationEntitlementInput,suffix:string)=>results(i).find(c=>c.input.check_id.endsWith(suffix))!;

describe('source-bound vacation through the ordinary RuleSpec candidate runtime',()=>{
 it.each([[1,16],[5,16],[6,18],[7,21],[8,22],[13,27],[14,28],[30,28]])('derives year %s quota as %s statutory calendar days',(year,expected)=>{
  const i=fixture();i.seniority_year!.printed_value=String(year);expect(output(i,'annual.quota')).toMatchObject({state:'calculated',expected:{kind:'integer',value:expected,unit:'calendar_days'},claim:'conditional_entitlement_candidate'});
 });
 it('computes a completed part-year without substituting a full-year threshold or monthly accrual',()=>{
  const i=fixture(),r=output(i,'annual.prorated');expect(r.expected).toEqual({kind:'integer',value:6,unit:'calendar_days'});
  expect(r.input.operands.find(o=>o.observation_id==='parameter.annual.threshold')?.printed_value).toBe('240');expect(replayDocumentReviewCalculation(r)).toEqual(r);
  expect(resolveVacationEntitlement(i).rule_metadata).toMatchObject({net_workday_conversion:false,annual_result_is_monthly_accrual:false,payroll_balance_is_entitlement:false,redemption_assessed:false});
 });
 it.each([[0,0],[12,0],[13,1],[100,8],[199,15],[200,16],[240,16]])('uses 200 only with an evidenced whole calendar year: %s -> %s',(workdays,expected)=>{
  const i=fixture();i.evaluated_at='2027-01-02T00:00:00Z';i.annual_basis!.employment_end=known('2026-12-31');i.annual_basis!.covered_through=known('2026-12-31');i.annual_basis!.actual_workdays!.printed_value=String(workdays);
  expect(output(i,'annual.prorated').expected).toEqual({kind:'integer',value:expected,unit:'calendar_days'});
 });
 it('does not treat an ongoing incomplete 2026 year as complete, even with a caller completion flag',()=>{
  const i=fixture();i.annual_basis!.employment_end=known('ongoing');i.annual_basis!.covered_through=known('2026-09-01');const r=resolveVacationEntitlement(i);
  expect(r.checks.map(c=>c.check_id)).toEqual(['synthetic.vacation.annual.quota']);expect(r.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'vacation.annual_complete_interval',state:'unknown'})]));
  i.annual_basis!.covered_through=known('2026-12-31');expect(resolveVacationEntitlement(i).checks).toHaveLength(1);
 });
 it.each(['missing','unknown','conflict','stale','expired','unreadable'] as const)('preserves %s workday evidence without zero or global suppression',state=>{
  const i=fixture();i.annual_basis!.actual_workdays!.state=state;i.annual_basis!.actual_workdays!.printed_value=null;const r=resolveVacationEntitlement(i);
  expect(r.checks).toHaveLength(1);expect(r.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'vacation.actual_workdays',state,dependent_check_ids:['synthetic.vacation.annual.prorated']})]));
 });
 it('rejects impossible annual counts and unit relabelling',()=>{
  const i=fixture();i.annual_basis!.actual_workdays!.printed_value='200';expect(()=>resolveVacationEntitlement(i)).toThrow('VACATION_WORKDAYS_EXCEED_EMPLOYMENT');
  i.annual_basis!.actual_workdays!.printed_value='100';i.seniority_year!.quantity_unit='days';expect(()=>resolveVacationEntitlement(i)).toThrow('VACATION_QUANTITY_UNIT');
 });
 it('retains source and factual trace for the chosen 200/240 threshold, without inventing a printed boolean',()=>{
  const r=output(fixture(),'annual.prorated');expect(r.input.operands.some(o=>o.representation==='boolean')).toBe(false);
  if(r.input.operation.kind!=='candidate_rule')throw Error('synthetic candidate');const d=r.input.operation.decisions.find(d=>d.decision_id==='vacation.complete_annual_scope')!;
  expect(JSON.parse(d.explanation)).toMatchObject({values:{whole_calendar_year:false,employment_end:'2026-06-30'},legal_applicability_approved:false});
 });
 it('does not derive legal applicability from a declaration or source-free acceptance',()=>{
  const i=fixture();i.applicability.find(d=>d.decision_id==='vacation.general_section3')!.basis='customer_declaration';expect(output(i,'annual.quota').state).toBe('blocked');
  const j=fixture();j.applicability.find(d=>d.decision_id==='vacation.general_section3')!.sources=[];expect(output(j,'annual.quota').state).toBe('blocked');
 });
 it('rejects foreign and changed law/source pins',()=>{
  const i=fixture();i.source_manifest[0].case_id='other-case';expect(()=>resolveVacationEntitlement(i)).toThrow('VACATION_CASE_SOURCE_BINDING');
  const j=fixture();j.applicability[0].sources[0].file_sha256='c'.repeat(64);expect(()=>resolveVacationEntitlement(j)).toThrow('VACATION_LEGAL_SOURCE_PIN');
 });
 it('blocks expired and conflicting assessments, while leaving source observations intact',()=>{
  const i=fixture();i.applicability[0].valid_until='2026-09-11T00:00:00Z';expect(output(i,'annual.quota').state).toBe('blocked');
  i.applicability[0].valid_until=null;i.applicability[0].state='conflict';expect(output(i,'annual.quota').state).toBe('blocked');expect(i.seniority_year?.state).toBe('observed');
 });
 it('computes actual hourly leave pay independently of missing annual data and preserves remittance independence',()=>{
  const i=pay(fixture());i.seniority_year=null;i.annual_basis=null;const r=output(i,'pay.expected');expect(r).toMatchObject({state:'calculated',expected:{kind:'money',currency:'ILS',minor_units:50000},remittance_status:'missing'});
  expect(replayDocumentReviewCalculation(r)).toEqual(r);expect(resolveVacationEntitlement(i).gaps.some(g=>g.dependency_id==='vacation.seniority_year')).toBe(true);
 });
 it('rounds only once at the total rather than rounding a daily wage first',()=>{
  const i=pay(fixture());i.leave_pay!.wage!.printed_value='1000.00';expect(output(i,'pay.expected').expected).toMatchObject({minor_units:5556});
 });
 it('does not choose an alternative quarter, infer calendar days from hours, or ignore a foreign review month',()=>{
  const i=pay(fixture());i.applicability=i.applicability.filter(d=>d.decision_id!=='vacation.pay_quarter_selection');expect(output(i,'pay.expected').state).toBe('blocked');
  const j=pay(fixture());if(j.leave_pay?.mode!=='hourly_quarter')throw Error('synthetic hourly');j.leave_pay.leave_calendar_days!.quantity_unit='hours';expect(()=>resolveVacationEntitlement(j)).toThrow('VACATION_QUANTITY_UNIT');
  const k=pay(fixture());k.leave_pay!.leave_period.to='2026-07-01';expect(()=>resolveVacationEntitlement(k)).toThrow('VACATION_LEAVE_REVIEW_PERIOD');
 });
 it.each([{from:'2026-03-01',to:'2026-06-01'},{from:'2025-01-01',to:'2025-03-31'},{from:'2026-03-02',to:'2026-05-31'}])('rejects incomplete, future or outside-window quarters %j',quarter_period=>{
  const i=pay(fixture());if(i.leave_pay?.mode!=='hourly_quarter')throw Error('synthetic hourly');i.leave_pay.quarter_period=quarter_period;expect(()=>resolveVacationEntitlement(i)).toThrow('VACATION_QUARTER_PERIOD');
 });
 it('uses a sourced monthly leave-period wage without a hidden daily divisor',()=>{
  const i=fixture();i.leave_pay={mode:'monthly_maintained_wage',leave_period:{from:'2026-06-01',to:'2026-06-05'},wage:number('1234.56',null),recorded:null};
  expect(output(i,'pay.expected').expected).toMatchObject({minor_units:123456});i.applicability=i.applicability.filter(d=>d.decision_id!=='vacation.pay_monthly_period');expect(output(i,'pay.expected').state).toBe('blocked');
 });
 it.each([['400.00',10000],['500.00',0],['600.00',-10000]])('compares only an allocated %s recorded leave payment with signed difference',(amount,expected)=>{
  const i=pay(fixture());i.leave_pay!.recorded=number(amount,null);const r=output(i,'pay.comparison');expect(r).toMatchObject({state:'calculated',difference:{minor_units:expected},comparison_basis:'document_allocation'});
  i.applicability=i.applicability.filter(d=>d.decision_id!=='vacation.pay_recorded_allocation');expect(output(i,'pay.comparison').state).toBe('blocked');expect(output(i,'pay.expected').state).toBe('calculated');
 });
 it('keeps independent check fingerprints unchanged when only annual attendance changes',()=>{
  const i=pay(fixture()),before=results(i);i.annual_basis!.actual_workdays!.printed_value='99';const after=results(i);
  for(const suffix of ['annual.quota','pay.expected'])expect(after.find(r=>r.input.check_id.endsWith(suffix))!.dependency_fingerprint).toBe(before.find(r=>r.input.check_id.endsWith(suffix))!.dependency_fingerprint);
  expect(after.find(r=>r.input.check_id.endsWith('annual.prorated'))!.dependency_fingerprint).not.toBe(before.find(r=>r.input.check_id.endsWith('annual.prorated'))!.dependency_fingerprint);
  i.run_id='retry';expect(canonicalSha256(results(i).map(r=>r.dependency_fingerprint))).toBe(canonicalSha256(after.map(r=>r.dependency_fingerprint)));
 });
 it('rejects duplicate decisions, unsupported catalog/month and a forged human-attestation field',()=>{
  const i=fixture();i.applicability.push(i.applicability[0]);expect(()=>resolveVacationEntitlement(i)).toThrow('VACATION_DECISION_SET');
  const j=fixture();j.period={from:'2026-04-01',to:'2026-04-30'};expect(()=>resolveVacationEntitlement(j)).toThrow('VACATION_SUPPORTED_MONTH_REQUIRED');
  expect(()=>resolveVacationEntitlement({...fixture(),human_attestation:'approved'})).toThrow();
 });
});
