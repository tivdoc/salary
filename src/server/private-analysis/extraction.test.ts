import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {devFinancialInputFixture} from '@/server/product/processing/dev-financial-flow.fixture';
import {newSolComparisonLedger} from '@/server/product/processing/live-extraction-sol-comparison-budget';
import {privateArtifactPath,runPrivatePayslipExtraction} from './extraction';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
vi.mock('server-only',()=>({}));
const io=vi.hoisted(()=>({count:vi.fn(),parse:vi.fn()}));
vi.mock('openai',()=>({default:class{responses={inputTokens:{count:io.count},parse:io.parse};}}));
const dirs:string[]=[];
const digest=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-09-11T08:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
async function fixture(missing=false){
 const f=await devFinancialInputFixture(missing),root=mkdtempSync(path.join(tmpdir(),'tivdoc-private-unit-'));dirs.push(root);
 const caseId=randomUUID(),documentId=randomUUID(),reference='INDEPENDENT_ORACLE_MUST_NOT_REACH_MODEL';
 mkdirSync(path.join(root,'CASE-01/source'),{recursive:true});writeFileSync(path.join(root,'CASE-01/source/payslip-01.pdf'),f.bytes);
 writeFileSync(path.join(root,'CASE-01/reference.private.json'),reference);
 const job={work_id:'CASE-01',case_id:caseId,document_id:documentId,filename:'payslip-01.pdf',mime_type:'application/pdf',source_sha256:f.sha256,size_bytes:f.bytes.length,
  printed_page_count:1,reference_file:'CASE-01/reference.private.json',reference_sha256:digest(reference),source_created_at:'2026-06-30T00:00:00Z',source_classification:'payslip',source_qa_classification:'non_qa_paid'};
 const auth={version:'private-paid-analysis-20260911-v1',source_project:'synthetic-private-unit',enabled:true,authorized_max_requests:40,authorized_max_usd:15,operative_max_requests:12,operative_max_usd:5,production_read_only:true,customer_delivery:false,jobs:[job],created_at:'2026-09-11T07:00:00Z'};
 writeFileSync(path.join(root,'authorization.private.json'),JSON.stringify(auth));writeFileSync(path.join(root,'package-budget-ledger.private.json'),JSON.stringify(newSolComparisonLedger()));
 writeFileSync(path.join(root,'CASE-01/source/download-receipt.private.json'),JSON.stringify({source_case_id:caseId,source_project:auth.source_project,source_is_qa:false,documents:[{source_document:{id:documentId,case_id:caseId,size:f.bytes.length,mime_type:job.mime_type,document_type:'payslip',created_at:job.source_created_at,storage_path:`cases/${caseId}/payslip-01.pdf`},observed_sha256:f.sha256,observed_size:f.bytes.length,private_filename:'payslip-01.pdf'}]}));
 io.count.mockResolvedValue({object:'response.input_tokens',input_tokens:1000});
 io.parse.mockResolvedValue({id:'resp_explicit_synthetic_unit_'+randomUUID(),status:'completed',output_parsed:f.output,usage:{input_tokens:1000,output_tokens:100,total_tokens:1100},model:'gpt-5.6-sol'});
 const input={privateRoot:root,documentId,apiKey:'synthetic-unit-key-no-network',codeRevision:'a'.repeat(40)};
 return {root,input,auth,job};
}
it('uses the existing mapper/normalizer/facts, isolates the oracle, and reuses a source without another request',async()=>{
 const f=await fixture();const result=await runPrivatePayslipExtraction(f.input);
 expect(result.budget.contentRequests).toBe(2);expect(io.parse).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(io.parse.mock.calls)).not.toContain('INDEPENDENT_ORACLE');expect(JSON.stringify(io.count.mock.calls)).not.toContain('INDEPENDENT_ORACLE');
 const saved=JSON.parse(readFileSync(result.resultPath,'utf8'));expect(saved.payload.facts.facts.length).toBeGreaterThan(0);
 expect(saved.customer_answers_added).toBe(0);expect(saved.scope).toBe('private_not_customer_admission');
 expect((await runPrivatePayslipExtraction(f.input)).state).toBe('reused');expect(io.parse).toHaveBeenCalledTimes(1);
});
it('preserves a missing critical field and explicit recovery skip without a second paid generation',async()=>{
 const f=await fixture(true),r=await runPrivatePayslipExtraction(f.input),saved=JSON.parse(readFileSync(r.resultPath,'utf8'));
 expect(saved.payload.resolved.final_validation.issues.some((i:{field_keys:string[]})=>i.field_keys.includes('regular_hours'))).toBe(true);
 expect(saved.payload.resolved.recovery_decision).toMatchObject({skipped:true,requested:false});expect(io.parse).toHaveBeenCalledTimes(1);
});
it.each(['source','reference','foreign','disabled'] as const)('refuses %s changes before any provider content request',async kind=>{
 const f=await fixture();
 if(kind==='source')writeFileSync(path.join(f.root,'CASE-01/source/payslip-01.pdf'),'changed');
 if(kind==='reference')writeFileSync(path.join(f.root,'CASE-01/reference.private.json'),'changed');
 if(kind==='disabled')writeFileSync(path.join(f.root,'authorization.private.json'),JSON.stringify({...f.auth,enabled:false}));
 await expect(runPrivatePayslipExtraction({...f.input,...(kind==='foreign'?{documentId:randomUUID()}:{})})).rejects.toThrow();
 expect(io.count).not.toHaveBeenCalled();expect(io.parse).not.toHaveBeenCalled();
});
it('records an unknown count outcome and refuses restart instead of silently charging again',async()=>{
 const f=await fixture();io.count.mockRejectedValue(new Error('synthetic transport loss'));
 await expect(runPrivatePayslipExtraction(f.input)).rejects.toThrow('transport loss');
 const ledger=JSON.parse(readFileSync(path.join(f.root,'package-budget-ledger.private.json'),'utf8'));
 expect(ledger.reservations[0].outcome).toBe('reserved_unknown');
 await expect(runPrivatePayslipExtraction(f.input)).rejects.toThrow();expect(io.count).toHaveBeenCalledTimes(1);
});
it('serializes concurrent calls and never exposes private artifacts to a Git checkout',async()=>{
 const f=await fixture();const results=await Promise.allSettled([runPrivatePayslipExtraction(f.input),runPrivatePayslipExtraction(f.input)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(io.parse).toHaveBeenCalledTimes(1);
 expect(()=>privateArtifactPath(path.join(process.cwd(),'customer-private.json'))).toThrow('PRIVATE_ARTIFACT_IN_GIT');
});
it('rejects altered derived facts even when their outer payload hash is recomputed',async()=>{
 const f=await fixture(),r=await runPrivatePayslipExtraction(f.input),saved=JSON.parse(readFileSync(r.resultPath,'utf8'));
 saved.payload.facts.facts=[];saved.payload_sha256=canonicalSha256(saved.payload);writeFileSync(r.resultPath,JSON.stringify(saved));
 await expect(runPrivatePayslipExtraction(f.input)).rejects.toThrow('PRIVATE_REPLAY_BINDING');expect(io.parse).toHaveBeenCalledTimes(1);
});
it('keeps a schema-valid response with wrong pages for diagnosis but never maps it as successful',async()=>{
 const f=await fixture(),output={...(await devFinancialInputFixture(false)).output,page_count:2};
 io.parse.mockResolvedValue({id:'resp_synthetic_wrong_pages',status:'completed',output_parsed:output,usage:{input_tokens:1000,output_tokens:100,total_tokens:1100},model:'gpt-5.6-sol'});
 const r=await runPrivatePayslipExtraction(f.input),saved=JSON.parse(readFileSync(r.resultPath,'utf8'));
 expect(saved.payload.mapped.extraction.error_code).toBe('provider_source_page_mismatch');expect(saved.payload.facts).toBeNull();
 const diagnostic=JSON.parse(readFileSync(path.join(path.dirname(r.resultPath),'structured.private.json'),'utf8'));
 expect(diagnostic.structured_output.page_count).toBe(2);expect(diagnostic.prompt_version).toMatch(/-fp1$/u);
 expect(io.parse.mock.calls[0][0].instructions).toContain('ONE source page');expect(r.budget.contentRequests).toBe(2);
});
it('does not allow an ownership-ambiguous QA source to be enrolled as a non-QA customer',async()=>{
 const f=await fixture(),file=path.join(f.root,'CASE-01/source/download-receipt.private.json'),receipt=JSON.parse(readFileSync(file,'utf8'));
 receipt.source_is_qa=true;writeFileSync(file,JSON.stringify(receipt));await expect(runPrivatePayslipExtraction(f.input)).rejects.toThrow('PRIVATE_SOURCE_RECEIPT_MISMATCH');expect(io.count).not.toHaveBeenCalled();
});
it('keeps a timed-out generation conservatively reserved and reports its unknown outcome',async()=>{
 const f=await fixture();io.parse.mockRejectedValue(new Error('synthetic timeout'));
 const r=await runPrivatePayslipExtraction(f.input);expect(r.state).toBe('failed');expect(r.budget.unknownGenerationReceipts).toBe(1);
 expect(r.budget.unknownOutcomes).toBe(1);expect(r.budget.reservedUpperBoundUsd).toBe(0.712);
 await runPrivatePayslipExtraction(f.input);expect(io.parse).toHaveBeenCalledTimes(1);
});
it('explicit failed-source retry preserves the first receipt and cumulative unknown cost; retry of that attempt is free',async()=>{
 const f=await fixture();io.parse.mockRejectedValue(new Error('synthetic provider outage'));
 const first=await runPrivatePayslipExtraction(f.input),old=readFileSync(first.resultPath);
 const second=await runPrivatePayslipExtraction({...f.input,attempt:2});
 expect(second.resultPath).toContain('attempt-2');expect(readFileSync(first.resultPath)).toEqual(old);
 expect(second.budget.contentRequests).toBe(4);expect(second.budget.unknownGenerationReceipts).toBe(2);expect(second.budget.reservedUpperBoundUsd).toBe(1.424);
 await runPrivatePayslipExtraction({...f.input,attempt:2});expect(io.parse).toHaveBeenCalledTimes(2);
});
it('rejects a skipped attempt and a repeat of successful extraction before another paid call',async()=>{
 const f=await fixture();await expect(runPrivatePayslipExtraction({...f.input,attempt:2})).rejects.toThrow('PRIVATE_RETRY_HISTORY_REQUIRED');
 await runPrivatePayslipExtraction(f.input);
 await expect(runPrivatePayslipExtraction({...f.input,attempt:2})).rejects.toThrow('PRIVATE_RETRY_REQUIRES_FAILED_RECEIPT');expect(io.parse).toHaveBeenCalledTimes(1);
});
