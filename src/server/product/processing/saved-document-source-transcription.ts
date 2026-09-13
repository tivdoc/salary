import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,type DocumentReviewInput} from '@/engine/document-review/contracts';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {evidenceSourceDocumentSchema,evidenceSourceReadingDependencies,documentEvidenceSourceTranscriptionTargetSchema,
 documentEvidenceSourceTranscriptionTarget,documentEvidenceSourceTranscriptionQuestion,resolveDocumentEvidenceSourceReading,
 parseDocumentEvidenceSourceReading,type DocumentEvidenceSourceReading,type EvidenceSourceDocument} from '../reports/document-evidence-source-transcription';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,type SourceJob} from './source-dispatch';
import {readSavedOrders,purchasedMonths,savedOrderOrigin,savedOrderReceiptSha256} from './saved-order-scope';
import {admitSavedSource} from './saved-admission';

const sourceContextSchema=z.object({case_id:z.uuid(),source_documents:z.array(evidenceSourceDocumentSchema).max(32),journal:z.object({answers:z.array(z.record(z.string(),z.unknown()))}).passthrough()}).strict();
async function contextFor(context:PostgresTransactionContext,job:SourceJob){
 await lockCurrentSource(context,job);
 const rows=await context.client.query(statement('saved_evidence_source_transcription_sources',
  'select private.evidence_source_transcription_sources($1::uuid,$2,$3) value',[job.case_id,job.revision,job.input_sha256]));
 if(rows.row_count!==1||rows.rows[0].value===null)throw Error('SOURCE_TRANSCRIPTION_CONTEXT_REQUIRED');
 const saved=sourceContextSchema.parse(rows.rows[0].value);
 if(saved.case_id!==job.case_id||saved.source_documents.some(s=>s.case_id!==job.case_id)||new Set(saved.source_documents.map(s=>s.version_id)).size!==saved.source_documents.length)
  throw Error('SOURCE_TRANSCRIPTION_SOURCE_SCOPE');
 for(const source of saved.source_documents)if(canonicalSha256(source.reading_dependencies)!==canonicalSha256(evidenceSourceReadingDependencies(saved.journal,job.case_id,source.version_id)))
  throw Error('SOURCE_TRANSCRIPTION_DEPENDENCIES_CHANGED');
 return saved;
}
const isTranscription=(a:Record<string,unknown>)=>a.field_target!==null&&typeof a.field_target==='object'
 &&['document-evidence-source-transcription-v1','document-evidence-source-transcription-v2'].includes(String((a.field_target as Record<string,unknown>).schema_version));
/** Separate authenticated text receipts. Never merge these with provider
 * observations or assign an extraction ID, confidence, or numeric amount. */
export async function readSavedDocumentSourceTranscriptions(context:PostgresTransactionContext,job:SourceJob,month:string,journal:unknown):Promise<DocumentEvidenceSourceReading[]>{
 const original=z.object({answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(journal);
 if(!original.answers?.some(isTranscription))return [];
 const saved=await contextFor(context,job);
 if(canonicalSha256(saved.journal.answers)!==canonicalSha256(original.answers))throw Error('SOURCE_TRANSCRIPTION_JOURNAL_CHANGED');
 const orders=(await readSavedOrders(context,job)).filter(o=>purchasedMonths(o).includes(month));
 const readings:DocumentEvidenceSourceReading[]=[],seen=new Set<string>();
 for(const raw of saved.journal.answers.filter(isTranscription)){
  const a=z.object({id:z.uuid(),case_id:z.literal(job.case_id),code:z.string(),scope_month:z.string(),answer_kind:z.literal('choice'),answer:z.string(),
   answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true}),field_target:documentEvidenceSourceTranscriptionTargetSchema}).parse(raw),target=a.field_target;
  if(seen.has(a.id)||a.code!==`document_field:${target.target_sha256}`||target.case_id!==job.case_id||target.month!==a.scope_month)throw Error('SOURCE_TRANSCRIPTION_JOURNAL_SCOPE');seen.add(a.id);
  if(a.scope_month!==month)continue;
  const source=saved.source_documents.find(s=>s.version_id===target.version_id),order=orders.find(o=>o.id===target.order_id);
  // Obsolete entries remain in the authenticated input journal. Their old
  // text cannot become a current reading after replacement or scope changes.
  if(!source||!order)continue;
  const result=resolveDocumentEvidenceSourceReading({target,currentSource:source,currentPurchase:{order_id:order.id,origin:savedOrderOrigin(order),receipt_sha256:savedOrderReceiptSha256(order),topics:[...order.topics]},
   caseId:job.case_id,month,requestId:a.id,answerRevision:a.answer_revision,identityId:a.answer_identity_id,answeredAt:a.answer_created_at,answer:a.answer});
  if(result.state==='current')readings.push(result.reading);
 }
 if(new Set(readings.map(r=>r.target.target_sha256)).size!==readings.length)throw Error('SOURCE_TRANSCRIPTION_READING_AMBIGUOUS');
 return readings.sort((a,b)=>a.request_id.localeCompare(b.request_id));
}
export function attachSavedDocumentSourceTranscriptions(review:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 const readings=(snapshot.document_source_transcriptions??[]).filter(r=>r.target.month===review.period.from.slice(0,7)&&r.target.order_id===review.purchased_scope.order_id);
 if(!readings.length)return review;
 for(const raw of readings){const r=parseDocumentEvidenceSourceReading(raw);
  if(r.target.case_id!==review.case_id||r.target.order_receipt_sha256!==review.purchased_scope.receipt_sha256||r.target.order_origin!==review.purchased_scope.origin
   ||canonicalSha256(r.target.purchased_topics)!==canonicalSha256(review.purchased_scope.topics)
   ||!review.documents.some(d=>d.version_id===r.target.version_id&&d.file_sha256===r.target.source_sha256))throw Error('SOURCE_TRANSCRIPTION_REVIEW_SCOPE');
 }
 return documentReviewInputSchema.parse({...review,document_source_transcriptions:readings});
}
export async function openSavedDocumentSourceTranscriptionRequests(context:PostgresTransactionContext,job:SourceJob,month:string,review:DocumentReviewInput){
 if(!review.purchased_scope.topics.some(t=>t==='contract'||t==='bonuses'))return [];
 await admitSavedSource(context,job);
 const saved=await contextFor(context,job),sources=saved.source_documents.filter(s=>!review.non_payslip_evidence?.some(e=>e.document.document_id===s.version_id&&e.extraction?.observations.some(o=>o.original.semantic==='clause_text')));
 const opened:{requestId:string;month:string;versionId:string;page:null}[]=[];
 for(const source of sources){
  const target=documentEvidenceSourceTranscriptionTarget({source,purchase:review.purchased_scope,month,page:null});
  const rows=await context.client.query(statement('saved_evidence_source_transcription_open','select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),documentEvidenceSourceTranscriptionQuestion(target).question]));
  if(rows.row_count!==1)throw Error('SOURCE_TRANSCRIPTION_REQUEST_REQUIRED');
  opened.push({requestId:z.uuid().parse(rows.rows[0].id),month,versionId:source.version_id,page:null});
 }
 return opened;
}
export type SavedEvidenceSourceDocument=EvidenceSourceDocument;
