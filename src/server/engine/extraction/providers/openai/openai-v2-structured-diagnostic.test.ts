import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {preprocessPayslipDocument} from '../../preprocessing';
import {OpenAiPayslipV2PassExtractor,OPENAI_V2_STRUCTURED_DIAGNOSTIC_MAX_BYTES,type OpenAiV2StructuredDiagnostic} from './v2-adapter';
import type {OpenAiPayslipV2StructuredOutput} from './v2-schema';
import type {SafeEngineLog} from '@/server/engine/safe-logging';
vi.mock('server-only',()=>({}));

const fixture=syntheticPayslipFixtures[0];
const output=():OpenAiPayslipV2StructuredOutput=>({detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
 salary_type:{documented_value:'hourly',documented_raw_value:null,documented_confidence:'high',documented_evidence:{page:1,region:'header',source_label:'synthetic-visible-label'},
  inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
 generic_fields:[{field:'salary_period',candidates:[{raw_value:'06/2026',confidence:'high',evidence:{page:1,region:'header',source_label:'period'},warnings:[]}]}],
 payroll_rows:[],totals:{visible:false,gross_candidates:[],deductions_candidates:[],net_candidates:[]},
 pension:{visible:false,base_candidates:[],employee:{rate_candidates:[],amount_candidates:[]},employer:{rate_candidates:[],amount_candidates:[]},severance:{rate_candidates:[],amount_candidates:[]}},
 earnings_components_complete:false,warnings:[]});
async function setup(value=output()){
 const prepared=await preprocessPayslipDocument({bytes:new Uint8Array([37,80,68,70,45]),mime_type:'application/pdf'});
 const request={...fixture.request,document:{...fixture.request.document,mime_type:'application/pdf',content_sha256:prepared.original.sha256,size_bytes:prepared.original.bytes.length}};
 let calls=0;const logs:SafeEngineLog[]=[];
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-key-never-network',model:'synthetic-provider',timeoutMs:1000},{
  transport:{async parse(){calls++;return {id:'synthetic_response',requestId:'synthetic_request',status:'completed',outputParsed:value,usage:null};}},log:entry=>logs.push(entry)});
 return {input:{request,prepared,kind:'first_pass' as const,requestedFields:[],sourcePageCount:1},extractor,logs,calls:()=>calls,value};
}

describe('bounded structured response diagnostics preserve provider/mapper attribution',()=>{
 it('captures the original invalid optional pair before mapper isolation without changing it or its injected origin',async()=>{
  const test=await setup(),before=canonicalSha256(test.value);let diagnostic:OpenAiV2StructuredDiagnostic|undefined;
  const result=await test.extractor.extractPreparedPass({...test.input,onStructuredOutput:value=>{diagnostic=value;
   expect(Object.isFrozen(value.structured_output.salary_type)).toBe(true);
   expect(()=>{value.structured_output.salary_type.documented_raw_value='mutated';}).toThrow();}});
  expect(diagnostic).toMatchObject({schema_version:'tivdoc-openai-structured-diagnostic-v1',origin:'injected_test_provider',source_sha256:test.input.request.document.content_sha256,
   provider_response_id:'synthetic_response',provider_request_id:'synthetic_request',structured_output_sha256:before,
   structured_output:{salary_type:{documented_value:'hourly',documented_raw_value:null}}});
  expect(result.salary_type_assessment.documented).toBeNull();expect(result.extraction.warnings).toContain('salary_type_documented_pair_invalid');
  expect(result.provider_receipt).toMatchObject({origin:'injected_test_provider',provider_attempted:true});expect(test.calls()).toBe(1);
  expect(canonicalSha256(test.value)).toBe(before);expect(result).not.toHaveProperty('structured_output');
  expect(JSON.stringify(test.logs)).not.toContain('synthetic-visible-label');expect(JSON.stringify(diagnostic)).not.toContain('synthetic-key-never-network');
 });
 it('does not add response payloads to normal results or logs when no sink is supplied',async()=>{
  const test=await setup(),result=await test.extractor.extractPreparedPass(test.input);
  expect(test.calls()).toBe(1);expect(result).not.toHaveProperty('structured_output');expect(result).not.toHaveProperty('diagnostic');
  expect(JSON.stringify(test.logs)).not.toContain('synthetic-visible-label');
 });
 it('retains a known attempted-provider receipt if the diagnostic writer fails; it never retries',async()=>{
  const test=await setup(),result=await test.extractor.extractPreparedPass({...test.input,onStructuredOutput(){throw Error('synthetic-secret-writer-message');}});
  expect(result.extraction.status).toBe('failed');expect(result.provider_receipt).toMatchObject({provider_attempted:true,provider_response_id:'synthetic_response',origin:'injected_test_provider'});
  expect(test.calls()).toBe(1);expect(JSON.stringify(result)).not.toContain('synthetic-secret-writer-message');expect(JSON.stringify(test.logs)).not.toContain('synthetic-secret-writer-message');
 });
 it('does not emit schema-invalid structured output to the diagnostic sink',async()=>{
  const test=await setup({...output(),unrecognized:true} as OpenAiPayslipV2StructuredOutput),sink=vi.fn();
  const result=await test.extractor.extractPreparedPass({...test.input,onStructuredOutput:sink});
  expect(result.extraction.status).toBe('failed');expect(sink).not.toHaveBeenCalled();expect(test.calls()).toBe(1);
 });
 it('bounds diagnostic payload bytes even if a transport returns an oversized schema-valid array',async()=>{
  const large:OpenAiPayslipV2StructuredOutput={...output(),generic_fields:Array.from({length:600},()=>({field:'salary_period',candidates:[{raw_value:'x'.repeat(500),confidence:'low',evidence:{page:1,region:'header',source_label:null},warnings:[]}]}))};
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(OPENAI_V2_STRUCTURED_DIAGNOSTIC_MAX_BYTES);
  const test=await setup(large),sink=vi.fn(),result=await test.extractor.extractPreparedPass({...test.input,onStructuredOutput:sink});
  expect(result.extraction.status).toBe('failed');expect(sink).not.toHaveBeenCalled();expect(test.calls()).toBe(1);
 });
});
