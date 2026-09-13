import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '@/engine/document-review/payslip-adapter';
import {runDocumentReview} from '@/engine/document-review/service';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {documentReadingTargetSchema} from '../reports/document-field-confirmation';
import {openSavedReadingDependencies} from './saved-reading-dependencies';
import type {SourceJob} from './source-dispatch';
vi.mock('server-only',()=>({}));

function fixture(pageCount:number|null){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-grand-total-physical-admission',mode:'real'}),document=f.stored.documents[0],template=f.stored.extractions[0];
 const base=template.fields.find(c=>c.field==='gross_salary')!;
 const field=(name:string,raw:string,minor:number)=>({...base,candidate_id:randomUUID(),field:name,raw_value:raw,normalized_value:{currency:'ILS',minor_units:minor},confidence:.94,
  source:{...base.source,page:1,text_fragment:`${name}: ${raw}`},warning_flags:[]});
 const machine=normalizedPayslipExtractionSchema.parse({...template,document_quality_confidence:1,quality_metrics:{...template.quality_metrics,page_count:1},
  fields:[...template.fields.filter(c=>c.field==='salary_period'),field('gross_salary','100.00',10000),field('net_salary','80.00',8000)],additional_components:[],earnings_components_complete:false});
 const result={final_extraction:machine,first_pass:{normalized_extraction:machine}},resultSha=canonicalSha256(result);
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:resultSha,run:{result}};
 const snapshot={...f.stored,documents:[document],extractions:[machine]},period={from:'2025-01-01',to:'2025-01-31'};
 const review=runDocumentReview(reviewInputFromPayslips({case_id:document.case_id,period,review_policy:PAYSLIP_REVIEW_POLICY,
  purchased_scope:{order_id:randomUUID(),receipt_sha256:'a'.repeat(64),origin:'saved_order',topics:['minimum_wage']},snapshot,
  retained_unresolved_fields:[{case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,checkpoint_result_sha256:resultSha,
   checkpoint_result:result,final_extraction_sha256:canonicalSha256(machine),first_pass:machine}]}),'synthetic.physical.grand.total');
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:document.case_id,revision:1,input_sha256:'b'.repeat(64),mode:'draft'};
 const physical={caseId:job.case_id,revision:job.revision,inputSha256:job.input_sha256,currentDocuments:[{id:checkpoint.product_document_id,
  version_id:document.document_id,sha256:document.content_sha256,type:'payslip',page_count:pageCount}]};
 const opened:ReturnType<typeof documentReadingTargetSchema.parse>[]=[],names:string[]=[];
 const context:PostgresTransactionContext={transaction_id:'synthetic-physical-grant',client:{async query(q){names.push(q.name);
  if(q.name==='review_dependency_checkpoint')return {rows:[{result:checkpoint,result_sha256:resultSha}],row_count:1};
  if(q.name==='review_dependency_physical_context'){
   expect(q.text).toBe('select private.legacy_source_intake_context($1::uuid,$2,$3) context');expect(q.values).toEqual([job.case_id,job.revision,job.input_sha256]);
   return {rows:[{context:physical}],row_count:1};
  }
  if(q.name==='review_dependency_existing_targets')return {rows:[],row_count:0};
  if(q.name==='review_dependency_request_open'){opened.push(documentReadingTargetSchema.parse(JSON.parse(String(q.values[3]))));return {rows:[{id:randomUUID()}],row_count:1};}
  throw Error(`UNEXPECTED_STATEMENT:${q.name}`);
 }}};
 return {job,physical,opened,names,review,run:()=>openSavedReadingDependencies(context,job,review,snapshot)};
}
it.each([1,2,null])('opens a grand-total reading only with independent physical page count 1: %s',async pageCount=>{
 const f=fixture(pageCount),before=canonicalSha256(f.review);await f.run();
 expect(f.opened.filter(t=>t.schema_version==='document-source-transcription-v1'&&t.subject.kind==='grand_total')).toHaveLength(pageCount===1?1:0);
 expect(f.opened.filter(t=>t.schema_version==='document-field-confirmation-v1')).toHaveLength(2);
 expect(f.review.checks.find(c=>c.check_id.endsWith('.gross.net'))?.calculation.state).toBe('blocked');expect(canonicalSha256(f.review)).toBe(before);
 expect(f.names.filter(n=>n==='review_dependency_physical_context')).toHaveLength(1);
});
it.each(['case','revision','head','version','hash','id','duplicate','invalid_count'] as const)('refuses changed or malformed physical context before opening any request: %s',kind=>{
 const f=fixture(1);
 if(kind==='case')f.physical.caseId=randomUUID();if(kind==='revision')f.physical.revision++;
 if(kind==='head')f.physical.inputSha256='c'.repeat(64);if(kind==='version')f.physical.currentDocuments[0].version_id=randomUUID();
 if(kind==='hash')f.physical.currentDocuments[0].sha256='c'.repeat(64);if(kind==='id')f.physical.currentDocuments[0].id=randomUUID();
 if(kind==='duplicate')f.physical.currentDocuments.push({...f.physical.currentDocuments[0]});if(kind==='invalid_count')f.physical.currentDocuments[0].page_count=0;
 return expect(f.run()).rejects.toThrow().then(()=>expect(f.opened).toEqual([]));
});
