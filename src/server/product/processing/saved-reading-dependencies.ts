import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {mappedRowCellCandidate} from '@/engine/extraction/reading-resolution';
import {documentReviewReadingDependencies} from '@/engine/document-review/source-dependencies';
import type {DocumentReviewResult} from '@/engine/document-review/contracts';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {documentRowCellTarget,documentRowCellQuestion} from '../reports/document-row-cell-confirmation';
import {documentSourceScopeTarget,documentSourceScopeQuestion} from '../reports/document-source-scope-confirmation';
import {documentSourceTranscriptionTarget,documentSourceTranscriptionQuestion} from '../reports/document-source-transcription';
import {documentSourceStructureTargetFromSubject,documentSourceStructureQuestion} from '../reports/document-source-structure';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint,documentFieldTarget,documentFieldQuestion} from '../reports/document-field-confirmation';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {SourceJob} from './source-dispatch';

/** Only cells used by a blocked purchased check become reading requests.
 * Existing scalar requests retain their exact v1 targets and history. */
export async function openSavedReadingDependencies(context:PostgresTransactionContext,job:SourceJob,review:DocumentReviewResult,snapshot:StoredCaseInputSnapshot){
 const opened:string[]=[];
 for(const extraction of snapshot.extractions){
  if(!review.documents.some(d=>d.document_id===extraction.document_id))continue;
  const dependencies=documentReviewReadingDependencies({review,document_id:extraction.document_id,extraction});
  if(!dependencies.row_cells.length&&!dependencies.scope_fields.length&&!dependencies.source_transcriptions.length&&!dependencies.scalar_fields.length&&!dependencies.source_structures?.length)continue;
  const rows=await context.client.query(statement('review_dependency_checkpoint',
   `select c.result,c.result_sha256 from private.case_extraction_checkpoints c
    join private.case_input_versions v on v.case_id=c.case_id and v.revision=c.revision
    join public.documents d on d.case_id=c.case_id and d.version_id=c.version_id and d.content_sha256=c.input_sha256
    where c.case_id=$1::uuid and c.revision=$2 and v.input_sha256=$3 and c.version_id=$4::uuid and c.policy_version=$5`,
   [job.case_id,job.revision,job.input_sha256,extraction.document_id,SAVED_EXTRACTION_POLICY]));
  if(rows.row_count!==1)throw Error('REVIEW_DEPENDENCY_CHECKPOINT');
  const checkpoint=rows.rows[0].result;
  const saved=z.object({result_sha256:z.string(),run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()})}).parse(checkpoint);
  if(saved.result_sha256!==rows.rows[0].result_sha256||canonicalSha256(saved.run.result)!==saved.result_sha256)throw Error('REVIEW_DEPENDENCY_CHECKPOINT_HASH');
  const existing=await context.client.query(statement('review_dependency_existing_targets',
   `select t.target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
    where t.case_id=$1::uuid and t.target->>'version_id'=$2 and r.expired_at is null and r.expires_at>clock_timestamp()`,[job.case_id,extraction.document_id]));
  const scalarIds=new Set<string>();
  for(const row of existing.rows){
   const target=documentReadingTargetSchema.parse(row.target);if(target.schema_version!=='document-field-confirmation-v1')continue;
   let current;try{current=documentReadingTargetForCheckpoint({target,currentCheckpoint:checkpoint});}catch{continue;}
   if(current.target_sha256===target.target_sha256)scalarIds.add(target.candidate.candidate_id);
  }
  const rowsToOpen=dependencies.row_cells.filter(dep=>{
   const row=saved.run.result.final_extraction.additional_components.find(r=>r.component_id===dep.component_id);
   if(!row)throw Error('REVIEW_DEPENDENCY_ROW_MISSING');
   const mapped=mappedRowCellCandidate({fields:saved.run.result.final_extraction.fields,row,cell:dep.cell});
   return !mapped||!scalarIds.has(mapped.candidate_id);
  });
  const targets=[...rowsToOpen.map(dep=>({target:documentRowCellTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,componentId:dep.component_id,cell:dep.cell}),checkIds:dep.check_ids})),
   ...dependencies.scalar_fields.filter(dep=>!scalarIds.has(dep.candidate_id)&&saved.run.result.final_extraction.fields.some(f=>f.candidate_id===dep.candidate_id&&f.normalized_value!==null)).map(dep=>({target:documentFieldTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,candidateId:dep.candidate_id}),checkIds:dep.check_ids})),
   ...dependencies.scope_fields.map(dep=>({target:documentSourceScopeTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,candidateId:dep.candidate_id}),checkIds:dep.check_ids})),
   ...dependencies.source_transcriptions.map(dep=>({target:documentSourceTranscriptionTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject:dep.subject}),checkIds:dep.check_ids})),
   ...(dependencies.source_structures??[]).map(dep=>({target:documentSourceStructureTargetFromSubject({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject:dep.subject}),checkIds:dep.check_ids}))];
  for(const {target,checkIds} of targets){
   const question=target.schema_version==='document-field-confirmation-v1'?documentFieldQuestion(target):target.schema_version==='document-row-cell-confirmation-v1'?documentRowCellQuestion(target)
    :target.schema_version==='document-source-scope-confirmation-v1'?documentSourceScopeQuestion(target):target.schema_version==='document-source-transcription-v1'?documentSourceTranscriptionQuestion(target):documentSourceStructureQuestion(target);
   const titles=review.checks.filter(c=>checkIds.includes(c.check_id)).map(c=>c.title);
   const explanation=` האימות יאפשר לבדוק: ${titles.join('; ')}.`;
   const text=question.question.length+explanation.length<=400?question.question+explanation:question.question;
   const result=await context.client.query(statement('review_dependency_request_open',
    'select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
    [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),text]));
   if(result.row_count!==1)throw Error('REVIEW_DEPENDENCY_REQUEST_ACK');
   opened.push(z.uuid().parse(result.rows[0]?.id));
  }
 }
 return opened;
}
