import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createAdmissionTestFixture} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
import {createRegularServiceTrustFixture} from '@/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import {prepareJune2026AdmittedContext} from '@/engine/minimum-wage-june2026/admitted-context';
import {prepareJune2026AssessmentPacket} from '@/engine/minimum-wage-june2026/assessment-packet';
import {createTopicRuleInputSnapshot} from '@/engine/rule-input/snapshot';
import {June2026RegularCatalog} from '@/engine/minimum-wage-june2026/regular-service/catalog';
import {June2026ReviewCatalog} from '@/engine/legal-operations/june2026-catalog';
import {June2026RegularExecutor} from '@/engine/minimum-wage-june2026/regular-service/executor';
import type {AnalysisResultBundle,CaseAnalysisCommand} from '@/engine/wave3/contracts';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {June2026RegularReportBuilder} from '../reports/june2026-regular-service';
import {SavedAnalysisDraftBuilder,savedAnalysisId} from './saved-draft-report';
import {loadSavedJune2026RegularAuthority,june2026RegularIdempotencyKey,june2026RegularReviewIdempotencyKey} from './saved-june2026-regular-authority';
import {SAVED_JUNE_REVIEW_VERSION} from './saved-minimum-wage-review';
import {runAutomaticDevMonth} from './automatic-dev-flow';

const ports=vi.hoisted(()=>({publish:vi.fn(),legacyAuthority:vi.fn(),financial:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../reports/publish-ai-report',()=>({publishSavedAiReport:ports.publish}));
vi.mock('./saved-june2026-test-authority',()=>({loadJune2026TestAuthority:ports.legacyAuthority,june2026TestIdempotencyKey:()=> 'old-test-key'}));
vi.mock('./dev-financial-analysis',()=>({runSavedDevFinancialMonth:ports.financial}));
type Input=Parameters<typeof runAutomaticDevMonth>[0];

// Actual synthetic signatures, catalog, executor and report; SQL authority and
// publication acknowledgements are explicit mocked ports. This proves callback
// composition, not database authorization or a live/provider/real-law approval.
async function fixture(){
 const f=createAdmissionTestFixture(),keys=createRegularServiceTrustFixture(),originalPacket=f.packet();
 const registry={registry:{namespace:keys.registry.namespace,organization_id:keys.registry.organization_id,
  organization_version:keys.registry.organization_version,policy_version:keys.registry.policy_version},trust_journal:keys.journal,legal:keys.legal};
 const assessment=keys.assessment(originalPacket,f.facts),registrySha=canonicalSha256(registry);
 const loaded={state:'loaded',registry,registry_sha256:registrySha,registry_revision:1,assessment,assessment_sha256:canonicalSha256(assessment),evaluated_at:keys.now};
 const sqlState:{authority:unknown;saveProjection:string|null}={authority:loaded,saveProjection:null};
 const ownerId=randomUUID(),query=vi.fn(async(sql:PostgresStatement)=>{
  if(sql.name==='june_regular_authority')return {rows:[{authority:sqlState.authority}],row_count:1};
  if(sql.name==='saved_order_entitlements'){
   const orders=[{id:originalPacket.current.order_id,kind:'full',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'a'.repeat(64)}];
   return {rows:[{orders,current_orders:orders}],row_count:1};
  }
  if(sql.name==='automatic_regular_saved_result')return {rows:[{value:{projection_id:sqlState.saveProjection??JSON.parse(String(sql.values[6])).id,identity_id:ownerId}}],row_count:1};
  throw Error('UNEXPECTED_LEGACY_OR_MUTATING_QUERY');
 });
 const context:PostgresTransactionContext={client:{query},transaction_id:'explicit-mock-regular-callback'};
 const job:Input['job']={schema_version:'saved-case-work-v1',case_id:f.facts.case_id,revision:originalPacket.current.input_revision,input_sha256:originalPacket.current.input_sha256,mode:'draft'};
 const orderId=originalPacket.current.order_id,authority=await loadSavedJune2026RegularAuthority(context,job,orderId);
 if(!authority||authority.state!=='ready')throw Error('TEST_AUTHORITY_REQUIRED');
 const key=june2026RegularIdempotencyKey(job,orderId,authority);
 const command:CaseAnalysisCommand={case_id:job.case_id,case_revision:job.revision,document_snapshot_id:`saved-documents:2026-06:${job.input_sha256}`,
  document_snapshot_sha256:f.checkpoint.input_sha256,extraction_snapshot_id:'synthetic-extraction',extraction_snapshot_sha256:f.checkpoint.result_sha256,
  declared_fact_snapshot_id:'synthetic-declarations',declared_fact_snapshot_sha256:canonicalSha256(f.collection),period:{start_date:'2026-06-01',end_date:'2026-06-30'},
  as_of:'2026-09-10',requested_topics:['minimum_wage'],sector:'general_private',population:'adult_general',mode:'synthetic_test',idempotency_key:key};
 const commandSha=canonicalSha256(command),runId=savedAnalysisId('case-analysis-run',commandSha),facts={...f.facts,analysis_run_id:runId};
 const factualContext=prepareJune2026AdmittedContext({...f.input,current:{...f.input.current,analysis_run_id:runId},saved:{...f.input.saved,analysis_run_id:runId},
  canonicalStage:{facts,facts_snapshot_sha256:canonicalSha256(facts)},ruleInput:createTopicRuleInputSnapshot(facts,'minimum_wage')});
 const packet=prepareJune2026AssessmentPacket({context:factualContext,facts});
 const selection=await new June2026RegularCatalog(authority.authority).resolve({mode:'synthetic_test',topic:'minimum_wage',target_date:'2026-06-30',as_of:'2026-09-10',sector:'general_private',population:'adult_general'});
 const executor=new June2026RegularExecutor({authority:authority.authority,packet,facts}),execution=await executor.execute({selection,rule_input:packet.rule_input,execution_id:randomUUID(),calculated_at:keys.now});
 const seed:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runId,case_id:job.case_id,case_revision:job.revision,
  period:command.period,as_of:command.as_of,document_snapshot_sha256:command.document_snapshot_sha256,extraction_snapshot_sha256:command.extraction_snapshot_sha256,
  declared_fact_snapshot_sha256:command.declared_fact_snapshot_sha256,facts_snapshot_sha256:canonicalSha256(facts),facts:facts.facts,rule_inputs:[packet.rule_input],catalog_sha256:selection.catalog_sha256,
  topic_results:[{topic:'minimum_wage',status:'calculated',blockers:[],rule_input_sha256:packet.rule_input.snapshot_sha256,amount:execution.amount,trace:execution.trace,legal_readiness:selection.readiness}],
  known_subtotal:execution.amount,coverage_complete:true};
 const bundle={...seed,result_sha256:canonicalSha256(seed)},builder=new June2026RegularReportBuilder({authority:authority.authority,executor,publicId:'TV-1234ABCD',offerSha256:'a'.repeat(64),reportKind:'full'});
 const report=await builder.build(bundle),diagnostic={schema_version:'saved-june2026-regular-diagnostics-v1',namespace:authority.authority.registry.namespace,
  authority_sha256:authority.authority.authority_sha256,registry_sha256:registrySha,assessment_sha256:loaded.assessment_sha256,admission:executor.admission,execution:executor.result,context_blocker:null};
 const review={report_sha256:report.report_sha256,auto_approved:false,export_eligible_before_review:false,diagnostics:diagnostic};
 const parent:Input['parent']={analysis_run_id:runId,idempotency_key:key,command_sha256:commandSha,command,stages:[{stage:'review_pending',payload:review,payload_sha256:canonicalSha256(review)}],
  selections:[selection],dependencies:null,bundle,report,completed:true};
 return {input:{context,job,orderId,month:'2026-06',parent} satisfies Input,sqlState,query,ownerId,loaded,diagnostic,document:builder.document!,execution:executor.result};
}
let saved:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{saved=await fixture();});
beforeEach(()=>{saved.sqlState.authority=saved.loaded;saved.sqlState.saveProjection=null;saved.query.mockClear();ports.publish.mockReset();ports.publish.mockResolvedValue({replayed:true});
 ports.legacyAuthority.mockReset();ports.financial.mockReset();});
const run=(input:Input=saved.input)=>runAutomaticDevMonth(input);

it('routes regular isolated execution before the old isolated-test guard and reuses its same-run save/publication boundaries',async()=>{
 const before=canonicalSha256(JSON.parse(Buffer.from(saved.input.parent.report!.json).toString('utf8')));
 await run();await run();
 const saves=saved.query.mock.calls.map(([s])=>s).filter(s=>s.name==='automatic_regular_saved_result');
 expect(saves).toHaveLength(2);expect(saves[0].values).toEqual(saves[1].values);
 expect(saves[0].values.slice(0,5)).toEqual([saved.input.job.case_id,saved.input.orderId,saved.input.job.revision,saved.input.job.input_sha256,saved.input.parent.analysis_run_id]);
 expect(JSON.parse(String(saves[0].values[5])).finding.potential_gap.minor_units).toBe(24058);
 expect(JSON.parse(String(saves[0].values[6])).id).toBe(saved.document.id);
 expect(ports.publish).toHaveBeenCalledTimes(2);expect(ports.publish).toHaveBeenLastCalledWith(saved.input.context,{caseId:saved.input.job.case_id,identityId:saved.ownerId,projectionId:saved.document.id});
 expect(canonicalSha256(JSON.parse(Buffer.from(saved.input.parent.report!.json).toString('utf8')))).toBe(before);
 expect(ports.legacyAuthority).not.toHaveBeenCalled();expect(ports.financial).not.toHaveBeenCalled();
});
it.each([null,{state:'blocked',reason:'case_assessment_revoked'},{state:'blocked',reason:'authority_expired_or_not_yet_valid'}])('refuses missing or invalid current authority before replay publication',async authority=>{
 saved.sqlState.authority=authority;await expect(run()).rejects.toThrow('REGULAR_MANAGED_CURRENT_AUTHORITY_REQUIRED');expect(ports.publish).not.toHaveBeenCalled();
});
it.each(['case','revision','hash','order','month','run','selection'] as const)('refuses changed %s binding before publication',async change=>{
 const input={...saved.input,job:{...saved.input.job},parent:structuredClone(saved.input.parent)};
 if(change==='case')input.job.case_id=randomUUID();if(change==='revision')input.job.revision++;if(change==='hash')input.job.input_sha256='b'.repeat(64);
 if(change==='order')input.orderId=randomUUID();if(change==='month')input.month='2026-07';
 if(change==='run')input.parent={...input.parent,analysis_run_id:randomUUID()};
 if(change==='selection')input.parent={...input.parent,selections:[{...input.parent.selections[0],catalog_sha256:'c'.repeat(64)}]};
 await expect(run(input)).rejects.toThrow();expect(ports.publish).not.toHaveBeenCalled();
 expect(saved.query.mock.calls.some(([s])=>s.name==='automatic_regular_saved_result')).toBe(false);
});
it('refuses edited diagnostic content even when its local stage hash is recomputed',async()=>{
 const parent=saved.input.parent,payload={report_sha256:parent.report!.report_sha256,diagnostics:{...saved.diagnostic,registry_sha256:'d'.repeat(64)}};
 await expect(run({...saved.input,parent:{...parent,stages:[{stage:'review_pending',payload,payload_sha256:canonicalSha256(payload)}]}})).rejects.toThrow('REGULAR_MANAGED_STAGE_BINDING');
 expect(ports.publish).not.toHaveBeenCalled();
});
it('does not publish a receipt for a different saved projection or a DB current-source refusal',async()=>{
 saved.sqlState.saveProjection=randomUUID();await expect(run()).rejects.toThrow('REGULAR_MANAGED_SAVE_ACK');expect(ports.publish).not.toHaveBeenCalled();
 saved.sqlState.saveProjection=null;saved.query.mockImplementationOnce(async()=>({rows:[{authority:saved.loaded}],row_count:1})).mockImplementationOnce(async()=>{throw Error('REGULAR_AUTHORITY_SOURCE_CHANGED');});
 await expect(run()).rejects.toThrow('REGULAR_AUTHORITY_SOURCE_CHANGED');expect(ports.publish).not.toHaveBeenCalled();
});
it('preserves a blocked regular draft without calling any financial publication or the old draft writer',async()=>{
 const original=saved.input.parent,b=original.bundle!,{result_sha256:omitted,...seed}=b;void omitted;
 const body={...seed,topic_results:b.topic_results.map(t=>({...t,status:'blocked_missing_facts' as const,blockers:['missing_input'],amount:null,trace:null})),known_subtotal:null,coverage_complete:false};
 const bundle={...body,result_sha256:canonicalSha256(body)},report=await new SavedAnalysisDraftBuilder().build(bundle);
 const payload={report_sha256:report.report_sha256,diagnostics:{...saved.diagnostic,execution:null,admission:null,context_blocker:'waiting_for_documented_input'}};
 await expect(run({...saved.input,parent:{...original,bundle,report,stages:[{stage:'review_pending',payload,payload_sha256:canonicalSha256(payload)}]}})).resolves.toBeUndefined();
 expect(saved.query.mock.calls.map(([s])=>s.name)).toEqual(['june_regular_authority']);expect(ports.publish).not.toHaveBeenCalled();expect(ports.financial).not.toHaveBeenCalled();
});

async function unsignedReview(){
 const input=saved.input,key=june2026RegularReviewIdempotencyKey(input.job,input.orderId);
 const command={...input.parent.command,idempotency_key:key,mode:'real' as const,sector:'unverified',population:'unverified'};
 const commandSha=canonicalSha256(command),runId=savedAnalysisId('case-analysis-run',commandSha);
 const facts={...saved.execution!.admission.effective_facts,analysis_run_id:runId},ruleInput=createTopicRuleInputSnapshot(facts,'minimum_wage');
 const selection=await new June2026ReviewCatalog().resolve({mode:'real',topic:'minimum_wage',target_date:'2026-06-30',as_of:command.as_of,sector:command.sector,population:command.population});
 const {result_sha256:omitted,...original}=input.parent.bundle!;void omitted;
 const body={...original,analysis_run_id:runId,facts_snapshot_sha256:canonicalSha256(facts),facts:facts.facts,rule_inputs:[ruleInput],catalog_sha256:selection.catalog_sha256,
  topic_results:[{topic:'minimum_wage' as const,status:'blocked_legal_readiness' as const,blockers:['signed_authority_required'],rule_input_sha256:ruleInput.snapshot_sha256,
   amount:null,trace:null,legal_readiness:selection.readiness}],known_subtotal:null,coverage_complete:false};
 const bundle={...body,result_sha256:canonicalSha256(body)},report=await new SavedAnalysisDraftBuilder().build(bundle);
 const payload={report_sha256:report.report_sha256,diagnostics:{schema_version:SAVED_JUNE_REVIEW_VERSION,case_id:input.job.case_id,analysis_run_id:runId,
  candidate_calculation_performed:false,findings_created:false,activation_allowed:false}};
 return {...input,parent:{...input.parent,analysis_run_id:runId,idempotency_key:key,command,command_sha256:commandSha,selections:[selection],bundle,report,
  stages:[{stage:'review_pending' as const,payload,payload_sha256:canonicalSha256(payload)}]}};
}
it('keeps a current unsigned REAL regular review waiting without creating an engineering calculation',async()=>{
 const input=await unsignedReview();saved.sqlState.authority=null;ports.legacyAuthority.mockResolvedValue(null);
 await expect(run(input)).resolves.toBeUndefined();
 expect(ports.financial).not.toHaveBeenCalled();expect(ports.publish).not.toHaveBeenCalled();
 expect(saved.query.mock.calls.map(([s])=>s.name)).toEqual(['june_regular_authority','saved_order_entitlements']);
});
it('refuses a cached unsigned review when current regular authority has arrived',async()=>{
 const input=await unsignedReview();ports.legacyAuthority.mockResolvedValue(null);
 await expect(run(input)).rejects.toThrow('REGULAR_MANAGED_REVIEW_AUTHORITY_CHANGED');expect(ports.financial).not.toHaveBeenCalled();
});
