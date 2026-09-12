import {beforeEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {AI_RELEASE_RUNTIME_FAMILIES} from '@/engine/ai-release-runtime/contracts';
import {fixture as pensionFixture} from '@/engine/entitlement-review/compose.fixture';
import {June2026ReviewCatalog} from '@/engine/legal-operations/june2026-catalog';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {aiReleaseConfigurationSchema} from './ai-release-configuration';
import type {SavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import {savedAnalysisId} from './saved-draft-report';
import {renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import {runAutomaticDevMonth} from './automatic-dev-flow';
const ports=vi.hoisted(()=>({profile:vi.fn(),current:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-ai-release-configuration',()=>({loadSavedAiReleaseConfiguration:ports.profile}));
vi.mock('./document-review-key',async original=>({...await original<typeof import('./document-review-key')>(),resolveSavedDocumentReviewKey:ports.current}));
type Input=Parameters<typeof runAutomaticDevMonth>[0];
async function setup(){
 const source=pensionFixture().input,orderId='55555555-5555-4555-8555-555555555555';
 source.purchased_scope={...source.purchased_scope,order_id:orderId,origin:'saved_order',topics:['pension']};source.entitlement_evidence!.order_id=orderId;
 const runtime=runtimeFixture(source),a=runtime.assessment_input,scope=a.current.scope,reviewSha=canonicalSha256(runtime.source),key='synthetic-qualified-callback';
 const f=buildSyntheticCaseFixture({fixture_id:'qualified-callback',mode:'real'});
 const command={...f.command,case_id:source.case_id,idempotency_key:key,document_review_sha256:reviewSha,population:scope.population,requested_topics:['pension' as const],period:{start_date:source.period.from,end_date:source.period.to},as_of:'2026-09-12'};
 const commandSha=canonicalSha256(command),runId=savedAnalysisId('case-analysis-run',commandSha);runtime.analysis_run_id=runId;
 const envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:command.case_revision,source_journal:{case_id:scope.case_id,input_revision:scope.input_revision,input_sha256:scope.input_sha256}});
 const selection=await new June2026ReviewCatalog().resolve({mode:'real',topic:'pension',target_date:source.period.to,as_of:command.as_of,sector:command.sector,population:command.population});
 const seed:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runId,case_id:source.case_id,case_revision:command.case_revision,
  period:command.period,as_of:command.as_of,document_snapshot_sha256:command.document_snapshot_sha256,extraction_snapshot_sha256:command.extraction_snapshot_sha256,
  declared_fact_snapshot_sha256:command.declared_fact_snapshot_sha256,facts_snapshot_sha256:scope.facts_sha256,facts:[],rule_inputs:[],catalog_sha256:selection.catalog_sha256,
  topic_results:[{topic:'pension',status:'blocked_legal_readiness',blockers:['legacy_catalog_not_activated'],rule_input_sha256:null,amount:null,trace:null,legal_readiness:selection.readiness}],
  known_subtotal:null,coverage_complete:false,document_review:envelope.result.review,ai_release:envelope};
 const bundle={...seed,result_sha256:canonicalSha256(seed)},report=renderAiReleaseBundle(bundle,savedAnalysisId('saved-report',bundle.result_sha256));
 const configBody={schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:orderId,revision:1,population:scope.population,build_manifest_sha256:'a'.repeat(64),policy:a.policy,registry:a.registry,source_receipts:a.source_receipts,interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts};
 const profile:SavedAiReleaseConfiguration={configuration:aiReleaseConfigurationSchema.parse({...configBody,sha256:canonicalSha256(configBody)}),trusted_generator_pins:runtime.trusted_generator_pins.map(pin=>{const family=AI_RELEASE_RUNTIME_FAMILIES.find(f=>f.family_id===pin.family_id);if(!family||pin.generator.id!==family.generator_id||pin.generator.version!==family.generator_version)throw Error('TEST_FAMILY_UNKNOWN');return {family_id:family.family_id,generator:{id:family.generator_id,version:family.generator_version,code_sha256:pin.generator.code_sha256}};}),
  enrollment_id:orderId,dependency_sha256:scope.authority_dependency_sha256,evaluated_at:a.current.evaluated_at,live_evaluated_at:a.current.evaluated_at,expires_at:a.policy.expires_at,profile_sha256:'b'.repeat(64),environment:'development',is_qa:true};
 ports.profile.mockResolvedValue(profile);ports.current.mockResolvedValue({key,reviewSha256:reviewSha});
 const order={id:orderId,kind:'full',from:'2026-06-01',to:'2026-06-01',topics:['pension'],offer_sha256:source.purchased_scope.receipt_sha256};
 const receipt={report_id:report.report_id,analysis_run_id:runId,published_at:'2026-09-12T10:00:00Z',replayed:false};
 const query=vi.fn(async(sql:PostgresStatement)=>{
  if(sql.name==='saved_order_entitlements')return {row_count:1,rows:[{orders:[order],current_orders:[order]}]};
  if(sql.name==='qualified_ai_report_publish')return {row_count:1,rows:[{value:receipt}]};throw Error('UNEXPECTED_QUERY');
 });
 const payload={report_sha256:report.report_sha256};
 const input:Input={context:{client:{query},transaction_id:'synthetic-current-adapters'},job:{schema_version:'saved-case-work-v1',case_id:scope.case_id,revision:scope.input_revision,input_sha256:scope.input_sha256,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:scope.authority_dependency_sha256},orderId,month:'2026-06',parent:{analysis_run_id:runId,idempotency_key:key,command_sha256:commandSha,command,completed:true,selections:[selection],bundle,report,stages:[{stage:'review_pending',payload,payload_sha256:canonicalSha256(payload)}],dependencies:{extraction_snapshot_sha256:command.extraction_snapshot_sha256,facts_snapshot_sha256:scope.facts_sha256,catalog_sha256:selection.catalog_sha256,source_version_ids:[],parameter_version_ids:[],rule_spec_versions:[],code_version:'case-analysis@0.6.8',template_version:AI_RELEASE_REPORT_TEMPLATE}}};
 return {input,query,receipt,profile};
}
beforeEach(()=>{ports.profile.mockReset();ports.current.mockReset();});
it('replays the ordinary calculated bundle and exact HTML/PDF before idempotent publication acknowledgement',async()=>{
 const f=await setup();await runAutomaticDevMonth(f.input);f.receipt.replayed=true;await runAutomaticDevMonth(f.input);
 expect(f.input.parent.bundle!.ai_release!.result.findings.length).toBeGreaterThan(0);
 const writes=f.query.mock.calls.filter(([s])=>s.name==='qualified_ai_report_publish');expect(writes).toHaveLength(2);
 expect(writes[0][0]).toEqual(writes[1][0]);expect(writes[0][0].values).toEqual([f.input.job.case_id,f.input.parent.analysis_run_id,f.input.parent.report!.report_id,f.input.parent.report!.report_sha256,f.input.parent.bundle!.ai_release!.sha256]);
});
it.each(['source','authority','artifact','stage','ack'] as const)('rejects changed %s without a replacement calculation',async kind=>{
 const f=await setup();if(kind==='source')ports.current.mockResolvedValue({key:'foreign',reviewSha256:'f'.repeat(64)});
 if(kind==='authority')ports.profile.mockResolvedValue({...f.profile,live_evaluated_at:'2026-09-14T00:00:00Z'});
 if(kind==='artifact')f.input.parent={...f.input.parent,report:{...f.input.parent.report!,pdf:Buffer.from('changed')}};
 if(kind==='stage')f.input.parent={...f.input.parent,stages:[]};
 if(kind==='ack')f.receipt.report_id='66666666-6666-4666-8666-666666666666';
 await expect(runAutomaticDevMonth(f.input)).rejects.toThrow();
 expect(f.query.mock.calls.filter(([s])=>s.name==='qualified_ai_report_publish')).toHaveLength(kind==='ack'?1:0);
});
