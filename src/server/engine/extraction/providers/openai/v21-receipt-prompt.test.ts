import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import {devFinancialInputFixture} from '@/server/product/processing/dev-financial-flow.fixture';
import {readSavedExtractionProvenance} from '@/server/product/processing/live-extraction-provenance';
import {OpenAiPayslipV2PassExtractor} from './v2-adapter';
import {OPENAI_SOURCE_FILE_PAGE_POLICY} from './v2-request';
vi.mock('server-only',()=>({}));

it.each([undefined,OPENAI_SOURCE_FILE_PAGE_POLICY])('binds the actual provider prompt through the normal saved pipeline: %s',async sourcePagePolicy=>{
 const source=await devFinancialInputFixture(false),caseId=randomUUID(),versionId=randomUUID();
 const parse=vi.fn(async()=>({id:'resp_offline_prompt_contract',requestId:'req_offline_prompt_contract',model:'synthetic-model',status:'completed',
  outputParsed:structuredClone(source.output),usage:{input_tokens:100,output_tokens:30,total_tokens:130}}));
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'not-a-secret-unit-test',model:'synthetic-model',timeoutMs:1000},
  {transport:{parse},extractorVersion:'2.1',sourcePagePolicy});
 const checkpoint=await extractSavedPayslip({caseId,versionId,expectedMonth:'2026-06',extractor,
  context:{snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:'2026-09-11T00:00:00Z',
   fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,randomUUID()]))},
  db:{async query(){return {rows:[{id:randomUUID(),case_id:caseId,version_id:versionId,document_type:'payslip',
   storage_path:`cases/${caseId}/versions/${versionId}.pdf`,original_filename:'synthetic.pdf',mime_type:'application/pdf',size:source.bytes.length,
   content_sha256:source.sha256,period_month:'2026-06-01',created_at:'2026-09-11T00:00:00Z'}]};}},
  storage:{async download(){return {data:new Blob([Buffer.from(source.bytes)],{type:'application/pdf'}),error:null};}},
 });
 const provenance=readSavedExtractionProvenance(checkpoint),receipt=provenance.receipts[0];
 expect(provenance.kind).toBe('injected_test_provider');
 expect(parse).toHaveBeenCalledTimes(1);
 expect(receipt.prompt_version).toBe(sourcePagePolicy?'payslip-extraction-openai-v2-first-r8-fp1':'payslip-extraction-openai-v2-first-r8');
 expect(checkpoint.run.result.first_pass.prompt_version).toBe(receipt.prompt_version);
 // A mismatched pass wrapper remains rejected even with its outer hash recomputed.
 const changed=structuredClone(checkpoint);changed.run.result.first_pass.prompt_version='unrelated-prompt';
 changed.result_sha256=canonicalSha256(changed.run.result);
 expect(()=>readSavedExtractionProvenance(changed)).toThrow('LIVE_EXTRACTION_RECEIPT_BINDING');
});
