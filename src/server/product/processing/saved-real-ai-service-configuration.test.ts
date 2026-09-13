import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import type {CaseAnalysisAiReleaseContext} from '@/engine/case-analysis/service';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {realAiServiceFixture,syntheticServiceId} from '../reports/real-ai-service.fixture';
import {loadSavedRealAiServiceConfiguration,prepareSavedRealAiServiceReview,savedRealAiServicePreparation,
 assertSavedRealAiServiceCurrent,savedRealAiServiceContextSchema} from './saved-real-ai-service-configuration';
import type {SourceJob} from './source-dispatch';

const changed='b'.repeat(64);
let fixture:ReturnType<typeof realAiServiceFixture>;
beforeAll(()=>{fixture=realAiServiceFixture();});
beforeEach(()=>vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1'));
afterEach(()=>vi.unstubAllEnvs());
function configured(){
 const {row,bundle}=fixture,envelope=bundle.ai_release!;
 const parsed=savedRealAiServiceContextSchema.parse({state:'configured',purpose:'real_customer_service',namespace:'real',is_qa:false,
  environment:row.current.assessment.environment,identity_id:row.current.identity_id,source_journal:envelope.binding.source_journal,
  configuration:fixture.configuration,configuration_sha256:fixture.configuration.sha256,enrollment_id:syntheticServiceId(7),
  dependency_sha256:row.current.assessment.scope.authority_dependency_sha256,service_decision:row.service_decision,service_decision_sha256:row.service_decision.sha256,
  enrollment_issued_at:'2026-09-12T02:00:00Z',evaluated_at:row.current.assessment.evaluated_at,expires_at:'2026-09-12T19:00:00Z',
  source_created_at:row.source_created_at,evidence:row.evidence,revocations:[]});
 if(parsed.state!=='configured')throw Error('TEST_CONFIGURATION_REQUIRED');return parsed;
}
function job():SourceJob{
 const scope=fixture.row.current.assessment.scope;
 return {schema_version:'saved-case-work-v1',case_id:scope.case_id,revision:scope.input_revision,input_sha256:scope.input_sha256,
  mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:scope.authority_dependency_sha256};
}
function context(value:unknown){
 const query=vi.fn(async()=>({row_count:1,rows:[{context:value}]}));
 return {query,context:{client:{query}} as unknown as PostgresTransactionContext};
}
function reseal<T extends {sha256:string}>(value:T):T{const {sha256,...body}=value;void sha256;return {...body,sha256:canonicalSha256(body)} as T;}
function pins():CaseAnalysisAiReleaseContext{
 const envelope=fixture.bundle.ai_release!,scope=envelope.input.assessment_input.current.scope,source=envelope.input.source;
 return {analysis_run_id:envelope.input.analysis_run_id,case_id:scope.case_id,command_sha256:changed,
  facts_snapshot_sha256:scope.facts_sha256,rule_inputs:[],document_review_input:source,source_journal:envelope.binding.source_journal,previous_ai_release:null,
  facts:{snapshot_id:syntheticServiceId(8),case_id:scope.case_id,analysis_run_id:envelope.input.analysis_run_id,schema_version:'v1',facts:[],created_at:envelope.input.assessment_input.current.evaluated_at},
  command:{case_id:scope.case_id,case_revision:7,document_review_sha256:canonicalSha256(source),document_snapshot_id:syntheticServiceId(9),document_snapshot_sha256:changed,
   extraction_snapshot_id:syntheticServiceId(10),extraction_snapshot_sha256:changed,declared_fact_snapshot_id:syntheticServiceId(11),declared_fact_snapshot_sha256:changed,
   period:{start_date:source.period.from,end_date:source.period.to},as_of:'2026-09-12',requested_topics:['pension'],sector:'synthetic',population:scope.population,mode:'real',idempotency_key:'synthetic-real-preparation'}};
}

describe('authenticated REAL saved configuration uses the ordinary release machinery',()=>{
 it('loads a frozen, source-bound REAL profile without publication or notification authority',async()=>{
  const c=context(configured()),profile=await loadSavedRealAiServiceConfiguration(c.context,job());
  expect(profile).toMatchObject({purpose:'real_customer_service',namespace:'real',is_qa:false,publication_allowed:false,notification_allowed:false});
  expect(Object.isFrozen(profile)).toBe(true);expect(Object.isFrozen(profile.configuration)).toBe(true);
  expect(c.query.mock.calls).toHaveLength(1);
  expect(profile.evaluated_at).toBe(fixture.row.source_created_at);
  const later=await loadSavedRealAiServiceConfiguration(context({...configured(),evaluated_at:'2026-09-12T11:00:00Z'}).context,job());
  expect(later.profile_sha256).toBe(profile.profile_sha256);expect(later.live_evaluated_at).not.toBe(profile.live_evaluated_at);
 });
 it('runs the existing automatic assessment and ordinary envelope executor with actual compiled pins',async()=>{
  const c=context(configured()),profile=await loadSavedRealAiServiceConfiguration(c.context,job());
  const input={...pins(),document_review_input:prepareSavedRealAiServiceReview(pins().document_review_input,profile)};
  const prepared=await savedRealAiServicePreparation(c.context,job(),profile)(input);
  expect(c.query.mock.calls).toHaveLength(2);expect(prepared.assessment_input.current).toMatchObject({namespace:'real',is_qa:false});
  const original=fixture.bundle.ai_release!;
  const envelope=createCaseAnalysisAiRelease({...original.input,...prepared},original.binding);
  expect(envelope.result.admission.state).toBe('admitted');
  expect(envelope.result.checks.some(c=>c.topic==='pension'&&c.state==='calculated')).toBe(true);
  expect(()=>assertSavedRealAiServiceCurrent(envelope,profile)).not.toThrow();
 });
 it('does not accept copied caller JSON as an authenticated profile',async()=>{
  const profile=await loadSavedRealAiServiceConfiguration(context(configured()).context,job()),copy=structuredClone(profile);
  expect(()=>prepareSavedRealAiServiceReview(pins().document_review_input,copy)).toThrow('REAL_SERVICE_PROCESSING_LOADER_REQUIRED');
  expect(()=>savedRealAiServicePreparation(context(configured()).context,job(),copy)).toThrow('REAL_SERVICE_PROCESSING_LOADER_REQUIRED');
 });
 it.each(['absent','expired','revoked','unscoped','forbidden'] as const)('fails closed for %s enrollment',async reason=>{
  const value=reason==='absent'?{state:'absent'}:{state:'unavailable',reason,dependency_sha256:changed};
  await expect(loadSavedRealAiServiceConfiguration(context(value).context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_');
 });
 it('requires enabled host and an explicitly enrolled draft work item before SQL',async()=>{
  const c=context(configured());vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');
  await expect(loadSavedRealAiServiceConfiguration(c.context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_DISABLED');
  vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');
  for(const mutation of [{processing_profile:undefined},{authority_dependency_sha256:undefined},{mode:'live' as const}])
   await expect(loadSavedRealAiServiceConfiguration(c.context,{...job(),...mutation})).rejects.toThrow('REAL_SERVICE_');
  expect(c.query).not.toHaveBeenCalled();
 });
 it.each([{purpose:'owner_engineering'},{namespace:'isolated_test'},{is_qa:true}])('rejects owner/QA scope %j',async mutation=>{
  await expect(loadSavedRealAiServiceConfiguration(context({...configured(),...mutation}).context,job())).rejects.toThrow();
 });
 it.each(['dependency','source_revision','source_hash','case'] as const)('rejects superseded %s',async kind=>{
  const row=configured();
  if(kind==='dependency')row.dependency_sha256=changed;
  if(kind==='source_revision')row.source_journal.input_revision++;
  if(kind==='source_hash')row.source_journal.input_sha256=changed;
  if(kind==='case')row.source_journal.case_id=syntheticServiceId(20);
  await expect(loadSavedRealAiServiceConfiguration(context(row).context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_SOURCE_SUPERSEDED');
 });
 it.each(['expired','future','overlong'] as const)('rejects an %s enrollment interval',async kind=>{
  const row=configured();if(kind==='expired')row.evaluated_at=row.expires_at;if(kind==='future')row.enrollment_issued_at='2026-09-12T12:00:00Z';
  if(kind==='overlong')row.expires_at='2026-09-12T21:00:00Z';
  await expect(loadSavedRealAiServiceConfiguration(context(row).context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_ENROLLMENT_');
 });
 it.each(['inactive','source_only','foreign_review','renderer'] as const)('rejects %s action authority',async kind=>{
  const row=configured(),decision=row.service_decision;
  if(kind==='inactive')decision.status='proposed_not_activated';
  if(kind==='source_only')decision.action_reviews=decision.action_reviews.filter(r=>r.action==='A01'||r.action==='A03');
  if(kind==='foreign_review')decision.action_reviews[0].interpretation_receipt_sha256=changed;
  if(kind==='renderer')decision.renderer.code_sha256=changed;
  row.service_decision=reseal(decision);row.service_decision_sha256=row.service_decision.sha256;
  await expect(loadSavedRealAiServiceConfiguration(context(row).context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_');
 });
 it.each(['missing','corrupted','duplicate'] as const)('requires actual %s evidence bytes',async kind=>{
  const row=configured();if(kind==='missing')row.evidence.shift();if(kind==='corrupted')row.evidence[0].content_base64=Buffer.from('changed').toString('base64');
  if(kind==='duplicate')row.evidence.push(row.evidence[0]);
  await expect(loadSavedRealAiServiceConfiguration(context(row).context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_');
 });
 it('clips future revocation and rejects it at the DB clock boundary',async()=>{
  const row=configured();row.revocations=[{target_sha256:row.service_decision.sha256,effective_at:'2026-09-12T11:00:00Z'}];
  const profile=await loadSavedRealAiServiceConfiguration(context(row).context,job());expect(profile.expires_at).toBe('2026-09-12T11:00:00.000Z');
  await expect(loadSavedRealAiServiceConfiguration(context({...row,evaluated_at:'2026-09-12T11:00:00Z'}).context,job())).rejects.toThrow('REAL_SERVICE_PROCESSING_REVOKED');
 });
 it('reloads genuine REAL authority before preparing and rejects a revoked enrollment',async()=>{
  const c=context(configured()),profile=await loadSavedRealAiServiceConfiguration(c.context,job());
  c.query.mockResolvedValueOnce({row_count:1,rows:[{context:{state:'unavailable',reason:'revoked',dependency_sha256:profile.dependency_sha256}}]});
  await expect(savedRealAiServicePreparation(c.context,job(),profile)(pins())).rejects.toThrow('REAL_SERVICE_PROCESSING_REVOKED');
 });
 it('does not resume an isolated-test envelope or accept bookkeeping command mode as authority',async()=>{
  const c=context(configured()),profile=await loadSavedRealAiServiceConfiguration(c.context,job());
  const input={...pins(),previous_ai_release:structuredClone(fixture.bundle.ai_release!)};input.previous_ai_release.input.assessment_input.current.namespace='isolated_test';
  input.previous_ai_release.input.assessment_input.current.is_qa=true;
  await expect(savedRealAiServicePreparation(c.context,job(),profile)(input)).rejects.toThrow('REAL_SERVICE_PROCESSING_ENVELOPE_SCOPE');
  await expect(savedRealAiServicePreparation(c.context,job(),profile)({...pins(),command:{...pins().command,mode:'synthetic_test'}})).rejects.toThrow('REAL_SERVICE_PROCESSING_COMMAND_SCOPE');
 });
});
