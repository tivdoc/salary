import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {normalizedCandidateFieldSchema,type NormalizedCandidateField,type NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {normalizeMoney} from '../extraction/normalization.ts';
import {payslipMachineExtractionSha256} from '../extraction/reading-resolution.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {calculateDocumentReview} from '../document-review/calculations.ts';
import {runDocumentReview} from '../document-review/service.ts';
import {attachAutomaticBenefitsEvidence} from './automatic-benefits.ts';
import {vacationEntitlementInputSchema,resolveVacationEntitlement,VACATION_APPLICABILITY,vacationLegalSource} from './vacation/index.ts';
import {convalescenceEntitlementInputSchema,resolveConvalescenceEntitlement} from './convalescence/index.ts';
import {composeEntitlementReview} from './compose.ts';

type Mutable<T>={-readonly [K in keyof T]:T[K]};
const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
function fixture(confidence=1,birthYear=1980){
 const old=buildSyntheticCaseFixture({fixture_id:'synthetic-automatic-benefits',mode:'real'}),period={from:'2026-06-01',to:'2026-06-30'};
 const document={...structuredClone(old.stored.documents[0]),document_period:{start_date:period.from,end_date:period.to}};
 const extraction:Mutable<NormalizedPayslipExtraction>={...structuredClone(old.stored.extractions[0]),fields:[],additional_components:[],extracted_at:'2026-07-02T00:00:00.000Z'};
 const field=(name:NormalizedCandidateField['field'],raw:string,value:unknown,c=confidence)=>{
  const f=normalizedCandidateFieldSchema.parse({candidate_id:uuid(['benefit.field',name]),field:name,raw_value:raw,normalized_value:value,confidence:c,
   source:{document_id:document.document_id,page:1,text_fragment:`Synthetic ${name}: ${raw}`,source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'Current month'}},extraction_method:'fixture',warning_flags:[]});
  extraction.fields.push(f);return f;
 };
 field('salary_period','06/2026',{year:2026,month:6,start_date:period.from,end_date:period.to},1);
 const start=field('employment_start_date','15/01/2024','2024-01-15'),conval=field('convalescence_amount','2257.50',normalizeMoney('2257.50'));
 field('vacation_balance','12 ימים',{amount:'12',unit:'days'});field('base_monthly_salary','9000.00',normalizeMoney('9000.00'));
 const entries=[['person.birth_year',birthYear],['employment.still_employed',true],['employment.start_month','2024-01']] as const;
 const facts=entries.map(([path,value],i)=>canonicalFactSchema.parse({fact_id:uuid(['benefit.declaration',i]),case_id:document.case_id,path,value,status:'needs_confirmation',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:uuid('benefit.response')}}],conflicting_fact_ids:[],resolution:null,created_at:'2026-07-01T00:00:00Z'}));
 const snapshot:StoredCaseInputSnapshot={...old.stored,documents:[document],extractions:[extraction],declared_fact_snapshot:{snapshot_id:'benefit.questionnaire',snapshot_sha256:canonicalSha256(facts),facts}};
 const input=()=>documentReviewInputSchema.parse(reviewInputFromPayslips({case_id:document.case_id,period,purchased_scope:{order_id:'benefit.order',receipt_sha256:'e'.repeat(64),topics:['vacation','convalescence'],origin:'saved_order'},snapshot,review_policy:PAYSLIP_REVIEW_POLICY}));
 const identify=()=>{const hash=payslipMachineExtractionSha256(extraction);extraction.customer_readings=extraction.fields.map(f=>({actor_kind:'customer',case_id:document.case_id,document_id:document.document_id,candidate_id:f.candidate_id,source_sha256:document.content_sha256,normalized_extraction_sha256:hash,candidate_sha256:canonicalSha256(f),extraction_result_sha256:'c'.repeat(64),target_sha256:canonicalSha256(['target',f.candidate_id]),month:'2026-06',request_id:uuid(['request',f.candidate_id]),answer_revision:1,identity_id:uuid('identity'),confirmed_at:'2026-07-03T00:00:00Z'}));};
 return {document,extraction,period,snapshot,input,start,conval,field,identify};
}
function branches(input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot){const prepared=attachAutomaticBenefitsEvidence(input,snapshot);return {prepared,vacation:vacationEntitlementInputSchema.parse(prepared.entitlement_evidence!.vacation),convalescence:convalescenceEntitlementInputSchema.parse(prepared.entitlement_evidence!.convalescence)};}
describe('automatic benefits evidence from the same saved source',()=>{
 it('reads startdate andconvalescenceamount butnot coverage/FTE/benefityearfrompayrollmonth',()=>{
  const f=fixture(),before=canonicalSha256(f.snapshot),{vacation,convalescence}=branches(f.input(),f.snapshot);
  expect(vacation.annual_basis?.employment_start).toMatchObject({state:'known',value:'2024-01-15'});
  expect(convalescence).toMatchObject({employment_start:{state:'observed',value:'2024-01-15'},recorded:{state:'observed',printed_value:'2257.50'},payment_coverage:{state:'missing'},benefit_year:{state:'missing'},due_date:{state:'missing'},recorded_inventory:{state:'missing'},segments:[],applicability:[]});
  expect(resolveConvalescenceEntitlement(convalescence).checks).toEqual([]);expect(canonicalSha256(f.snapshot)).toBe(before);
 });
 it('doesnotturnbalance12 intoquota/accrual/leavepay or assume completeyear',()=>{
  const f=fixture(),{vacation}=branches(f.input(),f.snapshot);expect(vacation).toMatchObject({seniority_year:null,leave_pay:null,annual_basis:{complete_year_evidence:{state:'missing'},covered_through:{state:'missing'},actual_workdays:null}});
  const r=resolveVacationEntitlement(vacation);expect(r.checks).toEqual([]);expect(r.gaps.some(g=>g.dependency_id==='vacation.leave_pay_source')).toBe(true);
 });
 it('admits exactquestionnaire age/ongoing asdeclarations with matchingmanifest, neverlegalapproval',()=>{
  const f=fixture(),{prepared,vacation}=branches(f.input(),f.snapshot);
  expect(vacation.facts.aged_21_or_more).toMatchObject({state:'known',value:true,basis:'customer_declaration',source:{reading:'questionnaire_declaration'}});
  expect(vacation.annual_basis?.employment_end.value).toBe('ongoing');expect(vacation.applicability).toEqual([]);
  expect(()=>runDocumentReview(composeEntitlementReview(prepared),'benefit.synthetic.run')).not.toThrow();
  const bad={...vacation,facts:{...vacation.facts,under_60:{...vacation.facts.under_60,basis:'ai_source_assessment' as const}}};expect(()=>resolveVacationEntitlement(bad)).toThrow('VACATION_FACT_BASIS');
 });
 it('doesnotinfer birthday orprecisefirstdayfrom birthyear/startmonth',()=>{
  const f=fixture(1,2005);f.extraction.fields=f.extraction.fields.filter(c=>c.field!=='employment_start_date');const {vacation,convalescence}=branches(f.input(),f.snapshot);
  expect(vacation.facts.aged_21_or_more.state).toBe('missing');expect(vacation.annual_basis?.employment_start.state).toBe('missing');expect(convalescence.employment_start.state).toBe('missing');
 });
 it('preserves missingpayments asnull andunknownreadings untiltheirownreceipt',()=>{
  const f=fixture(.94),before=branches(f.input(),f.snapshot);expect(before.convalescence.recorded).toBeNull();expect(before.convalescence.employment_start.state).toBe('missing');
  f.identify();const after=branches(f.input(),f.snapshot);expect(after.convalescence.recorded).toMatchObject({state:'observed',source:{reading:'identified_document_reading'}});expect(after.convalescence.employment_start.value).toBe('2024-01-15');
  f.extraction.fields=f.extraction.fields.filter(c=>c.field!=='convalescence_amount');delete f.extraction.customer_readings;expect(branches(f.input(),f.snapshot).convalescence.recorded).toBeNull();
 });
 it('preservesexisting leavepay branch includingindependentpay withmissingannualdata',()=>{
  const f=fixture(),prepared=branches(f.input(),f.snapshot).prepared,vacation=vacationEntitlementInputSchema.parse(prepared.entitlement_evidence!.vacation);
  const source={document_id:f.document.document_id,version_id:f.document.document_id,file_sha256:f.document.content_sha256,page:1,locator:'Synthetic separately source-assessed quarter wage and actual leave, not inferred by this mapper',label:'Synthetic quarter wage and leave record',reading:'ai_document_review' as const,reading_receipt_sha256:canonicalSha256(f.extraction)};
  vacation.annual_basis=null;vacation.seniority_year=null;vacation.leave_pay={mode:'hourly_quarter',leave_period:{from:'2026-06-01',to:'2026-06-05'},quarter_period:{from:'2026-03-01',to:'2026-05-31'},wage:{id:'quarter.wage',observation_id:'synthetic.quarter',state:'observed',printed_value:'9000.00',representation:'money_ils',quantity_unit:null,precision:'source_exact',source},leave_calendar_days:{id:'leave.days',observation_id:'synthetic.leave',state:'observed',printed_value:'5',representation:'integer',quantity_unit:'calendar_days',precision:'source_exact',source},recorded:null};
  vacation.applicability=Object.keys(VACATION_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic independent applicability, never produced by automatic mapper',sources:[vacationLegalSource('law',1,decision_id)],valid_until:null}));
  prepared.entitlement_evidence!.vacation=vacation;delete prepared.entitlement_evidence!.convalescence;
  const result=attachAutomaticBenefitsEvidence(prepared,f.snapshot);expect(result.entitlement_evidence!.vacation).toEqual(vacation);
  const checks=resolveVacationEntitlement(result.entitlement_evidence!.vacation).checks.map(c=>calculateDocumentReview(c.calculation));
  expect(checks.find(c=>c.input.check_id.endsWith('.pay.expected'))).toMatchObject({state:'calculated',expected:{minor_units:50000}});expect(checks.some(c=>c.input.check_id.endsWith('.annual.prorated'))).toBe(false);
 });
 it('neveruses modified check values asfreshsourcereading',()=>{
  const f=fixture(.94),input=f.input();input.checks=[{check_id:'invented.pay',topic:'convalescence',title:'Synthetic injected draft',explanation:'Must not be used as a source',calculation:{arbitrary_amount:999999}}];
  expect(branches(input,f.snapshot).convalescence.recorded).toBeNull();
 });
 it('uses oneexactconvalescence row whennoscalarexists, withoutinventingthecoveredyear',()=>{
  const f=fixture();f.extraction.fields=f.extraction.fields.filter(c=>c.field!=='convalescence_amount');f.extraction.additional_components=[{component_id:uuid('conval.row'),source_label:'Synthetic convalescence payment',normalized_label:'synthetic.convalescence',semantic_kind:'convalescence',quantity_raw:'5',rate_raw:'451.50',amount_raw:'2257.50',percentage_raw:null,quantity:'5',rate:normalizeMoney('451.50'),amount:normalizeMoney('2257.50'),percentage:null,confidence:1,source:{document_id:f.document.document_id,page:1,text_fragment:'Synthetic convalescence row',source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'Current month'}},extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}];
  const {convalescence}=branches(f.input(),f.snapshot);expect(convalescence.recorded).toMatchObject({state:'observed',printed_value:'2257.50'});expect(convalescence.benefit_year.state).toBe('missing');expect(convalescence.payment_coverage.state).toBe('missing');
 });
 it('oldreading,foreigncase,unpaidtopics andduplicatechecks cannotgainbranches',()=>{
  const f=fixture(),stale=f.input();stale.documents[0].reading_sha256='f'.repeat(64);expect(attachAutomaticBenefitsEvidence(stale,f.snapshot)).toEqual(stale);
  const unpaid=f.input();unpaid.purchased_scope.topics=['travel'];expect(attachAutomaticBenefitsEvidence(unpaid,f.snapshot)).toEqual(unpaid);
  const foreign={...f.snapshot,documents:[{...f.document,case_id:uuid('foreign')}]};expect(()=>attachAutomaticBenefitsEvidence(f.input(),foreign)).toThrow('AUTOMATIC_BENEFITS_SOURCE_CASE');
  expect(()=>attachAutomaticBenefitsEvidence(f.input(),{...f.snapshot,documents:[f.document,f.document]})).toThrow('AUTOMATIC_BENEFITS_DUPLICATE_SOURCE');
 });
 it('keeps existingpacketsandreplay unchanged',()=>{
  const f=fixture(),input=f.input(),minimum={source_packet:'preserved'};input.entitlement_evidence={schema_version:'entitlement-source-evidence-v1',case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,minimum_wage:minimum};
  const once=attachAutomaticBenefitsEvidence(input,f.snapshot);expect(once.entitlement_evidence!.minimum_wage).toEqual(minimum);expect(attachAutomaticBenefitsEvidence(once,f.snapshot)).toEqual(once);
 });
 it('rejectschanged orforeignquestionnaire and alteredboundfactvalues',()=>{
  const f=fixture();expect(()=>attachAutomaticBenefitsEvidence(f.input(),{...f.snapshot,declared_fact_snapshot:{...f.snapshot.declared_fact_snapshot,snapshot_sha256:'d'.repeat(64)}})).toThrow('ENTITLEMENT_DECLARATION_SNAPSHOT_HASH');
  const facts=f.snapshot.declared_fact_snapshot.facts.map(v=>({...v,case_id:uuid('other.case')}));expect(()=>attachAutomaticBenefitsEvidence(f.input(),{...f.snapshot,declared_fact_snapshot:{...f.snapshot.declared_fact_snapshot,facts,snapshot_sha256:canonicalSha256(facts)}})).toThrow('ENTITLEMENT_DECLARATION_SCOPE');
  const r=branches(f.input(),f.snapshot);r.vacation.facts.under_60.value=false;r.prepared.entitlement_evidence!.vacation=r.vacation;expect(()=>composeEntitlementReview(r.prepared)).toThrow('ENTITLEMENT_QUESTIONNAIRE_VALUE');
 });
});
