import 'server-only';
import {z} from 'zod';
import {createDocumentTranscriptionTarget,documentTranscriptionQuestion,type DocumentTranscriptionSelector} from '../reports/document-field-transcription';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource} from './saved-admission';
import {readSavedOrders} from './saved-order-scope';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {SourceJob} from './source-dispatch';

/** Missing OCR fields get separate source transcriptions. Existing candidates
 * keep their original reading-confirmation flow and immutable extraction. */
export async function openSavedTranscriptionRequests(context:PostgresTransactionContext,job:SourceJob,checkpoint:unknown){
 const saved=z.object({case_id:z.uuid(),expected_month:z.string(),period_mismatch:z.boolean(),run:z.object({result:z.object({final_extraction:z.object({
  fields:z.array(z.object({field:z.string()})),additional_components:z.array(z.object({component_id:z.uuid()})),
 })})})}).parse(checkpoint);
 if(saved.case_id!==job.case_id)throw Error('TRANSCRIPTION_CASE_MISMATCH');
 if(saved.expected_month!=='2026-06'||saved.period_mismatch)return [];
 await admitSavedSource(context,job);
 if(!(await readSavedOrders(context,job)).some(o=>o.from<='2026-06-01'&&o.to>='2026-06-01'&&o.topics.includes('minimum_wage')))return [];
 const extraction=saved.run.result.final_extraction;
 // The paired completion consumer supports only this exact absent-field case.
 // Do not ask a question that cannot yet affect an engineering calculation.
 if(extraction.fields.some(f=>f.field==='salary_type'||f.field==='base_monthly_salary')||extraction.additional_components.length!==1)return [];
 const selectors:DocumentTranscriptionSelector[]=[{kind:'salary_type'},{kind:'component_amount',componentId:extraction.additional_components[0].component_id}];
 let planned;
 try{planned=selectors.map(subject=>{
   const target=createDocumentTranscriptionTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject});
   return {target,question:documentTranscriptionQuestion(target)};
  });}catch(error){
   // This narrow request does not cover inconsistent or unsupported sources.
   // Preserve their existing unresolved evidence instead of guessing a value.
   if(error instanceof Error&&/^TRANSCRIPTION_(PERIOD_UNSUPPORTED|SINGLE_PAGE_RECEIPT_REQUIRED|EXTRACTION_UNSUPPORTED|COMPONENT_UNSUPPORTED|COMPONENT_TOTAL_CONFLICT|QUESTION_TOO_LONG)$/.test(error.message))return [];
   throw error;
  }
 const opened:string[]=[];
 for(const {target,question} of planned){
  const result=await context.client.query(statement('saved_transcription_open','select private.document_transcription_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),question.question]));
  if(result.rows[0]?.id!==null)opened.push(z.uuid().parse(result.rows[0]?.id));
 }
 return opened;
}
