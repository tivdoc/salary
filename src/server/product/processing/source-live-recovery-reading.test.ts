import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {extractionResultSchema,type PayslipFieldKey} from '@/engine/extraction/contracts';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {buildPassEvaluation,payslipExtractionPassSchema} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21,recoveryDecisionSchema,payslipExtractionV21ResultSchema} from '@/engine/extraction/v21';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {calculateDevMinimumWage} from '@/engine/calculations/dev-minimum-wage';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {savedDocumentFieldReadings} from './saved-field-readings';
import {assertDevFinancialExtractionSource} from './dev-financial-source';
import {assertDevFinancialScenario,devFinancialFacts} from './dev-financial-contract';
import {openSavedDocumentFieldRequests} from './saved-field-requests';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope',async original=>({...await original<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));

// Literal synthetic June scenario reproduces c521776's missing first-pass
// salary type and valid .94 recovery-only reading. No provider is called and
// this fixture is not represented as another live receipt/checkpoint.
const version='d4ac1ef3-0571-47bf-bec3-4a80515027a9',caseId='63e077e8-3a04-465f-956b-8f06ad4a0086';
const sourceSha='4a1749471e064555bcd72a265aba80191ef6f3fe8f1d1f3e5613730e360558fb';
const at='2026-09-09T21:46:17.986Z',policy='offline-recovery-reading-test';
const observed:readonly [PayslipFieldKey,string,string][]=[
 ['document_type','payslip','document type'],['salary_period','06/2026','Salary period: 06/2026'],
 ['regular_hours','100','Complete earnings table: 100'],['hourly_rate','33.00','Complete earnings table: 33.00'],
 ['base_monthly_salary','3,300.00','Complete earnings table: 3,300.00'],['gross_salary','3,300.00','Gross salary (ILS): 3,300.00'],
 ['total_deductions','0.00','Total deductions (ILS): 0.00'],['net_salary','3,300.00','Net salary (ILS): 3,300.00'],
];
function setup(confidence=.94,regions:('header'|'earnings')[]=[]){
 const firstRaw=extractionResultSchema.parse({...syntheticPayslipFixtures[0].extraction,document_id:version,extraction_id:randomUUID(),
  fields:observed.map(([field,raw_value,text_fragment])=>({candidate_id:randomUUID(),field,raw_value,confidence:field==='document_type'?.96:.94,
   source:{document_id:version,page:1,text_fragment},extraction_method:'ai_vision',warning_flags:[]})),
  warnings:['salary_type_documented_pair_invalid'],sensitive_metadata:[],document_quality_confidence:.96,earnings_components_complete:true,
  additional_components:[{component_id:randomUUID(),semantic_kind:'hourly_base',source_label:'Regular hourly base',normalized_label:'hourly_base',
   quantity_raw:'100',rate_raw:'33.00',amount_raw:'3,300.00',percentage_raw:null,confidence:.94,
   source:{document_id:version,page:1,text_fragment:'Regular hourly base'},extraction_method:'ai_vision',warning_flags:[]}]});
 const recoveryRaw=extractionResultSchema.parse({...firstRaw,extraction_id:randomUUID(),status:'partial',warnings:[],earnings_components_complete:false,additional_components:[],
  fields:[{candidate_id:randomUUID(),field:'salary_type',raw_value:'hourly',confidence,source:{document_id:version,page:1,text_fragment:'Salary type: hourly'},extraction_method:'ai_vision',warning_flags:[]}]});
 const evaluate=(raw:typeof firstRaw,recovery=false)=>buildPassEvaluation({pass_id:raw.extraction_id,kind:recovery?'targeted_recovery':'first_pass',
  requested_fields:recovery?['salary_type']:observed.map(([field])=>field),selected_regions:recovery?regions:[],model:'synthetic-offline-replay',prompt_version:'offline-c521-observation',
  raw_extraction:raw,salary_type_assessment:{documented:recovery&&raw.fields.length===1?{candidate_id:raw.fields[0].candidate_id,raw_value:raw.fields[0].raw_value,value:'hourly',confidence:raw.fields[0].confidence}:null,inferred:null},
  totals_section_visible:!recovery,pension_section_visible:false,critical_context:{hourly_analysis_implied:true,required_fields:['salary_type','salary_period']},reference_year:2026});
 const decision=recoveryDecisionSchema.parse({requested:true,skipped:false,fields_requested:['salary_type'],regions:['header'],reason_codes:['missing_critical_field'],expected_information_gain:'missing_critical_field'});
 const resolve=()=>resolvePayslipExtractionPassesV21({first_pass:evaluate(firstRaw),recovery_passes:[evaluate(recoveryRaw,true)],recovery_decision:decision,
  final_extraction_id:randomUUID(),critical_context:{hourly_analysis_implied:true,required_fields:['salary_type','salary_period']},reference_year:2026});
 return {firstRaw,recoveryRaw,resolve};
}
function readingHarness(result:ReturnType<ReturnType<typeof setup>['resolve']>,expectedOverrides:Record<string,unknown>={}){
 const machine=result.final_extraction,document={...syntheticPayslipFixtures[0].request.document,case_id:caseId,document_id:version,content_sha256:sourceSha,size_bytes:3512,
  storage_path:`cases/${caseId}/documents/${version}/original.pdf`};
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:randomUUID(),version_id:version,input_sha256:sourceSha,
  expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}};
 const context={snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:at,fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,randomUUID()]))};
 const expected:Record<string,unknown>={salary_type:'hourly',salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},regular_hours:{amount:'100',unit:'hours_per_month'},
  hourly_rate:{currency:'ILS',minor_units:3300},base_monthly_salary:{currency:'ILS',minor_units:330000},gross_salary:{currency:'ILS',minor_units:330000},net_salary:{currency:'ILS',minor_units:330000},...expectedOverrides};
 const answers=machine.fields.filter(c=>Object.hasOwn(expected,c.field)).map(candidate=>{
  expect(candidate.normalized_value).toEqual(expected[candidate.field]);
  const target=documentFieldTarget({checkpoint,policyVersion:policy,candidateId:candidate.candidate_id});
  return {id:randomUUID(),case_id:caseId,scope_month:'2026-06',code:`document_field:${target.target_sha256}`,answer_kind:'choice',answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0] as string,
   answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:at,field_target:target};
 });
 const snapshot=(journalAnswers=answers)=>{const readings=savedDocumentFieldReadings({caseId,month:'2026-06',policyVersion:policy,journal:{answers:journalAnswers},checkpoint});
  return resolvePayslipSnapshot({document,extraction:{...machine,customer_readings:[...readings]},validation:validatePayslipGate0(machine,{reference_year:2026}),context});};
 return {machine,checkpoint,answers,snapshot};
}

describe('valid recovery-only cells require exact identified readings',()=>{
 it('retains the .94 recovery observation with a mandatory reading warning, no automatic promotion and immutable raw evidence',()=>{
  const s=setup(),original=canonicalSha256(s.recoveryRaw),r=s.resolve(),candidate=r.final_extraction.fields.find(f=>f.field==='salary_type');
  expect(candidate).toMatchObject({candidate_id:s.recoveryRaw.fields[0].candidate_id,normalized_value:'hourly',confidence:.94,warning_flags:['recovery_reading_confirmation_required']});
  expect(r.resolutions.find(f=>f.field==='salary_type')).toMatchObject({status:'requires_confirmation',selected_candidate_id:null});
  expect(r.final_validation.field_assessments.find(a=>a.candidate_id===candidate?.candidate_id)).toMatchObject({status:'requires_confirmation',issue_codes:expect.arrayContaining(['recovery_reading_confirmation_required'])});
  expect(canonicalSha256(s.recoveryRaw)).toBe(original);expect(r.first_pass.raw_extraction.warnings).toContain('salary_type_documented_pair_invalid');
  expect(()=>assertDevFinancialExtractionSource(r.final_extraction,version)).not.toThrow();
 });
 it.each([.94,.99])('keeps confidence %s below automatic acceptance until identified confirmation',confidence=>{
  const s=setup(confidence),r=s.resolve(),h=readingHarness(r),before=h.snapshot([]);
  expect(before.facts.find(f=>f.path==='compensation.salary_type')).toMatchObject({status:'needs_confirmation',value:'hourly'});
  expect(()=>assertDevFinancialScenario(before,version)).toThrow('DEV_FINANCIAL_CANONICAL_SCENARIO');
  const withoutSalary=h.snapshot(h.answers.filter(a=>a.field_target.candidate.field!=='salary_type'));
  expect(()=>assertDevFinancialScenario(withoutSalary,version)).toThrow('DEV_FINANCIAL_CANONICAL_SCENARIO');
  const after=h.snapshot();expect(h.answers).toHaveLength(7);expect(()=>assertDevFinancialScenario(after,version)).not.toThrow();
  expect(calculateDevMinimumWage({facts:devFinancialFacts(after,randomUUID(),null),month:'2026-06',calculatedAt:at})).toMatchObject({state:'calculated',expectedMinor:354000,recordedMinor:330000,gapMinor:24000});
  expect(h.machine.fields.find(f=>f.field==='salary_type')?.confidence).toBe(confidence);
 });
 it('keeps the original automatic recovery path for a valid high-confidence targeted region',()=>{
  const r=setup(.99,['header']).resolve();expect(r.resolutions.find(f=>f.field==='salary_type')?.status).toBe('recovered');
  expect(r.final_extraction.fields.find(f=>f.field==='salary_type')?.warning_flags).not.toContain('recovery_reading_confirmation_required');
 });
 it('opens the high-confidence recovery-only reading through existing purchased-scope request construction',async()=>{
  const h=readingHarness(setup(.99).resolve()),targets:unknown[]=[];
  ports.admit.mockResolvedValue({});ports.orders.mockResolvedValue([{id:randomUUID(),kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'a'.repeat(64)}]);
  const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){
   if(s.name==='saved_field_question_scope')return {rows:[{fields:['salary_type']}],row_count:1};
   if(s.name==='saved_field_request_open'){targets.push(JSON.parse(String(s.values[3])));return {rows:[{id:randomUUID()}],row_count:1};}
   throw Error('UNEXPECTED_STATEMENT');
  }}};
  await openSavedDocumentFieldRequests(context,{schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'},h.checkpoint);
  expect(targets).toHaveLength(1);expect(targets[0]).toMatchObject({source_sha256:sourceSha,version_id:version,candidate:{field:'salary_type',confidence:.99,warning_flags:['recovery_reading_confirmation_required']}});
 });
 it.each(['missing','failed','duplicate','conflicting','invalid','warning'] as const)('never exposes %s recovery as a confirmable replacement',change=>{
  const s=setup();if(change==='missing'||change==='failed')s.recoveryRaw.fields=[];
  if(change==='failed'){s.recoveryRaw.status='failed';s.recoveryRaw.error_code='extraction_failed';}
  if(change==='duplicate'||change==='conflicting')s.recoveryRaw.fields.push({...s.recoveryRaw.fields[0],candidate_id:randomUUID(),raw_value:change==='conflicting'?'monthly':'hourly'});
  if(change==='invalid')s.recoveryRaw.fields[0].raw_value='unreadable';
  if(change==='warning')s.recoveryRaw.fields[0].warning_flags=['ocr_ambiguous'];
  const r=s.resolve();expect(r.final_extraction.fields.some(f=>f.field==='salary_type')).toBe(false);
 });
 it('cannot confirm a changed source/candidate, a negative answer, or a duplicate reading',()=>{
  const h=readingHarness(setup().resolve()),salary=h.answers.find(a=>a.field_target.candidate.field==='salary_type')!;
  expect(h.snapshot(h.answers.map(a=>a===salary?{...a,answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1]}:a)).facts.find(f=>f.path==='compensation.salary_type')?.status).not.toBe('confirmed');
  expect(()=>h.snapshot([...h.answers,salary])).toThrow('SAVED_REQUEST_ID_AMBIGUOUS');
  const source=h.checkpoint.input_sha256;h.checkpoint.input_sha256='b'.repeat(64);
  expect(h.snapshot().facts.find(f=>f.path==='compensation.salary_type')?.status).not.toBe('confirmed');h.checkpoint.input_sha256=source;
  h.machine.fields.find(f=>f.field==='salary_type')!.raw_value='monthly';h.checkpoint.result_sha256=canonicalSha256(h.checkpoint.run.result);
  expect(h.snapshot().facts.find(f=>f.path==='compensation.salary_type')?.status).not.toBe('confirmed');
 });
 it('preserves a deterministic contradiction after all identified readings',()=>{
  const s=setup();s.firstRaw.fields.find(f=>f.field==='gross_salary')!.raw_value='4,400.00';const r=s.resolve();
  const h=readingHarness(r,{gross_salary:{currency:'ILS',minor_units:440000}});
  const machine=r.final_extraction,validation=validatePayslipGate0(machine,{reference_year:2026});
  expect(validation.issues.some(i=>i.code==='gross_component_mismatch')).toBe(true);
  const snapshot=h.snapshot();expect(snapshot.facts.find(f=>f.path==='compensation.base_monthly_salary')?.status).not.toBe('confirmed');
  expect(calculateDevMinimumWage({facts:devFinancialFacts(snapshot,randomUUID(),null),month:'2026-06',calculatedAt:at})).toMatchObject({state:'missing_input',fields:expect.arrayContaining(['compensation.base_monthly_salary'])});
 });
 it.skipIf(process.env.TIVDOC_C521_RECOVERY_REPLAY!=='1')('replays the original c521 checkpoint offline without modifying its receipts or files',()=>{
  const path=process.env.TIVDOC_C521_CHECKPOINT??'output/release-completion/dev-financial-live-flow-c521776-failed/initial-extraction.json',original=readFileSync(path),checkpoint=JSON.parse(original.toString('utf8'));
  expect(checkpoint.run.result.first_pass.raw_extraction.document_id).toBe(version);
  const previous=checkpoint.run.result;
  expect(previous.final_extraction.fields.some((f:{field:string})=>f.field==='salary_type')).toBe(false);
  const result=resolvePayslipExtractionPassesV21({first_pass:payslipExtractionPassSchema.parse(previous.first_pass),recovery_passes:previous.recovery_passes.map((p:unknown)=>payslipExtractionPassSchema.parse(p)),
   recovery_decision:recoveryDecisionSchema.parse(previous.recovery_decision),final_extraction_id:previous.final_extraction.extraction_id,
   critical_context:{hourly_analysis_implied:true,required_fields:['salary_type','salary_period']},reference_year:2026});
  const h=readingHarness(result);expect(()=>assertDevFinancialScenario(h.snapshot([]),version)).toThrow();
  expect(()=>assertDevFinancialScenario(h.snapshot(),version)).not.toThrow();
  expect(readFileSync(path).equals(original)).toBe(true);expect(previous.resolution_policy_version).not.toBe(result.resolution_policy_version);
  expect(()=>payslipExtractionV21ResultSchema.parse(previous)).not.toThrow();
 });
});
