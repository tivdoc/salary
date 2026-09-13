import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {readSavedExtractionProvenance,type SavedExtractionProvenance} from './live-extraction-provenance';
import {deriveSavedExtractionPromptCheckpoint} from './saved-extraction-prompt-derivation';

type DerivationReceipt=ReturnType<typeof deriveSavedExtractionPromptCheckpoint>['receipt'];
export type AdmittedSavedExtractionProvenance=SavedExtractionProvenance & Readonly<{promptBindingDerivation?:DerivationReceipt}>;
export type SavedExtractionPromptAudit=Readonly<{codeRevision:string;createdAt:string}>;
const auditSchema=z.object({codeRevision:z.string().regex(/^[a-f0-9]{40}$/u),createdAt:z.iso.datetime({offset:true})}).strict();
const scopeSchema=z.object({case_id:z.uuid(),version_id:z.uuid(),result_sha256:z.string().regex(/^[a-f0-9]{64}$/u)});
const storedAuditSchema=z.object({code_revision:z.string().regex(/^[a-f0-9]{40}$/u),created_at:z.iso.datetime({offset:true})});

function inspect(jobInput:SourceJob,checkpoint:unknown){
 const job=sourceJobSchema.parse(jobInput),scope=scopeSchema.parse(checkpoint);
 if(scope.case_id!==job.case_id)throw Error('EXTRACTION_PROMPT_ADMISSION_SCOPE');
 const checkpointSha256=canonicalSha256(checkpoint);
 try{return {job,scope,checkpointSha256,strict:readSavedExtractionProvenance(checkpoint)};}
 catch(error){
  if(!(error instanceof Error)||error.message!=='LIVE_EXTRACTION_RECEIPT_BINDING')throw error;
  return {job,scope,checkpointSha256,strict:null};
 }
}
function verifiedStored(checkpoint:unknown,checkpointSha256:string,stored:unknown):AdmittedSavedExtractionProvenance{
 const metadata=storedAuditSchema.parse(stored);
 const derived=deriveSavedExtractionPromptCheckpoint(checkpoint,{originalCheckpointSha256:checkpointSha256,
  codeRevision:metadata.code_revision,createdAt:metadata.created_at},readSavedExtractionProvenance);
 if(canonicalSha256(stored)!==canonicalSha256(derived.receipt))throw Error('EXTRACTION_PROMPT_ADMISSION_RECEIPT');
 const provenance=readSavedExtractionProvenance(derived.derivedCheckpoint);
 return deepFreeze({...provenance,checkpointResultSha256:derived.receipt.original_result_sha256,promptBindingDerivation:derived.receipt});
}
async function get(context:PostgresTransactionContext,scope:ReturnType<typeof inspect>){
 const result=await context.client.query(statement('extraction_prompt_derivation_get',
  'select private.extraction_prompt_derivation_get($1::uuid,$2::integer,$3::uuid,$4::text) as receipt',
  [scope.job.case_id,scope.job.revision,scope.scope.version_id,scope.checkpointSha256]));
 if(result.row_count!==1||result.rows.length!==1||!Object.hasOwn(result.rows[0],'receipt'))throw Error('EXTRACTION_PROMPT_ADMISSION_READ');
 return result.rows[0].receipt;
}

/** Pure read boundary: never creates an admission. All unchanged checkpoints use
 * the existing strict verifier; the one known mismatch requires a stored proof. */
export async function readAdmittedSavedExtractionProvenance(context:PostgresTransactionContext,job:SourceJob,checkpoint:unknown):Promise<AdmittedSavedExtractionProvenance>{
 const scope=inspect(job,checkpoint);if(scope.strict)return scope.strict;
 const stored=await get(context,scope);
 if(stored===null||stored===undefined)throw Error('EXTRACTION_PROMPT_DERIVATION_NOT_ADMITTED');
 return verifiedStored(checkpoint,scope.checkpointSha256,stored);
}

/** Same caller transaction and verified-worker DB boundary. Admission is append
 * only and scoped to the exact existing checkpoint. Racing puts return the first
 * immutable receipt, which is independently verified with its original audit time. */
export async function ensureSavedExtractionPromptProvenance(context:PostgresTransactionContext,job:SourceJob,checkpoint:unknown,audit:SavedExtractionPromptAudit):Promise<AdmittedSavedExtractionProvenance>{
 const scope=inspect(job,checkpoint);if(scope.strict)return scope.strict;
 const stored=await get(context,scope);
 if(stored!==null&&stored!==undefined)return verifiedStored(checkpoint,scope.checkpointSha256,stored);
 const metadata=auditSchema.parse(audit);
 const proposed=deriveSavedExtractionPromptCheckpoint(checkpoint,{originalCheckpointSha256:scope.checkpointSha256,...metadata},readSavedExtractionProvenance);
 const result=await context.client.query(statement('extraction_prompt_derivation_put',
  'select private.extraction_prompt_derivation_put($1::uuid,$2::integer,$3::uuid,$4::text,$5::jsonb) as receipt',
  [scope.job.case_id,scope.job.revision,scope.scope.version_id,scope.checkpointSha256,JSON.stringify(proposed.receipt)]));
 if(result.row_count!==1||result.rows.length!==1||result.rows[0].receipt==null)throw Error('EXTRACTION_PROMPT_ADMISSION_WRITE');
 return verifiedStored(checkpoint,scope.checkpointSha256,result.rows[0].receipt);
}
