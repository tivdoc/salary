import {assertSavedDocumentReviewSourceScope,type SavedDocumentReviewSourceScope} from './saved-document-review';
import {assertJune2026TestAuthority,june2026TestIdempotencyKey,type June2026TestAuthority} from './saved-june2026-test-authority';
import {assertSavedJune2026RegularAuthority,june2026RegularIdempotencyKey,type SavedJune2026RegularAuthority} from './saved-june2026-regular-authority';
import {savedHoursDeclarations} from './saved-hours-declarations';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';
import {savedDeclaredFacts} from './saved-request-facts';
import {savedDocumentFieldReadings} from './saved-field-readings';
import { z } from 'zod';
import { immutableDocumentSchema } from '@/engine/domain/documents';
import { normalizedPayslipExtractionSchema } from '@/engine/extraction/payslip';
import { canonicalSha256, deepFreeze } from '@/engine/rule-runtime/canonical';
import type { StoredCaseInputSnapshot, StoredCaseSnapshotPort } from '@/engine/case-analysis/contracts';
import type { CaseAnalysisCommand } from '@/engine/wave3/contracts';
import { statement, type PostgresTransactionContext } from '@/server/platform/persistence/postgres/contracts';
import { lockCurrentSource, sourceJobSchema, type SourceJob } from './source-dispatch';

export const SAVED_EXTRACTION_POLICY = 'saved-payslip-v21-p95-v1';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const storedMonth=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/).transform(value=>value.slice(0,7));
const sourceSchema = z.object({
 case_id: z.uuid(), month,
 documents: z.array(z.object({id:z.uuid(),version_id:z.uuid(),sha256:sha,type:z.string(),month:storedMonth.nullable()})),
});
const checkpointSchema = z.object({
 schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),
 product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,expected_month:month,
 period_mismatch:z.boolean(),requires_confirmation:z.boolean(),result_sha256:sha,
 run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough(),
});

/** A transaction-bound adapter, never an in-memory repository. Only the exact
 * immutable journal revision and extraction policy can become engine inputs.
 * Revalidates source scope even on retry; it never calls a provider in a lock. */
export class SavedCaseSnapshot implements StoredCaseSnapshotPort {
 constructor(private readonly context:PostgresTransactionContext,private readonly candidate:SourceJob,private readonly targetMonth?:string,private readonly testScope?:{authority:June2026TestAuthority;orderId:string},private readonly regularScope?:{authority:SavedJune2026RegularAuthority;orderId:string},private readonly allowEmptyReview=false,private readonly sourceReviewScope?:SavedDocumentReviewSourceScope) {}

 async read():Promise<StoredCaseInputSnapshot> {
  const job=sourceJobSchema.parse(this.candidate);
  await lockCurrentSource(this.context,job);
  const journal=await this.context.client.query(statement('saved_snapshot_journal',
   `select input,created_at,input_sha256,encode(sha256(convert_to(input::text,'UTF8')),'hex') as actual_sha256
    from private.case_input_versions where case_id=$1::uuid and revision=$2`,[job.case_id,job.revision]));
  const row=journal.rows[0];
  if(!row||row.input_sha256!==job.input_sha256||row.actual_sha256!==job.input_sha256)throw new Error('SAVED_INPUT_HASH_MISMATCH');
  const source=sourceSchema.parse(row.input);
  if(source.case_id!==job.case_id)throw new Error('SAVED_INPUT_CASE_MISMATCH');
  const selectedMonth=month.parse(this.targetMonth??source.month);
  if(this.sourceReviewScope){
   if(this.testScope||this.regularScope||!this.targetMonth)throw Error('SAVED_REVIEW_SOURCE_MODE');
   await assertSavedDocumentReviewSourceScope(this.context,job,selectedMonth,this.sourceReviewScope);
  }
  const payslips=this.sourceReviewScope?[]:source.documents.filter(d=>d.type==='payslip'&&(d.month??source.month)===selectedMonth);
  if(!payslips.length&&!this.allowEmptyReview&&!this.sourceReviewScope)throw new Error('SAVED_PAYSLIP_REQUIRED');
  if(new Set(source.documents.map(d=>d.version_id)).size!==source.documents.length)throw new Error('SAVED_VERSION_DUPLICATE');
  const documents=[],extractions=[];
  for(const pinned of payslips){
   const rows=await this.context.client.query(statement('saved_snapshot_document',
    `select d.*,c.input_sha256 as checkpoint_input_sha256,c.result_sha256 as checkpoint_result_sha256,c.result
     from public.documents d join private.case_extraction_checkpoints c
      on c.case_id=d.case_id and c.version_id=d.version_id
     where d.case_id=$1::uuid and d.id=$2::uuid and d.version_id=$3::uuid
      and c.revision=$4 and c.policy_version=$5`,[job.case_id,pinned.id,pinned.version_id,job.revision,SAVED_EXTRACTION_POLICY]));
   const d=rows.rows[0];
   if(!d)throw new Error('SAVED_EXTRACTION_PENDING');
   const checkpoint=checkpointSchema.parse(d.result);
   if(checkpoint.case_id!==job.case_id||checkpoint.product_document_id!==pinned.id||checkpoint.version_id!==pinned.version_id
    ||checkpoint.input_sha256!==pinned.sha256||d.content_sha256!==pinned.sha256||d.checkpoint_input_sha256!==pinned.sha256
    ||d.checkpoint_result_sha256!==checkpoint.result_sha256||canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256)
    throw new Error('SAVED_EXTRACTION_BINDING_MISMATCH');
   const expected=pinned.month??source.month;
   if(checkpoint.expected_month!==expected||checkpoint.period_mismatch)throw new Error('SAVED_EXTRACTION_PERIOD_MISMATCH');
   const extraction=checkpoint.run.result.final_extraction;
   if(extraction.document_id!==pinned.version_id)throw new Error('SAVED_EXTRACTION_CASE_MISMATCH');
   const periods=extraction.fields.filter(f=>f.field==='salary_period').map(f=>f.normalized_value);
   if(!periods.length||periods.some(p=>!p||`${p.year}-${String(p.month).padStart(2,'0')}`!==expected))throw new Error('SAVED_EXTRACTION_PERIOD_MISMATCH');
   // Do not reclassify low-confidence OCR as a declaration or confirmation.
   // The existing Gate 0 and canonical resolver retain candidate confidence.
   const extension=d.mime_type==='application/pdf'?'pdf':d.mime_type==='image/png'?'png':d.mime_type==='image/jpeg'?'jpg':null;
   if(!extension||d.storage_path!==`cases/${job.case_id}/versions/${pinned.version_id}.${extension}`)throw new Error('SAVED_STORAGE_SCOPE');
   documents.push(immutableDocumentSchema.parse({document_id:pinned.version_id,case_id:job.case_id,document_type:'payslip',
    original_filename:d.original_filename,mime_type:d.mime_type,size_bytes:Number(d.size),content_sha256:pinned.sha256,
    storage_path:`cases/${job.case_id}/documents/${pinned.version_id}/original.${extension}`,
    document_period:null,supersedes_document_id:null,created_at:new Date(String(d.created_at)).toISOString()}));
   const readings=savedDocumentFieldReadings({caseId:job.case_id,month:selectedMonth,policyVersion:SAVED_EXTRACTION_POLICY,journal:row.input,checkpoint:d.result});
   extractions.push(readings.length?{...extraction,customer_readings:[...readings]}:extraction);
  }
  // Free-text questionnaire/request answers are preserved by the source hash.
  // They cannot be promoted into verified critical facts by this adapter.
  const facts=[...savedDeclaredFacts({caseId:job.case_id,revision:job.revision,inputSha256:job.input_sha256,month:selectedMonth,journal:row.input,createdAt:new Date(String(row.created_at)).toISOString()})];
  const hasHoursAnswer=z.object({answers:z.array(z.object({code:z.string().optional()}).passthrough()).optional()}).passthrough().parse(row.input)
   .answers?.some(a=>a.code?.startsWith('june2026_regular_hours:'));
  if(hasHoursAnswer&&selectedMonth==='2026-06'&&payslips.length===1&&!extractions[0].fields.some(f=>f.field==='regular_hours')){
   const orders=await readSavedOrders(this.context,job);
   const scoped=orders.filter(o=>purchasedMonths(o).includes('2026-06')&&o.topics.includes('minimum_wage'));
   const declarations=(await Promise.all(scoped.map(o=>savedHoursDeclarations(this.context,job,o.id)))).flat();
   if(declarations.length>1)throw Error('SAVED_HOURS_DECLARATION_AMBIGUOUS');
   facts.push(...declarations);
  }
  const reviewAnswers=z.object({answers:z.array(z.object({code:z.string().optional()}).passthrough()).optional()}).passthrough().parse(row.input)
   .answers?.some(a=>a.code?.startsWith('document_review:'));
  return deepFreeze({...(reviewAnswers?{has_document_review_answers:true}:{}),document_snapshot_id:`saved-documents:${selectedMonth}:${job.input_sha256}`,document_snapshot_sha256:canonicalSha256(documents),documents,
   extraction_snapshot_id:`saved-extractions:${selectedMonth}:${job.input_sha256}`,extraction_snapshot_sha256:canonicalSha256(extractions),extractions,
   declared_fact_snapshot:{snapshot_id:`saved-declarations:${selectedMonth}:${job.input_sha256}`,snapshot_sha256:canonicalSha256(facts),facts}});
 }

 async loadPinned(command:CaseAnalysisCommand):Promise<StoredCaseInputSnapshot>{
  if(this.sourceReviewScope){
   if(!command.document_review_sha256)throw new Error('SAVED_REVIEW_COMMAND_REQUIRED');
   const end=new Date(Date.UTC(Number(this.targetMonth?.slice(0,4)),Number(this.targetMonth?.slice(5,7)),0)).toISOString().slice(0,10);
   if(command.period.start_date!==`${this.targetMonth}-01`||command.period.end_date!==end)throw Error('SAVED_COMMAND_SCOPE');
  }
  if(command.case_id!==this.candidate.case_id)throw new Error('SAVED_COMMAND_SCOPE');
  if(this.testScope){
   const {authority,orderId}=this.testScope;assertJune2026TestAuthority(authority,this.candidate,orderId);
   if(command.mode!=='synthetic_test'||this.targetMonth!=='2026-06'||command.period.start_date!=='2026-06-01'||command.period.end_date!=='2026-06-30'
    ||command.requested_topics.length!==1||command.requested_topics[0]!=='minimum_wage'
    ||command.idempotency_key!==june2026TestIdempotencyKey(this.candidate,orderId,authority))throw new Error('SAVED_COMMAND_SCOPE');
  }else if(this.regularScope){
   const {authority,orderId}=this.regularScope;assertSavedJune2026RegularAuthority(authority,this.candidate,orderId);
   if(command.mode!==authority.mode||this.targetMonth!=='2026-06'||command.period.start_date!=='2026-06-01'||command.period.end_date!=='2026-06-30'
    ||command.requested_topics.length!==1||command.requested_topics[0]!=='minimum_wage'
    ||command.idempotency_key!==june2026RegularIdempotencyKey(this.candidate,orderId,authority))throw Error('SAVED_COMMAND_SCOPE');
  }else if(command.mode!=='real')throw new Error('SAVED_COMMAND_SCOPE');
  const snapshot=await this.read();
  if(command.document_snapshot_id!==snapshot.document_snapshot_id||command.document_snapshot_sha256!==snapshot.document_snapshot_sha256
   ||command.extraction_snapshot_id!==snapshot.extraction_snapshot_id||command.extraction_snapshot_sha256!==snapshot.extraction_snapshot_sha256
   ||command.declared_fact_snapshot_id!==snapshot.declared_fact_snapshot.snapshot_id||command.declared_fact_snapshot_sha256!==snapshot.declared_fact_snapshot.snapshot_sha256)
   throw new Error('SAVED_COMMAND_PIN_MISMATCH');
  return snapshot;
 }
}
