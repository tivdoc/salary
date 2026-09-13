import {describe,expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21,recoveryDecisionForV21} from '@/engine/extraction/v21';
import {extractionRequestSchema} from '@/engine/extraction/contracts';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from '@/server/product/processing/live-extraction-corpus';
import {mapOpenAiV2Output} from './v2-mapper';
import {openAiPayslipV2StructuredOutputSchema,type OpenAiPayslipV2StructuredOutput} from './v2-schema';
import {explicitHourlyBaseCells,HOURLY_ROW_READING_WARNING,OPENAI_V2_HOURLY_ROW_EVIDENCE_POLICY} from './v2-hourly-row-evidence';
vi.mock('server-only',()=>({}));

const request=syntheticPayslipFixtures[0].request;
const cell=(raw_value:string)=>({raw_value,confidence:'high' as const,evidence:{page:1,region:'totals' as const,source_label:'Synthetic printed total'},warnings:[]});
const output=():OpenAiPayslipV2StructuredOutput=>({detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
 salary_type:{documented_value:'hourly',documented_raw_value:'סוג שכר: שעתי',documented_confidence:'high',documented_evidence:{page:1,region:'header',source_label:'סוג שכר'},
  inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
 generic_fields:[{field:'salary_period',candidates:[{...cell('06/2026'),evidence:{page:1,region:'header',source_label:'Period'}}]}],
 payroll_rows:[{source_label:'001',semantic_kind:'base_salary',quantity_raw:'100',rate_raw:'33.00',percentage_raw:null,amount_raw:'3300.00',confidence:'high',evidence:{page:1,region:'earnings',source_label:'שכר יסוד שעתי'},warnings:[]}],
 totals:{visible:true,gross_candidates:[cell('3300.00')],deductions_candidates:[cell('0.00')],net_candidates:[cell('3300.00')]},
 pension:{visible:false,base_candidates:[],employee:{rate_candidates:[],amount_candidates:[]},employer:{rate_candidates:[],amount_candidates:[]},severance:{rate_candidates:[],amount_candidates:[]}},earnings_components_complete:true,warnings:[]});
const mapping=(value=output(),allowedFields?:Parameters<typeof mapOpenAiV2Output>[0]['allowedFields'])=>mapOpenAiV2Output({request,output:value,model:'synthetic-offline',extractorVersion:'2.1',durationMs:1,providerResponseId:'synthetic-offline',tokenUsage:null,extractedAt:request.requested_at,allowedFields});
const evaluate=(mapped:ReturnType<typeof mapping>)=>buildPassEvaluation({pass_id:request.extraction_id,kind:'first_pass',requested_fields:[],selected_regions:[],prompt_version:'offline-mapper-regression',model:'synthetic-offline',
 raw_extraction:mapped.extraction,salary_type_assessment:mapped.salary_type_assessment,pension_section_visible:mapped.pension_section_visible,totals_section_visible:mapped.totals_section_visible,critical_context:mapped.critical_context,reference_year:2026});

describe('explicit hourly base cells remain source-bound readings',()=>{
 it('preserves100 and33.00 with the actual hourly label, without changing the provider row or claiming reliable extraction',()=>{
  const value=output(),before=canonicalSha256(value),mapped=mapping(value),pass=evaluate(mapped);
  expect(canonicalSha256(value)).toBe(before);expect(OPENAI_V2_HOURLY_ROW_EVIDENCE_POLICY).toBe('payslip-v2-explicit-hourly-row-cells-v1');
  const fields=mapped.extraction.fields.filter(f=>f.field==='regular_hours'||f.field==='hourly_rate');expect(fields.map(f=>f.raw_value)).toEqual(['100','33.00']);
  for(const field of fields){expect(field.warning_flags).toContain(HOURLY_ROW_READING_WARNING);expect(field.confidence).toBeLessThan(0.94);expect(field.source.document_id).toBe(request.document.document_id);expect(field.source.page).toBe(1);expect(field.source.text_fragment).toContain('שכר יסוד שעתי');}
  expect(mapped.extraction.additional_components[0]).toMatchObject({source_label:'001',semantic_kind:'base_salary',quantity_raw:'100',rate_raw:'33.00',amount_raw:'3300.00',warning_flags:[]});
  const result=resolvePayslipExtractionPassesV21({first_pass:pass,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),final_extraction_id:request.extraction_id,critical_context:mapped.critical_context,reference_year:2026});
  expect(result.final_extraction.fields.find(f=>f.field==='regular_hours')?.normalized_value).toEqual({amount:'100',unit:'hours_per_month'});
  expect(result.final_extraction.fields.find(f=>f.field==='hourly_rate')?.normalized_value).toEqual({currency:'ILS',minor_units:3300});
  expect(result.final_confidence_assessment.decisions.filter(d=>d.field==='regular_hours'||d.field==='hourly_rate').map(d=>d.status)).toEqual(['needs_confirmation','needs_confirmation']);
 });
 it.each(['mixed','monthly',null] as const)('does not override a documented%s salary type even when a row label looks hourly',documented=>{
  const value=output(),raw=documented===null?null:documented==='mixed'?'סוג שכר: מעורב':'סוג שכר: חודשי';
  const changed={...value,salary_type:{...value.salary_type,documented_value:documented,documented_raw_value:raw}};
  expect(explicitHourlyBaseCells(changed,changed.payroll_rows[0])).toBeNull();expect(mapping(changed).extraction.fields.some(f=>f.field==='regular_hours'||f.field==='hourly_rate')).toBe(false);
  if(documented==='mixed')expect(mapping(changed).salary_type_assessment.documented?.value).toBe('mixed');
 });
 it('refuses an hourly enum when its actual header text says monthly; an inferred hourly type is insufficient',()=>{
  const value=output();expect(explicitHourlyBaseCells({...value,salary_type:{...value.salary_type,documented_raw_value:'סוג שכר: חודשי'}},value.payroll_rows[0])).toBeNull();
  expect(explicitHourlyBaseCells({...value,salary_type:{...value.salary_type,documented_value:null,documented_raw_value:null,inferred_value:'hourly',inference_basis:['hourly_rate']}},value.payroll_rows[0])).toBeNull();
 });
 it.each([
  {quantity_raw:null},{rate_raw:null},{quantity_raw:'100 hours'},{quantity_raw:'0'},{rate_raw:'NaN'},{amount_raw:null},{percentage_raw:'125%'},
  {semantic_kind:'unknown'},{semantic_kind:'overtime_125'},{warnings:['ambiguous_value']},
  {evidence:{page:1,region:'earnings',source_label:'שכר יסוד'}},{evidence:{page:1,region:'earnings',source_label:'001'}},
  {evidence:{page:1,region:'pension',source_label:'שכר יסוד שעתי'}},{evidence:{page:2,region:'earnings',source_label:'שכר יסוד שעתי'}},
 ])('refuses missing, ambiguous or out-of-scope cells%j',patch=>{
  const value=output(),row=openAiPayslipV2StructuredOutputSchema.parse({...value,payroll_rows:[{...value.payroll_rows[0],...patch}]}).payroll_rows[0];
  expect(explicitHourlyBaseCells(value,row)).toBeNull();
 });
 it('does not duplicate normal hourly_base mapping and respects a targeted field allowlist',()=>{
  const value=output(),ordinary=mapping({...value,payroll_rows:[{...value.payroll_rows[0],semantic_kind:'hourly_base'}]});
  expect(ordinary.extraction.fields.filter(f=>f.field==='regular_hours')).toHaveLength(1);expect(ordinary.extraction.fields.find(f=>f.field==='regular_hours')?.warning_flags).toEqual([]);
  const targeted=mapping(value,['regular_hours']);expect(targeted.extraction.fields.map(f=>f.field)).toEqual(['regular_hours']);expect(targeted.extraction.additional_components).toEqual([]);
 });
 it('retains an independently observed conflicting quantity; it never selects the value that balances the salary',()=>{
  const value=output(),conflicting=mapping({...value,payroll_rows:[{...value.payroll_rows[0],semantic_kind:'hourly_base',source_label:'Second printed hourly row',quantity_raw:'90'},...value.payroll_rows]});
  expect(conflicting.extraction.fields.filter(f=>f.field==='regular_hours').map(f=>f.raw_value)).toEqual(['90','100']);
  expect(evaluate(conflicting).validation.issues.some(i=>i.code==='conflicting_candidates'&&i.field_keys.includes('regular_hours'))).toBe(true);
 });
});

// Optional authentic-receipt replay is OFFLINE. These are derivative mapper
// observations, not new live receipts; neither original proof nor ledger is
// written, and incomplete/wrong provider fields must still fail the oracle.
it.skipIf(process.env.TIVDOC_HOURLY_ROW_RECEIPT_REPLAY!=='1')('replays both actual047fa41 structured responses without changing their failed live proof',()=>{
 const directory='output/release-completion/live-provider-june2026/hebrew-scan-probe-047fa41-caeb6644-d78f-478b-bd84-a575e69e1b6e';
 const proofBytes=readFileSync(directory+'/proof.json'),ledgerBytes=readFileSync('output/release-completion/live-provider-june2026/live-provider-budget-ledger.json'),proof=JSON.parse(proofBytes.toString('utf8'));
 expect(proof.state).toBe('FAIL');expect(proof.budget.reservedPasses).toBe(21);
 const observations:unknown[]=[];
 for(const entry of loadLiveExtractionCorpus('hebrew-june2026','he-clear,he-scan-clear')){
  const structuredBytes=readFileSync(`${directory}/${entry.id}-structured.json`),captured=JSON.parse(structuredBytes.toString('utf8'));
  const oldBytes=readFileSync(`${directory}/${entry.id}-mapped.json`),old=JSON.parse(oldBytes.toString('utf8')),oldResult=proof.results.find((r:{id:string})=>r.id===entry.id);
  expect(captured.origin).toBe('openai_live');expect(captured.source_sha256).toBe(entry.sha256);expect(captured.structured_output_sha256).toBe(canonicalSha256(captured.structured_output));expect(oldResult.structuredOutputSha256).toBe(captured.structured_output_sha256);
  expect(old.provider_receipt.raw_extraction_sha256).toBe(canonicalSha256(old.extraction));expect(old.extraction.fields.some((f:{field:string})=>f.field==='regular_hours'||f.field==='hourly_rate')).toBe(false);
  const actualRequest=extractionRequestSchema.parse({...request,case_id:captured.case_id,analysis_run_id:captured.analysis_run_id,extraction_id:old.extraction.extraction_id,
   document:{...request.document,case_id:captured.case_id,document_id:captured.document_id,content_sha256:entry.sha256,size_bytes:entry.sizeBytes,mime_type:entry.mimeType,
    storage_path:`cases/${captured.case_id}/documents/${captured.document_id}/original.${entry.mimeType==='application/pdf'?'pdf':'png'}`}});
  const mapped=mapOpenAiV2Output({request:actualRequest,output:captured.structured_output,model:old.extraction.provider.model_version,extractorVersion:old.extraction.provider.extractor_version,
   durationMs:old.extraction.operation.duration_ms,providerResponseId:captured.provider_response_id,tokenUsage:old.extraction.operation.token_usage,extractedAt:old.extraction.extracted_at});
  const pass=evaluate(mapped),resolved=resolvePayslipExtractionPassesV21({first_pass:pass,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),final_extraction_id:actualRequest.extraction_id,critical_context:mapped.critical_context,reference_year:2026});
  const comparison=checkLiveExtractionCorpus({entry,extraction:resolved.final_extraction,validation:resolved.final_validation});expect(comparison.passed).toBe(false);expect(resolved.final_validation.status).toBe('invalid');
  if(entry.id==='he-scan-clear'){
   expect(resolved.final_extraction.fields.find(f=>f.field==='regular_hours')?.normalized_value).toEqual({amount:'100',unit:'hours_per_month'});
   expect(resolved.final_extraction.fields.find(f=>f.field==='hourly_rate')?.normalized_value).toEqual({currency:'ILS',minor_units:3540});
   expect(comparison.failures).not.toContain('FIELD_regular_hours');expect(comparison.failures).not.toContain('FIELD_hourly_rate');
   expect(comparison.failures).toContain('FIELD_pension_employee_rate');expect(comparison.failures).toContain('DEDUCTION_ROW_COUNT');
  }else{
   expect(mapped.salary_type_assessment.documented?.value).toBe('mixed');expect(comparison.failures).toContain('FIELD_salary_type');expect(comparison.failures).toContain('FIELD_regular_hours');
  }
  observations.push({id:entry.id,sourceSha256:entry.sha256,structuredOutputSha256:captured.structured_output_sha256,originalProviderReceipt:old.provider_receipt.receipt_sha256,comparison,validationStatus:resolved.final_validation.status,readings:resolved.final_extraction.fields.filter(f=>['regular_hours','hourly_rate','salary_type'].includes(f.field)),confidence:resolved.final_confidence_assessment.decisions.filter(d=>['regular_hours','hourly_rate','salary_type'].includes(d.field))});
  expect(readFileSync(`${directory}/${entry.id}-structured.json`)).toEqual(structuredBytes);expect(readFileSync(`${directory}/${entry.id}-mapped.json`)).toEqual(oldBytes);
 }
 expect(readFileSync(directory+'/proof.json')).toEqual(proofBytes);expect(readFileSync('output/release-completion/live-provider-june2026/live-provider-budget-ledger.json')).toEqual(ledgerBytes);
 const out='output/release-completion/june-canonical';mkdirSync(out,{recursive:true});writeFileSync(out+'/hourly-row-replay.json',JSON.stringify({schemaVersion:'hourly-row-live-receipt-offline-replay-v1',gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeClean:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()==='',policy:OPENAI_V2_HOURLY_ROW_EVIDENCE_POLICY,liveProofSha256:canonicalSha256(proof),providerCalls:0,checkpointChanged:false,overallPayslipAccuracyProved:false,observations},null,2)+'\n');
});
