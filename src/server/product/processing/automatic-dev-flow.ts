import {loadJune2026TestAuthority,june2026TestIdempotencyKey} from "./saved-june2026-test-authority";
import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {statement} from '@/server/platform/persistence/postgres/contracts';
import {PROJECTION_SCHEMA_VERSION,PROJECTION_LEGAL_BASIS,PROJECTION_TOPICS,parseProjection} from '../reports/case-report-projection';
import {AI_PUBLICATION_POLICY,reportDocumentV3Schema} from '../reports/report-document';
import {savedAnalysisId} from './saved-draft-report';
import type {SavedMonthCompletion} from './saved-job-runner';
import {assertDevFinancialScenario} from './dev-financial-contract';
import {runSavedDevFinancialMonth} from './dev-financial-analysis';
import {loadSavedJune2026RegularAuthority,june2026RegularIdempotencyKey,june2026RegularReviewIdempotencyKey,assertSavedJune2026RegularAuthority} from './saved-june2026-regular-authority';
import {June2026RegularCatalog} from '@/engine/minimum-wage-june2026/regular-service/catalog';
import {June2026ReviewCatalog} from '@/engine/legal-operations/june2026-catalog';
import {decodeBundle,validateReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {publishSavedAiReport} from '../reports/publish-ai-report';
import {JUNE_REGULAR_REPORT_TEMPLATE} from '../reports/june2026-regular-service';
import {SAVED_DRAFT_TEMPLATE} from './saved-draft-report';
import {SAVED_JUNE_REVIEW_VERSION} from './saved-minimum-wage-review';
import {readSavedOrders,savedMonthIdempotencyKey} from './saved-order-scope';
import {resolveSavedDocumentReviewKey} from './document-review-key';
import {renderReviewBundle} from '../reports/document-review-projection';

type Input=Parameters<SavedMonthCompletion>[0];
const HISTORICAL_REVIEW_CODE_VERSIONS=new Set(['case-analysis@0.6.0','case-analysis@0.6.1','case-analysis@0.6.2',
 'case-analysis@0.6.3','case-analysis@0.6.4','case-analysis@0.6.5','case-analysis@0.6.6']);

/** The current document review remains a source/arithmetic draft. Resolve the
 * exact current review input again before acknowledging this month's saved
 * bytes. This path cannot reach either financial publisher or DEV calculator. */
async function completeDocumentReview(input:Input){
 const {context,job,orderId,month,parent}=input,command=parent.command;
 const [order]=await readSavedOrders(context,job,orderId);
 const june=month==='2026-06'&&order.topics.length===1&&order.topics[0]==='minimum_wage';
 if(june){
  const legacy=await loadJune2026TestAuthority(context,job,orderId),authority=await loadSavedJune2026RegularAuthority(context,job,orderId);
  if(legacy||authority?.state==='ready')throw Error('REGULAR_MANAGED_REVIEW_AUTHORITY_CHANGED');
 }
 const baseKey=june?june2026RegularReviewIdempotencyKey(job,orderId):savedMonthIdempotencyKey(job,orderId,month);
 const current=await resolveSavedDocumentReviewKey(context,job,order,month,baseKey);
 const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 if(month<order.from.slice(0,7)||month>order.to.slice(0,7)||!parent.completed||!parent.bundle||!parent.report
  ||parent.idempotency_key!==current.key||command.idempotency_key!==current.key||command.document_review_sha256!==current.reviewSha256
  ||command.mode!=='real'||command.case_id!==job.case_id||command.document_snapshot_id!==current.snapshot.document_snapshot_id
  ||command.document_snapshot_sha256!==current.snapshot.document_snapshot_sha256
  ||command.extraction_snapshot_id!==current.snapshot.extraction_snapshot_id||command.extraction_snapshot_sha256!==current.snapshot.extraction_snapshot_sha256
  ||command.declared_fact_snapshot_id!==current.snapshot.declared_fact_snapshot.snapshot_id||command.declared_fact_snapshot_sha256!==current.snapshot.declared_fact_snapshot.snapshot_sha256
  ||command.period.start_date!==`${month}-01`||command.period.end_date!==end
  ||canonicalSha256(command.requested_topics)!==canonicalSha256(order.topics)||canonicalSha256(command)!==parent.command_sha256
  ||parent.analysis_run_id!==savedAnalysisId('case-analysis-run',parent.command_sha256)||parent.selections.length!==order.topics.length)
  throw Error('DOCUMENT_REVIEW_MANAGED_SCOPE');
 const catalog=new June2026ReviewCatalog();
 for(const [index,topic] of order.topics.entries()){
  const expected=await catalog.resolve({mode:'real',topic,target_date:command.period.end_date,as_of:command.as_of,sector:command.sector,population:command.population});
  if(canonicalSha256(expected)!==canonicalSha256(parent.selections[index]))throw Error('DOCUMENT_REVIEW_MANAGED_SELECTION');
 }
 const bundle=decodeBundle(parent.bundle,order.topics);validateReport(parent.report);
 if(bundle.case_id!==job.case_id||bundle.analysis_run_id!==parent.analysis_run_id||bundle.case_revision!==command.case_revision
  ||bundle.document_review?.input_sha256!==current.reviewSha256||canonicalSha256(bundle.document_review.input)!==canonicalSha256(current.review)
  ||bundle.known_subtotal!==null||bundle.coverage_complete||bundle.topic_results.some(t=>!['blocked_missing_facts','blocked_conflict','blocked_legal_readiness','error'].includes(t.status)||t.amount!==null||t.trace!==null)
  ||parent.report.report_id!==savedAnalysisId('saved-report',bundle.result_sha256)||parent.report.analysis_result_sha256!==bundle.result_sha256)
  throw Error('DOCUMENT_REVIEW_MANAGED_RESULT');
 // Reuse the typed projection and renderer. A self-consistent edited JSON or
 // PDF hash is insufficient: all formats must be the same saved review result.
 const expectedReport=renderReviewBundle(bundle,parent.report.report_id);
 if(parent.report.report_sha256!==expectedReport.report_sha256)throw Error('DOCUMENT_REVIEW_MANAGED_ARTIFACT');
 const stages=parent.stages.filter(s=>s.stage==='review_pending'),stage=stages[0];
 if(stages.length!==1||!stage||stage.payload_sha256!==canonicalSha256(stage.payload))throw Error('DOCUMENT_REVIEW_MANAGED_STAGE');
 const review=z.object({report_sha256:z.literal(parent.report.report_sha256),auto_approved:z.literal(false),export_eligible_before_review:z.literal(false)}).passthrough().parse(stage.payload);
 if(june)z.object({diagnostics:z.object({schema_version:z.literal(SAVED_JUNE_REVIEW_VERSION),case_id:z.literal(job.case_id),
  analysis_run_id:z.literal(parent.analysis_run_id),candidate_calculation_performed:z.literal(false),findings_created:z.literal(false),activation_allowed:z.literal(false)}).passthrough()}).passthrough().parse(review);
}
/** An unsigned regular review is a completed diagnostic/waiting result. It
 * never falls through to the separate historical engineering calculator. */
async function completeRegularReview(input:Input){
 const {context,job,orderId,month,parent}=input,command=parent.command;
 if(!parent.dependencies||!HISTORICAL_REVIEW_CODE_VERSIONS.has(parent.dependencies.code_version)
  ||command.document_review_sha256||parent.bundle?.document_review)throw Error('REGULAR_MANAGED_HISTORICAL_REVIEW_REQUIRED');
 const legacy=await loadJune2026TestAuthority(context,job,orderId),authority=await loadSavedJune2026RegularAuthority(context,job,orderId);
 if(legacy||authority?.state==='ready')throw Error('REGULAR_MANAGED_REVIEW_AUTHORITY_CHANGED');
 const [order]=await readSavedOrders(context,job,orderId),key=june2026RegularReviewIdempotencyKey(job,orderId);
 if(month!=='2026-06'||!order||canonicalSha256(order.topics)!==canonicalSha256(['minimum_wage'])
  ||month<order.from.slice(0,7)||month>order.to.slice(0,7)||!parent.completed||!parent.bundle||!parent.report
  ||parent.idempotency_key!==key||command.idempotency_key!==key||command.mode!=='real'||command.case_id!==job.case_id
  ||command.document_snapshot_id!==`saved-documents:2026-06:${job.input_sha256}`
  ||command.period.start_date!=='2026-06-01'||command.period.end_date!=='2026-06-30'
  ||canonicalSha256(command.requested_topics)!==canonicalSha256(['minimum_wage'])||canonicalSha256(command)!==parent.command_sha256
  ||parent.analysis_run_id!==savedAnalysisId('case-analysis-run',parent.command_sha256)||parent.selections.length!==1)throw Error('REGULAR_MANAGED_REVIEW_SCOPE');
 const expected=await new June2026ReviewCatalog().resolve({mode:'real',topic:'minimum_wage',target_date:command.period.end_date,
  as_of:command.as_of,sector:command.sector,population:command.population});
 if(canonicalSha256(expected)!==canonicalSha256(parent.selections[0]))throw Error('REGULAR_MANAGED_REVIEW_SELECTION');
 const bundle=decodeBundle(parent.bundle,['minimum_wage']);validateReport(parent.report);
 if(bundle.case_id!==job.case_id||bundle.analysis_run_id!==parent.analysis_run_id||parent.report.analysis_result_sha256!==bundle.result_sha256
  ||bundle.known_subtotal!==null||bundle.coverage_complete||bundle.topic_results.some(t=>!['blocked_missing_facts','blocked_conflict','blocked_legal_readiness','error'].includes(t.status)||t.amount!==null||t.trace!==null))
  throw Error('REGULAR_MANAGED_BLOCKED_RESULT');
 const stages=parent.stages.filter(s=>s.stage==='review_pending'),stage=stages[0];
 if(stages.length!==1||!stage||stage.payload_sha256!==canonicalSha256(stage.payload))throw Error('REGULAR_MANAGED_STAGE_BINDING');
 const review=z.object({report_sha256:z.string(),diagnostics:z.object({schema_version:z.literal(SAVED_JUNE_REVIEW_VERSION),case_id:z.literal(job.case_id),
  analysis_run_id:z.literal(parent.analysis_run_id),candidate_calculation_performed:z.literal(false),findings_created:z.literal(false),activation_allowed:z.literal(false)}).passthrough()}).passthrough().parse(stage.payload);
 const artifact=z.object({schema_version:z.literal(SAVED_DRAFT_TEMPLATE),publication:z.literal('draft')}).passthrough().parse(JSON.parse(Buffer.from(parent.report.json).toString('utf8')));
 if(review.report_sha256!==parent.report.report_sha256||artifact.publication!=='draft')throw Error('REGULAR_MANAGED_STAGE_BINDING');
}
/** The regular runtime already committed this exact financial result inside
 * the current month transaction. Re-admit its saved bytes and publication via
 * the existing idempotent SQL boundary; never render or calculate another run
 * and never feed a financial parent into the historical DEV draft writer. */
async function completeRegularMonth(input:Input){
 const {context,job,orderId,month,parent}=input;
 const authority=await loadSavedJune2026RegularAuthority(context,job,orderId);
 if(!authority||authority.state!=='ready')throw Error('REGULAR_MANAGED_CURRENT_AUTHORITY_REQUIRED');
 assertSavedJune2026RegularAuthority(authority,job,orderId);
 const key=june2026RegularIdempotencyKey(job,orderId,authority),command=parent.command;
 if(month!=='2026-06'||!parent.completed||!parent.bundle||!parent.report||parent.analysis_run_id!==parent.bundle.analysis_run_id
  ||parent.idempotency_key!==key||command.idempotency_key!==key||command.case_id!==job.case_id
  ||command.mode!==authority.mode||command.document_snapshot_id!==`saved-documents:2026-06:${job.input_sha256}`
  ||command.period.start_date!=='2026-06-01'||command.period.end_date!=='2026-06-30'
  ||canonicalSha256(command.requested_topics)!==canonicalSha256(['minimum_wage'])
  ||canonicalSha256(command)!==parent.command_sha256||parent.analysis_run_id!==savedAnalysisId('case-analysis-run',parent.command_sha256)
  ||parent.selections.length!==1)throw Error('REGULAR_MANAGED_SCOPE');
 const expected=await new June2026RegularCatalog(authority.authority).resolve({mode:command.mode,topic:'minimum_wage',
  target_date:command.period.end_date,as_of:command.as_of,sector:command.sector,population:command.population});
 if(canonicalSha256(expected)!==canonicalSha256(parent.selections[0]))throw Error('REGULAR_MANAGED_SELECTION');
 const bundle=decodeBundle(parent.bundle,['minimum_wage']);validateReport(parent.report);
 if(bundle.case_id!==job.case_id||bundle.analysis_run_id!==parent.analysis_run_id
  ||parent.report.analysis_result_sha256!==bundle.result_sha256)throw Error('REGULAR_MANAGED_REPORT_BINDING');
 const stages=parent.stages.filter(s=>s.stage==='review_pending'),stage=stages[0];
 if(stages.length!==1||!stage||stage.payload_sha256!==canonicalSha256(stage.payload))throw Error('REGULAR_MANAGED_STAGE_BINDING');
 const review=z.object({report_sha256:z.string(),diagnostics:z.object({schema_version:z.literal('saved-june2026-regular-diagnostics-v1'),
  namespace:z.enum(['real','isolated_test']),authority_sha256:z.string(),registry_sha256:z.string(),assessment_sha256:z.string(),
  admission:z.unknown(),execution:z.unknown(),context_blocker:z.string().nullable()}).strict()}).passthrough().parse(stage.payload);
 const diagnostic=review.diagnostics;
 if(review.report_sha256!==parent.report.report_sha256||diagnostic.namespace!==authority.authority.registry.namespace
  ||diagnostic.authority_sha256!==authority.authority.authority_sha256||diagnostic.registry_sha256!==authority.registry_sha256
  ||diagnostic.assessment_sha256!==authority.assessment_sha256)throw Error('REGULAR_MANAGED_STAGE_BINDING');
 const artifact=z.object({schema_version:z.string()}).passthrough().parse(JSON.parse(Buffer.from(parent.report.json).toString('utf8')));
 if(diagnostic.execution===null){
  if(artifact.schema_version!==SAVED_DRAFT_TEMPLATE||bundle.known_subtotal!==null||bundle.coverage_complete
   ||bundle.topic_results.some(t=>!['blocked_missing_facts','blocked_conflict','blocked_legal_readiness','error'].includes(t.status)||t.amount!==null||t.trace!==null))
   throw Error('REGULAR_MANAGED_BLOCKED_RESULT');
  return;
 }
 const saved=z.object({schema_version:z.literal(JUNE_REGULAR_REPORT_TEMPLATE),bundle:z.unknown(),execution:z.object({case_id:z.uuid(),analysis_run_id:z.uuid(),
  order_id:z.uuid(),input_revision:z.number().int().positive(),input_sha256:z.string(),authority_sha256:z.string(),admission:z.unknown(),trace:z.unknown()}).passthrough(),
  document:reportDocumentV3Schema}).passthrough().parse(artifact);
 if(canonicalSha256(saved.bundle)!==canonicalSha256(bundle)||canonicalSha256(saved.execution)!==canonicalSha256(diagnostic.execution)
  ||canonicalSha256(saved.execution.admission)!==canonicalSha256(diagnostic.admission)
  ||saved.execution.case_id!==job.case_id||saved.execution.analysis_run_id!==parent.analysis_run_id
  ||saved.execution.order_id!==orderId||saved.execution.input_revision!==job.revision||saved.execution.input_sha256!==job.input_sha256
  ||saved.execution.authority_sha256!==authority.authority.authority_sha256||saved.document.id!==parent.report.report_id
  ||canonicalSha256(saved.execution.trace)!==canonicalSha256(bundle.topic_results[0].trace))throw Error('REGULAR_MANAGED_REPORT_BINDING');
 // This RPC rechecks the current source/entitlement/authority, exact persisted
 // run, stage, Finding and report bytes before returning its existing receipt.
 const rows=await context.client.query(statement('automatic_regular_saved_result',
  'select private.june2026_regular_result_save($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb) value',
  [job.case_id,orderId,job.revision,job.input_sha256,parent.analysis_run_id,JSON.stringify(saved.execution),JSON.stringify(saved.document)]));
 const receipt=z.object({projection_id:z.uuid(),identity_id:z.uuid()}).strict().parse(rows.rows[0]?.value);
 if(rows.rows.length!==1||receipt.projection_id!==parent.report.report_id)throw Error('REGULAR_MANAGED_SAVE_ACK');
 await publishSavedAiReport(context,{caseId:job.case_id,identityId:receipt.identity_id,projectionId:receipt.projection_id});
}
/** A saved canonical result becomes the existing product report envelope.
 * Zero activated rules yields an immutable DRAFT, never a checked finding or
 * report-ready publication. This bridge cannot turn the engineering comparison
 * into a canonical monetary finding. */
export async function saveAutomaticDevCanonicalDraft(input:Input){
 const {context,job,orderId,parent,month}=input;
 if(month!=='2026-06'||!parent.bundle||parent.bundle.case_id!==job.case_id)throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 const bundle=parent.bundle;
 const selected=await context.client.query(statement('automatic_dev_draft_source',
  'select private.dev_financial_admit($1::uuid,$2::uuid,$3,$4) source',[job.case_id,orderId,job.revision,job.input_sha256]));
 const source=z.object({public_id:z.string(),document_id:z.uuid(),version_id:z.uuid(),source_sha256:z.string()}).parse(selected.rows[0]?.source);
 const offer=await context.client.query(statement('automatic_dev_draft_offer','select offer_sha256 from private.product_orders where id=$1::uuid and case_id=$2::uuid',[orderId,job.case_id]));
 const id=savedAnalysisId('automatic-dev-canonical-product-draft',bundle.result_sha256);
 const projection=parseProjection({schema_version:PROJECTION_SCHEMA_VERSION,case_public_id:source.public_id,
  check_period_month:month,months_covered:[month],report_kind:'initial',legal_basis:PROJECTION_LEGAL_BASIS,generated_at:new Date(bundle.as_of).toISOString(),
  topics:PROJECTION_TOPICS.map(topic=>({topic,branches_examined:[],parameter_grades:{},gate:'awaiting_verification',activation:'awaiting_verification',
   status:'not_checked',customer_text:'ממתין לאימות בסיום הפיתוח',blocked_by_grades:['draft']}))});
 const document=reportDocumentV3Schema.parse({schema_version:'tivdoc-report-document-v3',id,case_id:job.case_id,order_id:orderId,revision:job.revision,
  input_sha256:job.input_sha256,projection_sha256:canonicalSha256(projection),purchased_period:{from:month,to:month},projection,
  // The canonical catalog currently produced no findings. The independent
  // canonical report and engineering artifact retain their own source traces.
  evidence:[],findings:[],publication:{state:'draft',approval_actor_kind:'automation',approved_input_sha256:null,published_at:null},
  service_kind:'ai_assisted',publication_policy:AI_PUBLICATION_POLICY,order_offer_sha256:offer.rows[0]?.offer_sha256,
  correction_policy:'append_new_revision_preserve_published'});
 const result=await context.client.query(statement('automatic_dev_canonical_draft_save',
  'select private.automatic_dev_canonical_draft_save($1::jsonb,$2,$3) value',[JSON.stringify(document),bundle.analysis_run_id,bundle.result_sha256]));
 const receipt=z.object({projection_id:z.literal(id),publication:z.literal('draft'),replayed:z.boolean()}).strict().parse(result.rows[0]?.value);
 return {source,receipt};
}

/** Runs inside the runner's existing case/source/lease-fenced transaction.
 * Answers create a new source revision and therefore a new canonical run;
 * retries reuse both run and artifact rather than appending duplicates. */
export const runAutomaticDevMonth:SavedMonthCompletion=async input=>{
 if(input.parent.command.document_review_sha256||input.parent.bundle?.document_review||input.parent.command.idempotency_key?.startsWith('review:')){
  await completeDocumentReview(input);return;
 }
 if(input.parent.command.idempotency_key?.startsWith('june-regular-review:')){
  await completeRegularReview(input);return;
 }
 if(input.parent.command.idempotency_key?.startsWith('june-regular:')
  ||input.parent.selections?.some(s=>s.catalog_id.startsWith('tivdoc.june2026.regular.'))){
  await completeRegularMonth(input);return;
 }
 // The canonical isolated test already saved its own same-run artifact. Never
 // feed its financial trace to the historical experimental draft/comparison.
 if(input.parent.command.mode==='synthetic_test'){
  const authority=await loadJune2026TestAuthority(input.context,input.job,input.orderId);
  if(!authority||input.month!=='2026-06'||input.parent.command.idempotency_key!==june2026TestIdempotencyKey(input.job,input.orderId,authority)
   ||input.parent.selections.length!==1||input.parent.selections[0].catalog_id!=='tivdoc.june2026.isolated-test')throw Error('JUNE_TEST_MANAGED_SCOPE');
  return;
 }
 const {source}=await saveAutomaticDevCanonicalDraft(input);
 const facts=employmentSnapshotSchema.parse(z.object({facts:z.unknown()}).parse(input.parent.stages.find(s=>s.stage==='canonical_facts')?.payload).facts);
 // Source-type transcription cannot bypass an unanswered/contradictory month.
 // Either answer order is valid; an incomplete source remains awaiting input.
 const periods=facts.facts.filter(f=>f.path==='documents.period');
 if(periods.length!==1||periods[0].status!=='confirmed'||periods[0].conflicting_fact_ids.length
  ||periods[0].value?.document_id!==source.version_id||periods[0].value.period.start_date!=='2026-06-01'
  ||periods[0].value.period.end_date!=='2026-06-30'
  ||!periods[0].provenance.some(p=>p.source_type==='documented'&&p.source_reference.document_id===source.version_id&&p.source_reference.locator?.page))return;
 const missingSalary=!facts.facts.some(f=>f.path==='compensation.salary_type'&&f.value!==null);
 if(!missingSalary)try{assertDevFinancialScenario(facts,source.version_id);}catch(error){
  if(error instanceof Error&&error.message==='DEV_FINANCIAL_CANONICAL_SCENARIO')return;
  throw error;
 }
 // A pending source confirmation is a waiting state, not a provider failure.
 const essential=facts.facts.filter(f=>['compensation.base_monthly_salary','work.regular_hours'].includes(f.path));
 if(essential.some(f=>f.value!==null&&f.status!=='confirmed'))return;
 try{await runSavedDevFinancialMonth({context:input.context,job:input.job,orderId:input.orderId,parent:input.parent});}
 catch(error){
  if(error instanceof Error&&error.message==='DEV_FINANCIAL_COMPLETIONS_REQUIRED')return;
  throw error;
 }
};
