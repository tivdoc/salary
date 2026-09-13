import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {createTopicRuleInputSnapshot} from '../rule-input/snapshot.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {createJune2026MinimumWageCandidate} from './candidate.ts';
import {prepareJune2026AdmittedContext,type June2026AdmittedContextInput} from './admitted-context.ts';
import {prepareJune2026AssessmentPacket,type June2026AssessmentPacket} from './assessment-packet.ts';
import {june2026TestAssessmentSchema} from './evidence-admission.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from './sources.ts';
import {createJune2026CollectionTarget,resolveJune2026CollectionAnswer,JUNE2026_COMPONENT_DECLARATIONS,
 JUNE2026_DECLARATION_OPTIONS,type June2026CollectionSelector} from './collection.ts';

export const admissionTestNow='2026-09-10T14:10:00.000Z';
export const admissionTestExtractionPolicy='saved-payslip-v21-p95-v1';
const yes=JUNE2026_DECLARATION_OPTIONS[0],no=JUNE2026_DECLARATION_OPTIONS[1];

/** Synthetic documents and identified answers only. These fixtures establish
 * no real source reading, registry authorization or professional attestation. */
export function createAdmissionTestFixture(withAnswers=true){
 const original=buildSyntheticCaseFixture({fixture_id:'june2026-admission-boundary',mode:'real'}),document=original.stored.documents[0];
 const extraction=normalizedPayslipExtractionSchema.parse(structuredClone(original.stored.extractions[0]));
 for(const field of extraction.fields){
  if(field.field==='salary_period')field.normalized_value={year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'};
  if(field.field==='salary_type')field.normalized_value='hourly';
  if(field.field==='regular_hours')field.normalized_value={amount:'100',unit:'hours_per_month'};
  if(field.field==='base_monthly_salary'||field.field==='gross_salary')field.normalized_value={currency:'ILS',minor_units:330000};
 }
 const component=normalizedAdditionalComponentSchema.parse({component_id:randomUUID(),source_label:'שכר יסוד',normalized_label:null,
  semantic_kind:'base_salary',quantity_raw:'100',rate_raw:'33',percentage_raw:null,amount_raw:'3300',confidence:0.94,
  source:{document_id:document.document_id,page:1,text_fragment:'Synthetic base salary 100 hours x 33 = 3300'},extraction_method:'fixture',warning_flags:[],
  quantity:'100',rate:{currency:'ILS',minor_units:3300},percentage:null,amount:{currency:'ILS',minor_units:330000},normalization_warnings:[]});
 extraction.additional_components=[component];
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,
  input_sha256:document.content_sha256,expected_month:'2026-06',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction}}};
 const paths=['work.regular_hours','compensation.base_monthly_salary','compensation.gross_salary','compensation.salary_type','documents.period'] as const;
 const values=[{amount:'100',unit:'hours_per_month'},{currency:'ILS',minor_units:330000},{currency:'ILS',minor_units:330000},'hourly',
  {document_id:document.document_id,period:{start_date:'2026-06-01',end_date:'2026-06-30'}}];
 const facts=employmentSnapshotSchema.parse({schema_version:'1.0.0',snapshot_id:randomUUID(),case_id:document.case_id,analysis_run_id:randomUUID(),created_at:admissionTestNow,
  facts:paths.map((path,index)=>({fact_id:randomUUID(),case_id:document.case_id,path,value:values[index],status:'confirmed',confidence:1,
   provenance:[{source_type:'documented',source_reference:{kind:'document',document_id:document.document_id,locator:{page:1}},read_by:'machine',verified:false}],
   conflicting_fact_ids:[],resolution:null,created_at:admissionTestNow}))});
 const saved={case_id:document.case_id,analysis_run_id:facts.analysis_run_id,input_revision:3,input_sha256:'e'.repeat(64),order_id:randomUUID(),month:'2026-06' as const};
 const input:June2026AdmittedContextInput={current:{...saved,topics:['minimum_wage'],document:{product_document_id:checkpoint.product_document_id,
  version_id:document.document_id,sha256:document.content_sha256,page_count:extraction.quality_metrics.page_count}},saved,
  canonicalStage:{facts,facts_snapshot_sha256:''},ruleInput:{snapshot_id:'',snapshot_version:'',snapshot_sha256:''},checkpoint,
  extractionPolicyVersion:admissionTestExtractionPolicy,collection:{schema_version:'saved-june2026-collection-evidence-v1',case_id:document.case_id,month:'2026-06',
   evaluated_at:admissionTestNow,resolutions:[],legal_confirmation:false,rule_activation:false}};
 const collection=input.collection as {resolutions:unknown[]};
 function repin(){
  checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
  input.canonicalStage.facts_snapshot_sha256=canonicalSha256(facts);
  Object.assign(input.ruleInput,createTopicRuleInputSnapshot(facts,'minimum_wage'));
 }
 repin();
 function addAnswer(subject:June2026CollectionSelector,answer:string,answerRevision=1){
  const target=createJune2026CollectionTarget({checkpoint,policyVersion:admissionTestExtractionPolicy,subject});
  const resolution=resolveJune2026CollectionAnswer({target,currentCheckpoint:checkpoint,policyVersion:admissionTestExtractionPolicy,caseId:document.case_id,month:'2026-06',
   requestId:randomUUID(),answerRevision,identityId:randomUUID(),answeredAt:admissionTestNow,answer});
  collection.resolutions.push(resolution);return resolution;
 }
 if(withAnswers){
  addAnswer({kind:'applicability',field:'age_18_entire_month'},yes);
  addAnswer({kind:'applicability',field:'sector'},'Synthetic office supplies shop; no claimed sector agreement');
  addAnswer({kind:'applicability',field:'hours_rest_law_applies'},'Synthetic hourly clerk, recorded hours and direct supervision');
  addAnswer({kind:'applicability',field:'no_better_minimum_wage_arrangement'},no);
  addAnswer({kind:'applicability',field:'no_adapted_minimum_wage'},no);
  addAnswer({kind:'applicability',field:'regular_hours_exclude_absence_overtime_rest'},yes);
  addAnswer({kind:'earnings_completeness'},yes);
  addAnswer({kind:'component',componentId:component.component_id},JUNE2026_COMPONENT_DECLARATIONS.base_salary);
 }
 const packet=()=>prepareJune2026AssessmentPacket({context:prepareJune2026AdmittedContext(input),facts});
 return {facts,extraction,component,checkpoint,input,collection,repin,addAnswer,packet};
}

/** This is an explicitly labelled private-test assumption shape, not a fake
 * human signature. Production authority is intentionally absent. */
export function createTestAssessment(packet:June2026AssessmentPacket){
 const candidate=createJune2026MinimumWageCandidate(1);
 return june2026TestAssessmentSchema.parse({schema_version:'june2026-isolated-test-assessment-v1',authority:'isolated_dev_test_assumptions',human_approval:false,
  assessment_id:randomUUID(),case_id:packet.current.case_id,order_id:packet.current.order_id,input_revision:packet.current.input_revision,input_sha256:packet.current.input_sha256,
  document_version_id:packet.document.version_id,document_sha256:packet.document.sha256,policy_sha256:JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
  rule_sha256:candidate.rule.content_sha256,golden_cases_sha256:candidate.goldenCases.content_sha256,issued_at:'2026-09-10T13:00:00.000Z',expires_at:'2026-09-11T13:00:00.000Z',
  source:'Synthetic test registry fixture; no professional authority',decisions:packet.gates.map(gate=>{
   if(!gate.observed_declaration||!gate.current_target_sha256)throw Error('TEST_DECLARATION_REQUIRED');
   return {field:gate.field,decision_kind:gate.field==='components.legal_classification'?'component_classification'
    :gate.field==='wage_components_complete'?'inventory_assessment':'applicability_assessment',target_sha256:gate.current_target_sha256,
    declaration_sha256:gate.observed_declaration.declaration_sha256,
    value:gate.field==='applicability.sector'?'general_private':gate.field==='components.legal_classification'?'base_salary':true,
    source:'Synthetic fixture assumption',rationale:'Assumed for this isolated engineering test only; not a legal approval'};
  })});
}
