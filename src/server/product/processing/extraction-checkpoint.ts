import {readSavedOrders} from './saved-order-scope.ts';
import {savedSourceDocumentRoute,savedSourcePeriodEvidence} from './saved-source-intake-planning.ts';
import { z } from 'zod';
import { canonicalSha256 } from '@/engine/rule-runtime/canonical';
import { statement, type PostgresTransactionContext } from '@/server/platform/persistence/postgres/contracts';
import { lockCurrentSource, type SourceJob } from './source-dispatch';
import { SAVED_EXTRACTION_POLICY } from './saved-snapshot';
import type { extractSavedPayslip } from '@/server/engine/extraction/saved-payslip';

type Result=Awaited<ReturnType<typeof extractSavedPayslip>>;
/** External extraction runs outside this transaction. Racing workers may spend
 * twice, but the first immutable checkpoint wins; neither replaces its result.
 * A changed source rolls back the insert and cannot reach analysis completion. */
export async function saveExtractionCheckpoint(context:PostgresTransactionContext,job:SourceJob,result:Result){
 await lockCurrentSource(context,job);
 z.uuid().parse(result.version_id);
 if(result.case_id!==job.case_id||canonicalSha256(result.run.result)!==result.result_sha256)throw new Error('EXTRACTION_CHECKPOINT_SCOPE');
 const source=await context.client.query(statement('checkpoint_source_match',
  `select 1 from private.case_input_versions v
   cross join lateral jsonb_array_elements(v.input->'documents') d
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3
    and d->>'id'=$4 and d->>'version_id'=$5 and d->>'sha256'=$6 and d->>'type'='payslip'
    and left(coalesce(d->>'month',v.input->>'month'),7)=$7`,
  [job.case_id,job.revision,job.input_sha256,result.product_document_id,result.version_id,result.input_sha256,result.expected_month]));
 if(source.row_count!==1){
  if(job.processing_profile!=='qualified_ai_v1')throw new Error('EXTRACTION_CHECKPOINT_SOURCE_MISMATCH');
  const fallback=await context.client.query(statement('checkpoint_intake_source',
   `select d->>'type' document_type,left(d->>'month',7) month,left(v.input->>'month',7) journal_month from private.case_input_versions v
    cross join lateral jsonb_array_elements(v.input->'documents') d
    where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3 and d->>'id'=$4 and d->>'version_id'=$5
     and d->>'sha256'=$6`,
   [job.case_id,job.revision,job.input_sha256,result.product_document_id,result.version_id,result.input_sha256]));
  if(fallback.row_count!==1)throw new Error('EXTRACTION_CHECKPOINT_SOURCE_MISMATCH');
  const orders=await readSavedOrders(context,job),route=savedSourceDocumentRoute(orders,{id:result.product_document_id,version_id:result.version_id,sha256:result.input_sha256,type:z.string().parse(fallback.rows[0].document_type),month:z.string().nullable().parse(fallback.rows[0].month)},z.string().nullable().parse(fallback.rows[0].journal_month));
  if(route.state!=='ready'||route.month!==result.expected_month||!savedSourcePeriodEvidence(orders,{caseId:job.case_id,documentId:result.product_document_id,versionId:result.version_id,sha256:result.input_sha256,month:result.expected_month}))throw new Error('EXTRACTION_CHECKPOINT_SOURCE_MISMATCH');
 }
 await context.client.query(statement('checkpoint_insert',
  `insert into private.case_extraction_checkpoints(case_id,revision,version_id,input_sha256,policy_version,result_sha256,result)
   values($1::uuid,$2,$3::uuid,$4,$5,$6,$7::jsonb)
   on conflict(case_id,revision,version_id,policy_version) do nothing`,
  [job.case_id,job.revision,result.version_id,result.input_sha256,SAVED_EXTRACTION_POLICY,result.result_sha256,JSON.stringify(result)]));
 const saved=await context.client.query(statement('checkpoint_read',
  `select result,input_sha256,result_sha256 from private.case_extraction_checkpoints
   where case_id=$1::uuid and revision=$2 and version_id=$3::uuid and policy_version=$4`,
  [job.case_id,job.revision,result.version_id,SAVED_EXTRACTION_POLICY]));
 if(saved.row_count!==1||saved.rows[0].input_sha256!==result.input_sha256)throw new Error('EXTRACTION_CHECKPOINT_UNAVAILABLE');
 return {result:saved.rows[0].result,reused:saved.rows[0].result_sha256!==result.result_sha256};
}
