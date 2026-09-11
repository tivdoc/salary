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
import {readAdmittedSavedExtractionProvenance,ensureSavedExtractionPromptProvenance} from './saved-extraction-prompt-admission';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
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

const audit={codeRevision:'a'.repeat(40),createdAt:'2026-09-11T18:00:00Z'};
const job=():SourceJob=>({schema_version:'saved-case-work-v1',case_id:old.case_id,revision:3,input_sha256:'c'.repeat(64),mode:'draft'});
function db(){
 const receipts=new Map<string,unknown>(),calls:PostgresStatement[]=[];
 const context:PostgresTransactionContext={transaction_id:'unit-transaction',client:{async query(statement){
  calls.push(statement);const key=JSON.stringify(statement.values.slice(0,4));
  if(statement.name==='extraction_prompt_derivation_get')return {row_count:1,rows:[{receipt:receipts.get(key)??null}]};
  if(statement.name==='extraction_prompt_derivation_put'){
   if(!receipts.has(key))receipts.set(key,JSON.parse(String(statement.values[4])));
   return {row_count:1,rows:[{receipt:receipts.get(key)}]};
  }
  throw Error('unexpected query');
 }}};
 return {context,receipts,calls};
}
it('read does not admit; ensure persists once; restart reads the same proof with original source hash',async()=>{
 const d=db(),before=canonicalSha256(old);
 await expect(readAdmittedSavedExtractionProvenance(d.context,job(),old)).rejects.toThrow('EXTRACTION_PROMPT_DERIVATION_NOT_ADMITTED');
 expect(d.calls.map(c=>c.name)).toEqual(['extraction_prompt_derivation_get']);
 const admitted=await ensureSavedExtractionPromptProvenance(d.context,job(),old,audit);
 expect(admitted.checkpointResultSha256).toBe(old.result_sha256);
 expect(admitted.promptBindingDerivation).toMatchObject({original_checkpoint_sha256:before,code_revision:audit.codeRevision,provider_calls:0});
 expect(admitted.kind).toBe('injected_test_provider');
 expect(await readAdmittedSavedExtractionProvenance(d.context,job(),old)).toEqual(admitted);
 expect(await ensureSavedExtractionPromptProvenance(d.context,job(),old,{codeRevision:'b'.repeat(40),createdAt:'2026-09-11T18:01:00Z'})).toEqual(admitted);
 expect(d.calls.filter(c=>c.name==='extraction_prompt_derivation_put')).toHaveLength(1);
 expect(d.receipts.size).toBe(1);expect(canonicalSha256(old)).toBe(before);
});
it('concurrent admission returns and verifies the first immutable audit, with no duplicate receipt',async()=>{
 const d=db();const [a,b]=await Promise.all([
  ensureSavedExtractionPromptProvenance(d.context,job(),old,audit),
  ensureSavedExtractionPromptProvenance(d.context,job(),old,{codeRevision:'b'.repeat(40),createdAt:'2026-09-11T18:01:00Z'}),
 ]);
 expect(a).toEqual(b);expect(d.receipts.size).toBe(1);expect(a.promptBindingDerivation?.created_at).toBe(audit.createdAt);
});
it('strict valid provenance never calls the admission database',async()=>{
 const d=db(),valid=deriveSavedExtractionPromptCheckpoint(old,{...audit,originalCheckpointSha256:canonicalSha256(old)},readSavedExtractionProvenance).derivedCheckpoint;
 const result=await ensureSavedExtractionPromptProvenance(d.context,job(),valid,audit);
 expect(result).toEqual(readSavedExtractionProvenance(valid));expect(result.promptBindingDerivation).toBeUndefined();
 await readAdmittedSavedExtractionProvenance(d.context,job(),valid);expect(d.calls).toEqual([]);
});
it.each(['code','derived_hash','extra_key'] as const)('rejects stored %s proof tampering, without overwriting it',async mutation=>{
 const d=db();await ensureSavedExtractionPromptProvenance(d.context,job(),old,audit);
 const key=[...d.receipts.keys()][0],value=JSON.parse(JSON.stringify(d.receipts.get(key)));
 if(mutation==='code')value.code_revision='b'.repeat(40);
 if(mutation==='derived_hash')value.derived_result_sha256='f'.repeat(64);
 if(mutation==='extra_key')value.whole_document_verified=true;
 d.receipts.set(key,value);
 await expect(readAdmittedSavedExtractionProvenance(d.context,job(),old)).rejects.toThrow('EXTRACTION_PROMPT_ADMISSION_RECEIPT');
 await expect(ensureSavedExtractionPromptProvenance(d.context,job(),old,audit)).rejects.toThrow('EXTRACTION_PROMPT_ADMISSION_RECEIPT');
 expect(d.calls.filter(c=>c.name==='extraction_prompt_derivation_put')).toHaveLength(1);
});
it('cannot borrow an admission for a foreign case or different revision',async()=>{
 const d=db();await ensureSavedExtractionPromptProvenance(d.context,job(),old,audit);
 await expect(readAdmittedSavedExtractionProvenance(d.context,{...job(),case_id:randomUUID()},old)).rejects.toThrow('EXTRACTION_PROMPT_ADMISSION_SCOPE');
 await expect(readAdmittedSavedExtractionProvenance(d.context,{...job(),revision:4},old)).rejects.toThrow('EXTRACTION_PROMPT_DERIVATION_NOT_ADMITTED');
 expect(d.receipts.size).toBe(1);
});
it('never persists a derivation when another receipt fence fails',async()=>{
 const d=db(),bad=structuredClone(old);bad.input_sha256='0'.repeat(64);
 await expect(ensureSavedExtractionPromptProvenance(d.context,job(),bad,audit)).rejects.toThrow('LIVE_EXTRACTION_RECEIPT_BINDING');
 expect(d.calls.filter(c=>c.name==='extraction_prompt_derivation_put')).toHaveLength(0);
 expect(d.receipts.size).toBe(0);
});
it('does not catch general checkpoint tampering or database authorization errors as a repairable alias',async()=>{
 const d=db(),bad=structuredClone(old);bad.result_sha256='0'.repeat(64);
 await expect(ensureSavedExtractionPromptProvenance(d.context,job(),bad,audit)).rejects.toThrow('LIVE_EXTRACTION_CHECKPOINT_BINDING');
 expect(d.calls).toEqual([]);
 const refused:PostgresTransactionContext={transaction_id:'refused',client:{async query(){throw Error('verified_worker_required');}}};
 await expect(ensureSavedExtractionPromptProvenance(refused,job(),old,audit)).rejects.toThrow('verified_worker_required');
});
