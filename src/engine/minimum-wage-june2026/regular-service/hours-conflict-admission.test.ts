import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {createHoursConflictDeclaration,hoursConflictTargetSchema,hasHoursConflictObservations} from '../../extraction/hours-conflict.ts';
import {HOURS_CONFLICT_ANSWER_VERSION,parseHoursConflictAnswer} from '../../extraction/hours-conflict-answer.ts';
import {createAdmissionTestFixture,admissionTestExtractionPolicy,admissionTestNow} from '../evidence-admission.test-fixtures.ts';
import {JUNE2026_COMPONENT_DECLARATIONS,JUNE2026_DECLARATION_OPTIONS} from '../collection.ts';
import {createRegularServiceTrustFixture} from './regular-service.test-fixtures.ts';
import {createJune2026RegularAuthority} from './authority.ts';
import {June2026RegularExecutor} from './executor.ts';
import {June2026RegularCatalog} from './catalog.ts';
import {deriveJune2026HoursConflictFacts} from './hours-conflict-admission.ts';
import {assertJune2026RegularSourceAdmission,june2026RegularSourceAdmissionV1Schema,june2026RegularSourceAdmissionV2Schema} from './source-admission.ts';
import {createSourceCalculationTrace} from '../../calculations/source-trace.ts';
vi.mock('server-only',()=>({}));

/** Synthetic observations, customer identity and test-only signing registry.
 * The target exercises pure binding, not live OCR, DB currentness or a human. */
function fixture(omitted=false){
 const f=createAdmissionTestFixture(false),original=f.extraction.fields.find(r=>r.field==='regular_hours')!;
 const observations=omitted?[]:['100','120'].map((amount,index)=>({...original,field:'regular_hours' as const,candidate_id:randomUUID(),raw_value:amount,
  normalized_value:{amount,unit:'hours_per_month' as const},source:{document_id:f.checkpoint.version_id,page:1,text_fragment:`Synthetic printed regular hours ${index}: ${amount}`}}));
 f.extraction.fields=[...f.extraction.fields.filter(r=>r.field!=='regular_hours'),...observations];f.extraction.warnings.push('conflicting_values');
 const hours=f.facts.facts.find(f=>f.path==='work.regular_hours')!;hours.status=omitted?'missing':'conflicted';hours.value=null;hours.confidence=.6;
 hours.conflicting_fact_ids=omitted?[]:[randomUUID(),randomUUID()];
 hours.provenance=observations.length?observations.map(row=>({source_type:'documented' as const,source_reference:{kind:'document' as const,document_id:row.source.document_id,
  locator:{page:row.source.page,text_span:row.source.text_fragment}},read_by:'machine' as const,verified:false})):
  [{source_type:'documented',source_reference:{kind:'document',document_id:f.checkpoint.version_id},read_by:'machine',verified:false}];
 f.repin();
 const yes=JUNE2026_DECLARATION_OPTIONS[0],no=JUNE2026_DECLARATION_OPTIONS[1];
 f.addAnswer({kind:'applicability',field:'age_18_entire_month'},yes);f.addAnswer({kind:'applicability',field:'sector'},'Synthetic ordinary office employer');
 f.addAnswer({kind:'applicability',field:'hours_rest_law_applies'},'Synthetic supervised hourly clerk');
 f.addAnswer({kind:'applicability',field:'no_better_minimum_wage_arrangement'},no);f.addAnswer({kind:'applicability',field:'no_adapted_minimum_wage'},no);
 f.addAnswer({kind:'applicability',field:'regular_hours_exclude_absence_overtime_rest'},yes);f.addAnswer({kind:'earnings_completeness'},yes);
 f.addAnswer({kind:'component',componentId:f.component.component_id},JUNE2026_COMPONENT_DECLARATIONS.base_salary);
 const packet=f.packet(),keys=createRegularServiceTrustFixture();
 const body={schema_version:'document-hours-conflict-target-v1',case_id:f.facts.case_id,order_id:packet.current.order_id,
  product_document_id:f.checkpoint.product_document_id,version_id:f.checkpoint.version_id,source_sha256:f.checkpoint.input_sha256,month:'2026-06',
  extraction_policy_version:admissionTestExtractionPolicy,extraction_result_sha256:f.checkpoint.result_sha256,source_page_count:1,
  reason:omitted?'provider_reported_conflict':'conflicting_observations',observations,source_warning_flags:f.extraction.warnings};
 const target=hoursConflictTargetSchema.parse({...body,target_sha256:canonicalSha256(body)});
 const declaration=createHoursConflictDeclaration({target,request_id:randomUUID(),answer_revision:2,identity_id:randomUUID(),answered_at:admissionTestNow,
  answer:{schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'declared',hours:'100',basis:'Synthetic time sheet records 100 ordinary hours; 120 includes a different scope.'}});
 const input=keys.input(packet,f.facts,declaration),loaded=createJune2026RegularAuthority(input);
 if(loaded.state!=='ready')throw Error(loaded.blockers.join(','));
 return {f,packet,keys,target,declaration,input,authority:loaded.authority};
}
async function execute(f:ReturnType<typeof fixture>){
 const executor=new June2026RegularExecutor({authority:f.authority,packet:f.packet,facts:f.f.facts,hoursConflictDeclaration:f.declaration});
 const selection=await new June2026RegularCatalog(f.authority).resolve({mode:'synthetic_test',topic:'minimum_wage',target_date:'2026-06-30',as_of:'2026-09-10',sector:'general_private',population:'adult_general'});
 expect(executor.admission.blockers).toEqual([]);
 const output=await executor.execute({selection,rule_input:f.packet.rule_input,execution_id:randomUUID(),calculated_at:f.keys.now});
 return {executor,output};
}
const rehash=<T extends {binding_sha256:string}>(value:T)=>{const {binding_sha256,...seed}=value;void binding_sha256;return {...seed,binding_sha256:canonicalSha256(seed)};};

describe('explicitly assessed conflict declaration, original OCR preserved',()=>{
 it.each([false,true])('calculates independently expected 24058 with omitted=%s only after identified basis and signed assessment',async omitted=>{
  const f=fixture(omitted),before=canonicalSha256(f.f.facts),rawBefore=canonicalSha256(f.f.checkpoint);
  const blocked=new June2026RegularExecutor({authority:f.authority,packet:f.packet,facts:f.f.facts});
  expect(blocked.admission.execution_allowed).toBe(false);
  const {executor,output}=await execute(f);
  expect(output.amount).toEqual({currency:'ILS',minor_units:Math.round(644385*100/182)-330000});
  expect(output.amount?.minor_units).toBe(24058);expect(executor.result?.certainty).toBe('medium');
  expect(output.trace).toMatchObject({analysis_run_id:f.f.facts.analysis_run_id});
  expect(executor.admission.effective_facts.facts.find(v=>v.path==='work.regular_hours')).toMatchObject({status:'confirmed',confidence:.6,provenance:f.declaration.provenance,value:{amount:'100',unit:'hours_per_month'}});
  expect(canonicalSha256(f.f.facts)).toBe(before);expect(canonicalSha256(f.f.checkpoint)).toBe(rawBefore);
  const proof=output.source_admission!,trace=executor.result!.trace;
  expect(june2026RegularSourceAdmissionV1Schema.safeParse(proof).success).toBe(false);
  expect(june2026RegularSourceAdmissionV2Schema.parse(proof)).toEqual(proof);
  expect(proof.verification).toBe('signed_assessment_binding_only');
  expect(assertJune2026RegularSourceAdmission(JSON.parse(JSON.stringify(proof)),trace,{case_id:f.f.facts.case_id,analysis_run_id:f.f.facts.analysis_run_id,
   facts_snapshot_sha256:before,facts:f.f.facts.facts,rule_inputs:[f.packet.rule_input]},f.packet.rule_input.snapshot_sha256)).toEqual(proof);
  expect(createJune2026RegularAuthority({...f.input,mode:'real'}).state).toBe('blocked');
 });
 it('does not admit unknown, blank basis, invented source rows, another case, or confirmed parent hours',()=>{
  const f=fixture();expect(parseHoursConflictAnswer(JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'unknown',basis:''})).state).toBe('unknown');
  expect(()=>createHoursConflictDeclaration({...f.declaration,answer:{schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'unknown',basis:''} as never})).toThrow();
  for(const answer of [{...f.declaration.answer,basis:''},{...f.declaration.answer,hours:'0100'},{...f.declaration.answer,hours:'183'}])
   expect(()=>createHoursConflictDeclaration({...f.declaration,answer})).toThrow();
  expect(()=>deriveJune2026HoursConflictFacts({...f.f.facts,case_id:randomUUID()},f.declaration)).toThrow();
  const changed={...f.f.facts,facts:f.f.facts.facts.map(row=>row.path==='work.regular_hours'?{...row,status:'confirmed' as const,conflicting_fact_ids:[],value:{amount:'100',unit:'hours_per_month' as const}}:row)};
  expect(()=>deriveJune2026HoursConflictFacts(changed,f.declaration)).toThrow('CONFLICT_PARENT');
  const single=f.target.observations.slice(0,1);
  expect(hasHoursConflictObservations({fields:single,warnings:['conflicting_values']})).toBe(false);
  expect(hasHoursConflictObservations({fields:[],warnings:['conflicting_values']})).toBe(true);
 });
 it('refuses changed answer revision, source/checkpoint, original observations or additional effective fact changes',async()=>{
  const f=fixture();
  const altered=createHoursConflictDeclaration({target:f.target,request_id:f.declaration.request_id,answer_revision:3,identity_id:f.declaration.identity_id,
   answered_at:f.declaration.answered_at,answer:f.declaration.answer});
  expect(()=>new June2026RegularExecutor({authority:f.authority,packet:f.packet,facts:f.f.facts,hoursConflictDeclaration:altered})).toThrow('CONFLICT_ASSESSMENT');
  const {executor,output}=await execute(f),trace=executor.result!.trace,scope={case_id:f.f.facts.case_id,analysis_run_id:f.f.facts.analysis_run_id,
   facts_snapshot_sha256:canonicalSha256(f.f.facts),facts:f.f.facts.facts,rule_inputs:[f.packet.rule_input]};
  for(const proof of [rehash({...output.source_admission!,analysis_run_id:randomUUID()}),rehash({...output.source_admission!,parent_facts_sha256:'b'.repeat(64)})])
   expect(()=>assertJune2026RegularSourceAdmission(proof,trace,scope,f.packet.rule_input.snapshot_sha256)).toThrow();
  const facts={...trace.facts_snapshot,facts:trace.facts_snapshot.facts.map(row=>row.path==='compensation.gross_salary'?{...row,confidence:.4}:row)};
  const changedTrace=createSourceCalculationTrace({calculationId:trace.calculation_id,caseId:trace.case_id,analysisRunId:trace.analysis_run_id,
   calculatedAt:trace.calculated_at,catalogSha256:trace.catalog_sha256,facts,rule:trace.rule_package,parameters:trace.parameters,
   bindings:trace.inputs.map(i=>({input_id:i.input_id,source:i.source}))});
  const changedProof=rehash({...output.source_admission!,effective_facts_sha256:changedTrace.facts_snapshot_sha256,effective_rule_input_sha256:changedTrace.rule_input_sha256});
  expect(()=>assertJune2026RegularSourceAdmission(changedProof,changedTrace,scope,f.packet.rule_input.snapshot_sha256)).toThrow('EFFECTIVE_BINDING');
 });
});
