import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {PAYSLIP_FINANCIAL_SOURCE_POLICY,type PayslipFinancialSourceProof,type RetainedUnresolvedPayslipFields} from '@/engine/document-review/payslip-adapter';
import {z} from 'zod';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {payslipMachineExtractionSha256,hasPayslipReadingAnnotations} from '@/engine/extraction/reading-resolution';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {readAdmittedSavedExtractionProvenance} from './saved-extraction-prompt-admission';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {SourceJob} from './source-dispatch';

/** Physical source metadata is server recorded after reading the original
 * bytes. It proves coverage of the uploaded file, not authenticity/completeness
 * of the document before upload or correctness of any provider observation. */
export async function savedReviewFinancialSourceProofs(context:PostgresTransactionContext,job:SourceJob,snapshot:StoredCaseInputSnapshot):Promise<readonly PayslipFinancialSourceProof[]>{
 return (await savedReviewSourceEvidence(context,job,snapshot)).proofs;
}

export async function savedReviewSourceEvidence(context:PostgresTransactionContext,job:SourceJob,snapshot:StoredCaseInputSnapshot){
 const proofs:PayslipFinancialSourceProof[]=[],retained:RetainedUnresolvedPayslipFields[]=[];
 for(const document of snapshot.documents){
  const rows=await context.client.query(statement('review_financial_source_proof',
   `select c.result,c.result_sha256 from private.case_extraction_checkpoints c
    join private.case_input_versions v on v.case_id=c.case_id and v.revision=c.revision
    where c.case_id=$1::uuid and c.revision=$2 and v.input_sha256=$3 and c.version_id=$4::uuid and c.policy_version=$5`,
   [job.case_id,job.revision,job.input_sha256,document.document_id,SAVED_EXTRACTION_POLICY]));
  if(rows.row_count!==1)throw Error('REVIEW_SOURCE_PROOF_CHECKPOINT');
  const row=rows.rows[0],provenance=await readAdmittedSavedExtractionProvenance(context,job,row.result);
  if(provenance.checkpointResultSha256!==row.result_sha256)throw Error('REVIEW_SOURCE_PROOF_HASH');
  const checkpoint=z.object({run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema,
   first_pass:z.object({normalized_extraction:normalizedPayslipExtractionSchema}).passthrough().optional()}).passthrough()})}).parse(row.result);
  const machine=checkpoint.run.result.final_extraction;
  if(hasPayslipReadingAnnotations(machine))throw Error('REVIEW_SOURCE_PROVIDER_READINGS_FORBIDDEN');
  const pinned=snapshot.extractions.find(e=>e.document_id===document.document_id);
  if(!pinned||payslipMachineExtractionSha256(pinned)!==canonicalSha256(machine))throw Error('REVIEW_SOURCE_SNAPSHOT_BINDING');
  if(checkpoint.run.result.first_pass)retained.push({case_id:job.case_id,document_id:document.document_id,source_sha256:document.content_sha256,
   checkpoint_result_sha256:row.result_sha256 as string,checkpoint_result:checkpoint.run.result,final_extraction_sha256:canonicalSha256(machine),first_pass:checkpoint.run.result.first_pass.normalized_extraction});
  // Historical or injected observations remain usable with their own origin,
  // but cannot establish this live-source completion policy.
  if(provenance.kind!=='openai_live'||!provenance.allPassesSucceeded)continue;
  const first=provenance.receipts.find(r=>r.pass_kind==='first_pass');
  if(!first?.source_page_count||!first.request_sha256||!first.provider_response_id)continue;
  if(first.case_id!==job.case_id||first.document_id!==document.document_id||first.source_sha256!==document.content_sha256
   ||first.source_size_bytes!==document.size_bytes||first.source_mime_type!==document.mime_type)throw Error('REVIEW_SOURCE_PROOF_BINDING');
  proofs.push({policy_version:PAYSLIP_FINANCIAL_SOURCE_POLICY,case_id:job.case_id,document_id:document.document_id,
   source_sha256:document.content_sha256,normalized_extraction_sha256:canonicalSha256(checkpoint.run.result.final_extraction),
   provider_receipt_sha256:first.receipt_sha256,source_page_count:first.source_page_count,complete_original_source:true});
 }
 return {proofs,retained};
}
