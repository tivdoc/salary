import 'server-only';
import {z} from 'zod';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {documentFieldTarget,documentFieldQuestion,confirmationFieldLabels} from '../reports/document-field-confirmation';
import {admitSavedSource} from './saved-admission';
import type {SourceJob} from './source-dispatch';
import {readSavedOrders} from './saved-order-scope';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';

/** Runs after the checkpoint is committed/selected and under the same admitted
 * case lock. Opening a question never confirms a value or changes the journal;
 * its eventual identified answer creates the next immutable input revision. */
export async function openSavedDocumentFieldRequests(context:PostgresTransactionContext,job:SourceJob,checkpoint:unknown){
 await admitSavedSource(context,job);
 const saved=z.object({case_id:z.uuid(),period_mismatch:z.boolean(),expected_month:z.string(),
  run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(checkpoint);
 if(saved.case_id!==job.case_id)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(saved.period_mismatch)return [];
 const orders=await readSavedOrders(context,job);
 const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).parse(saved.expected_month);
 const topics=[...new Set(orders.filter(order=>order.from<=month+'-01'&&order.to>=month+'-01').flatMap(order=>order.topics))].sort();
 if(!topics.length)throw Error('REQUEST_FIELD_UNPURCHASED_MONTH');
 // One versioned database policy is shared with the write boundary. Neither
 // the browser nor a caller-provided topic list authorizes opening a request.
 const scope=await context.client.query(statement('saved_field_question_scope',
  'select private.document_field_question_fields_v1(array(select jsonb_array_elements_text($1::jsonb))) fields',[JSON.stringify(topics)]));
 if(scope.rows.length!==1)throw Error('REQUEST_FIELD_SCOPE_ACK');
 const allowed=new Set(z.array(z.enum(Object.keys(confirmationFieldLabels) as [keyof typeof confirmationFieldLabels,...(keyof typeof confirmationFieldLabels)[]]))
  .max(12).refine(fields=>new Set(fields).size===fields.length).parse(scope.rows[0].fields));
 const extraction=saved.run.result.final_extraction;
 const validation=validatePayslipGate0(extraction,{reference_year:Number(saved.expected_month.slice(0,4))});
 const candidates=extraction.fields.filter(candidate=>{
  if(!allowed.has(candidate.field as keyof typeof confirmationFieldLabels)||candidate.normalized_value===null)return false;
  const assessment=validation.field_assessments.find(a=>a.candidate_id===candidate.candidate_id);
  return assessment&&assessment.status!=='invalid'&&(candidate.confidence<0.95||extraction.document_quality_confidence<0.95||assessment.status!=='valid');
 });
 const opened:string[]=[];
 for(const candidate of candidates){
  const target=documentFieldTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,candidateId:candidate.candidate_id});
  const question=documentFieldQuestion(target);
  const result=await context.client.query(statement('saved_field_request_open',
   'select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),question.question]));
  opened.push(z.uuid().parse(result.rows[0]?.id));
 }
 return opened;
}
