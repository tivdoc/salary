import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema,type NormalizedPayslipExtraction} from '@/engine/extraction/payslip';
import {payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from '@/engine/document-review/payslip-adapter';
import {documentReviewReadingDependencies} from '@/engine/document-review/source-dependencies';
import {runDocumentReview} from '@/engine/document-review/service';
import {documentSourceStructureTargetSchema} from '../reports/document-source-structure';
import {SavedCaseSnapshot,SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {openSavedReadingDependencies} from './saved-reading-dependencies';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';

const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
function fixture(qualified=true){
 const base=buildSyntheticCaseFixture({fixture_id:'synthetic-saved-period-bootstrap',mode:'real'}),doc=base.stored.documents[0],period={from:'2026-06-01',to:'2026-06-30'};
 const source={document_id:doc.document_id,page:1,text_fragment:'Synthetic hourly row',source_scope:{period_kind:'unknown',fund_kind:'unknown',column_label:'Unresolved month'}};
 const field=(name:string,raw:string,value:unknown)=>({candidate_id:uuid(name),field:name,raw_value:raw,normalized_value:value,confidence:.99,source,extraction_method:'fixture',warning_flags:[]});
 const machine=normalizedPayslipExtractionSchema.parse({...base.stored.extractions[0],document_quality_confidence:1,extracted_at:'2026-07-02T00:00:00Z',
  fields:[{...field('salary_period','06/2026',{year:2026,month:6,start_date:period.from,end_date:period.to}),source:{...source,source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'Current month'}}}],
  additional_components:[{component_id:uuid('hourly-row'),source_label:'Synthetic hourly row',normalized_label:'hourly.base',semantic_kind:'hourly_base',
   quantity_raw:'100',rate_raw:'33.00',amount_raw:'3300.00',percentage_raw:null,quantity:'100',rate:{currency:'ILS',minor_units:3300},amount:{currency:'ILS',minor_units:330000},percentage:null,
   source,confidence:.99,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}]});
 const first=normalizedPayslipExtractionSchema.parse({...machine,extraction_id:uuid('first-pass')});
 const runResult:{final_extraction:NormalizedPayslipExtraction;first_pass?:{normalized_extraction:unknown}}={final_extraction:machine,first_pass:{normalized_extraction:first}};
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:doc.case_id,product_document_id:uuid('product'),version_id:doc.document_id,input_sha256:doc.content_sha256,
  expected_month:'2026-06',period_mismatch:false,requires_confirmation:false,run:{result:runResult},result_sha256:canonicalSha256(runResult)};
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:doc.case_id,revision:9,input_sha256:'a'.repeat(64),mode:'draft',...(qualified?{processing_profile:'qualified_ai_v1' as const}:{})};
 const journal={case_id:doc.case_id,month:'2026-06',documents:[{id:checkpoint.product_document_id,version_id:doc.document_id,sha256:doc.content_sha256,type:'payslip',month:'2026-06'}],answers:[]};
 const calls:PostgresStatement[]=[],opened:unknown[]=[];let actualHash=job.input_sha256,dispatchProfile=job.processing_profile;
 const context:PostgresTransactionContext={transaction_id:'synthetic-period-bootstrap',client:{async query(q){calls.push(q);
  if(q.name==='source_case_lock')return {row_count:0,rows:[]};
  if(q.name==='source_revision_check')return {row_count:1,rows:[{revision:job.revision,input_sha256:job.input_sha256,processing_profile:dispatchProfile??null}]};
  if(q.name==='saved_snapshot_journal')return {row_count:1,rows:[{input:journal,created_at:'2026-07-03T00:00:00Z',input_sha256:job.input_sha256,actual_sha256:actualHash}]};
  if(q.name==='saved_snapshot_document')return {row_count:1,rows:[{...doc,content_sha256:doc.content_sha256,mime_type:'application/pdf',size:doc.size_bytes,
   storage_path:`cases/${doc.case_id}/versions/${doc.document_id}.pdf`,checkpoint_input_sha256:doc.content_sha256,checkpoint_result_sha256:checkpoint.result_sha256,result:checkpoint}]};
  if(q.name==='review_dependency_checkpoint')return {row_count:1,rows:[{result:checkpoint,result_sha256:checkpoint.result_sha256}]};
  if(q.name==='review_dependency_existing_targets')return {row_count:0,rows:[]};
  if(q.name==='review_dependency_request_open'){opened.push(JSON.parse(String(q.values[3])));return {row_count:1,rows:[{id:uuid(['request',opened.length])}]};}
  throw Error('UNEXPECTED_BOOTSTRAP_QUERY:'+q.name);
 }}};
 const load=()=>new SavedCaseSnapshot(context,job,'2026-06').read();
 const review=(snapshot:Awaited<ReturnType<typeof load>>)=>runDocumentReview(reviewInputFromPayslips({case_id:job.case_id,period,
  purchased_scope:{order_id:uuid('order'),receipt_sha256:'e'.repeat(64),origin:'saved_order',topics:['minimum_wage']},snapshot,review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY}),'synthetic.bootstrap.run');
 return {job,doc,machine,first,journal,checkpoint,context,calls,opened,load,review,seal(){checkpoint.result_sha256=canonicalSha256(runResult);},
  tamperJournal(){actualHash='b'.repeat(64);},revokeProfile(){dispatchProfile=undefined;}};
}
describe('qualified saved snapshot bootstraps the first period target',()=>{
 it('loads the authenticated first pass without prior readings and opens its exact first metadata request',async()=>{
  const f=fixture(),before=canonicalSha256(f.checkpoint),snapshot=await f.load(),extraction=snapshot.extractions[0];
  expect(extraction.source_reading_context).toEqual({checkpoint_result_sha256:f.checkpoint.result_sha256,first_pass:f.first});
  expect(extraction.customer_source_structures).toEqual([]);expect(extraction.customer_source_transcriptions).toBeUndefined();expect(extraction.customer_readings).toBeUndefined();
  expect(payslipMachineExtractionSha256(extraction)).toBe(canonicalSha256(f.machine));
  const report=f.review(snapshot),deps=documentReviewReadingDependencies({review:report,document_id:f.doc.document_id,extraction});
  const period=deps.source_structures?.filter(d=>d.subject.kind==='period_association');expect(period).toHaveLength(1);
  await openSavedReadingDependencies(f.context,f.job,report,snapshot);
  const targets=f.opened.flatMap(raw=>{const parsed=documentSourceStructureTargetSchema.safeParse(raw);return parsed.success&&parsed.data.subject.kind==='period_association'?[parsed.data]:[];});
  expect(targets).toHaveLength(1);expect(targets[0]).toMatchObject({schema_version:'document-source-period-association-v1',source_sha256:f.doc.content_sha256,
   extraction_result_sha256:f.checkpoint.result_sha256,first_pass_extraction_sha256:canonicalSha256(f.first),normalized_extraction_sha256:canonicalSha256(f.machine),proposed_value:null,policy_version:SAVED_EXTRACTION_POLICY});
  expect(targets[0].subject).toEqual(period![0].subject);expect(f.journal.answers).toEqual([]);expect(canonicalSha256(f.checkpoint)).toBe(before);
  expect(await f.load()).toEqual(snapshot);
 });
 it('preserves historical extraction bytes and does not add a first target without the explicit profile',async()=>{
  const f=fixture(false),snapshot=await f.load();expect(snapshot.extractions).toEqual([f.machine]);
  expect(snapshot.extraction_snapshot_sha256).toBe(canonicalSha256([f.machine]));
  expect(documentReviewReadingDependencies({review:f.review(snapshot),document_id:f.doc.document_id,extraction:snapshot.extractions[0]}).source_structures).toBeUndefined();
  delete f.checkpoint.run.result.first_pass;f.seal();expect((await f.load()).extractions).toEqual(snapshot.extractions);
 });
 it('refuses a missing first pass rather than copying the final extraction into its place',async()=>{
  const f=fixture();delete f.checkpoint.run.result.first_pass;f.seal();await expect(f.load()).rejects.toThrow('SAVED_SOURCE_READING_FIRST_PASS_REQUIRED');expect(f.opened).toEqual([]);
 });
 it.each(['document','observation','annotation','page'] as const)('rejects a resealed %s first pass before creating any target',async change=>{
  const f=fixture(),first=structuredClone(f.first);
  if(change==='document')first.document_id=uuid('foreign');
  if(change==='observation')first.fields[0].source.document_id=uuid('foreign');
  if(change==='annotation')first.customer_source_structures=[];
  if(change==='page')first.fields[0].source.page=first.quality_metrics.page_count+1;
  f.checkpoint.run.result.first_pass={normalized_extraction:first};f.seal();
  await expect(f.load()).rejects.toThrow('SAVED_SOURCE_READING_FIRST_PASS_INVALID');expect(f.opened).toEqual([]);
 });
 it('rejects changed checkpoint/journal bytes and a revoked profile before using retained context',async()=>{
  const first=fixture();first.first.warnings.push('Changed after checkpoint');await expect(first.load()).rejects.toThrow('SAVED_EXTRACTION_BINDING_MISMATCH');
  const journal=fixture();journal.tamperJournal();await expect(journal.load()).rejects.toThrow('SAVED_INPUT_HASH_MISMATCH');
  const profile=fixture();profile.revokeProfile();await expect(profile.load()).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');
 });
});
