import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {devFinancialInputFixture} from '@/server/product/processing/dev-financial-flow.fixture';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import {OpenAiPayslipV2PassExtractor} from './v2-adapter';
import {runOpenAiPayslipExtractionV21} from './v21-adapter';
import {OPENAI_SOL_COMPARISON_PROFILE} from './v2-request';
vi.mock('server-only',()=>({}));
afterEach(()=>vi.unstubAllEnvs());

it.each(['automatic','skip_package_budget'] as const)('preserves the first pass and unresolved hours with honest %s recovery history',async recoveryExecution=>{
 vi.stubEnv('TIVDOC_SOL_SAVED_WORKER_PROOF','1');
 const fixture=await devFinancialInputFixture(true),original=syntheticPayslipFixtures[0].request;
 const request={...original,document:{...original.document,content_sha256:fixture.sha256,size_bytes:fixture.bytes.length,document_period:null}};
 const parse=vi.fn(async()=>({id:'resp_synthetic_unit_'+randomUUID(),status:'completed',outputParsed:fixture.output,usage:null,model:'gpt-5.6-sol'}));
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-test-no-network',model:'gpt-5.6-sol',timeoutMs:1000},
  {transport:{parse},extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution});
 const run=await runOpenAiPayslipExtractionV21({request,extractor,source:{async read(){return fixture.bytes;}},reference_year:2026,
  snapshot_context:{case_id:request.case_id,analysis_run_id:request.analysis_run_id,snapshot_id:randomUUID(),schema_version:'1.0',
   created_at:request.requested_at,fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(field=>[field,randomUUID()]))}});
 expect(run.result.first_pass.raw_extraction.document_id).toBe(request.document.document_id);
 expect(run.result.final_extraction.fields.filter(field=>field.field==='regular_hours'&&field.normalized_value!==null)).toEqual([]);
 expect(run.result.final_validation.issues.some(issue=>issue.field_keys.includes('regular_hours'))).toBe(true);
 const decision=run.result.recovery_decision;
 if(recoveryExecution==='automatic'){
  expect(parse).toHaveBeenCalledTimes(2);expect(run.result.recovery_passes).toHaveLength(1);expect(decision.requested).toBe(true);
 }else{
  expect(parse).toHaveBeenCalledTimes(1);expect(run.result.recovery_passes).toEqual([]);
  expect(decision).toMatchObject({requested:false,skipped:true});expect(decision.fields_requested).toContain('regular_hours');
  expect(decision.reason_codes).toContain('recovery_skipped_package_budget');expect(decision.expected_information_gain).not.toBe('none');
 }
 expect(run.provider_receipts?.every(receipt=>receipt.origin==='injected_test_provider')).toBe(true);
});

it('does not permit the DEV budget skip through an ordinary model factory',()=>{
 vi.stubEnv('TIVDOC_SOL_SAVED_WORKER_PROOF','');
 expect(()=>new OpenAiPayslipV2PassExtractor({apiKey:null,model:'gpt-5.6-sol',timeoutMs:1000},
  {executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution:'skip_package_budget'})).toThrow('RECOVERY_EXECUTION_SCOPE');
});
