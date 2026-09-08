import {describe,it,expect} from 'vitest';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SavedCaseSnapshot} from './saved-snapshot';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import type {SourceJob} from './source-dispatch';
import {runSavedMonthAnalysis} from './saved-analysis';
import {InMemoryCaseAnalysisRepository} from '@/server/engine/case-analysis/in-memory-repository';
import {FixtureCaseReviewPort} from '@/engine/case-analysis/fixture-ports';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import {validateReport} from '@/server/platform/persistence/postgres/analysis/validation';

function setup(){
 const fixture=buildSyntheticCaseFixture({fixture_id:'saved-adapter',mode:'real'});
 const doc=fixture.stored.documents[0],extraction=structuredClone(fixture.stored.extractions[0]);
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:doc.case_id,revision:2,input_sha256:'a'.repeat(64),mode:'draft'};
 const id='11111111-1111-4111-8111-111111111111';
 const result={schema_version:'tivdoc-saved-extraction-v1',case_id:doc.case_id,product_document_id:id,version_id:doc.document_id,
  input_sha256:doc.content_sha256,expected_month:'2025-01',period_mismatch:false,requires_confirmation:false,
  run:{result:{final_extraction:extraction}},result_sha256:''};
 result.result_sha256=canonicalSha256(result.run.result);
 const input={case_id:doc.case_id,month:'2025-01',documents:[{id,version_id:doc.document_id,sha256:doc.content_sha256,type:'payslip',month:'2025-01'}]};
 const record:Record<string,unknown>={...doc,mime_type:'application/pdf',size:doc.size_bytes,storage_path:`cases/${doc.case_id}/versions/${doc.document_id}.pdf`,
  checkpoint_input_sha256:doc.content_sha256,checkpoint_result_sha256:result.result_sha256,result};
 const calls:PostgresStatement[]=[];
 const responses:Record<string,Record<string,unknown>[]>={source_case_lock:[],source_revision_check:[{revision:2,input_sha256:job.input_sha256}],
  saved_snapshot_journal:[{input,created_at:'2025-02-01T00:00:00Z',input_sha256:job.input_sha256,actual_sha256:job.input_sha256}],saved_snapshot_document:[record],
  checkpoint_source_match:[{exists:1}],checkpoint_insert:[],checkpoint_read:[{result,input_sha256:result.input_sha256,result_sha256:result.result_sha256}]};
 const context:PostgresTransactionContext={transaction_id:'synthetic-test',client:{async query(s){calls.push(s);const rows=responses[s.name];if(!rows)throw new Error(`UNEXPECTED_SQL:${s.name}`);return {rows,row_count:rows.length};}}};
 return {fixture,job,result,input,record,responses,calls,context,reader:new SavedCaseSnapshot(context,job)};
}
describe('exact saved source to canonical snapshot',()=>{
 it('reopens persisted extraction and pins exact documents; no declarations are invented',async()=>{
  const s=setup(),snapshot=await s.reader.read();
  expect(snapshot.documents).toHaveLength(1);expect(snapshot.extractions).toHaveLength(1);
  expect(snapshot.declared_fact_snapshot.facts).toEqual([]);
  const command={...s.fixture.command,document_snapshot_id:snapshot.document_snapshot_id,document_snapshot_sha256:snapshot.document_snapshot_sha256,
   extraction_snapshot_id:snapshot.extraction_snapshot_id,extraction_snapshot_sha256:snapshot.extraction_snapshot_sha256,
   declared_fact_snapshot_id:snapshot.declared_fact_snapshot.snapshot_id,declared_fact_snapshot_sha256:snapshot.declared_fact_snapshot.snapshot_sha256};
  expect(await s.reader.loadPinned(command)).toEqual(snapshot);
  await expect(s.reader.loadPinned({...command,case_id:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow('SAVED_COMMAND_SCOPE');
  await expect(s.reader.loadPinned({...command,extraction_snapshot_sha256:'b'.repeat(64)})).rejects.toThrow('SAVED_COMMAND_PIN_MISMATCH');
 });
 it('checks case lock before reads and refuses replacement since enqueue',async()=>{
  const s=setup();s.responses.source_revision_check[0].revision=3;
  await expect(s.reader.read()).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  expect(s.calls.map(c=>c.name)).toEqual(['source_case_lock','source_revision_check']);
 });
 it('rejects altered journal, foreign source, missing checkpoint and changed extracted bytes',async()=>{
  const altered=setup();altered.responses.saved_snapshot_journal[0].actual_sha256='b'.repeat(64);
  await expect(altered.reader.read()).rejects.toThrow('SAVED_INPUT_HASH_MISMATCH');
  const foreign=setup();foreign.result.case_id='22222222-2222-4222-8222-222222222222';
  await expect(foreign.reader.read()).rejects.toThrow('SAVED_EXTRACTION_BINDING_MISMATCH');
  const missing=setup();missing.responses.saved_snapshot_document=[];
  await expect(missing.reader.read()).rejects.toThrow('SAVED_EXTRACTION_PENDING');
  const corrupt=setup();corrupt.result.run.result.final_extraction.warnings.push('altered');
  await expect(corrupt.reader.read()).rejects.toThrow('SAVED_EXTRACTION_BINDING_MISMATCH');
 });
 it('does not substitute a different month or Storage path',async()=>{
  const s=setup();s.result.expected_month='2025-02';await expect(s.reader.read()).rejects.toThrow('SAVED_EXTRACTION_PERIOD_MISMATCH');
  const p=setup();p.record.storage_path='cases/other/versions/file.pdf';await expect(p.reader.read()).rejects.toThrow('SAVED_STORAGE_SCOPE');
 });
 it('retains insufficient candidate confidence instead of confirming a saved result',async()=>{
  const s=setup();s.result.requires_confirmation=true;s.result.run.result.final_extraction.fields[0].confidence=0.5;
  s.result.result_sha256=canonicalSha256(s.result.run.result);s.record.checkpoint_result_sha256=s.result.result_sha256;
  expect((await s.reader.read()).extractions[0].fields[0].confidence).toBe(0.5);
 });
 it('first checkpoint wins a racing extraction without an update or delete',async()=>{
  const s=setup();s.responses.checkpoint_read[0].result_sha256='b'.repeat(64);
  const saved=await saveExtractionCheckpoint(s.context,s.job,s.result as Parameters<typeof saveExtractionCheckpoint>[2]);
  expect(saved.reused).toBe(true);expect(saved.result).toBe(s.result);
  expect(s.calls.find(c=>c.name==='checkpoint_insert')?.text).toContain('do nothing');
  expect(s.calls.map(c=>c.text).join('\n')).not.toMatch(/\b(delete|update\s+private\.case_extraction)/i);
 });
 it('rejects a source absent from this revision before inserting checkpoint',async()=>{
  const s=setup();s.responses.checkpoint_source_match=[];
  await expect(saveExtractionCheckpoint(s.context,s.job,s.result as Parameters<typeof saveExtractionCheckpoint>[2])).rejects.toThrow('EXTRACTION_CHECKPOINT_SOURCE_MISMATCH');
  expect(s.calls.some(c=>c.name==='checkpoint_insert')).toBe(false);
 });
 it('keeps months separate instead of treating another month salary as a conflict',async()=>{
  const s=setup();s.input.documents.push({...s.input.documents[0],id:'22222222-2222-4222-8222-222222222222',version_id:'33333333-3333-4333-8333-333333333333',month:'2025-02'});
  expect((await s.reader.read()).documents).toHaveLength(1);
  expect(s.calls.filter(c=>c.name==='saved_snapshot_document')).toHaveLength(1);
 });
 it('runs canonical analysis on saved inputs, retains seven refusals and replays exact draft bytes',async()=>{
  const s=setup(),orderId='44444444-4444-4444-8444-444444444444';
  const order={id:orderId,kind:'full',from:'2025-01-01',to:'2025-01-01',topics:s.fixture.command.requested_topics,offer_sha256:'b'.repeat(64)};
  s.responses.saved_order_entitlements=[{orders:[order],current_orders:[order]}];
  s.responses.saved_analysis_order=[{created_at:'2025-02-01T00:00:00Z',engine_revision:'1'}];
  // Deliberately hermetic: this checks real service/catalog/renderer behavior,
  // not PostgreSQL commit/rollback or provider extraction.
  const analysis={caseAnalysis:new InMemoryCaseAnalysisRepository(),reports:new FixtureCaseReviewPort()} as unknown as PostgresAnalysisRepositories;
  const args={context:s.context,analysis,tenantId:'synthetic-test',job:s.job,orderId,month:'2025-01'};
  const completed=await runSavedMonthAnalysis(args);
  expect(completed.completed).toBe(true);expect(completed.stages).toHaveLength(7);
  expect(completed.bundle?.topic_results).toHaveLength(7);
  expect(completed.bundle?.topic_results.every(t=>t.amount===null&&t.trace===null)).toBe(true);
  expect(completed.bundle?.coverage_complete).toBe(false);
  expect(()=>validateReport(completed.report!)).not.toThrow();
  expect(Buffer.from(completed.report!.html).toString()).toContain('טרם אושרה לפרסום');
  expect(Buffer.from(completed.report!.html).toString()).not.toContain('נתוני בדיקה סינתטיים');
  expect((await runSavedMonthAnalysis(args)).report).toEqual(completed.report);
  await expect(runSavedMonthAnalysis({...args,orderId:'55555555-5555-4555-8555-555555555555'})).rejects.toThrow('SAVED_ORDER_SCOPE');
  await expect(runSavedMonthAnalysis({...args,month:'2025-02'})).rejects.toThrow('SAVED_ORDER_SCOPE');
  await expect(runSavedMonthAnalysis({...args,job:{...s.job,mode:'live'}})).rejects.toThrow('SAVED_LIVE_COMPOSITION_NOT_ENABLED');
 });
});
