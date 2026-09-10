import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {findingSchema,findingV1Schema,findingV2Schema} from '../../findings/contracts.ts';
import {createAdmissionTestFixture} from '../evidence-admission.test-fixtures.ts';
import {createRegularServiceTrustFixture} from './regular-service.test-fixtures.ts';
import {createJune2026RegularAuthority,assertJune2026RegularAuthority} from './authority.ts';
import {resolveJune2026RegularEvidence} from './evidence.ts';
import {June2026RegularCatalog} from './catalog.ts';
import {June2026RegularExecutor} from './executor.ts';
import {june2026CaseAssessmentSchema} from './contracts.ts';
import {prepareJune2026AdmittedContext} from '../admitted-context.ts';
import {prepareJune2026AssessmentPacket} from '../assessment-packet.ts';
import {createTopicRuleInputSnapshot} from '../../rule-input/snapshot.ts';
import {replaySavedRegularTrust} from '../../../server/product/processing/saved-regular-trust.ts';
import {JUNE2026_COMPONENT_DECLARATIONS,JUNE2026_DECLARATION_OPTIONS} from '../collection.ts';
vi.mock('server-only',()=>({}));

function setup(){const f=createAdmissionTestFixture(),packet=f.packet(),keys=createRegularServiceTrustFixture();return {f,packet,keys,input:keys.input(packet,f.facts)};}
function ready(input:Parameters<typeof createJune2026RegularAuthority>[0]){const result=createJune2026RegularAuthority(input);expect(result).toMatchObject({state:'ready'});if(result.state!=='ready')throw Error(result.blockers.join(','));return result.authority;}
const selectionInput={mode:'synthetic_test' as const,topic:'minimum_wage' as const,target_date:'2026-06-30',as_of:'2026-09-10',sector:'general_private',population:'adult_general'};

describe('signed June regular-service bridge',()=>{
 it('replays real Ed25519/PoP registry, six complete lifecycle histories, and the independently specified 24058 result',async()=>{
  const {f,packet,input,keys}=setup();const before=canonicalSha256(f.facts);
  const authority=ready({...input,trust:replaySavedRegularTrust(keys.journal,keys.now)});
  const later=new Date(Date.parse(keys.now)+60_000).toISOString();
  const retryAuthority=ready({...input,evaluatedAt:later,trust:replaySavedRegularTrust(keys.journal,later)});
  expect(retryAuthority.authority_sha256).toBe(authority.authority_sha256);
  expect(authority.real_legal_authority).toBe(false);expect(authority.registry.namespace).toBe('isolated_test');expect(authority.artifacts).toHaveLength(6);
  const selection=await new June2026RegularCatalog(authority).resolve(selectionInput);expect(selection.readiness.status).toBe('READY');
  const executor=new June2026RegularExecutor({authority,packet,facts:f.facts});expect(executor.admission.execution_allowed).toBe(true);
  const command={selection,rule_input:packet.rule_input,execution_id:randomUUID(),calculated_at:keys.now};
  const result=await executor.execute(command);
  // Independent integer arithmetic: round(644385 * 100 / 182) - 330000.
  expect(result.amount).toEqual({currency:'ILS',minor_units:24058});
  expect(executor.result?.comparison.expected.minor_units).toBe(354058);
  expect(executor.result?.finding?.potential_gap?.minor_units).toBe(24058);
  expect(executor.result?.finding?.evidence_references).toEqual(expect.arrayContaining([expect.objectContaining({source_type:'documented'})]));
  expect(executor.result?.finding?.confidence_tier).toBe('medium');expect(executor.result?.finding?.status).toBe('candidate');
  expect(canonicalSha256(f.facts)).toBe(before);expect(await executor.execute(command)).toEqual(result);
  const v2=executor.result!.finding!;expect(findingSchema.parse(v2)).toEqual(v2);expect(findingV1Schema.safeParse(v2).success).toBe(false);
  expect(findingSchema.safeParse(executor.result!.comparison).success).toBe(false);
  for(const changed of [
   {...v2,analysis_run_id:randomUUID()}, {...v2,potential_gap:{currency:'ILS',minor_units:24000}},
   {...v2,fact_references:[randomUUID()]}, {...v2,authority:{...v2.authority,real_legal_authority:true}},
   {...v2,calculation_trace:{...v2.calculation_trace,trace_sha256:'a'.repeat(64)}},
  ])expect(findingV2Schema.safeParse(changed).success).toBe(false);
  await expect(executor.execute({...command,rule_input:{...packet.rule_input,snapshot_sha256:'a'.repeat(64)}})).rejects.toThrow('RULE_INPUT_BINDING');
 });
 it('refuses missing, expired, wrong namespace, wrong source, removed approval, unsigned activation and forged authority',()=>{
  const {input}=setup();
  const changed={...input.legal,artifacts:input.legal.artifacts.map((a,i)=>i?a:{...a,events:a.events.filter(e=>e.kind!=='source_review')})};
  const unsigned={...input.legal,artifacts:input.legal.artifacts.map((a,i)=>i?a:{...a,events:a.events.map((e,n)=>n===a.events.length-1?{...e,envelope:null}:e)})};
  const wrongSource={...input.legal,artifacts:input.legal.artifacts.map((a,i)=>i?a:{...a,import:{...a.import,content_sha256:'f'.repeat(64)}})};
  for(const bad of [
   {...input,legal:{...input.legal,artifacts:[]}}, {...input,evaluatedAt:'2026-09-11T16:00:00.000Z'},
   {...input,mode:'real' as const}, {...input,mode:'real' as const,registry:{...input.registry,namespace:'real' as const}},
   {...input,legal:changed}, {...input,legal:unsigned}, {...input,legal:wrongSource},
  ])expect(createJune2026RegularAuthority(bad).state).toBe('blocked');
  const authority=ready(input);expect(()=>assertJune2026RegularAuthority(structuredClone(authority))).toThrow('AUTHENTICATED_AUTHORITY');
 });
 it('honors current key revocation from the complete journal instead of accepting a previously signed old registry head',()=>{
  const {input,keys}=setup();
  const journal=structuredClone(keys.journal);journal.events.push({kind:'revoke',at:keys.now,key_id:'isolated.june.key.case',effective_at:keys.now,
   reason_code:'SYNTHETIC_TEST_REVOCATION',actor:'isolated.june.admin'});
  expect(createJune2026RegularAuthority({...input,registry:{...input.registry,registry_sha256:canonicalSha256(journal)},trust:replaySavedRegularTrust(journal,keys.now)}).state).toBe('blocked');
 });
 it('blocks absent, stale, expired, unknown and conflicted evidence without converting signed assumptions to facts',()=>{
  const {f,packet,input}=setup(),authority=ready(input);
  for(const state of ['missing','stale','expired','unknown','conflicted'] as const){
   const {packet_sha256:old,...body}=packet;void old;
   const changed={...body,gates:body.gates.map((gate,index)=>index?gate:{...gate,state})};
   const result=resolveJune2026RegularEvidence({authority,facts:f.facts,packet:{...changed,packet_sha256:canonicalSha256(changed)}});
   expect(result.execution_allowed).toBe(false);expect(result.blockers).toContain(`applicability.age_18_entire_month:${state}`);
  }
  const changedFacts=structuredClone(f.facts);changedFacts.facts[0].confidence=0.5;
  expect(()=>resolveJune2026RegularEvidence({authority,packet,facts:changedFacts})).toThrow('CONTEXT_HASH');
 });
 it('admits only exact separately signed declared-hours input, preserving its source and original canonical snapshot',async()=>{
  const f=createAdmissionTestFixture(false);const hours=f.facts.facts.find(f=>f.path==='work.regular_hours')!;
  hours.status='needs_confirmation';hours.confidence=0.8;
  hours.provenance=[{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:randomUUID(),answer_revision:1}}];
  f.extraction.fields=f.extraction.fields.filter(f=>f.field!=='regular_hours');f.repin();
  const yes=JUNE2026_DECLARATION_OPTIONS[0],no=JUNE2026_DECLARATION_OPTIONS[1];
  f.addAnswer({kind:'applicability',field:'age_18_entire_month'},yes);
  f.addAnswer({kind:'applicability',field:'sector'},'Synthetic ordinary office employer');
  f.addAnswer({kind:'applicability',field:'hours_rest_law_applies'},'Synthetic supervised hourly clerk');
  f.addAnswer({kind:'applicability',field:'no_better_minimum_wage_arrangement'},no);
  f.addAnswer({kind:'applicability',field:'no_adapted_minimum_wage'},no);
  f.addAnswer({kind:'applicability',field:'regular_hours_exclude_absence_overtime_rest'},yes);
  f.addAnswer({kind:'earnings_completeness'},yes);f.addAnswer({kind:'component',componentId:f.component.component_id},JUNE2026_COMPONENT_DECLARATIONS.base_salary);
  const packet=f.packet(),keys=createRegularServiceTrustFixture(),input=keys.input(packet,f.facts),authority=ready(input);
  expect(packet.factual_issues).toEqual([{field:'work.regular_hours',reason:'declared_hours_assessment_required'}]);
  const original=canonicalSha256(f.facts),executor=new June2026RegularExecutor({authority,packet,facts:f.facts});
  expect(executor.admission.execution_allowed).toBe(true);
  expect(executor.admission.fact_admissions).toHaveLength(1);expect(executor.admission.effective_facts_snapshot_sha256).not.toBe(original);
  const admitted=executor.admission.effective_facts.facts.find(f=>f.fact_id===hours.fact_id)!;
  expect(admitted.status).toBe('confirmed');expect(admitted.provenance).toEqual(hours.provenance);expect(admitted.confidence).toBe(0.8);
  const selection=await new June2026RegularCatalog(authority).resolve(selectionInput);
  expect((await executor.execute({selection,rule_input:packet.rule_input,execution_id:randomUUID(),calculated_at:keys.now})).amount?.minor_units).toBe(24058);
  expect(canonicalSha256(f.facts)).toBe(original);expect(hours.status).toBe('needs_confirmation');
  const without={...june2026CaseAssessmentSchema.parse(input.assessment.payload),hours_acceptance:null};
  expect(createJune2026RegularAuthority({...input,assessment:{...input.assessment,payload:without}}).state).toBe('blocked');
  // The real service reprojects every canonical ID for the authority-bound
  // analysis run. A source answer must remain usable without signing a hash
  // that itself depends on the resulting signed assessment/idempotency key.
  const oldRun=f.facts.analysis_run_id,oldHoursId=hours.fact_id;
  const nextRun=randomUUID(),nextFacts={...structuredClone(f.facts),analysis_run_id:nextRun,snapshot_id:randomUUID(),created_at:keys.now};
  for(const fact of nextFacts.facts){fact.fact_id=randomUUID();fact.created_at=keys.now;}
  const nextHours=nextFacts.facts.find(f=>f.path==='work.regular_hours')!;
  const nextInput={...structuredClone(f.input),current:{...f.input.current,analysis_run_id:nextRun},saved:{...f.input.saved,analysis_run_id:nextRun},
   canonicalStage:{facts:nextFacts,facts_snapshot_sha256:canonicalSha256(nextFacts)},ruleInput:createTopicRuleInputSnapshot(nextFacts,'minimum_wage')};
  const packetFor=(facts:typeof nextFacts)=>prepareJune2026AssessmentPacket({context:prepareJune2026AdmittedContext({...nextInput,
   canonicalStage:{facts,facts_snapshot_sha256:canonicalSha256(facts)},ruleInput:createTopicRuleInputSnapshot(facts,'minimum_wage')}),facts});
  const nextPacket=packetFor(nextFacts),nextExecutor=new June2026RegularExecutor({authority,packet:nextPacket,facts:nextFacts});
  expect(nextExecutor.admission.execution_allowed).toBe(true);expect(nextRun).not.toBe(oldRun);expect(nextHours.fact_id).not.toBe(oldHoursId);
  const acceptance=june2026CaseAssessmentSchema.parse(input.assessment.payload).hours_acceptance!;
  expect(nextExecutor.admission.fact_admissions[0]).toMatchObject({fact_id:nextHours.fact_id,declared_answer:{request_id:acceptance.request_id,
   answer_revision:acceptance.answer_revision,provenance_sha256:acceptance.provenance_sha256}});
  expect((await nextExecutor.execute({selection,rule_input:nextPacket.rule_input,execution_id:randomUUID(),calculated_at:keys.now})).amount?.minor_units).toBe(24058);
  expect(nextExecutor.result?.trace.analysis_run_id).toBe(nextRun);
  const originalHours=structuredClone(nextHours);
  const reference=originalHours.provenance[0];
  if(reference.source_type!=='declared'||reference.source_reference.kind!=='case_request_answer')throw Error('TEST_DECLARATION_REQUIRED');
  for(const changed of [
   {...reference,source_reference:{...reference.source_reference,request_id:randomUUID()}},
   {...reference,source_reference:{...reference.source_reference,answer_revision:2}},
  ]){
   const altered=structuredClone(nextFacts);altered.facts.find(f=>f.path==='work.regular_hours')!.provenance=[changed];
   expect(new June2026RegularExecutor({authority,packet:packetFor(altered),facts:altered}).admission.blockers).toContain('work.regular_hours:identified_declaration_assessment_required');
  }
  const ambiguous=structuredClone(nextFacts);ambiguous.facts.find(f=>f.path==='work.regular_hours')!.provenance=[reference,reference];
  expect(new June2026RegularExecutor({authority,packet:packetFor(ambiguous),facts:ambiguous}).admission.execution_allowed).toBe(false);
  const alteredAmount=structuredClone(nextFacts),amountFact=alteredAmount.facts.find(f=>f.path==='work.regular_hours')!;
  if(amountFact.path!=='work.regular_hours'||!amountFact.value)throw Error('TEST_HOURS_REQUIRED');
  amountFact.value={...amountFact.value,amount:'101'};
  expect(new June2026RegularExecutor({authority,packet:packetFor(alteredAmount),facts:alteredAmount}).admission.blockers).toContain('work.regular_hours:identified_declaration_assessment_required');
 });
});
