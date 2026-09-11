import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {replayDocumentReview} from '@/engine/document-review/service';
import {reviewSourcePinSchema} from '@/engine/document-review/completions';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,sourceJobSchema,type SourceJob} from '../processing/source-dispatch';
import {assessReviewUpload,reviewUploadReceiptSchema,reviewUploadScopeSchema,type ReviewUploadAssessment} from './review-fulfillment';

const savedInputsSchema=z.object({review:z.unknown(),current_source_pins:z.array(reviewSourcePinSchema).max(602),
 items:z.array(z.object({scope:reviewUploadScopeSchema,receipt:reviewUploadReceiptSchema}).strict()).max(256)}).strict();

/** Run after persisted topic_results, inside the source-locked transaction,
 * including receipt replay. Inputs and assessment are independently bound in
 * SQL to the authenticated worker, current journal and this exact saved run.
 * Receiving a file never writes a customer answer or sends a notification. */
export async function assessSavedReviewUploads(context:PostgresTransactionContext,candidate:SourceJob,analysisRunId:string):Promise<readonly ReviewUploadAssessment[]>{
 const job=sourceJobSchema.parse(candidate);z.string().min(1).max(200).parse(analysisRunId);
 await lockCurrentSource(context,job);
 const loaded=await context.client.query(statement('review_upload_assessment_inputs',
  'select private.document_review_upload_assessment_inputs($1::uuid,$2,$3,$4,$5) value',
  [job.case_id,job.revision,job.input_sha256,analysisRunId,job.authority_dependency_sha256??null]));
 if(loaded.row_count!==1)throw Error('REVIEW_UPLOAD_STAGE_REQUIRED');
 const input=savedInputsSchema.parse(loaded.rows[0]?.value),review=replayDocumentReview(input.review);
 if(review.case_id!==job.case_id||review.analysis_run_id!==analysisRunId)throw Error('REVIEW_UPLOAD_STAGE_SCOPE');
 if(new Set(input.items.map(i=>i.receipt.request_id)).size!==input.items.length)throw Error('REVIEW_UPLOAD_REQUEST_AMBIGUOUS');
 // Preflight every pure assessment before the first persistence call.
 const expected=input.items.map(item=>({item,assessment:assessReviewUpload({...item,review,current_source_pins:input.current_source_pins})}));
 const results:ReviewUploadAssessment[]=[];
 for(const {item,assessment} of expected){
  const persisted=await context.client.query(statement('review_upload_assess',
   'select private.document_review_upload_assess($1::uuid,$2,$3,$4::uuid,$5,$6) value',
   [job.case_id,job.revision,job.input_sha256,item.receipt.batch_id,analysisRunId,job.authority_dependency_sha256??null]));
  if(persisted.row_count!==1||canonicalSha256(persisted.rows[0]?.value)!==canonicalSha256(assessment))throw Error('REVIEW_UPLOAD_ASSESSMENT_MISMATCH');
  results.push(assessment);
 }
 return results;
}
