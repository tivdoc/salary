import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import type {NormalizedCandidateField,NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {normalizeMoney,normalizeDecimal} from '../extraction/normalization.ts';
import {payslipMachineExtractionSha256} from '../extraction/reading-resolution.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {runDocumentReview} from '../document-review/service.ts';
import {attachAutomaticPayrollEvidence} from './automatic-payroll.ts';
import {workingTimePayrollRate} from './working-time/payroll-rate.ts';
import {minimumWageEntitlementInputSchema,resolveMinimumWageEntitlement} from './minimum-wage/index.ts';
import {travelEntitlementInputSchema,resolveTravelEntitlement} from './travel/index.ts';
import {composeEntitlementReview} from './compose.ts';

const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
type Mutable<T>={-readonly [K in keyof T]:T[K]};
function fixture(options:{confidence?:number;transport?:boolean}={}){
 const base=buildSyntheticCaseFixture({fixture_id:'synthetic-automatic-payroll',mode:'real'}),document={...structuredClone(base.stored.documents[0]),document_period:{start_date:'2026-06-01',end_date:'2026-06-30'}};
 const extraction:Mutable<NormalizedPayslipExtraction>={...structuredClone(base.stored.extractions[0]),fields:[],additional_components:[],extracted_at:'2026-07-02T00:00:00.000Z'},period={from:'2026-06-01',to:'2026-06-30'};
 const source=(label:string)=>({document_id:document.document_id,page:1,text_fragment:label,source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Current month'}});
 const field=(name:NormalizedCandidateField['field'],raw:string,value:NormalizedCandidateField['normalized_value'],confidence=options.confidence??1)=>{
  const f={candidate_id:uuid(['field',name]),field:name,raw_value:raw,normalized_value:value,confidence,source:source(name+': '+raw),extraction_method:'fixture',warning_flags:[]} as NormalizedCandidateField;
  extraction.fields.push(f);return f;
 };
 const salaryPeriod=field('salary_period','06/2026',{year:2026,month:6,start_date:period.from,end_date:period.to},1);
 field('salary_type','שעתי','hourly',1);
 const hours=field('regular_hours','100',{amount:'100',unit:'hours_per_month'}),travel=field('travel_amount','120.00',normalizeMoney('120.00'));
 field('base_monthly_salary','5000.00',normalizeMoney('5000.00'));field('gross_salary','5120.00',normalizeMoney('5120.00'));
 const row=(semantic_kind:NormalizedPayslipExtraction['additional_components'][number]['semantic_kind'],quantity:string,rate:string,amount:string)=>{
  const r:NormalizedPayslipExtraction['additional_components'][number]={component_id:uuid(['row',semantic_kind,amount]),source_label:'Synthetic '+semantic_kind,normalized_label:'synthetic.'+semantic_kind,semantic_kind,
   quantity_raw:quantity,rate_raw:rate,amount_raw:amount,percentage_raw:null,quantity:normalizeDecimal(quantity),rate:normalizeMoney(rate),amount:normalizeMoney(amount),percentage:null,
   source:source('Synthetic distinct '+semantic_kind+' row'),confidence:options.confidence??1,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]};
  extraction.additional_components.push(r);return r;
 };
 const baseRow=row('hourly_base','100','50.00','5000.00'),travelRow=row('travel','10','12.00','120.00');
 const entries=[['travel.employer_provides_transport',options.transport??false],['travel.commute_over_500m',true],['work.days_per_week',5],['compensation.salary_type','hourly']] as const;
 const facts=entries.map(([path,value],i)=>canonicalFactSchema.parse({fact_id:uuid(['declaration',i]),case_id:document.case_id,path,value,status:'needs_confirmation',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:uuid('synthetic.response')}}],conflicting_fact_ids:[],resolution:null,created_at:'2026-07-01T00:00:00Z'}));
 const snapshot:StoredCaseInputSnapshot={...base.stored,documents:[document],extractions:[extraction],declared_fact_snapshot:{snapshot_id:'synthetic.questionnaire.v1',snapshot_sha256:canonicalSha256(facts),facts}};
 const input=()=>documentReviewInputSchema.parse(reviewInputFromPayslips({case_id:document.case_id,period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage','working_time','travel','bonuses'],origin:'saved_order'},snapshot,review_policy:PAYSLIP_REVIEW_POLICY}));
 const identify=()=>{
  const hash=payslipMachineExtractionSha256(extraction);
  extraction.customer_readings=extraction.fields.map(f=>({actor_kind:'customer',case_id:document.case_id,document_id:document.document_id,candidate_id:f.candidate_id,source_sha256:document.content_sha256,normalized_extraction_sha256:hash,candidate_sha256:canonicalSha256(f),extraction_result_sha256:'c'.repeat(64),target_sha256:canonicalSha256(['scalar.target',f.candidate_id]),month:'2026-06',request_id:uuid(['scalar.request',f.candidate_id]),answer_revision:1,identity_id:uuid('identity'),confirmed_at:'2026-07-03T00:00:00Z'}));
  extraction.customer_row_readings=extraction.additional_components.flatMap(r=>(['quantity','rate','amount'] as const).map(cell=>({schema_version:'document-row-cell-reading-v1' as const,actor_kind:'customer' as const,case_id:document.case_id,document_id:document.document_id,component_id:r.component_id,cell,source_sha256:document.content_sha256,normalized_extraction_sha256:hash,original_component_sha256:canonicalSha256(r),extraction_result_sha256:'c'.repeat(64),target_sha256:canonicalSha256(['row.target',r.component_id,cell]),month:'2026-06',request_id:uuid(['row.request',r.component_id,cell]),answer_revision:1,identity_id:uuid('identity'),confirmed_at:'2026-07-03T00:00:00Z'})));
 };
 return {document,extraction,snapshot,input,field,row,identify,salaryPeriod,hours,travel,baseRow,travelRow};
}
function branches(input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot){const prepared=attachAutomaticPayrollEvidence(input,snapshot);return {prepared,mw:minimumWageEntitlementInputSchema.parse(prepared.entitlement_evidence!.minimum_wage),travel:travelEntitlementInputSchema.parse(prepared.entitlement_evidence!.travel)};}
describe('automatic payroll source evidence',()=>{
 it('reuses canonicalregularhours androwamountwithoutdoublecountingscalarmonthlybase',()=>{
  const f=fixture(),before=canonicalSha256(f.snapshot),{mw,travel}=branches(f.input(),f.snapshot);
  expect(mw.ordinary_hours).toMatchObject({state:'observed',printed_value:'100',quantity_unit:'hours'});
  expect(mw.components.map(c=>[c.classification.value,c.amount.printed_value])).toEqual([['base_salary','5000.00'],['expense_reimbursement','120.00']]);
  expect(travel.recorded).toMatchObject({state:'observed',printed_value:'120.00'});expect(canonicalSha256(f.snapshot)).toBe(before);
 });
 it('doesnotchoosemethod,182framework,population,FTEorpayablecompletenessfromordinarysource',()=>{
  const f=fixture(),{mw}=branches(f.input(),f.snapshot);expect(mw).toMatchObject({method:{state:'missing'},employment:{state:'missing'},population:{state:'missing'},monthly_coverage:{state:'missing'},eligible_pay_inventory:{state:'unknown'},applicability:[]});
  const r=resolveMinimumWageEntitlement(mw);expect(r.checks).toEqual([]);expect(r.missing.some(m=>m.fact_key==='mw.method'&&m.kind==='applicability')).toBe(true);
 });
 it('preserves questionnairefalse->none exacttransform withoutdistance/weekdays/fareinferences',()=>{
  const f=fixture(),{prepared,travel}=branches(f.input(),f.snapshot);
  expect(travel.facts.employer_transport).toMatchObject({state:'known',value:'none',basis:'customer_declaration',source:{reading:'questionnaire_declaration'}});
  expect(travel.facts.needs_transport.state).toBe('missing');expect(travel.commute_days).toBeNull();expect(travel.discounted_daily_fare).toBeNull();expect(travel.monthly_pass_cost).toBeNull();
  expect(prepared.entitlement_declarations!.snapshot_sha256).toBe(f.snapshot.declared_fact_snapshot.snapshot_sha256);
  const composed=composeEntitlementReview(prepared);expect(()=>runDocumentReview(composed,'synthetic.auto-payroll')).not.toThrow();
  expect(resolveTravelEntitlement(travel).gaps.some(g=>g.input_path==='facts.employer_transport')).toBe(false);
 });
 it('questionnairetransporttrue cannotbecomeeitherbothoronedirection',()=>{
  const f=fixture({transport:true}),{travel}=branches(f.input(),f.snapshot);expect(travel.facts.employer_transport).toMatchObject({state:'missing',value:null});
 });
 it('keeps94percent readings uncertainuntiltheirownidentifiedreceipts, noconfidencechange',()=>{
  const f=fixture({confidence:.94}),first=branches(f.input(),f.snapshot);
  expect(first.mw.ordinary_hours).toBeNull();expect(first.travel.recorded).toBeNull();expect(first.mw.components[0].amount.state).toBe('unknown');
  f.identify();const second=branches(f.input(),f.snapshot);expect(second.mw.ordinary_hours).toMatchObject({state:'observed',source:{reading:'identified_document_reading'}});
  expect(second.mw.components[0].amount).toMatchObject({state:'observed',printed_value:'5000.00',source:{reading:'identified_document_reading'}});expect(f.baseRow.confidence).toBe(.94);
 });
 it('doesnotreadartificialnumericanswersfromcandidatechecks',()=>{
  const f=fixture({confidence:.94}),input=f.input();input.checks=input.checks.map(c=>{const calculation=documentReviewCalculationInputSchema.parse(c.calculation);return {...c,calculation:{...calculation,operands:calculation.operands.map(o=>({...o,state:'observed',printed_value:'999999'}))}};});
  const r=branches(input,f.snapshot);expect(r.mw.components[0].amount).toMatchObject({state:'unknown',printed_value:'5000.00'});expect(r.travel.recorded).toBeNull();
 });
 it('doesnotuseafooterreportedtotal orrowquantity asregularhourswhenprovideromitsfield',()=>{
  const f=fixture();f.extraction.fields=f.extraction.fields.filter(c=>c.field!=='regular_hours');const {mw}=branches(f.input(),f.snapshot);expect(mw.ordinary_hours).toBeNull();expect(mw.components[0].amount.printed_value).toBe('5000.00');
 });
 it('conflictingscalartravel cannotbeevadedbypickinga matchingrow',()=>{
   const f=fixture();if(f.travel.field!=='travel_amount')throw Error('synthetic travel field');f.extraction.fields.push({...f.travel,candidate_id:uuid('conflicting.travel'),raw_value:'150.00',normalized_value:normalizeMoney('150.00')});
  expect(branches(f.input(),f.snapshot).travel.recorded).toBeNull();
 });
 it('monthlybasefallback preservesunknowninventory andexcludesgross/pensionbase',()=>{
  const f=fixture();f.extraction.additional_components=[];const {mw}=branches(f.input(),f.snapshot);expect(mw.components).toHaveLength(1);expect(mw.components[0].amount.printed_value).toBe('5000.00');expect(mw.eligible_pay_inventory.state).toBe('unknown');
 });
 it('unclassifiedbonus remainsunknown, aprintedamountdoesnotchooselegalinclusion',()=>{
  const f=fixture();f.row('bonus','1','100.00','100.00');const {mw}=branches(f.input(),f.snapshot);expect(mw.components.find(c=>c.amount.printed_value==='100.00')?.classification).toMatchObject({state:'unknown',value:'unknown'});
 });
 it('preserves existingbranches andisidempotentwithoutmutatingpackets',()=>{
  const f=fixture(),input=f.input(),pension={immutable_placeholder:'original source packet, not activated'};
  input.entitlement_evidence={schema_version:'entitlement-source-evidence-v1',case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,pension};
  const prepared=attachAutomaticPayrollEvidence(input,f.snapshot);expect(prepared.entitlement_evidence!.pension).toEqual(pension);expect(attachAutomaticPayrollEvidence(prepared,f.snapshot)).toEqual(prepared);
 });
 it('doesnotattachunpaidtopics or useanotherreadingversion',()=>{
  const f=fixture(),input=f.input();input.purchased_scope.topics=['travel'];const r=attachAutomaticPayrollEvidence(input,f.snapshot);expect(r.entitlement_evidence?.minimum_wage).toBeUndefined();expect(r.entitlement_evidence?.travel).toBeDefined();
  const stale=f.input();stale.documents[0].reading_sha256='d'.repeat(64);expect(attachAutomaticPayrollEvidence(stale,f.snapshot)).toEqual(stale);
  const version=f.input();version.documents[0].version_id='another-version';expect(attachAutomaticPayrollEvidence(version,f.snapshot)).toEqual(version);
 });
 it('rejectschangedquestionnairehash/caseandretaineddeclarationreplacement',()=>{
  const f=fixture();expect(()=>attachAutomaticPayrollEvidence(f.input(),{...f.snapshot,declared_fact_snapshot:{...f.snapshot.declared_fact_snapshot,snapshot_sha256:'e'.repeat(64)}})).toThrow('ENTITLEMENT_DECLARATION_SNAPSHOT_HASH');
  const facts=f.snapshot.declared_fact_snapshot.facts.map(v=>({...v,case_id:uuid('foreign.case')}));expect(()=>attachAutomaticPayrollEvidence(f.input(),{...f.snapshot,declared_fact_snapshot:{...f.snapshot.declared_fact_snapshot,facts,snapshot_sha256:canonicalSha256(facts)}})).toThrow('ENTITLEMENT_DECLARATION_SCOPE');
  const prepared=branches(f.input(),f.snapshot).prepared;delete prepared.entitlement_evidence!.travel;prepared.entitlement_declarations!.snapshot_id='changed';expect(()=>attachAutomaticPayrollEvidence(prepared,f.snapshot)).toThrow('AUTOMATIC_PAYROLL_DECLARATIONS_CHANGED');
 });
 it('rejectsforeignsourcecase anddoesnotaccept cumulative scalarhours',()=>{
  const f=fixture(),foreign={...f.snapshot,documents:[{...f.document,case_id:uuid('foreign')} ]};expect(()=>attachAutomaticPayrollEvidence(f.input(),foreign)).toThrow('AUTOMATIC_PAYROLL_SOURCE_CASE');
   f.extraction.fields=f.extraction.fields.map(c=>c.candidate_id===f.hours.candidate_id?{...c,source:{...c.source,source_scope:{period_kind:'cumulative',fund_kind:'unknown',column_label:'Cumulative'}}}:c);expect(branches(f.input(),f.snapshot).mw.ordinary_hours).toBeNull();
 });
 it('two currentpayslips are notsummed/chosenbyequalmoneyvalues',()=>{
  const f=fixture(),otherId=uuid('second.document'),other={...f.document,document_id:otherId,storage_path:`cases/${f.document.case_id}/documents/${otherId}/original.json`};
  const extraction={...f.extraction,document_id:otherId,extraction_id:uuid('second.extraction'),fields:f.extraction.fields.map(c=>({...c,candidate_id:uuid(['second',c.candidate_id]),source:{...c.source,document_id:otherId}})),additional_components:f.extraction.additional_components.map(r=>({...r,component_id:uuid(['second',r.component_id]),source:{...r.source,document_id:otherId}}))};
  const snapshot={...f.snapshot,documents:[f.document,other],extractions:[f.extraction,extraction]},input=reviewInputFromPayslips({case_id:f.document.case_id,period:{from:'2026-06-01',to:'2026-06-30'},purchased_scope:f.input().purchased_scope,snapshot,review_policy:PAYSLIP_REVIEW_POLICY});
  const {mw,travel}=branches(input,snapshot);expect(mw.ordinary_hours).toBeNull();expect(travel.recorded).toBeNull();expect(mw.components).toHaveLength(4);expect(mw.eligible_pay_inventory.state).toBe('unknown');
 });
});

describe('ordinary working-time base-rate source link',()=>{
 it('reads50 from the existing accepted payroll row without legal classification or prepared check operands',()=>{
  const f=fixture(),input=f.input(),before=canonicalSha256(f.snapshot),rate=workingTimePayrollRate(input,f.snapshot);
  expect(rate).toMatchObject({state:'observed',printed_value:'50.00',source:{document_id:f.document.document_id,reading:'provider_extraction'}});
  input.checks=[];expect(workingTimePayrollRate(input,f.snapshot)).toEqual(rate);expect(canonicalSha256(f.snapshot)).toBe(before);
 });
 it('does not choose a different source, ambiguous base row or unaccepted cell',()=>{
  const f=fixture();f.baseRow.confidence=.2;expect(workingTimePayrollRate(f.input(),f.snapshot)).toBeNull();
  const ambiguous=fixture();ambiguous.row('hourly_base','80','50.00','4000.00');expect(workingTimePayrollRate(ambiguous.input(),ambiguous.snapshot)).toBeNull();
  const replaced=fixture(),input=replaced.input();input.documents[0].file_sha256='0'.repeat(64);expect(workingTimePayrollRate(input,replaced.snapshot)).toBeNull();
 });
 it('rejects a foreign case and retains an identified rate through the ordinary reading resolver',()=>{
  const f=fixture();f.identify();expect(workingTimePayrollRate(f.input(),f.snapshot)?.source.reading).toBe('identified_document_reading');
  const input=f.input();input.case_id=uuid('different-case');expect(()=>workingTimePayrollRate(input,f.snapshot)).toThrow('WORKING_RATE_FOREIGN_SOURCE');
 });
});
