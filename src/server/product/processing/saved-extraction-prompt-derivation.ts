import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {payslipExtractionV21ResultSchema} from '@/engine/extraction/v21';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import type {SavedExtractionProvenance} from './live-extraction-provenance';

export const SAVED_EXTRACTION_PROMPT_DERIVATION_POLICY='saved-payslip-v21-prompt-receipt-derivation-v1' as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),version_id:z.uuid(),
 input_sha256:hash,result_sha256:hash,run:z.object({result:payslipExtractionV21ResultSchema,
  snapshot:employmentSnapshotSchema.nullable().optional(),provider_receipts:z.array(z.unknown()).length(1)}).passthrough()}).passthrough();
const auditSchema=z.object({originalCheckpointSha256:hash,codeRevision:z.string().regex(/^[a-f0-9]{40}$/u),createdAt:z.iso.datetime({offset:true})}).strict();

/** Repairs only an orchestration prompt label, never raw provider content or
 * extraction/fact decisions. The caller must persist the proof append-only and
 * retain the original checkpoint as the source binding. readStrict must be the
 * unchanged complete provenance verifier, not a fallback that calls this function. */
export function deriveSavedExtractionPromptCheckpoint(input:unknown,audit:z.infer<typeof auditSchema>,
 readStrict:(checkpoint:unknown)=>SavedExtractionProvenance){
 const context=auditSchema.parse(audit),original=checkpointSchema.parse(input);
 if(canonicalSha256(input)!==context.originalCheckpointSha256||canonicalSha256(original)!==context.originalCheckpointSha256
  ||canonicalSha256(original.run.result)!==original.result_sha256)throw Error('EXTRACTION_PROMPT_DERIVATION_PARENT');
 const result=original.run.result,receipt=parseOpenAiProviderReceipt(original.run.provider_receipts[0]);
 if(result.first_pass.kind!=='first_pass'||result.recovery_passes.length!==0||receipt.pass_kind!=='first_pass'
  ||receipt.status!=='completed'||receipt.prompt_version!=='payslip-extraction-openai-v2-first-r8-fp1'
  ||result.first_pass.prompt_version!=='payslip-extraction-openai-v2-first-r8')throw Error('EXTRACTION_PROMPT_DERIVATION_NOT_APPLICABLE');
 const derived=structuredClone(original);
 derived.run.result.first_pass.prompt_version=receipt.prompt_version;
 derived.result_sha256=canonicalSha256(derived.run.result);
 // Source, case, pass IDs, raw bytes, model, operation, token usage, timestamps,
 // page count and snapshot/run fences still run, without accepting an alias.
 const provenance=readStrict(derived);
 if(provenance.checkpointResultSha256!==derived.result_sha256||provenance.receipts.length!==1
  ||canonicalSha256(provenance.receipts[0])!==canonicalSha256(receipt))throw Error('EXTRACTION_PROMPT_DERIVATION_VERIFIER');
 const body={policy_version:SAVED_EXTRACTION_PROMPT_DERIVATION_POLICY,case_id:original.case_id,version_id:original.version_id,
  source_sha256:original.input_sha256,original_checkpoint_sha256:context.originalCheckpointSha256,
  original_result_sha256:original.result_sha256,derived_checkpoint_sha256:canonicalSha256(derived),derived_result_sha256:derived.result_sha256,
  provider_receipt_sha256:receipt.receipt_sha256,raw_extraction_sha256:receipt.raw_extraction_sha256,
  original_prompt_version:result.first_pass.prompt_version,provider_prompt_version:receipt.prompt_version,
  origin:receipt.origin,code_revision:context.codeRevision,created_at:context.createdAt,
  provider_calls:0 as const,changed_paths:['run.result.first_pass.prompt_version','result_sha256'] as const};
 return deepFreeze({derivedCheckpoint:derived,receipt:{...body,receipt_sha256:canonicalSha256(body)}});
}
