import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CaseAnalysisService} from '@/engine/case-analysis/service';
import {June2026ReviewCatalog} from '@/engine/legal-operations/june2026-catalog';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {CaseAnalysisCommand} from '@/engine/wave3/contracts';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,sourceJobSchema,type SourceJob} from './source-dispatch';
import {SavedCaseSnapshot} from './saved-snapshot';
import {SavedAnalysisDraftBuilder,SAVED_DRAFT_TEMPLATE,savedAnalysisId} from './saved-draft-report';
import {readSavedOrders,savedMonthIdempotencyKey} from './saved-order-scope';
import {buildSavedJune2026ReviewDiagnostic} from './saved-minimum-wage-review';
import {readSavedJune2026Collection} from './saved-june2026-collection';

const monthSchema=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** Execute one purchased month through the existing CaseAnalysisService and
 * canonical PostgreSQL analysis adapters. Caller owns the canonical transaction;
 * all stages, legal pins, results, traces and draft bytes commit/rollback together.
 * A source job may contain several orders/months. Never merge different months'
 * salary fields into one canonical fact or acknowledge that job prematurely. */
export async function runSavedMonthAnalysis(input:{context:PostgresTransactionContext;analysis:PostgresAnalysisRepositories;tenantId:string;job:SourceJob;orderId:string;month:string}){
 const job=sourceJobSchema.parse(input.job);z.uuid().parse(input.orderId);monthSchema.parse(input.month);
 if(job.mode!=='draft')throw new Error('SAVED_LIVE_COMPOSITION_NOT_ENABLED');
 await lockCurrentSource(input.context,job);
 // Recheck the selected entitlement even on replay. A different paid order in
 // this case, or an old cached result, cannot authorize a revoked purchase.
 const [order]=await readSavedOrders(input.context,job,input.orderId);
 if(input.month<order.from.slice(0,7)||input.month>order.to.slice(0,7))throw new Error('SAVED_ORDER_SCOPE');
 const selected=await input.context.client.query(statement('saved_analysis_order',
  `select v.created_at,ecs.revision as engine_revision from private.case_input_versions v
   join public.engine_case_state ecs on ecs.canonical_case_id=v.case_id::text and ecs.tenant_id=$3
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$4`,[job.case_id,job.revision,input.tenantId,job.input_sha256]));
 const row=selected.rows[0];if(!row)throw new Error('SAVED_ENGINE_CASE_NOT_ADMITTED');
 const key=savedMonthIdempotencyKey(job,order.id,input.month);
 const existing=await input.analysis.caseAnalysis.getCompletedByIdempotencyKey(key);
 if(existing){if(existing.command.case_id!==job.case_id||!existing.bundle||!existing.report)throw new Error('SAVED_REPLAY_SCOPE');return existing;}
 const snapshots=new SavedCaseSnapshot(input.context,job,input.month),snapshot=await snapshots.read();
 const end=new Date(Date.UTC(Number(input.month.slice(0,4)),Number(input.month.slice(5,7)),0)).toISOString().slice(0,10);
 const now=new Date(String(row.created_at)).toISOString();
 const collection=input.month==='2026-06'&&order.topics.includes('minimum_wage')?await readSavedJune2026Collection(input.context,job):null;
 const command:CaseAnalysisCommand={case_id:job.case_id,case_revision:z.coerce.number().int().positive().parse(row.engine_revision),
  document_snapshot_id:snapshot.document_snapshot_id,document_snapshot_sha256:snapshot.document_snapshot_sha256,
  extraction_snapshot_id:snapshot.extraction_snapshot_id,extraction_snapshot_sha256:snapshot.extraction_snapshot_sha256,
  declared_fact_snapshot_id:snapshot.declared_fact_snapshot.snapshot_id,declared_fact_snapshot_sha256:snapshot.declared_fact_snapshot.snapshot_sha256,
  period:{start_date:`${input.month}-01`,end_date:end},as_of:now.slice(0,10),requested_topics:order.topics,
  sector:'unverified',population:'unverified',mode:'real',idempotency_key:key};
 const service=new CaseAnalysisService({clock:{now:()=>now},ids:{derive:savedAnalysisId},
  hashes:{hashCanonical:canonicalSha256,hashBytes:b=>createHash('sha256').update(b).digest('hex')},
  snapshots,repository:input.analysis.caseAnalysis,legalCatalog:new June2026ReviewCatalog(),
  // The current real catalog has zero active rules. No fixture executor is
  // reachable here; unexpected activation requires a reviewed production binding.
  executor:{async execute(){throw new Error('SAVED_RULE_EXECUTOR_NOT_ACTIVATED');}},
  reportBuilder:new SavedAnalysisDraftBuilder(),reportRegistration:input.analysis.reports,
  reviewDiagnostics:args=>{
   const diagnostic=buildSavedJune2026ReviewDiagnostic(args);
   return diagnostic&&collection?{...diagnostic,collection,
    blockers:{...diagnostic.blockers,technical:['canonical_component_fact_and_executor_admission_not_connected']},
    customer_requests_created:collection.resolutions.length>0}:diagnostic;
  },
  logs:{write(){}},templateVersion:SAVED_DRAFT_TEMPLATE});
 const bundle=await service.runCaseAnalysis(command);
 const completed=await service.getCompletedRun(bundle.analysis_run_id);
 if(!completed?.report)throw new Error('SAVED_ANALYSIS_NOT_COMMITTED');
 return completed;
}
