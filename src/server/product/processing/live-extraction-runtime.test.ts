import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import {OpenAiPayslipV2PassExtractor,type OpenAiV2ResponsesTransport} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {createOpenAiProviderReceipt,parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {createLiveExtractionRuntime} from './live-extraction-runtime';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {devFinancialInputFixture} from './dev-financial-flow.fixture';
vi.mock('server-only',()=>({}));

async function setup(error?:unknown){
 const source=await devFinancialInputFixture(false),caseId=randomUUID(),versionId=randomUUID(),runId=randomUUID();
 const parse=vi.fn<OpenAiV2ResponsesTransport['parse']>(async()=>{
  if(error)throw error;
  return {id:'resp_synthetic_receipt',requestId:'req_synthetic_receipt',model:'reported-model-version',status:'completed',
   outputParsed:structuredClone(source.output),usage:{input_tokens:100,output_tokens:30,total_tokens:130}};
 });
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'unit-test-secret',model:'requested-model-version',timeoutMs:1000},{transport:{parse},extractorVersion:'2.1'});
 const context={snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:runId,schema_version:'1.0.0',created_at:'2026-09-09T15:00:00Z',
  fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,randomUUID()]))};
 const input={caseId,versionId,expectedMonth:'2026-06',context,extractor,
  db:{async query(){return {rows:[{id:randomUUID(),case_id:caseId,version_id:versionId,document_type:'payslip',
   storage_path:`cases/${caseId}/versions/${versionId}.pdf`,original_filename:source.name,mime_type:'application/pdf',size:source.bytes.length,
   content_sha256:source.sha256,period_month:'2026-06-01',created_at:'2026-09-09T15:00:00Z'}]};}},
  storage:{async download(){return {data:new Blob([Buffer.from(source.bytes)],{type:'application/pdf'}),error:null};}},
 };
 return {source,parse,input,run:()=>extractSavedPayslip(input)};
}

describe('live runtime configuration',()=>{
 it.each([{}, {OPENAI_API_KEY:''},{OPENAI_API_KEY:'  '}])('blocks missing credentials before creating a provider: %j',environment=>{
  expect(createLiveExtractionRuntime(environment)).toEqual({state:'blocked',code:'LIVE_EXTRACTION_PROVIDER_UNCONFIGURED',provider:'openai'});
 });
 it.each([{OPENAI_EXTRACTION_MODEL:'bad model secret'}, {OPENAI_EXTRACTION_TIMEOUT_MS:'NaN'}, {OPENAI_EXTRACTION_TIMEOUT_MS:'999999'}])('redacts invalid configuration %j',invalid=>{
  expect(createLiveExtractionRuntime({OPENAI_API_KEY:'never-print-secret',...invalid})).toEqual({state:'blocked',code:'LIVE_EXTRACTION_CONFIG_INVALID',provider:'openai'});
 });
 it('creates only the SDK-backed provider and does not equate configured with proved',()=>{
  const runtime=createLiveExtractionRuntime({OPENAI_API_KEY:'unit-test-not-used',OPENAI_EXTRACTION_MODEL:'configured-model'});
  expect(runtime.state).toBe('configured');
  if(runtime.state==='configured')expect(runtime.provider).toMatchObject({kind:'openai_live',model:'configured-model',extractorVersion:'2.1'});
 });
});

describe('checkpoint provider provenance',()=>{
 it('records an explicitly injected transport honestly with exact source/pass/run binding',async()=>{
  const fixture=await setup(),checkpoint=await fixture.run(),provenance=readSavedExtractionProvenance(checkpoint);
  expect(fixture.parse).toHaveBeenCalledTimes(1);
  expect(provenance).toMatchObject({kind:'injected_test_provider',providerAttempted:true,allPassesSucceeded:true,checkpointResultSha256:checkpoint.result_sha256});
  const receipt=provenance.receipts[0];
  expect(receipt).toMatchObject({source_sha256:fixture.source.sha256,source_size_bytes:fixture.source.bytes.length,
   source_page_count:1,
   document_id:fixture.input.versionId,case_id:fixture.input.caseId,analysis_run_id:fixture.input.context.analysis_run_id,
   requested_model:'requested-model-version',actual_model:'reported-model-version',provider_response_id:'resp_synthetic_receipt',
   provider_request_id:'req_synthetic_receipt',token_usage:{input_tokens:100,output_tokens:30,total_tokens:130},
   cost:{status:'not_returned_by_provider',amount_usd:null}});
  expect(parseOpenAiProviderReceipt(receipt)).toEqual(receipt);
  expect(checkpoint.run.result.final_extraction.fields.filter(field=>field.field!=='document_type').every(field=>field.confidence===0.94)).toBe(true);
  expect(JSON.stringify(provenance)).not.toMatch(/unit-test-secret|raw_value|file_data|image_url/);
 });

 it.each(['page-count','candidate-page','row-page'] as const)('refuses provider %s outside the actual PDF page count',async changed=>{
  const fixture=await setup();
  if(changed==='page-count')fixture.source.output={...fixture.source.output,page_count:2};
  if(changed==='candidate-page')fixture.source.output.generic_fields[0].candidates[0].evidence.page=2;
  if(changed==='row-page')fixture.source.output.payroll_rows[0].evidence.page=2;
  const checkpoint=await fixture.run(),provenance=readSavedExtractionProvenance(checkpoint);
  expect(fixture.parse).toHaveBeenCalledTimes(1);
  expect(checkpoint.run.result.final_extraction.fields).toEqual([]);
  expect(provenance).toMatchObject({kind:'injected_test_provider',providerAttempted:true,allPassesSucceeded:false});
  expect(provenance.receipts[0]).toMatchObject({source_page_count:1,status:'failed',error_code:'provider_source_page_mismatch'});
 });

 it('retains compatibility with an earlier receipt that did not record page count',async()=>{
  const fixture=await setup(),checkpoint=await fixture.run();
  const {receipt_sha256,source_page_count,...body}=checkpoint.run.provider_receipts![0];void receipt_sha256;void source_page_count;
  expect(readSavedExtractionProvenance({...checkpoint,run:{...checkpoint.run,provider_receipts:[createOpenAiProviderReceipt(body)]}}).kind).toBe('injected_test_provider');
 });

 it('does not infer live or injected provenance from a legacy model label',async()=>{
  const fixture=await setup(),checkpoint=await fixture.run();
  const {provider_receipts,...legacyRun}=checkpoint.run;void provider_receipts;
  expect(readSavedExtractionProvenance({...checkpoint,run:legacyRun})).toMatchObject({kind:'unproven_legacy',providerAttempted:false,allPassesSucceeded:false,receipts:[]});
 });

 it.each(['hash','document','source','pass','model','response','usage'] as const)('refuses tampered %s receipt metadata',async difference=>{
  const fixture=await setup(),checkpoint=structuredClone(await fixture.run()),receipt=checkpoint.run.provider_receipts![0];
  const {receipt_sha256,...body}=receipt;void receipt_sha256;
  let altered=receipt;
  if(difference==='hash')altered={...receipt,receipt_sha256:'0'.repeat(64)};
  else{
   if(difference==='document')body.document_id=randomUUID();
   if(difference==='source')body.source_sha256='0'.repeat(64);
   if(difference==='pass')body.extraction_id=randomUUID();
   if(difference==='model')body.actual_model='different-model';
   if(difference==='response')body.provider_response_id='resp_different';
   if(difference==='usage')body.token_usage={input_tokens:101,output_tokens:30,total_tokens:131};
   altered=createOpenAiProviderReceipt(body);
  }
  expect(()=>readSavedExtractionProvenance({...checkpoint,run:{...checkpoint.run,provider_receipts:[altered]}})).toThrow();
 });

 it('refuses altered checkpoint data even if the receipt itself is untouched',async()=>{
  const fixture=await setup(),checkpoint=await fixture.run();
  expect(()=>readSavedExtractionProvenance({...checkpoint,result_sha256:'0'.repeat(64)})).toThrow('LIVE_EXTRACTION_CHECKPOINT_BINDING');
 });

 it.each([
  [{status:401},'provider_authentication_failed'],[{status:403},'provider_permission_denied'],[{status:404},'provider_model_unavailable'],
  [{status:429},'provider_rate_limit'],[{status:400},'provider_input_rejected'],[{name:'APIConnectionTimeoutError'},'provider_timeout'],
  [{name:'APIConnectionError'},'provider_connection_failed'],
 ] as const)('persists a bounded failure receipt for %j without a hidden retry',async(error,code)=>{
  const fixture=await setup({...error,requestID:'req_failed_attempt',message:'sensitive response body unit-test-secret'}),checkpoint=await fixture.run();
  const provenance=readSavedExtractionProvenance(checkpoint);
  expect(fixture.parse).toHaveBeenCalledTimes(1);
  expect(provenance).toMatchObject({kind:'injected_test_provider',providerAttempted:true,allPassesSucceeded:false});
  expect(provenance.receipts[0]).toMatchObject({error_code:code,provider_request_id:'req_failed_attempt',status:'failed'});
  expect(JSON.stringify(checkpoint)).not.toContain('sensitive response body');
 });

 it('binds the receipt request hash to the exact provider request, not its declared model alone',async()=>{
  const fixture=await setup(),checkpoint=await fixture.run();
  const request=fixture.parse.mock.calls[0][0];
  expect(checkpoint.run.provider_receipts![0].request_sha256).toBe(canonicalSha256(request));
 });
});
