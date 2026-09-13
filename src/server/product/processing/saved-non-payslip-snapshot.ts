import {savedNonPayslipReadings} from './saved-non-payslip-readings';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {savedNonPayslipEvidenceSchema,type SavedNonPayslipEvidence} from '@/engine/extraction/document-evidence/snapshot';
import {DOCUMENT_EVIDENCE_POLICY} from '@/engine/extraction/document-evidence/contracts';
import {validateSavedDocumentEvidence} from '@/server/engine/extraction/saved-document-evidence';
import {loadVerifiedUpload} from '@/server/engine/extraction/verified-upload-source';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';

/** Called only after the ordinary snapshot loader locks/authenticates the
 * current source. Missing OCR is preserved as pending, not a missing file. */
export async function readSavedNonPayslipEvidence(context:PostgresTransactionContext,job:SourceJob,pins:readonly {id:string;version_id:string;sha256:string;type:string}[],journal:unknown,month:string):Promise<SavedNonPayslipEvidence[]>{
 const results:SavedNonPayslipEvidence[]=[];
 for(const p of pins.filter(p=>p.type==='contract'||p.type==='attendance')){
  const rows=await context.client.query(statement('saved_non_payslip_snapshot',
   `select d.*,c.result,c.result_sha256 as checkpoint_result_sha256,c.input_sha256 as checkpoint_input_sha256,
    exists(select 1 from private.case_extraction_invocations i where i.case_id=d.case_id and i.version_id=d.version_id and i.policy_version=$5 and i.input_sha256=d.content_sha256 and i.result is null) has_uncertain_dispatch
    from public.documents d left join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id and c.revision=$4 and c.policy_version=$5
    where d.case_id=$1::uuid and d.id=$2::uuid and d.version_id=$3::uuid and d.content_sha256=$6 and d.document_type::text=$7`,
   [job.case_id,p.id,p.version_id,job.revision,DOCUMENT_EVIDENCE_POLICY,p.sha256,p.type]));
  if(rows.row_count!==1)throw Error('SAVED_NON_PAYSLIP_SOURCE_CHANGED');
  const row=rows.rows[0],loaded=await loadVerifiedUpload(job.case_id,p.version_id,{async query(){return {rows:[row]};}},{async download(){throw Error('SNAPSHOT_EXTERNAL_IO_FORBIDDEN');}});
  if(!row.result){results.push(savedNonPayslipEvidenceSchema.parse({document:loaded.document,product_document_id:p.id,checkpoint_result_sha256:null,provider_receipt_sha256:null,extraction:null,failure_code:row.has_uncertain_dispatch===true?'provider_outcome_pending':'extraction_pending',readings:[]}));continue;}
  const checkpoint=validateSavedDocumentEvidence({checkpoint:row.result,document:loaded.document,productDocumentId:p.id,requiredMonths:[]});
  if(row.checkpoint_input_sha256!==p.sha256||row.checkpoint_result_sha256!==checkpoint.result_sha256)throw Error('SAVED_NON_PAYSLIP_CHECKPOINT_CHANGED');
  const result=checkpoint.run.result,receipt=z.object({receipt_sha256:z.string()}).passthrough().parse(result.provider_receipt);
  results.push(savedNonPayslipEvidenceSchema.parse({document:loaded.document,product_document_id:p.id,checkpoint_result_sha256:checkpoint.result_sha256,provider_receipt_sha256:receipt.receipt_sha256,
   extraction:result.normalized,failure_code:result.status==='completed'?null:'provider_extraction_failed',readings:result.status==='completed'?savedNonPayslipReadings({caseId:job.case_id,month,journal,checkpoint,document:loaded.document,productDocumentId:p.id}):[]}));
 }
 if(new Set(results.map(r=>canonicalSha256(r.document))).size!==results.length)throw Error('SAVED_NON_PAYSLIP_DUPLICATE');
 return results;
}
