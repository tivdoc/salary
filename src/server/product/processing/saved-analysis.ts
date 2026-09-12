import {loadSavedOwnerEngineeringConfiguration} from './saved-owner-engineering-configuration';
import {prepareSavedOwnerEngineeringReview,savedOwnerEngineeringPreparation,assertSavedOwnerEngineeringCurrent} from './saved-owner-engineering';
import {OWNER_ENGINEERING_REPORT_TEMPLATE} from '../reports/owner-engineering-report';
import {loadSavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import {prepareSavedAiReleaseReview,savedAiReleasePreparation,assertSavedAiReleaseCurrent} from './saved-ai-release';
import {AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import {assessSavedReviewUploads} from '../documents/review-fulfillment-saved';
import {savedDocumentReviewInput,savedDocumentReviewSourceScope,openSavedNonPayslipReviewRequests} from "./saved-document-review";
import {openSavedReviewRequests} from './saved-review-requests';
import {documentReviewIdempotencyKey,savedAiReleaseBaseKey} from "./document-review-key";
import {loadJune2026TestAuthority,assertJune2026TestAuthority,june2026TestIdempotencyKey} from "./saved-june2026-test-authority";
import {loadSavedJune2026RegularAuthority,june2026RegularIdempotencyKey,june2026RegularReviewIdempotencyKey,JUNE_REGULAR_READING_POLICY,assertSavedJune2026RegularAuthority} from './saved-june2026-regular-authority';
import {SavedJune2026RegularRuntime} from './saved-june2026-regular';
import {June2026RegularCatalog} from '@/engine/minimum-wage-june2026/regular-service/catalog';
import {JUNE_REGULAR_REPORT_TEMPLATE} from '../reports/june2026-regular-service';
import {June2026IsolatedTestCatalog} from "@/engine/minimum-wage-june2026/test-catalog";
import {JUNE2026_MINIMUM_WAGE_POLICY} from "@/engine/minimum-wage-june2026/sources";
import {SavedJune2026CanonicalRuntime,JUNE2026_CANONICAL_TEST_TEMPLATE} from "./saved-june2026-canonical";
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
import {readSavedOrders,savedMonthIdempotencyKey,purchasedMonths,savedOrderLegalTopics} from './saved-order-scope';
import {buildSavedJune2026ReviewDiagnostic} from './saved-minimum-wage-review';
import {readSavedJune2026Collection} from './saved-june2026-collection';
import {loadSavedJune2026AdmittedContext,type SavedJune2026AdmittedContext} from './saved-june2026-admitted-context';

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
 if(!purchasedMonths(order).includes(input.month))throw new Error('SAVED_ORDER_SCOPE');
 const selected=await input.context.client.query(statement('saved_analysis_order',
  `select v.created_at,ecs.revision as engine_revision,(select public_id from public.cases where id=v.case_id) public_id from private.case_input_versions v
   join public.engine_case_state ecs on ecs.canonical_case_id=v.case_id::text and ecs.tenant_id=$3
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$4`,[job.case_id,job.revision,input.tenantId,job.input_sha256]));
 const row=selected.rows[0];if(!row)throw new Error('SAVED_ENGINE_CASE_NOT_ADMITTED');
 const ownerProfile=await loadSavedOwnerEngineeringConfiguration(input.context,job);
 const aiProfile=ownerProfile?null:await loadSavedAiReleaseConfiguration(input.context,job);
 const activeProfile=ownerProfile??aiProfile;
 const testAuthority=!activeProfile&&input.month==="2026-06"&&order.topics.length===1&&order.topics[0]==="minimum_wage"
  ?await loadJune2026TestAuthority(input.context,job,order.id):null;
 const canonical=testAuthority?new SavedJune2026CanonicalRuntime(testAuthority,job,order.id):null;
 const regularState=!activeProfile&&!testAuthority&&input.month==='2026-06'&&order.topics.length===1&&order.topics[0]==='minimum_wage'
  ?await loadSavedJune2026RegularAuthority(input.context,job,order.id):null;
 const regularAuthority=regularState?.state==='ready'?regularState:null;
 const regularReadingPolicy=!activeProfile&&!testAuthority&&input.month==='2026-06'&&order.topics.length===1&&order.topics[0]==='minimum_wage'?JUNE_REGULAR_READING_POLICY:undefined;
 const regular=regularAuthority&&order.kind!=='legacy_initial'?new SavedJune2026RegularRuntime(regularAuthority,job,order,z.string().parse(row.public_id)):null;
 const runtime=canonical??regular;
 const baseKey=activeProfile?savedAiReleaseBaseKey(job,order.id,input.month,activeProfile):testAuthority?june2026TestIdempotencyKey(job,order.id,testAuthority):regularAuthority?june2026RegularIdempotencyKey(job,order.id,regularAuthority):regularReadingPolicy?june2026RegularReviewIdempotencyKey(job,order.id):savedMonthIdempotencyKey(job,order.id,input.month);

 const sourceScope=!runtime&&!activeProfile?await savedDocumentReviewSourceScope(input.context,job,order,input.month):undefined;
 const baseSnapshots=new SavedCaseSnapshot(input.context,job,input.month,testAuthority?{authority:testAuthority,orderId:order.id}:undefined,
  regularAuthority?{authority:regularAuthority,orderId:order.id}:undefined,!runtime,sourceScope),baseSnapshot=await baseSnapshots.read();
 const prepareReview=async(base:Awaited<ReturnType<typeof baseSnapshots.read>>)=>{
  const source=await savedDocumentReviewInput(input.context,job,order,input.month,base,!!activeProfile);
  return ownerProfile?prepareSavedOwnerEngineeringReview(source,ownerProfile):aiProfile?prepareSavedAiReleaseReview(source,aiProfile):source;
 };
 const review=runtime?undefined:await prepareReview(baseSnapshot);
 const key=runtime?baseKey:documentReviewIdempotencyKey(baseKey,canonicalSha256(review));
 const existing=await input.analysis.caseAnalysis.getCompletedByIdempotencyKey(key);
 if(existing){if(ownerProfile){if(!existing.bundle?.owner_engineering)throw Error('OWNER_ENGINEERING_REPLAY_ENVELOPE_REQUIRED');assertSavedOwnerEngineeringCurrent(existing.bundle.owner_engineering,ownerProfile);}if(aiProfile){if(!existing.bundle?.ai_release)throw Error('AI_RELEASE_REPLAY_ENVELOPE_REQUIRED');assertSavedAiReleaseCurrent(existing.bundle.ai_release,aiProfile);}if(existing.command.case_id!==job.case_id||!existing.bundle||!existing.report||review&&existing.command.document_review_sha256!==canonicalSha256(review))throw new Error('SAVED_REPLAY_SCOPE');if(review){await openSavedNonPayslipReviewRequests(input.context,job,order,input.month,baseSnapshot,!!activeProfile);await assessSavedReviewUploads(input.context,job,existing.bundle.analysis_run_id);}return existing;}
 const snapshot={...baseSnapshot,...(review?{document_review_input:review}:{})};
 const snapshots={async loadPinned(command:CaseAnalysisCommand){
  const base=await baseSnapshots.loadPinned(command);
  if(!review)return base;
  const current=await prepareReview(base);
  if(canonicalSha256(current)!==command.document_review_sha256)throw Error("SAVED_REVIEW_INPUT_CHANGED");
  return {...base,document_review_input:current};
 }};
 const end=new Date(Date.UTC(Number(input.month.slice(0,4)),Number(input.month.slice(5,7)),0)).toISOString().slice(0,10);
 const now=activeProfile?activeProfile.evaluated_at:regularAuthority?regularAuthority.authority.assessment.issued_at:new Date(String(row.created_at)).toISOString();
 // A document-review command has its own source hash and idempotency key.
 // The canonical June factual loader accepts only canonical runtime commands;
 // do not reinterpret a wider source review as an admitted minimum-wage run.
 const collection=!review&&input.month==='2026-06'&&order.topics.includes('minimum_wage')?await readSavedJune2026Collection(input.context,job):null;
 let factualContext:SavedJune2026AdmittedContext|null=null;
 let preparedRunId:string|null=null;
 const command:CaseAnalysisCommand={...(review?{document_review_sha256:canonicalSha256(review)}:{}),case_id:job.case_id,case_revision:z.coerce.number().int().positive().parse(row.engine_revision),
  document_snapshot_id:snapshot.document_snapshot_id,document_snapshot_sha256:snapshot.document_snapshot_sha256,
  extraction_snapshot_id:snapshot.extraction_snapshot_id,extraction_snapshot_sha256:snapshot.extraction_snapshot_sha256,
  declared_fact_snapshot_id:snapshot.declared_fact_snapshot.snapshot_id,declared_fact_snapshot_sha256:snapshot.declared_fact_snapshot.snapshot_sha256,
  period:{start_date:`${input.month}-01`,end_date:end},as_of:now.slice(0,10),requested_topics:savedOrderLegalTopics(order),
  sector:runtime?JUNE2026_MINIMUM_WAGE_POLICY.sector:'unverified',population:activeProfile?activeProfile.configuration.population:runtime?JUNE2026_MINIMUM_WAGE_POLICY.population:'unverified',mode:testAuthority?'synthetic_test':regularAuthority?.mode??'real',idempotency_key:key};
 const service=new CaseAnalysisService({clock:{now:()=>now},ids:{derive:savedAnalysisId},
  readingPolicy:regularReadingPolicy,
  prepareOwnerEngineering:ownerProfile?savedOwnerEngineeringPreparation(input.context,job,ownerProfile):undefined,
  prepareAiRelease:aiProfile?savedAiReleasePreparation(input.context,job,aiProfile):undefined,
  hashes:{hashCanonical:canonicalSha256,hashBytes:b=>createHash('sha256').update(b).digest('hex')},
  snapshots,repository:input.analysis.caseAnalysis,legalCatalog:testAuthority?new June2026IsolatedTestCatalog(testAuthority.assessment):regularAuthority?new June2026RegularCatalog(regularAuthority.authority):new June2026ReviewCatalog(),
  executor:runtime??{async execute(){throw new Error('REGULAR_AUTHORITY_REQUIRED');}},
  reportBuilder:runtime??new SavedAnalysisDraftBuilder(),reportRegistration:input.analysis.reports,
  authorizeIsolatedTest:testAuthority?async(command,selection)=>{
   assertJune2026TestAuthority(testAuthority,job,order.id);
   const expected=await new June2026IsolatedTestCatalog(testAuthority.assessment).resolve({topic:selection.topic,target_date:command.period.end_date,
    as_of:command.as_of,sector:command.sector,population:command.population,mode:command.mode});
   if(canonicalSha256(expected)!==canonicalSha256(selection))throw Error('JUNE_TEST_CATALOG_AUTHORITY_BINDING');
  }:regularAuthority?.mode==='synthetic_test'?async(command,selection)=>{
   assertSavedJune2026RegularAuthority(regularAuthority,job,order.id);
   const expected=await new June2026RegularCatalog(regularAuthority.authority).resolve({topic:selection.topic,target_date:command.period.end_date,
    as_of:command.as_of,sector:command.sector,population:command.population,mode:command.mode});
   if(canonicalSha256(expected)!==canonicalSha256(selection))throw Error('REGULAR_ISOLATED_SELECTION_BINDING');
  }:undefined,
  executionBlockers:runtime?()=>runtime.blockers():undefined,
  prepareExecutionContext:collection?async pins=>{
   if(pins.case_id!==job.case_id)throw new Error('SAVED_JUNE_CONTEXT_PREEXECUTION_SCOPE');
   const loaded=await loadSavedJune2026AdmittedContext({context:input.context,job,orderId:order.id,analysisRunId:pins.analysis_run_id,...(testAuthority?{testAuthority}:{}),...(regularAuthority?{regularAuthority}:{}),...(regularReadingPolicy?{regularReadingPolicy}:{})});
   const actual=loaded.state==='context_loaded'?loaded.context.current:loaded;
   if(actual.case_id!==pins.case_id||actual.analysis_run_id!==pins.analysis_run_id
    ||(loaded.state==='context_loaded'&&(loaded.command_sha256!==pins.command_sha256
     ||loaded.context.facts_snapshot_sha256!==pins.facts_snapshot_sha256
     ||!pins.rule_inputs.some(ruleInput=>canonicalSha256(ruleInput)===canonicalSha256(loaded.context.rule_input))))) {
    throw new Error('SAVED_JUNE_CONTEXT_PREEXECUTION_BINDING');
   }
   factualContext=loaded;preparedRunId=pins.analysis_run_id;runtime?.prepare(loaded);
  }:undefined,
  reviewDiagnostics:async args=>{
   if(canonical)return {authority:"isolated_dev_test_assumptions",admission:canonical.admission,comparison:canonical.comparison};
   if(regular)return regular.diagnostics();
   const diagnostic=buildSavedJune2026ReviewDiagnostic(args);
   if(!diagnostic||!collection)return diagnostic;
   if(!factualContext||preparedRunId!==args.bundle.analysis_run_id
    ||(factualContext.state==='context_loaded'&&factualContext.context.facts_snapshot_sha256!==args.bundle.facts_snapshot_sha256)) {
    throw new Error('SAVED_JUNE_CONTEXT_NOT_PREPARED');
   }
   return {...diagnostic,collection,factual_context:factualContext,
    blockers:{...diagnostic.blockers,technical:[],authority:regularState?.state==='blocked'?regularState.blockers:['signed_case_assessment_and_current_registry_required']},
    customer_requests_created:collection.resolutions.length>0};
  },
  logs:{write(){}},templateVersion:ownerProfile?OWNER_ENGINEERING_REPORT_TEMPLATE:aiProfile?AI_RELEASE_REPORT_TEMPLATE:canonical?JUNE2026_CANONICAL_TEST_TEMPLATE:regular?JUNE_REGULAR_REPORT_TEMPLATE:SAVED_DRAFT_TEMPLATE});
 const bundle=await service.runCaseAnalysis(command);
 const completed=await service.getCompletedRun(bundle.analysis_run_id);
 if(!completed?.report)throw new Error('SAVED_ANALYSIS_NOT_COMMITTED');
 if(canonical)await canonical.persist(input.context,bundle.analysis_run_id);
 if(regular)await regular.persist(input.context,bundle.analysis_run_id);
 if(review){
  // Source-structure needs are exact document_field targets. They can exist
  // after all generic factual questions were answered, so both projections
  // must run even when the generic completion list is empty.
  await openSavedNonPayslipReviewRequests(input.context,job,order,input.month,baseSnapshot,!!activeProfile);
  await openSavedReviewRequests(input.context,job,bundle.analysis_run_id,baseSnapshot);
  await assessSavedReviewUploads(input.context,job,bundle.analysis_run_id);
 }
 return completed;
}
