import {savedSourceDocumentRoute,savedSourcePeriodEvidence,assertSavedSourcePeriodEvidence} from './saved-source-intake-planning.ts';
import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import type {UploadExtractionStorage} from '@/server/engine/extraction/verified-upload-source';
import type {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';
import {sourceJobSchema,SOURCE_JOB_KIND,type SourceJob} from './source-dispatch';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {savedAnalysisId} from './saved-draft-report';
import {openSavedDocumentFieldRequests} from './saved-field-requests';
import {openSavedJune2026Collection} from './saved-june2026-collection';
import {openSavedTranscriptionRequests} from './saved-transcription-requests';
import {ensureSavedExtractionPromptProvenance} from './saved-extraction-prompt-admission';

type Extraction=Awaited<ReturnType<typeof extractSavedPayslip>>;
export type SavedExtractionLease={jobId:string;workerId:string;fencingToken:number;versionId:string};
import type {SavedWorkerTransactions} from './saved-worker-contracts';
export type {SavedWorkerTransactions} from './saved-worker-contracts';
type Invocation={invocation_id:string;case_id:string;version_id:string;expected_month:string;input_sha256:string;source_revision:number;dispatched_at:string;result:Extraction|null;source_period_evidence?:unknown};
type Admission={job:SourceJob;document:Record<string,unknown>;month:string;requestedMonths:string[];sourcePeriodEvidence:ReturnType<typeof savedSourcePeriodEvidence>};

/** The caller installs its actual machine session for EVERY short transaction.
 * A case/source lock is acquired before the job lock, matching finalization. */
export async function admitSavedExtractionLease(context:PostgresTransactionContext,input:SavedExtractionLease,kinds:readonly ('payslip'|'attendance'|'contract')[]=['payslip']):Promise<Admission>{
 z.string().min(1).parse(input.jobId);z.string().min(1).parse(input.workerId);
 z.number().int().positive().parse(input.fencingToken);z.uuid().parse(input.versionId);
 const read=async(lock:boolean)=>(await context.client.query(statement(lock?'extraction_job_lock':'extraction_job_read',
  `select job_kind,payload,payload_sha256,tenant_id,canonical_case_id,state,lease_owner,fencing_token,
   coalesce(lease_expires_at>clock_timestamp(),false) lease_valid,cancellation_requested
   from public.engine_durable_jobs where job_id=$1${lock?' for update':''}`,[input.jobId]))).rows[0];
 const initial=await read(false);if(!initial)throw new Error('SAVED_JOB_SCOPE');
 const job=sourceJobSchema.parse(initial.payload);
 if(initial.job_kind!==SOURCE_JOB_KIND||initial.tenant_id!==savedCaseTenant(job.case_id)||initial.canonical_case_id!==job.case_id
  ||initial.payload_sha256!==canonicalSha256(job))throw new Error('SAVED_JOB_SCOPE');
 await admitSavedSource(context,job);
 const locked=await read(true);
 if(!locked||locked.payload_sha256!==initial.payload_sha256||canonicalSha256(locked.payload)!==initial.payload_sha256
  ||locked.state!=='running'||locked.lease_owner!==input.workerId||Number(locked.fencing_token)!==input.fencingToken
  ||locked.lease_valid!==true||locked.cancellation_requested!==false)throw new Error('SAVED_JOB_FENCE');
 const orders=await readSavedOrders(context,job);
 const rows=await context.client.query(statement('extraction_pinned_document',
  `select d.*,left(p->>'month',7) pinned_month,left(v.input->>'month',7) journal_month,left(coalesce(p->>'month',v.input->>'month'),7) expected_month
   from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'documents') p
   join public.documents d on d.id=(p->>'id')::uuid and d.version_id=(p->>'version_id')::uuid and d.case_id=v.case_id
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3 and d.version_id=$4::uuid
    and p->>'type'=d.document_type::text and (d.document_type::text in(select jsonb_array_elements_text($5::jsonb)) or $6::boolean) and d.content_sha256=p->>'sha256'`,
  [job.case_id,job.revision,job.input_sha256,input.versionId,JSON.stringify(kinds),job.processing_profile==='qualified_ai_v1'&&kinds.length===1&&kinds[0]==='payslip']));
 if(rows.row_count!==1)throw new Error('SAVED_EXTRACTION_SOURCE_SCOPE');
 const requestedMonths=[...new Set(orders.flatMap(purchasedMonths))].sort();
 const stored=rows.rows[0],payroll=kinds.length===1&&kinds[0]==='payslip';
 let document=stored,selectedMonth=stored.document_type==='payslip'||payroll?stored.expected_month:requestedMonths[0];
 if(job.processing_profile==='qualified_ai_v1'&&orders.some(o=>o.kind==='legacy_initial'&&o.source_period_evidence)&&payroll){
  const route=savedSourceDocumentRoute(orders,{id:z.uuid().parse(stored.id),version_id:input.versionId,sha256:z.string().parse(stored.content_sha256),type:z.string().parse(stored.document_type),month:stored.pinned_month===null?null:z.string().parse(stored.pinned_month)},stored.journal_month===null?null:z.string().parse(stored.journal_month));
  if(route.state!=='ready'||route.kind!=='payslip')throw Error('SAVED_EXTRACTION_SOURCE_INTAKE_REQUIRED');selectedMonth=route.month;
  if(stored.document_type!=='payslip'){
   // Only the exact authenticated reading can select this extractor. This is
   // an invocation-local projection, never an UPDATE of the uploaded source.
   if(!savedSourcePeriodEvidence(orders,{caseId:job.case_id,documentId:z.uuid().parse(stored.id),versionId:input.versionId,sha256:z.string().parse(stored.content_sha256),month:route.month}))throw Error('SAVED_EXTRACTION_SOURCE_INTAKE_REQUIRED');
   document={...stored,stored_document_type:stored.document_type,document_type:'payslip'};
  }
 }
 if(!kinds.includes(document.document_type as 'payslip'|'attendance'|'contract'))throw Error('SAVED_EXTRACTION_SOURCE_SCOPE');
 const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).parse(selectedMonth);
 const sourcePeriodEvidence=job.processing_profile==='qualified_ai_v1'&&document.document_type==='payslip'?savedSourcePeriodEvidence(orders,{caseId:job.case_id,documentId:z.uuid().parse(document.id),versionId:input.versionId,sha256:z.string().parse(document.content_sha256),month}):null;
 if(!orders.some(order=>purchasedMonths(order).includes(month)))throw new Error('SAVED_EXTRACTION_UNPURCHASED_MONTH');
 return {job,document,month,requestedMonths,sourcePeriodEvidence};
}
const admit=admitSavedExtractionLease;

function validateResult(invocation:Pick<Invocation,'case_id'|'version_id'|'expected_month'|'input_sha256'>,result:Extraction){
 if(result.schema_version!=='tivdoc-saved-extraction-v1'||result.case_id!==invocation.case_id||result.version_id!==invocation.version_id
  ||result.expected_month!==invocation.expected_month||result.input_sha256!==invocation.input_sha256
  ||result.run.result.final_extraction.document_id!==invocation.version_id
  ||canonicalSha256(result.run.result)!==result.result_sha256)throw new Error('SAVED_EXTRACTION_RECEIPT_SCOPE');
}

async function prepare(context:PostgresTransactionContext,input:SavedExtractionLease&{receiptOnly?:boolean}){
 const admitted=await admit(context,input),{job,month,document}=admitted,invocationId=randomUUID();
 const contentHash=z.string().regex(/^[a-f0-9]{64}$/).parse(document.content_sha256);
 const cached=await context.client.query(statement('extraction_existing_checkpoint',
  `select result from private.case_extraction_checkpoints where case_id=$1::uuid and version_id=$2::uuid
   and policy_version=$3 and input_sha256=$4 and result->>'expected_month'=$5 order by revision desc limit 1`,
  [job.case_id,input.versionId,SAVED_EXTRACTION_POLICY,contentHash,month]));
 if(cached.rows[0]){
  const checkpoint=cached.rows[0].result as Extraction;
  validateResult({case_id:job.case_id,version_id:input.versionId,expected_month:month,input_sha256:contentHash},checkpoint);
  return {...admitted,invocation:null,checkpoint,reused:true};
 }
 if(input.receiptOnly){
  const existing=await context.client.query(statement('extraction_saved_receipt_only',
   'select * from private.case_extraction_invocations where case_id=$1::uuid and version_id=$2::uuid and policy_version=$3 and expected_month=$4',
   [job.case_id,input.versionId,SAVED_EXTRACTION_POLICY,month]));
  const invocation=existing.rows[0] as Invocation|undefined;
  if(!invocation?.result)throw Error('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  validateResult({case_id:job.case_id,version_id:input.versionId,expected_month:month,input_sha256:contentHash},invocation.result);
  return {...admitted,invocation,checkpoint:null,reused:true};
 }
 const inserted=await context.client.query(statement('extraction_dispatch_once',
  `insert into private.case_extraction_invocations(invocation_id,case_id,version_id,policy_version,expected_month,input_sha256,source_revision,job_id,fencing_token,source_period_evidence)
   select $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$11::jsonb from public.engine_durable_jobs j
   where j.job_id=$8 and j.lease_owner=$10 and j.fencing_token=$9 and j.state='running'
    and not j.cancellation_requested and j.lease_expires_at>clock_timestamp()
   on conflict(case_id,version_id,policy_version,expected_month) do nothing returning invocation_id`,
  [invocationId,job.case_id,input.versionId,SAVED_EXTRACTION_POLICY,month,contentHash,job.revision,input.jobId,input.fencingToken,input.workerId,admitted.sourcePeriodEvidence===null?null:JSON.stringify(admitted.sourcePeriodEvidence)]));
 const rows=await context.client.query(statement('extraction_invocation_read',
  `select * from private.case_extraction_invocations where case_id=$1::uuid and version_id=$2::uuid and policy_version=$3 and expected_month=$4`,
  [job.case_id,input.versionId,SAVED_EXTRACTION_POLICY,month]));
 const invocation=rows.rows[0] as Invocation|undefined;
 if(!invocation)throw new Error('SAVED_JOB_FENCE');
 if(invocation.input_sha256!==document.content_sha256)throw new Error('SAVED_EXTRACTION_RECEIPT_SCOPE');
 if(inserted.row_count===0&&invocation.result===null)throw new Error('SAVED_EXTRACTION_OUTCOME_PENDING');
 if(invocation.result!==null)validateResult(invocation,invocation.result);
 return {...admitted,invocation,checkpoint:null,reused:inserted.row_count===0};
}

/** Save a late provider receipt even if the job/source moved meanwhile. This
 * records evidence only; current source, payment and fence gate checkpointing.
 * It can be retried after an uncertain DB commit without another provider call. */
export async function recordSavedExtractionResult(context:PostgresTransactionContext,invocationId:string,result:Extraction){
 z.uuid().parse(invocationId);
 const authority=await context.client.query(statement('extraction_receipt_authority',
  "select private.runtime_verified_tenant() tenant_id,session_user::text principal",[]));
 if(authority.rows[0]?.principal!=='tivdoc_worker_runtime'||authority.rows[0]?.tenant_id!==savedCaseTenant(result.case_id))throw new Error('SAVED_WORKER_SCOPE_FORBIDDEN');
 const rows=await context.client.query(statement('extraction_receipt_lock',
  'select * from private.case_extraction_invocations where invocation_id=$1::uuid for update',[invocationId]));
 const invocation=rows.rows[0] as Invocation|undefined;
 if(!invocation)throw new Error('SAVED_EXTRACTION_RECEIPT_SCOPE');validateResult(invocation,result);
 const sourcePeriodEvidence=invocation.source_period_evidence==null?null:assertSavedSourcePeriodEvidence(invocation.source_period_evidence,{caseId:invocation.case_id,documentId:result.product_document_id,versionId:invocation.version_id,sha256:invocation.input_sha256,month:invocation.expected_month});
 const source=await context.client.query(statement('extraction_receipt_source',
  `select 1 from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'documents') d
   where v.case_id=$1::uuid and v.revision=$2 and d->>'id'=$3 and d->>'version_id'=$4
    and d->>'sha256'=$5 and (d->>'type'='payslip' or $7::boolean) and (left(coalesce(d->>'month',v.input->>'month'),7)=$6 or ($7::boolean and d->>'month' is null))`,
  [invocation.case_id,invocation.source_revision,result.product_document_id,invocation.version_id,invocation.input_sha256,invocation.expected_month,sourcePeriodEvidence!==null]));
 if(source.row_count!==1)throw new Error('SAVED_EXTRACTION_RECEIPT_SCOPE');
 if(invocation.result!==null){
  if(canonicalSha256(invocation.result)!==canonicalSha256(result))throw new Error('SAVED_EXTRACTION_RECEIPT_IMMUTABLE');
  return;
 }
 const updated=await context.client.query(statement('extraction_receipt_record',
  `update private.case_extraction_invocations set result=$2::jsonb,result_sha256=$3,recorded_at=clock_timestamp()
   where invocation_id=$1::uuid and result is null returning invocation_id`,[invocationId,JSON.stringify(result),result.result_sha256]));
 if(updated.row_count!==1)throw new Error('SAVED_EXTRACTION_RECEIPT_UNAVAILABLE');
}

/** No external I/O runs inside a database transaction. Once dispatched, an
 * unknown provider outcome stops automatic repeats for this immutable input.
 * Recovered receipts are reusable across source revisions with the same file,
 * month and extraction policy. No customer publication or job completion here. */
export async function runSavedWorkerExtraction(input:SavedExtractionLease&{
 transactions:SavedWorkerTransactions;storage:UploadExtractionStorage;providerEnabled:boolean;receiptOnly?:boolean;extractor?:OpenAiPayslipV2PassExtractor;
 promptDerivationAudit?:{codeRevision:string;createdAt:string};
}){
 if(!input.receiptOnly&&!input.providerEnabled)throw new Error('SAVED_EXTRACTION_PROVIDER_DISABLED');
 if(!input.receiptOnly&&!input.extractor&&!process.env.OPENAI_API_KEY?.trim())throw new Error('SAVED_EXTRACTION_PROVIDER_UNCONFIGURED');
 const prepared=await input.transactions(context=>prepare(context,input));
 let result=prepared.checkpoint??prepared.invocation?.result??null;
 if(result===null){
  if(input.receiptOnly)throw Error('SAVED_EXTRACTION_RECEIPT_REQUIRED');
  const invocation=prepared.invocation;
  if(!invocation)throw new Error('SAVED_EXTRACTION_RECEIPT_UNAVAILABLE');
  const seed=canonicalSha256({invocation_id:invocation.invocation_id,policy:SAVED_EXTRACTION_POLICY});
  const snapshotId=savedAnalysisId('saved-extraction-snapshot',seed);
  result=await extractSavedPayslip({caseId:prepared.job.case_id,versionId:input.versionId,expectedMonth:prepared.month,
   context:{snapshot_id:snapshotId,case_id:prepared.job.case_id,analysis_run_id:savedAnalysisId('saved-extraction-run',seed),schema_version:'1.0.0',
    created_at:new Date(prepared.invocation.dispatched_at).toISOString(),
    fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,savedAnalysisId(`saved-extraction-fact:${path}`,seed)]))},
   // This server-owned immutable metadata was admitted before dispatch. Byte
   // download/rehash still happens in the existing extraction adapter.
   db:{async query(){return {rows:[prepared.document]};}},storage:input.storage,extractor:input.extractor});
  const received=result;
  await input.transactions(context=>recordSavedExtractionResult(context,invocation.invocation_id,received));
 }
 const receipt=result;
 const checkpoint=await input.transactions(async context=>{
  const current=await admit(context,input);
  if(current.document.content_sha256!==receipt.input_sha256||current.month!==receipt.expected_month)throw new Error('SAVED_EXTRACTION_SOURCE_SCOPE');
  const saved=await saveExtractionCheckpoint(context,current.job,receipt);
  // Explicit, audited recovery of a known historical wrapper defect. A normal
  // receipt never needs this and no provider output is rewritten or retried.
  if(input.promptDerivationAudit)await ensureSavedExtractionPromptProvenance(context,current.job,saved.result,input.promptDerivationAudit);
  await openSavedDocumentFieldRequests(context,current.job,saved.result);
  // Qualified reviews collect factual dependencies through the ordinary review
  // pipeline. The historical June collection requires its own modern-order scope.
  if(current.job.processing_profile!=='qualified_ai_v1'){
   await openSavedJune2026Collection(context,current.job,saved.result);
   await openSavedTranscriptionRequests(context,current.job,saved.result);
  }
  return saved;
 });
 return {invocationId:prepared.invocation?.invocation_id??null,reused:prepared.reused,result:checkpoint.result};
}
