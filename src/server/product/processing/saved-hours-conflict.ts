import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {hasHoursConflictObservations} from '@/engine/extraction/hours-conflict';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {createDocumentHoursConflictTarget,resolveDocumentHoursConflictAnswer} from '../reports/document-hours-conflict';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';

/** Only authenticated journal data can supply a correction declaration. The
 * canonical parent/candidates are never edited by this loader. */
export async function loadSavedHoursConflict(input:{context:PostgresTransactionContext;job:SourceJob;orderId:string;checkpoint:unknown}){
 const extraction=normalizedPayslipExtractionSchema.parse(z.object({run:z.object({result:z.object({final_extraction:z.unknown()})})}).parse(input.checkpoint).run.result.final_extraction);
 if(!hasHoursConflictObservations(extraction))return {state:'not_applicable' as const};
 const expected=createDocumentHoursConflictTarget({checkpoint:input.checkpoint,orderId:input.orderId,policyVersion:SAVED_EXTRACTION_POLICY});
 const result=await input.context.client.query(statement('saved_hours_conflict_admit',
  'select private.june2026_hours_conflict_admit($1::uuid,$2::uuid,$3,$4) source',[input.job.case_id,input.orderId,input.job.revision,input.job.input_sha256]));
 const source=z.object({target:z.unknown().nullable(),checkpoint:z.unknown(),policy_version:z.literal(SAVED_EXTRACTION_POLICY),
  answer:z.object({request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),answer:z.string()}).nullable()}).strict().parse(result.rows[0]?.source);
 if(canonicalSha256(source.checkpoint)!==canonicalSha256(input.checkpoint))throw Error('SAVED_HOURS_CONFLICT_CHECKPOINT_MISMATCH');
 if(source.target===null){if(source.answer!==null)throw Error('SAVED_HOURS_CONFLICT_TARGET_REQUIRED');return {state:'awaiting_input' as const,target:expected};}
 if(canonicalSha256(source.target)!==canonicalSha256(expected))throw Error('SAVED_HOURS_CONFLICT_TARGET_MISMATCH');
 if(!source.answer)return {state:'awaiting_input' as const,target:expected};
 const answer=source.answer;
 return resolveDocumentHoursConflictAnswer({target:source.target,currentCheckpoint:input.checkpoint,policyVersion:source.policy_version,
  caseId:input.job.case_id,orderId:input.orderId,month:'2026-06',requestId:answer.request_id,answerRevision:answer.answer_revision,
  identityId:answer.identity_id,answeredAt:answer.answered_at,answer:answer.answer});
}
