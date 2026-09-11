import {beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {OPENAI_SOURCE_FILE_PAGE_POLICY} from '@/server/engine/extraction/providers/openai/v2-request';
import {devFinancialInputFixture} from './dev-financial-flow.fixture';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {deriveSavedExtractionPromptCheckpoint} from './saved-extraction-prompt-derivation';
vi.mock('server-only',()=>({}));
let old:Awaited<ReturnType<typeof extractSavedPayslip>>;
beforeAll(async()=>{
 const source=await devFinancialInputFixture(false),caseId=randomUUID(),versionId=randomUUID();
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-test-only',model:'synthetic-model',timeoutMs:1000},{extractorVersion:'2.1',sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY,
  transport:{async parse(){return {id:'resp_synthetic_derivation',requestId:'req_synthetic_derivation',model:'synthetic-model',status:'completed',outputParsed:source.output,usage:{input_tokens:100,output_tokens:20,total_tokens:120}};}}});
 old=await extractSavedPayslip({caseId,versionId,expectedMonth:'2026-06',extractor,
  context:{snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:'2026-09-11T00:00:00Z',fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,randomUUID()]))},
  db:{async query(){return {rows:[{id:randomUUID(),case_id:caseId,version_id:versionId,document_type:'payslip',storage_path:`cases/${caseId}/versions/${versionId}.pdf`,original_filename:'synthetic.pdf',mime_type:'application/pdf',size:source.bytes.length,content_sha256:source.sha256,period_month:'2026-06-01',created_at:'2026-09-11T00:00:00Z'}]};}},
  storage:{async download(){return {data:new Blob([Buffer.from(source.bytes)]),error:null};}}});
 old=structuredClone(old);
 old.run.result.first_pass.prompt_version='payslip-extraction-openai-v2-first-r8';
 old.result_sha256=canonicalSha256(old.run.result);
});
const derive=(value:unknown)=>deriveSavedExtractionPromptCheckpoint(value,{originalCheckpointSha256:canonicalSha256(value),codeRevision:'a'.repeat(40),createdAt:'2026-09-11T18:00:00Z'},readSavedExtractionProvenance);
it('derives only the known wrapper mismatch while keeping every original source and decision byte',()=>{
 const before=canonicalSha256(old);expect(()=>readSavedExtractionProvenance(old)).toThrow('LIVE_EXTRACTION_RECEIPT_BINDING');
 const result=derive(old),expected=structuredClone(old);
 expected.run.result.first_pass.prompt_version='payslip-extraction-openai-v2-first-r8-fp1';expected.result_sha256=canonicalSha256(expected.run.result);
 expect(result.derivedCheckpoint).toEqual(expected);expect(canonicalSha256(old)).toBe(before);
 expect(result.receipt).toMatchObject({original_checkpoint_sha256:before,original_result_sha256:old.result_sha256,origin:'injected_test_provider',provider_calls:0,
  changed_paths:['run.result.first_pass.prompt_version','result_sha256']});
 expect(readSavedExtractionProvenance(result.derivedCheckpoint).kind).toBe('injected_test_provider');
 expect(derive(old)).toEqual(result);
});
it('refuses an unrelated prompt or an already repaired wrapper',()=>{
 for(const version of ['unknown-version','payslip-extraction-openai-v2-first-r8-fp1']){
  const bad=structuredClone(old);bad.run.result.first_pass.prompt_version=version;bad.result_sha256=canonicalSha256(bad.run.result);
  expect(()=>derive(bad)).toThrow('EXTRACTION_PROMPT_DERIVATION_NOT_APPLICABLE');
 }
});
it.each(['source','case','document','raw','snapshot','operation'] as const)('does not turn a %s mismatch into a permissible prompt repair',changed=>{
 let bad=structuredClone(old);
 if(changed==='source')bad.input_sha256='b'.repeat(64);
 if(changed==='case')bad.case_id=randomUUID();
 if(changed==='document')bad.version_id=randomUUID();
 if(changed==='raw')bad.run.result.first_pass.raw_extraction.fields[0].raw_value='altered original';
 if(changed==='snapshot')bad={...bad,run:{...bad.run,snapshot:{...bad.run.snapshot!,analysis_run_id:randomUUID()}}};
 if(changed==='operation')bad.run.result.first_pass.raw_extraction.operation.duration_ms+=1;
 bad.result_sha256=canonicalSha256(bad.run.result);
 expect(()=>derive(bad)).toThrow();
});
it('requires the exact original checkpoint hash before deriving',()=>{
 expect(()=>deriveSavedExtractionPromptCheckpoint(old,{originalCheckpointSha256:'0'.repeat(64),codeRevision:'a'.repeat(40),createdAt:'2026-09-11T18:00:00Z'},readSavedExtractionProvenance)).toThrow('EXTRACTION_PROMPT_DERIVATION_PARENT');
});
