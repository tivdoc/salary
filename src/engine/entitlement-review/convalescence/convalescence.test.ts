import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema,replayDocumentReviewCalculation,type DocumentReviewSource,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import {CONVALESCENCE_DAYS_SPEC} from '../../legal-quality/sensitivity-rulespecs.ts';
import {resolveConvalescenceEntitlement,CONVALESCENCE_APPLICABILITY} from './resolve.ts';
import {CONVALESCENCE_SOURCE_REVIEW,CONVALESCENCE_CATALOG,convalescenceLegalDocuments,isPinnedConvalescenceLegalDocument} from './source-policy.ts';
import type {ConvalescenceEntitlementInput} from './contracts.ts';

const source:DocumentReviewSource={document_id:'synthetic.service',version_id:'v1',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic employment and payment record',label:'Synthetic evidence',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
const fact=<T>(value:T)=>({state:'observed' as const,value,source});
const money=(value:string|null):DocumentReviewOperand=>({id:'recorded.havraa',observation_id:'synthetic.havraa.amount',state:value===null?'missing':'observed',printed_value:value,representation:'money_ils',quantity_unit:null,precision:'source_exact',source});
function fixture():ConvalescenceEntitlementInput{
 const coverage={from:'2025-06-01',to:'2026-05-31'};
 return {schema_version:'convalescence-entitlement-input-v1',catalog_version:'1.0.0',case_id:'synthetic.case',run_id:'synthetic.run',check_prefix:'convalescence.synthetic',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic.case'}],
  population:fact('adult_private_general_21_59'),employment_start:fact('2025-06-01'),qualifying_service:fact('continuous_no_excluded_absence'),payment_coverage:fact(coverage),benefit_year:fact(2026),due_date:fact('2026-06-30'),
  segments:[{id:'segment.full',period:fact(coverage),fte:fact('0.5')}],recorded:money('1000'),recorded_coverage:fact(coverage),recorded_inventory:fact('complete_allocated'),
  applicability:Object.entries(CONVALESCENCE_APPLICABILITY).map(([decision_id,explanation])=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic assessment only. '+explanation,sources:[source],valid_until:null}))};
}
function calculation(i:ConvalescenceEntitlementInput,compared=true){const c=resolveConvalescenceEntitlement(i).checks.find(c=>c.check_id.endsWith(compared?'.comparison':'.expected'));if(!c)throw Error('Synthetic check unexpectedly absent');return calculateDocumentReview(c.calculation);}
describe('convalescence source-derived entitlement through RuleSpec',()=>{
 it('first completed year half-time is1128.75; comparison128.75, not automaticdayreduction',()=>{
  const r=calculation(fixture());expect(r).toMatchObject({state:'calculated',expected:{minor_units:112875},recorded:{minor_units:100000},difference:{minor_units:12875},human_attestation:null,real_activation_allowed:false});
  if(r.state==='calculated'){expect(replayDocumentReviewCalculation(r)).toEqual(r);expect(r.input.operation.kind).toBe('candidate_rule');}
 });
 it.each([[1,225750],[2,270900],[3,270900],[4,316050],[10,316050],[11,361200],[15,361200],[16,406350],[19,406350],[20,451500],[22,451500]])('derives employmentyear%s fromdates andusesindependentbandamount%s', (year,expected)=>{
  const i=fixture();i.employment_start=fact(`${2026-year}-06-01`);i.segments[0].fte=fact('1');
  const r=calculation(i);expect(r).toMatchObject({state:'calculated',expected:{minor_units:expected}});
  const resolved=resolveConvalescenceEntitlement(i);expect(resolved.selection_receipt.accrual_slices[0].employment_year).toBe(year);
  const c=documentReviewCalculationInputSchema.parse(resolved.checks[0].calculation);
  expect(c.operation.kind==='candidate_rule'&&c.operation.rule.nodes.some(n=>n.operation==='band.lookup')).toBe(true);
 });
 it('preserves zero and excess as signed comparisons without a debt ortransferclaim',()=>{
  const i=fixture();i.recorded=money('1128.75');expect(calculation(i)).toMatchObject({difference:{minor_units:0}});
  i.recorded=money('1200');expect(calculation(i)).toMatchObject({difference:{minor_units:-7125}});
 });
 it('splits a third-to-fourth employmentyear atactualanniversary, nohigherbandforallmonths',()=>{
  const i=fixture(),coverage={from:'2026-01-01',to:'2026-06-30'};i.employment_start=fact('2023-04-01');i.payment_coverage=fact(coverage);i.recorded_coverage=fact(coverage);i.segments=[{id:'half.year',period:fact(coverage),fte:fact('1')}];
  expect(resolveConvalescenceEntitlement(i).selection_receipt.accrual_slices).toMatchObject([{employment_year:3,calendar_days:90,year_calendar_days:365},{employment_year:4,calendar_days:91,year_calendar_days:365}]);
  // Independent fraction: (6*90+7*91)/365 *45150=145593.287... agorot.
  expect(calculation(i)).toMatchObject({expected:{minor_units:145593}});
 });
 it('computes partialyear only afterfirstyearcompleted and with explicitcandidatefraction',()=>{
  const i=fixture(),coverage={from:'2026-01-01',to:'2026-05-31'};i.payment_coverage=fact(coverage);i.recorded_coverage=fact(coverage);i.segments[0].period=fact(coverage);
  // 5 *151/365 *1/2 *45150=46696.232... agorot, not5/12permonth.
  expect(calculation(i)).toMatchObject({expected:{minor_units:46696}});
  i.applicability=i.applicability.filter(d=>d.decision_id!=='cv.proration');expect(calculation(i)).toMatchObject({state:'blocked',expected:null});
 });
 it('rounds once afterallsegments andretains exactsourceFTE',()=>{
  const i=fixture();i.segments[0].fte=fact('0.33333333');const baseline=calculation(i);
  i.segments=[{id:'first.part',period:fact({from:'2025-06-01',to:'2025-12-31'}),fte:fact('0.33333333')},{id:'second.part',period:fact({from:'2026-01-01',to:'2026-05-31'}),fte:fact('0.33333333')}];
  expect(calculation(i).expected).toEqual(baseline.expected);expect(calculation(i)).toMatchObject({expected:{minor_units:75250}});
 });
 it('uses366daydenominator foraleap-containing employmentyear withoutunitconversion',()=>{
  const i=fixture(),coverage={from:'2023-06-01',to:'2024-05-31'};i.employment_start=fact('2023-06-01');i.payment_coverage=fact(coverage);i.recorded_coverage=fact(coverage);i.segments[0].period=fact(coverage);
  expect(resolveConvalescenceEntitlement(i).selection_receipt.accrual_slices[0]).toMatchObject({calendar_days:366,year_calendar_days:366});expect(calculation(i)).toMatchObject({expected:{minor_units:112875}});
 });
 it('does not invent pay fromabsence ofrow orrequirepaymentto preserve expected',()=>{
  const i=fixture();i.recorded=null;i.recorded_inventory={state:'unknown',value:null,source};i.recorded_coverage={state:'missing',value:null,source};
  const r=resolveConvalescenceEntitlement(i);expect(r.checks).toHaveLength(1);expect(calculation(i,false)).toMatchObject({expected:{minor_units:112875},recorded:null,difference:null});
  expect(r.missing.filter(m=>m.fact_key.startsWith('cv.recorded')).every(m=>m.dependent_check_ids.every(id=>id.endsWith('.comparison')))).toBe(true);
 });
 it('changedpayment/allocation doesnotinvalidate expectedcheck, but changescomparison',()=>{
  const i=fixture(),before=resolveConvalescenceEntitlement(i);i.recorded=money('1128.75');i.recorded_inventory={...i.recorded_inventory,source:{...source,locator:'Another explicit payment allocation receipt'}};
  const after=resolveConvalescenceEntitlement(i);expect(after.checks[0]).toEqual(before.checks[0]);expect(after.checks[1]).not.toEqual(before.checks[1]);
 });
});
describe('convalescence decisive source and chronology boundaries',()=>{
 it('retains laterpublication knowledge andrefuses prepublication evenwith assumption',()=>{
  const i=fixture();expect(resolveConvalescenceEntitlement(i).checks[0].explanation).toContain('18.8.2026');
  i.evaluated_at='2026-07-31T12:00:00Z';i.conditional_assumptions=[{decision_id:'cv.rate_2026',explanation:'Synthetic counterfactual cannot import future knowledge'}];
  const r=resolveConvalescenceEntitlement(i);expect(r.checks).toEqual([]);expect(r.missing.some(m=>m.fact_key==='cv.publication_knowledge')).toBe(true);
 });
 it('requires explicitpaymentcoverage andbenefityear; neverdefaults toJulyJune orpayrollyear',()=>{
  const i=fixture();i.payment_coverage={state:'unknown',value:null,source};expect(resolveConvalescenceEntitlement(i).checks).toEqual([]);
  const year=fixture();year.benefit_year=fact(2025);expect(resolveConvalescenceEntitlement(year).checks).toEqual([]);
  expect(CONVALESCENCE_SOURCE_REVIEW.automatic_july_june_year).toBe(false);expect(CONVALESCENCE_SOURCE_REVIEW.automatic_2026_day_reduction).toBe(false);
 });
 it('requires due-monthsource andfirstyearcompletion; Mayrequiresfactualdateanddecision',()=>{
  const before=fixture();before.employment_start=fact('2025-07-01');before.payment_coverage=fact({from:'2025-07-01',to:'2026-05-31'});before.segments[0].period=before.payment_coverage;expect(resolveConvalescenceEntitlement(before).missing.some(m=>m.fact_key==='cv.first_year')).toBe(true);
  const wrong=fixture();wrong.due_date=fact('2026-09-01');expect(resolveConvalescenceEntitlement(wrong).checks).toEqual([]);
  const may=fixture();may.period={from:'2026-05-01',to:'2026-05-31'};may.due_date=fact('2026-05-31');may.employment_start=fact('2025-05-01');may.payment_coverage=fact({from:'2025-05-01',to:'2026-04-30'});may.recorded_coverage=may.payment_coverage;may.segments[0].period=may.payment_coverage;expect(calculation(may)).toMatchObject({expected:{minor_units:112875}});
  may.applicability=may.applicability.filter(d=>d.decision_id!=='cv.due_date');expect(calculation(may)).toMatchObject({state:'blocked'});
 });
 it.each(['unknown','conflict','stale','expired','unreadable'] as const)('%s FTE blocks numericresult withoutoverwritingoriginal',state=>{
  const i=fixture();i.segments[0].fte={state,value:'0.5',source};const before=canonicalSha256(i);expect(resolveConvalescenceEntitlement(i).checks).toEqual([]);expect(canonicalSha256(i)).toBe(before);
 });
 it('no automaticunpaidabsence/continuity/leapday/Public arrangementinterpretation',()=>{
  const unpaid=fixture();unpaid.qualifying_service=fact('excluded_absence_or_break');expect(resolveConvalescenceEntitlement(unpaid).checks).toEqual([]);
  const leap=fixture();leap.employment_start=fact('2024-02-29');expect(resolveConvalescenceEntitlement(leap).missing.some(m=>m.fact_key==='cv.leap_start')).toBe(true);
  const publicCase=fixture();publicCase.population=fact('public_or_pegged');expect(resolveConvalescenceEntitlement(publicCase).checks).toEqual([]);
 });
 it('refusesoverlap/gaps/duplicates andfuturecoverage; neveraveragespartialinventory',()=>{
  const duplicate=fixture();duplicate.segments.push({...duplicate.segments[0]});expect(()=>resolveConvalescenceEntitlement(duplicate)).toThrow('CONVALESCENCE_DUPLICATE_SEGMENT');
  const overlap=fixture();overlap.segments.push({...overlap.segments[0],id:'second.segment'});expect(resolveConvalescenceEntitlement(overlap).checks).toEqual([]);
  const gap=fixture();gap.segments[0].period=fact({from:'2025-07-01',to:'2026-05-31'});expect(resolveConvalescenceEntitlement(gap).checks).toEqual([]);
  const future=fixture();future.payment_coverage=fact({from:'2025-06-01',to:'2026-07-31'});future.segments[0].period=future.payment_coverage;expect(resolveConvalescenceEntitlement(future).checks).toEqual([]);
 });
 it('refusespartialorforeignperiod payment comparison butnotexpected',()=>{
  const i=fixture();i.recorded_inventory=fact('partial');expect(resolveConvalescenceEntitlement(i).checks).toHaveLength(1);
  i.recorded_inventory=fact('complete_allocated');i.recorded_coverage=fact({from:'2026-01-01',to:'2026-06-30'});expect(resolveConvalescenceEntitlement(i).checks).toHaveLength(1);
 });
 it('checks all fact/decision citations, declarationidentity andscope withoutassuminglegalapproval',()=>{
  const foreign=fixture();foreign.case_id='other.case';expect(()=>resolveConvalescenceEntitlement(foreign)).toThrow('CONVALESCENCE_SOURCE_BINDING');
  const declaration=fixture();declaration.segments[0].fte={state:'declared',value:'0.5',source:{...source,reading:'customer_declaration'}};expect(()=>resolveConvalescenceEntitlement(declaration)).toThrow('CONVALESCENCE_DECLARATION_SOURCE');
  const decision=fixture();decision.applicability[0].basis='customer_declaration';expect(()=>resolveConvalescenceEntitlement(decision)).toThrow('CONVALESCENCE_DECLARATION_NOT_APPLICABILITY');
  const badPage=fixture();badPage.applicability[0].sources=[{...source,page:2}];expect(()=>resolveConvalescenceEntitlement(badPage)).toThrow('CONVALESCENCE_SOURCE_BINDING');
 });
 it('explicitmissingapplicability mayyieldcounterfactual only, conflict/expiry cannot',()=>{
  const i=fixture();i.applicability=i.applicability.filter(d=>d.decision_id!=='cv.benefit_year');expect(calculation(i)).toMatchObject({state:'blocked'});
  i.conditional_assumptions=[{decision_id:'cv.benefit_year',explanation:'Only if documented coverage is legally the2026benefityear'}];expect(calculation(i)).toMatchObject({state:'calculated',counterfactual_only:true,unresolved_conditions:[{decision:{decision_id:'cv.benefit_year',state:'missing'}}]});
  i.applicability.push({decision_id:'cv.benefit_year',state:'conflict',basis:'ai_source_assessment',explanation:'Conflicting period evidence',sources:[source],valid_until:null});expect(calculation(i)).toMatchObject({state:'blocked'});
  const expired=fixture();expired.applicability[0].valid_until='2026-09-12T03:00:00+03:00';expect(calculation(expired)).toMatchObject({state:'blocked'});
 });
 it('pins newsourcecopy andpreserves historicalrulespec bytes',()=>{
  const old=canonicalSha256(CONVALESCENCE_DAYS_SPEC);resolveConvalescenceEntitlement(fixture());expect(canonicalSha256(CONVALESCENCE_DAYS_SPEC)).toBe(old);
  const docs=convalescenceLegalDocuments('synthetic.case');expect(docs.every(d=>isPinnedConvalescenceLegalDocument(d,'synthetic.case'))).toBe(true);
  expect(isPinnedConvalescenceLegalDocument({...docs[0],file_sha256:'f'.repeat(64)},'synthetic.case')).toBe(false);expect(CONVALESCENCE_CATALOG.real_activation_allowed).toBe(false);
 });
});
