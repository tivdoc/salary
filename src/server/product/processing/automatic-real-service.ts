import 'server-only';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {decodeBundle,validateReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import {publishRealAiServiceReport} from '../reports/real-ai-service-delivery';
import {prepareAndEnqueueRealAiReportNotification} from '../reports/real-ai-service-notification';
import {loadSavedRealAiServiceConfiguration,assertSavedRealAiServiceCurrent} from './saved-real-ai-service-configuration';
import {readSavedOrders,purchasedMonths,savedOrderLegalTopics} from './saved-order-scope';
import {resolveSavedDocumentReviewKey,savedAiReleaseBaseKey} from './document-review-key';
import {savedAnalysisId} from './saved-draft-report';
import {prepareSavedReleaseQuoteStage} from './saved-release-quote-stage';
import type {SavedMonthCompletion} from './saved-worker-contracts';

/** Completes the ordinary saved analysis inside its source/lease transaction.
 * No owner envelope is promoted, and no new calculation/report is manufactured.
 * Publication and notification grants are independent from processing authority. */
export const completeRealAiServiceMonth:SavedMonthCompletion=async input=>{
 const {context,job,orderId,month,parent}=input;
 const profile=await loadSavedRealAiServiceConfiguration(context,job);
 if(!parent.completed||!parent.bundle?.ai_release||!parent.report||parent.bundle.owner_engineering)throw Error('REAL_SERVICE_MANAGED_RESULT_REQUIRED');
 const [order]=await readSavedOrders(context,job,orderId);
 if(!purchasedMonths(order).includes(month))throw Error('REAL_SERVICE_MANAGED_ORDER_SCOPE');
 const current=await resolveSavedDocumentReviewKey(context,job,order,month,savedAiReleaseBaseKey(job,order.id,month,profile),{realProfile:profile});
 const command=parent.command,bundle=decodeBundle(parent.bundle,savedOrderLegalTopics(order));validateReport(parent.report);
 if(!bundle.ai_release||!parent.dependencies||parent.dependencies.template_version!==AI_RELEASE_REPORT_TEMPLATE
  ||command.mode!=='real'||command.idempotency_key!==current.key||parent.idempotency_key!==current.key||canonicalSha256(command)!==parent.command_sha256
  ||command.case_id!==job.case_id||command.population!==profile.configuration.population||command.document_review_sha256!==current.reviewSha256
  ||canonicalSha256(bundle.ai_release.input.source)!==current.reviewSha256||bundle.case_id!==job.case_id||bundle.analysis_run_id!==parent.analysis_run_id
  ||bundle.ai_release.binding.source_journal.input_revision!==job.revision||bundle.ai_release.binding.source_journal.input_sha256!==job.input_sha256
  ||parent.analysis_run_id!==savedAnalysisId('case-analysis-run',parent.command_sha256)
  ||canonicalSha256(command.requested_topics)!==canonicalSha256(savedOrderLegalTopics(order)))throw Error('REAL_SERVICE_MANAGED_RESULT_BINDING');
 assertSavedRealAiServiceCurrent(bundle.ai_release,profile);
 const expected=renderAiReleaseBundle(bundle,savedAnalysisId('saved-report',bundle.result_sha256));
 if(parent.report.report_sha256!==expected.report_sha256||parent.report.report_id!==expected.report_id)throw Error('REAL_SERVICE_MANAGED_ARTIFACT');
 const stages=parent.stages.filter(s=>s.stage==='review_pending');
 if(stages.length!==1||stages[0].payload_sha256!==canonicalSha256(stages[0].payload)
  ||!stages[0].payload||typeof stages[0].payload!=='object'||!('report_sha256' in stages[0].payload)
  ||stages[0].payload.report_sha256!==expected.report_sha256)throw Error('REAL_SERVICE_MANAGED_STAGE');
 const selector={case_id:job.case_id,identity_id:profile.identity_id,report_id:expected.report_id};
 const published=await publishRealAiServiceReport(context,selector);
 if(published.analysis_run_id!==parent.analysis_run_id||published.report_id!==expected.report_id)throw Error('REAL_SERVICE_MANAGED_PUBLICATION_ACK');
 await prepareSavedReleaseQuoteStage({context,job,orderId,month,analysisRunId:parent.analysis_run_id,identityId:profile.identity_id});
 if(process.env.TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED==='1'){
  const origin=process.env.TIVDOC_REAL_AI_SERVICE_ORIGIN,secret=process.env.TIVDOC_NOTIFICATION_ENCRYPTION_KEY;
  if(!origin||!secret)throw Error('REAL_SERVICE_NOTIFICATION_CONFIGURATION_REQUIRED');
  await prepareAndEnqueueRealAiReportNotification(context,selector,origin,secret);
 }
};
