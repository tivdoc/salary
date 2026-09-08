import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {reportDocumentV3Schema} from './report-document';

/** Internal verified worker transaction only. The database rechecks authority,
 * paid offer, current input and exact saved document under its case lock. */
export async function publishSavedAiReport(context:PostgresTransactionContext,input:{caseId:string;identityId:string;projectionId:string}){
 for(const id of Object.values(input))z.uuid().parse(id);
 const result=await context.client.query(statement('ai_report_candidate',
  'select report_document,projection,projection_sha256 from public.case_report_projections where id=$1::uuid and case_id=$2::uuid',
  [input.projectionId,input.caseId]));
 const row=result.rows[0];if(!row)throw new Error('REPORT_AI_FORBIDDEN');
 const document=reportDocumentV3Schema.parse(row.report_document);
 if(document.id!==input.projectionId||document.case_id!==input.caseId||document.projection_sha256!==row.projection_sha256
  ||canonicalSha256(row.projection)!==document.projection_sha256)throw new Error('REPORT_AI_DOCUMENT_MISMATCH');
 // Evaluate the deliverable shape without choosing the actual publication time.
 // Only the database can create its final receipt; this value is never persisted.
 reportDocumentV3Schema.parse({...document,publication:{state:'published',approval_actor_kind:'automation',
  approved_input_sha256:document.input_sha256,published_at:document.projection.generated_at}});
 const published=await context.client.query(statement('ai_report_publish',
  'select private.report_ai_publish($1::uuid,$2::uuid,$3::uuid,$4::jsonb) value',
  [input.caseId,input.identityId,input.projectionId,JSON.stringify(document)]));
 const receipt=z.object({projection_id:z.uuid(),qa_id:z.uuid(),published_at:z.iso.datetime({offset:true}),replayed:z.boolean()}).strict().parse(published.rows[0]?.value);
 if(receipt.projection_id!==input.projectionId)throw new Error('REPORT_AI_ACKNOWLEDGEMENT_MISMATCH');
 return receipt;
}
