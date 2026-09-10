import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {extractionResultSchema,type PayslipFieldKey} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21,recoveryDecisionForV21} from '@/engine/extraction/v21';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '@/engine/facts/snapshot';
import {createJune2026CollectionTarget,JUNE2026_COMPONENT_DECLARATIONS} from '@/engine/minimum-wage-june2026/collection';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {calculateDevMinimumWage,DEV_MINIMUM_WAGE_POLICY} from '@/engine/calculations/dev-minimum-wage';
import {createDocumentTranscriptionTarget,SALARY_TYPE_TRANSCRIPTION_ANSWERS,COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS} from '../reports/document-field-transcription';
import {renderDevFinancialArtifacts} from '../reports/dev-financial-artifacts';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {materializeDevFinancialSourceCompletions,parseDevFinancialSourceCompletions,devFinancialCompletionFacts} from './dev-financial-completions';
import {DEV_FINANCIAL_SCHEMA_V2,devFinancialFactsV2,devFinancialFinding,parseDevFinancialRun,assertDevFinancialScenario} from './dev-financial-contract';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import {JUNE2026_REVIEW_CATALOG_SHA256} from '@/engine/legal-operations/june2026-catalog';
vi.mock('server-only',()=>({}));

const now='2026-09-10T04:00:00.000Z',policy='saved-payslip-v21-p95-v1';
const caseId='11111111-1111-4111-8111-111111111111',version='33333333-3333-4333-8333-333333333333',orderId='99999999-9999-4999-8999-999999999999';
const sourceSha='1'.repeat(64),inputSha='2'.repeat(64),identityId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// An independently specified synthetic unknown paid row. No transport, uploaded
// source, DB session, live receipt, completed report or finding is seeded here.
function syntheticCheckpoint(){
 const raw=extractionResultSchema.parse({...syntheticPayslipFixtures[0].extraction,extraction_id:randomUUID(),document_id:version,extracted_at:now,
  fields:([['salary_period','06/2026'],['gross_salary','3,300.00'],['net_salary','3,300.00'],['total_deductions','0.00']] as [PayslipFieldKey,string][])
   .map(([field,raw_value])=>({candidate_id:randomUUID(),field,raw_value,confidence:.94,source:{document_id:version,page:1,text_fragment:`Synthetic ${field}: ${raw_value}`},extraction_method:'fixture',warning_flags:[]})),
  warnings:['salary_type_documented_pair_invalid'],sensitive_metadata:[],earnings_components_complete:true,
  additional_components:[{component_id:randomUUID(),source_label:'Synthetic regular paid row',normalized_label:null,semantic_kind:'unknown',
   quantity_raw:null,rate_raw:'33.00',amount_raw:'3,300.00',percentage_raw:null,confidence:.94,source:{document_id:version,page:1,text_fragment:'Synthetic regular paid row'},extraction_method:'fixture',warning_flags:[]}],
  provider:{provider_id:'openai',extractor_version:'2.1',model_version:'unit-injected'},operation:{duration_ms:0,provider_response_id:'unit-not-a-live-request',token_usage:null}});
 const first=buildPassEvaluation({pass_id:raw.extraction_id,kind:'first_pass',requested_fields:[],selected_regions:[],model:'unit-injected',prompt_version:'unit-completion-v1',
  raw_extraction:raw,salary_type_assessment:{documented:null,inferred:null},totals_section_visible:true,pension_section_visible:false,
  critical_context:{hourly_analysis_implied:true,required_fields:['salary_type','salary_period']},reference_year:2026});
 const result=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),final_extraction_id:randomUUID(),
  critical_context:{hourly_analysis_implied:true,required_fields:['salary_type','salary_period']},reference_year:2026});
 const receipt=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'injected_test_provider',case_id:caseId,analysis_run_id:randomUUID(),document_id:version,extraction_id:raw.extraction_id,
  source_sha256:sourceSha,source_size_bytes:1000,source_mime_type:'application/pdf',source_page_count:1,request_sha256:'5'.repeat(64),raw_extraction_sha256:canonicalSha256(raw),pass_kind:'first_pass',
  requested_model:'unit-injected',actual_model:'unit-injected',extractor_version:'2.1',prompt_version:'unit-completion-v1',provider_response_id:'unit-not-a-live-request',provider_request_id:null,
  provider_attempted:true,status:'completed',error_code:null,http_status:null,duration_ms:0,token_usage:null,cost:{status:'not_returned_by_provider',amount_usd:null},created_at:now});
 return {schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:randomUUID(),version_id:version,input_sha256:sourceSha,
  expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result,provider_receipts:[receipt]}};
}
function setup(checkpoint=syntheticCheckpoint()){
 const component=checkpoint.run.result.final_extraction.additional_components[0];
 const targets=[createDocumentTranscriptionTarget({checkpoint,policyVersion:policy,subject:{kind:'salary_type'}}),
  createDocumentTranscriptionTarget({checkpoint,policyVersion:policy,subject:{kind:'component_amount',componentId:component.component_id}})];
 const common={case_id:checkpoint.case_id,scope_month:'2026-06',answer_kind:'choice',answer_revision:1,answer_identity_id:identityId,answer_created_at:now};
 const answers=targets.map((target,index)=>({...common,id:randomUUID(),code:`document_transcription:${target.target_sha256}`,
  transcription_target:target,answer:index===0?SALARY_TYPE_TRANSCRIPTION_ANSWERS[0]:COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS[0]}));
 const nature=createJune2026CollectionTarget({checkpoint,policyVersion:policy,subject:{kind:'component',componentId:component.component_id}});
 const natureAnswer={...common,id:randomUUID(),code:`minimum_wage_june2026:${nature.target_sha256}`,june2026_target:nature,answer:JUNE2026_COMPONENT_DECLARATIONS.base_salary};
 const journal={answers:[...answers,natureAnswer]};
 const materialize=(value:unknown=journal)=>materializeDevFinancialSourceCompletions({caseId:checkpoint.case_id,orderId,checkpoint,journal:value,policyVersion:policy});
 const complete=()=>{const result=materialize();if(result.state!=='completed')throw Error('EXPECTED_COMPLETION');return result.snapshot;};
 return {checkpoint,component,targets,journal,materialize,complete};
}
function parentFor(checkpoint:ReturnType<typeof syntheticCheckpoint>):EmploymentSnapshot{
 const common={case_id:checkpoint.case_id,confidence:.94,conflicting_fact_ids:[],resolution:null,created_at:now};
 return employmentSnapshotSchema.parse({snapshot_id:randomUUID(),case_id:checkpoint.case_id,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:now,facts:[
  ...(['compensation.salary_type','compensation.base_monthly_salary','work.regular_hours'] as const).map(path=>({...common,fact_id:randomUUID(),path,value:null,status:'missing',
   provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:checkpoint.version_id},read_by:'machine',verified:false}]})),
  {...common,fact_id:randomUUID(),path:'documents.period',status:'confirmed',value:{document_id:checkpoint.version_id,period:{start_date:'2026-06-01',end_date:'2026-06-30'}},
   provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:checkpoint.version_id,locator:{page:1}},read_by:'machine',verified:true}]},
 ]});
}
function runCandidate(s=setup(),hours='100'){
 const completions=s.complete(),parent=parentFor(s.checkpoint),runId=randomUUID(),checkpointSha=s.checkpoint.result_sha256;
 const reading={request_id:randomUUID(),answer_revision:1,identity_id:identityId,answered_at:now,answer:hours,version_id:s.checkpoint.version_id,checkpoint_sha256:checkpointSha};
 const facts=devFinancialFactsV2(parent,runId,reading,completions),calculation=calculateDevMinimumWage({facts,month:'2026-06',calculatedAt:now});
 const job={schema_version:'saved-case-work-v1' as const,case_id:s.checkpoint.case_id,revision:25,input_sha256:inputSha,mode:'draft' as const};
 const provenance=readSavedExtractionProvenance(s.checkpoint),receipt=provenance.receipts[0];
 return {schema_version:DEV_FINANCIAL_SCHEMA_V2,authority:'engineering_only' as const,run_id:runId,case_id:s.checkpoint.case_id,public_id:'TV-1234ABCD',order_id:orderId,
  input_revision:25,input_sha256:inputSha,month:'2026-06' as const,parent_run_id:parent.analysis_run_id,parent_result_sha256:'7'.repeat(64),parent_key:savedMonthIdempotencyKey(job,orderId,'2026-06'),
  parent_key_catalog_sha256:JUNE2026_REVIEW_CATALOG_SHA256,parent_facts:parent,parent_facts_sha256:canonicalSha256(parent),facts,facts_sha256:canonicalSha256(facts),reading,source_completions:completions,
  source:{document_id:s.checkpoint.product_document_id,version_id:s.checkpoint.version_id,source_sha256:s.checkpoint.input_sha256,checkpoint_sha256:checkpointSha,
   path:`cases/${s.checkpoint.case_id}/versions/${s.checkpoint.version_id}.pdf`,mime:'application/pdf' as const,size:receipt.source_size_bytes,page:1},
  policy_sha256:canonicalSha256(DEV_MINIMUM_WAGE_POLICY),created_at:now,calculation,finding:devFinancialFinding(runId,calculation),request_id:reading.request_id,
  scenario:'synthetic_adult_hourly_general_182_regular_base_only' as const,extraction_provider:provenance.kind,extraction_provenance:provenance};
}
function rehash<T extends {snapshot_sha256:string}>(snapshot:T){const {snapshot_sha256,...body}=snapshot;void snapshot_sha256;return {...body,snapshot_sha256:canonicalSha256(body)};}

describe('source-bound engineering completions preserve canonical and OCR history',()=>{
 it('requires explicit readings of both cells plus the separate component-nature declaration',()=>{
  const s=setup();expect(s.materialize({answers:[]})).toEqual({state:'incomplete',missing:['salary_type','component_amount','component_nature']});
  expect(s.materialize({answers:s.journal.answers.slice(0,2)})).toEqual({state:'incomplete',missing:['component_nature']});
  expect(s.materialize({answers:[s.journal.answers[0],s.journal.answers[2]]})).toEqual({state:'incomplete',missing:['component_amount']});
  expect(s.complete().component_nature).toMatchObject({legal_classification_status:'unreviewed',candidate_evidence_admitted:false,evidence_status:'needs_confirmation'});
 });
 it('accepts SQL-style null sibling targets without changing the selected readings or snapshot',()=>{
  const s=setup(),answers=s.journal.answers.map(answer=>({field_target:null,transcription_target:null,june2026_target:null,...answer}));
  const result=s.materialize({answers});
  expect(result.state).toBe('completed');
  if(result.state!=='completed')throw Error('EXPECTED_COMPLETION');
  expect(result.snapshot).toEqual(s.complete());
 });
 it.each(['missing','null'] as const)('still rejects a %s relevant target in either namespace when irrelevant targets are null',kind=>{
  const s=setup();
  for(const index of [0,1,2]){
   const answers=s.journal.answers.map(answer=>({field_target:null,transcription_target:null,june2026_target:null,...answer}));
   const relevant=index===2?'june2026_target':'transcription_target';
   const changed={...answers[index],[relevant]:kind==='null'?null:undefined};
   expect(()=>s.materialize({answers:answers.map((answer,i)=>i===index?changed:answer)})).toThrow();
  }
 });
 it('computes the independently specified 100 × 35.40 − 3300 = 240 only from effective facts',()=>{
  const s=setup(),original=canonicalSha256(s.checkpoint),p=runCandidate(s),run=parseDevFinancialRun(p);
  expect(run.finding?.gap_minor).toBe(24000);expect(run.calculation).toMatchObject({state:'calculated',expectedMinor:354000,recordedMinor:330000});
  expect(run.parent_facts.facts.find(f=>f.path==='compensation.base_monthly_salary')?.value).toBeNull();
  expect(run.parent_facts.facts.find(f=>f.path==='compensation.salary_type')?.value).toBeNull();
  expect(()=>assertDevFinancialScenario(run.parent_facts,s.checkpoint.version_id)).toThrow();
  expect(run.facts.analysis_run_id).toBe(run.run_id);expect(canonicalSha256(s.checkpoint)).toBe(original);
  expect(s.component.semantic_kind).toBe('unknown');expect(s.component.confidence).toBe(.94);
  expect(run.facts.facts.find(f=>f.path==='compensation.base_monthly_salary')?.provenance).toEqual(expect.arrayContaining([
   {source_type:'declared',source_reference:{kind:'case_request_answer',request_id:s.journal.answers[1].id,answer_revision:1}},
   {source_type:'declared',source_reference:{kind:'case_request_answer',request_id:s.journal.answers[2].id,answer_revision:1}},
  ]));
 });
 it('does not infer missing hours after completing the source cells',()=>{
  const s=setup(),parent=parentFor(s.checkpoint),facts=devFinancialFactsV2(parent,randomUUID(),null,s.complete());
  expect(calculateDevMinimumWage({facts,month:'2026-06',calculatedAt:now})).toEqual({state:'missing_input',fields:['work.regular_hours']});
 });
 it.each(['compensation.salary_type','compensation.base_monthly_salary'] as const)('never overwrites present, conflicted or rejected parent %s',path=>{
  const s=setup(),parent=parentFor(s.checkpoint);
  for(const patch of [{value:path==='compensation.salary_type'?'hourly':{currency:'ILS',minor_units:330000},status:'needs_confirmation'},
   {value:null,status:'conflicted',conflicting_fact_ids:[randomUUID(),randomUUID()]},{value:path==='compensation.salary_type'?'hourly':{currency:'ILS',minor_units:330000},status:'rejected'}]){
   const changed=employmentSnapshotSchema.parse({...parent,facts:parent.facts.map(f=>f.path===path?{...f,...patch}:f)});
   expect(()=>devFinancialCompletionFacts(changed,randomUUID(),s.complete())).toThrow('DEV_FINANCIAL_NONMISSING_INPUT_OVERRIDE');
  }
 });
 it('rejects null needs_confirmation because the unchanged canonical schema permits only missing/conflicted nulls',()=>{
  const s=setup(),parent=parentFor(s.checkpoint),changed={...parent,facts:parent.facts.map(f=>f.value===null?{...f,status:'needs_confirmation' as const}:f)};
  expect(()=>devFinancialCompletionFacts(changed,randomUUID(),s.complete())).toThrow('Only missing or conflicted facts may have no value');
 });
 it.each([SALARY_TYPE_TRANSCRIPTION_ANSWERS[3],SALARY_TYPE_TRANSCRIPTION_ANSWERS[4]])('retains unconfirmed salary answer %s',answer=>{
  const s=setup();expect(s.materialize({answers:s.journal.answers.map((a,i)=>i===0?{...a,answer}:a)})).toEqual({state:'incomplete',missing:['salary_type']});
 });
 it('refuses monthly or mixed documentary transcriptions for the hourly-only scenario',()=>{
  const s=setup();for(const answer of SALARY_TYPE_TRANSCRIPTION_ANSWERS.slice(1,3))expect(()=>s.materialize({answers:s.journal.answers.map((a,i)=>i===0?{...a,answer}:a)})).toThrow('DEV_FINANCIAL_COMPLETION_SOURCE_UNSUPPORTED');
 });
 it('does not substitute a nature declaration for a negative amount reading',()=>{
  const s=setup();expect(s.materialize({answers:s.journal.answers.map((a,i)=>i===1?{...a,answer:COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS[1]}:a)})).toEqual({state:'incomplete',missing:['component_amount']});
 });
 it('rejects a foreign case, duplicate request or rewritten target code in the journal',()=>{
  const s=setup();for(const answers of [[...s.journal.answers,s.journal.answers[0]],s.journal.answers.map((a,i)=>i===0?{...a,case_id:randomUUID()}:a),
   s.journal.answers.map((a,i)=>i===0?{...a,code:'document_transcription:'+'a'.repeat(64)}:a)])expect(()=>s.materialize({answers})).toThrow();
 });
 it('refuses stale target/checkpoint and modified amount even after recalculating the outer hash',()=>{
  const s=setup(),p=s.complete();
  for(const change of [
   {...p,case_id:randomUUID()},
   {...p,checkpoint:{...p.checkpoint,input_sha256:'a'.repeat(64)}},
   {...p,readings:p.readings.map(r=>r.target.subject.kind==='component_amount'?{...r,normalized_value:{currency:'ILS',minor_units:1}}:r)},
   {...p,component_nature:{...p.component_nature,candidate_evidence_admitted:true}},
  ])expect(()=>parseDevFinancialSourceCompletions(rehash(change))).toThrow();
 });
 it('rejects changed effective amounts, source/run, parent period and provider claims',()=>{
  const p=runCandidate();
  const facts=employmentSnapshotSchema.parse({...p.facts,facts:p.facts.facts.map(f=>f.path==='compensation.base_monthly_salary'?{...f,value:{currency:'ILS',minor_units:1}}:f)});
  const parent=employmentSnapshotSchema.parse({...p.parent_facts,facts:p.parent_facts.facts.map(f=>f.path==='documents.period'?{...f,status:'needs_confirmation'}:f)});
  for(const tampered of [{...p,facts,facts_sha256:canonicalSha256(facts)},{...p,source:{...p.source,page:2}},{...p,run_id:randomUUID()},
   {...p,parent_facts:parent,parent_facts_sha256:canonicalSha256(parent)},{...p,extraction_provider:'openai_live'},
   {...p,source_completions:rehash({...p.source_completions,order_id:randomUUID()})}])expect(()=>parseDevFinancialRun(tampered)).toThrow();
 });
 it('replays identical HTML/PDF and keeps the same financial run and arithmetic in both',()=>{
  const p=runCandidate(),a=renderDevFinancialArtifacts(p),b=renderDevFinancialArtifacts(p);
  expect(a).toEqual(b);const pdf=[...Buffer.from(a.pdf).toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>/gu)]
   .map(m=>String.fromCharCode(...m[1].match(/.{4}/gu)!.map(hex=>parseInt(hex,16)))).join('').replace(/\s/gu,'');
  for(const value of [p.run_id,'3540.00','3300.00','240.00']){expect(a.html).toContain(value);expect(pdf).toContain(value);}
 });
 it.skipIf(process.env.TIVDOC_RETAINED_COMPLETION_REPLAY!=='1')('validates the authentic retained checkpoint offline without changing bytes or claiming a new OCR call',()=>{
  const bytes=readFileSync('output/release-completion/dev-financial-live-flow/87eb4418-7d9f-4b68-aa86-82be059295ac/missing-extraction.json');
  const checkpoint=JSON.parse(bytes.toString('utf8')) as ReturnType<typeof syntheticCheckpoint>,before=canonicalSha256(checkpoint),s=setup(checkpoint);
  expect(checkpoint.case_id).toBe('87eb4418-7d9f-4b68-aa86-82be059295ac');expect(checkpoint.result_sha256).toBe('ad86e2da0337294e6e0fa9cfdeb910519cca6fd79f3e85f1e71080114d584dff');
  expect(s.materialize({answers:[]})).toMatchObject({state:'incomplete'});
  const parent=parentFor(checkpoint),waiting=devFinancialFactsV2(parent,randomUUID(),null,s.complete());
  expect(calculateDevMinimumWage({facts:waiting,month:'2026-06',calculatedAt:now})).toEqual({state:'missing_input',fields:['work.regular_hours']});
  expect(parseDevFinancialRun(runCandidate(s)).finding?.gap_minor).toBe(24000);
  expect(canonicalSha256(checkpoint)).toBe(before);expect(Buffer.compare(bytes,readFileSync('output/release-completion/dev-financial-live-flow/87eb4418-7d9f-4b68-aa86-82be059295ac/missing-extraction.json'))).toBe(0);
 });
});
