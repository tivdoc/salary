import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_EVIDENCE_POLICY} from '@/engine/extraction/document-evidence/contracts';
import {extractSavedDocumentEvidence,savedDocumentEvidenceSchema,validateSavedDocumentEvidence} from '@/server/engine/extraction/saved-document-evidence';
import {loadVerifiedUpload,type UploadExtractionStorage} from '@/server/engine/extraction/verified-upload-source';
import type {DocumentEvidenceExtractor} from '@/server/engine/extraction/providers/openai/document-evidence-adapter';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedExtractionLease,type SavedExtractionLease,type SavedWorkerTransactions} from './saved-extraction-worker';
import {savedCaseTenant} from './saved-admission';
import {savedAnalysisId} from './saved-draft-report';

type Result=z.infer<typeof savedDocumentEvidenceSchema>;
type Invocation={invocation_id:string;case_id:string;version_id:string;expected_month:string;input_sha256:string;source_revision:number;dispatched_at:string;result:Result|null};
const noDownload:UploadExtractionStorage={async download(){throw Error('DOCUMENT_EVIDENCE_REPLAY_DOWNLOAD_FORBIDDEN');}};
async function validate(document:Record<string,unknown>,candidate:unknown){
 const result=savedDocumentEvidenceSchema.parse(candidate);
 const loaded=await loadVerifiedUpload(result.case_id,result.version_id,{async query(){return {rows:[document]};}},noDownload);
 // requested_months records the original invocation context only. Current
 // purchase/period scope is selected afresh by the analysis, never by OCR.
 return validateSavedDocumentEvidence({checkpoint:result,document:loaded.document,productDocumentId:loaded.productDocumentId,requiredMonths:[]});
}
function invocationScope(i:Invocation,r:Result){
 if(i.case_id!==r.case_id||i.version_id!==r.version_id||i.input_sha256!==r.input_sha256||i.expected_month!==r.dispatch_month)throw Error('DOCUMENT_EVIDENCE_INVOCATION_SCOPE');
}
async function prepare(context:PostgresTransactionContext,input:SavedExtractionLease,receiptOnly:boolean){
 const a=await admitSavedExtractionLease(context,input,['attendance','contract']);
 const contentHash=z.string().regex(/^[a-f0-9]{64}$/u).parse(a.document.content_sha256);
 // File + policy identity is independent of purchased month. Never re-read a
 // contract because an order later adds another month of the same source.
 const cached=await context.client.query(statement('document_evidence_cached',
  `select result from private.case_extraction_checkpoints where case_id=$1::uuid and version_id=$2::uuid
   and input_sha256=$3 and policy_version=$4 order by revision desc limit 1`,[a.job.case_id,input.versionId,contentHash,DOCUMENT_EVIDENCE_POLICY]));
 if(cached.rows[0])return {...a,invocation:null,result:await validate(a.document,cached.rows[0].result),reused:true};
 // Serialize dispatches for a version, including two simultaneous jobs whose
 // earliest purchased month differs. Existing job/source fences still apply.
 await context.client.query(statement('document_evidence_dispatch_lock','select pg_advisory_xact_lock(hashtextextended($1,0))',[`document-evidence:${a.job.case_id}:${input.versionId}`]));
 const read=async()=>(await context.client.query(statement('document_evidence_invocation_read',
  'select * from private.case_extraction_invocations where case_id=$1::uuid and version_id=$2::uuid and policy_version=$3 order by dispatched_at limit 1',
  [a.job.case_id,input.versionId,DOCUMENT_EVIDENCE_POLICY]))).rows[0] as Invocation|undefined;
 let invocation=await read();let reused=true;
 if(!invocation){
  if(receiptOnly)throw Error('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  const id=randomUUID();
  await context.client.query(statement('document_evidence_dispatch_once',
   `insert into private.case_extraction_invocations(invocation_id,case_id,version_id,policy_version,expected_month,input_sha256,source_revision,job_id,fencing_token)
    values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9)`,
   [id,a.job.case_id,input.versionId,DOCUMENT_EVIDENCE_POLICY,a.month,contentHash,a.job.revision,input.jobId,input.fencingToken]));
  invocation=await read();reused=false;
 }
 if(!invocation||invocation.input_sha256!==a.document.content_sha256)throw Error('DOCUMENT_EVIDENCE_INVOCATION_SCOPE');
 if(reused&&!invocation.result)throw Error('SAVED_EXTRACTION_OUTCOME_PENDING');
 const result=invocation.result?await validate(a.document,invocation.result):null;
 if(result)invocationScope(invocation,result);
 return {...a,invocation,result,reused};
}

/** A late receipt is evidence, not authorization to finalize stale work. */
export async function recordSavedDocumentEvidenceResult(context:PostgresTransactionContext,invocationId:string,candidate:unknown){
 const r=savedDocumentEvidenceSchema.parse(candidate);z.uuid().parse(invocationId);
 const auth=await context.client.query(statement('document_evidence_receipt_authority','select private.runtime_verified_tenant() tenant_id,session_user::text principal',[]));
 if(auth.rows[0]?.principal!=='tivdoc_worker_runtime'||auth.rows[0]?.tenant_id!==savedCaseTenant(r.case_id))throw Error('SAVED_WORKER_SCOPE_FORBIDDEN');
 const row=(await context.client.query(statement('document_evidence_receipt_lock','select * from private.case_extraction_invocations where invocation_id=$1::uuid and policy_version=$2 for update',[invocationId,DOCUMENT_EVIDENCE_POLICY]))).rows[0] as Invocation|undefined;
 if(!row)throw Error('DOCUMENT_EVIDENCE_INVOCATION_SCOPE');invocationScope(row,r);
 const source=await context.client.query(statement('document_evidence_receipt_source',
  'select private.document_evidence_receipt_source($1::uuid) as source',[invocationId]));
 // The invocation-scoped helper combines immutable dispatch hash/type with
 // exact current OR retained version metadata. This admits late evidence only;
 // finalization below still requires the current source and active job lease.
 const metadata=z.record(z.string(),z.unknown()).safeParse(source.rows[0]?.source);
 if(source.row_count!==1||!metadata.success)throw Error('DOCUMENT_EVIDENCE_RECEIPT_SOURCE');await validate(metadata.data,r);
 if(row.result){if(canonicalSha256(row.result)!==canonicalSha256(r))throw Error('SAVED_EXTRACTION_RECEIPT_IMMUTABLE');return;}
 const write=await context.client.query(statement('document_evidence_receipt_record',
  'update private.case_extraction_invocations set result=$2::jsonb,result_sha256=$3,recorded_at=clock_timestamp() where invocation_id=$1::uuid and result is null returning invocation_id',
  [invocationId,JSON.stringify(r),r.result_sha256]));
 if(write.row_count!==1)throw Error('SAVED_EXTRACTION_RECEIPT_UNAVAILABLE');
}

export async function runSavedWorkerDocumentEvidence(input:SavedExtractionLease&{transactions:SavedWorkerTransactions;storage:UploadExtractionStorage;providerEnabled:boolean;receiptOnly?:boolean;extractor?:DocumentEvidenceExtractor}){
 const configured=input.providerEnabled&&!!input.extractor;
 const prepared=await input.transactions(c=>prepare(c,input,!!input.receiptOnly||!configured)).catch(error=>{
  if(!configured&&!input.receiptOnly&&error instanceof Error&&error.message==='SAVED_EXTRACTION_RECEIPT_REQUIRED')throw Error('DOCUMENT_EVIDENCE_PROVIDER_UNCONFIGURED');
  throw error;
 });
 let r=prepared.result;
 if(!r){
  const invocation=prepared.invocation;if(!invocation||!input.extractor)throw Error('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  const seed=canonicalSha256({invocation_id:invocation.invocation_id,policy:DOCUMENT_EVIDENCE_POLICY});
  r=await extractSavedDocumentEvidence({caseId:prepared.job.case_id,versionId:input.versionId,requestedMonths:prepared.requestedMonths,
   analysisRunId:savedAnalysisId('document-evidence-run',seed),extractionId:savedAnalysisId('document-evidence-extraction',seed),createdAt:new Date(invocation.dispatched_at).toISOString(),
   db:{async query(){return {rows:[prepared.document]};}},storage:input.storage,extractor:input.extractor});
  const received=r;await input.transactions(c=>recordSavedDocumentEvidenceResult(c,invocation.invocation_id,received));
 }
 const receipt=r;
 await input.transactions(async c=>{
  const current=await admitSavedExtractionLease(c,input,['attendance','contract']);await validate(current.document,receipt);
  await c.client.query(statement('document_evidence_checkpoint_insert',
   `insert into private.case_extraction_checkpoints(case_id,revision,version_id,input_sha256,policy_version,result_sha256,result)
    values($1::uuid,$2,$3::uuid,$4,$5,$6,$7::jsonb) on conflict(case_id,revision,version_id,policy_version) do nothing`,
   [current.job.case_id,current.job.revision,input.versionId,receipt.input_sha256,DOCUMENT_EVIDENCE_POLICY,receipt.result_sha256,JSON.stringify(receipt)]));
  const saved=(await c.client.query(statement('document_evidence_checkpoint_read','select result from private.case_extraction_checkpoints where case_id=$1::uuid and revision=$2 and version_id=$3::uuid and policy_version=$4',[current.job.case_id,current.job.revision,input.versionId,DOCUMENT_EVIDENCE_POLICY]))).rows[0];
  if(!saved||canonicalSha256(saved.result)!==canonicalSha256(receipt))throw Error('DOCUMENT_EVIDENCE_CHECKPOINT_IMMUTABLE');
 });
 return {invocationId:prepared.invocation?.invocation_id??null,reused:prepared.reused,result:receipt};
}
