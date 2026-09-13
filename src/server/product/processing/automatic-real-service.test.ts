import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {WAVE3_TOPICS} from '@/engine/wave3/contracts';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import type {PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {realAiServiceFixture,syntheticServiceId} from '../reports/real-ai-service.fixture';
import {renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import {savedAnalysisId} from './saved-draft-report';
import {completeRealAiServiceMonth} from './automatic-real-service';
import {runAutomaticDevMonth} from './automatic-dev-flow';
import {loadSavedRealAiServiceIfEnrolled} from './saved-real-ai-service-configuration';
const ports=vi.hoisted(()=>({current:vi.fn(),publish:vi.fn(),enqueue:vi.fn(),quote:vi.fn(),status:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./document-review-key',async original=>({...await original<typeof import('./document-review-key')>(),resolveSavedDocumentReviewKey:ports.current}));
vi.mock('../reports/real-ai-service-delivery',async original=>({...await original<typeof import('../reports/real-ai-service-delivery')>(),publishRealAiServiceReport:ports.publish}));
vi.mock('../reports/real-ai-service-notification',async original=>({...await original<typeof import('../reports/real-ai-service-notification')>(),prepareAndEnqueueRealAiReportNotification:ports.enqueue}));
vi.mock('./saved-release-quote-stage',()=>({prepareSavedReleaseQuoteStage:ports.quote,recordSavedReleaseQuoteStatus:ports.status}));
type Input=Parameters<typeof completeRealAiServiceMonth>[0];
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED','0');});
afterEach(()=>vi.unstubAllEnvs());
function setup(){
 const f=realAiServiceFixture({orderId:syntheticServiceId(18)}),scope=f.row.current.assessment.scope,source=f.bundle.ai_release!.input.source,key='synthetic-real-current-review';
 const generated=buildSyntheticCaseFixture({fixture_id:'real-callback',mode:'real'});
 const command={...generated.command,case_id:scope.case_id,idempotency_key:key,document_review_sha256:canonicalSha256(source),population:scope.population,
  requested_topics:source.purchased_scope.topics.filter((t):t is typeof WAVE3_TOPICS[number]=>WAVE3_TOPICS.includes(t as typeof WAVE3_TOPICS[number])),period:{start_date:source.period.from,end_date:source.period.to},as_of:'2026-09-12'};
 const commandSha=canonicalSha256(command),runId=savedAnalysisId('case-analysis-run',commandSha);
 const envelope=createCaseAnalysisAiRelease({...f.bundle.ai_release!.input,analysis_run_id:runId},{...f.bundle.ai_release!.binding,engine_case_revision:command.case_revision});
 const {result_sha256,...base}=f.bundle;void result_sha256;
 const body={...base,analysis_run_id:runId,case_revision:command.case_revision,period:command.period,ai_release:envelope,document_review:envelope.result.review,
  document_snapshot_sha256:command.document_snapshot_sha256,extraction_snapshot_sha256:command.extraction_snapshot_sha256,declared_fact_snapshot_sha256:command.declared_fact_snapshot_sha256};
 const bundle={...body,result_sha256:canonicalSha256(body)},report=renderAiReleaseBundle(bundle,savedAnalysisId('saved-report',bundle.result_sha256));
 const configured={state:'configured',purpose:'real_customer_service',namespace:'real',is_qa:false,environment:f.row.current.assessment.environment,identity_id:f.selector.identity_id,
  source_journal:envelope.binding.source_journal,configuration:f.configuration,configuration_sha256:f.configuration.sha256,enrollment_id:syntheticServiceId(7),
  dependency_sha256:scope.authority_dependency_sha256,service_decision:f.row.service_decision,service_decision_sha256:f.row.service_decision.sha256,
  enrollment_issued_at:'2026-09-12T02:00:00Z',evaluated_at:f.row.current.assessment.evaluated_at,expires_at:'2026-09-12T19:00:00Z',source_created_at:f.row.source_created_at,evidence:f.row.evidence,revocations:[]};
 const order={id:source.purchased_scope.order_id,kind:'full',from:source.period.from,to:source.period.from,topics:source.purchased_scope.topics,offer_sha256:source.purchased_scope.receipt_sha256,purchase_topics_version:'tivdoc-purchase-topics-v2'};
 let enrolled=true;
 const query=vi.fn(async(s:PostgresStatement)=>{
  if(s.name==='real_ai_service_processing_enrolled')return {row_count:1,rows:[{enrolled}]};
  if(s.name==='real_ai_service_processing_context')return {row_count:1,rows:[{context:configured}]};
  if(s.name==='saved_order_entitlements')return {row_count:1,rows:[{orders:[order],current_orders:[order]}]};
  throw Error(`UNEXPECTED_QUERY:${s.name}`);
 });
 ports.current.mockResolvedValue({key,reviewSha256:canonicalSha256(source)});
 ports.publish.mockResolvedValue({analysis_run_id:runId,report_id:report.report_id,replayed:false});
 ports.quote.mockResolvedValue({state:'skipped',reason:'pricing_comparison_incomplete'});
 ports.status.mockResolvedValue({sha256:'a'.repeat(64),replayed:false,availability:{state:'needs_information',period:{from:'2026-06',to:'2026-06'}}});
 const payload={report_sha256:report.report_sha256};
 const input:Input={context:{transaction_id:'synthetic-routing-only',client:{query}},job:{schema_version:'saved-case-work-v1',case_id:scope.case_id,revision:scope.input_revision,input_sha256:scope.input_sha256,
  mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:scope.authority_dependency_sha256},orderId:order.id,month:source.period.from.slice(0,7),
  parent:{analysis_run_id:runId,idempotency_key:key,command_sha256:commandSha,command,completed:true,selections:[],bundle,report,
   stages:[{stage:'review_pending',payload,payload_sha256:canonicalSha256(payload)}],dependencies:{extraction_snapshot_sha256:command.extraction_snapshot_sha256,facts_snapshot_sha256:scope.facts_sha256,
    catalog_sha256:bundle.catalog_sha256,source_version_ids:[],parameter_version_ids:[],rule_spec_versions:[],code_version:'case-analysis@0.6.8',template_version:AI_RELEASE_REPORT_TEMPLATE}}};
 return {input,configured,query,setEnrolled:(value:boolean)=>{enrolled=value;}};
}
it('routes a real envelope through the current ordinary monthly callback and identical publication selector on retry',async()=>{
 const f=setup();await runAutomaticDevMonth(f.input);await runAutomaticDevMonth(f.input);
 expect(ports.publish).toHaveBeenCalledTimes(2);expect(ports.publish.mock.calls[0]).toEqual(ports.publish.mock.calls[1]);
 expect(ports.current.mock.calls[0][5].realProfile.purpose).toBe('real_customer_service');expect(ports.enqueue).not.toHaveBeenCalled();
 expect(ports.quote).toHaveBeenCalledWith({context:f.input.context,job:f.input.job,orderId:f.input.orderId,month:f.input.month,
  analysisRunId:f.input.parent.analysis_run_id,identityId:f.configured.identity_id});
 expect(ports.publish.mock.invocationCallOrder[0]).toBeLessThan(ports.quote.mock.invocationCallOrder[0]);
 expect(ports.status).toHaveBeenCalledWith(expect.objectContaining({analysisRunId:f.input.parent.analysis_run_id}),{state:'skipped',reason:'pricing_comparison_incomplete'});
 expect(ports.quote.mock.invocationCallOrder[0]).toBeLessThan(ports.status.mock.invocationCallOrder[0]);
});
it('prepares the independently authorized report notice after publication, without manufacturing consent',async()=>{
 const f=setup();vi.stubEnv('TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ORIGIN','https://synthetic.example');
 vi.stubEnv('TIVDOC_NOTIFICATION_ENCRYPTION_KEY','synthetic-test-key');ports.enqueue.mockResolvedValue({state:'skipped_not_authorized',reason:'not_authorized'});
 await completeRealAiServiceMonth(f.input);
 expect(ports.publish.mock.invocationCallOrder[0]).toBeLessThan(ports.enqueue.mock.invocationCallOrder[0]);
 expect(ports.enqueue).toHaveBeenCalledWith(f.input.context,ports.publish.mock.calls[0][1],'https://synthetic.example','synthetic-test-key');
});
it.each(['source','expiry','qa','artifact','stage','mode'] as const)('refuses changed %s before publication',async kind=>{
 const f=setup();
 if(kind==='source')ports.current.mockResolvedValue({key:'changed',reviewSha256:'f'.repeat(64)});
 if(kind==='expiry')f.configured.expires_at=f.configured.evaluated_at;
 if(kind==='qa')f.configured.is_qa=true;
 if(kind==='artifact')f.input.parent={...f.input.parent,report:{...f.input.parent.report!,pdf:Buffer.from('changed')}};
 if(kind==='stage')f.input.parent={...f.input.parent,stages:[]};
 if(kind==='mode')f.input.parent={...f.input.parent,command:{...f.input.parent.command,mode:'synthetic_test'}};
 await expect(runAutomaticDevMonth(f.input)).rejects.toThrow();expect(ports.publish).not.toHaveBeenCalled();expect(ports.enqueue).not.toHaveBeenCalled();
});
it('routes enrolled history before feature flag: disabled cannot become DEV fallback',async()=>{
 const f=setup();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');
 await expect(loadSavedRealAiServiceIfEnrolled(f.input.context,f.input.job)).rejects.toThrow('REAL_SERVICE_PROCESSING_DISABLED');
 expect(f.query.mock.calls.map(([s])=>s.name)).toEqual(['real_ai_service_processing_enrolled']);
});
it('allows an authenticated absent REAL enrollment to retain the existing DEV path',async()=>{
 const f=setup();f.setEnrolled(false);expect(await loadSavedRealAiServiceIfEnrolled(f.input.context,f.input.job)).toBeNull();
 expect(f.query.mock.calls.map(([s])=>s.name)).toEqual(['real_ai_service_processing_enrolled']);
});
