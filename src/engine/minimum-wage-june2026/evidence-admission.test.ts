import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {resolveJune2026Evidence,june2026TestAssessmentSchema,type June2026TestAssessment} from './evidence-admission.ts';
import {createJune2026CollectionTarget,resolveJune2026CollectionAnswer,JUNE2026_UNKNOWN_ANSWER,JUNE2026_CONFLICTED_ANSWER,JUNE2026_DECLARATION_OPTIONS,JUNE2026_COMPONENT_DECLARATIONS} from './collection.ts';
import {createAdmissionTestFixture,createTestAssessment,admissionTestNow,admissionTestExtractionPolicy} from './evidence-admission.test-fixtures.ts';

const fixture=()=>{
 const f=createAdmissionTestFixture(),packet=f.packet(),assessment=createTestAssessment(packet);
 const resolve=(overrides:Partial<Parameters<typeof resolveJune2026Evidence>[0]>={})=>resolveJune2026Evidence({packet,facts:f.facts,assessment,
  evaluatedAt:admissionTestNow,mode:'synthetic_test',...overrides});
 return {...f,originalPacket:packet,assessment,resolve};
};

describe('June2026 isolated evidence admission boundary',()=>{
 it('calculates the independent 24058-agora oracle only under explicit isolated test assumptions',()=>{
  const f=fixture(),before=JSON.stringify({packet:f.originalPacket,facts:f.facts,assessment:f.assessment});
  const result=f.resolve();
  // Independent exact-method oracle: half_up(644385 * 100 / 182) is
  // 354058; subtract the documented 330000 to get 24058, not rounded-rate 24000.
  expect(result).toMatchObject({execution_allowed:true,authority:'isolated_dev_test_assumptions',human_approval:false,
   legal_activation:false,customer_publication_allowed:false,preflight:{state:'candidate_calculated',expectedMinor:354058,recordedMinor:330000,gapMinor:24058,
    activationAllowed:false,pricingAllowed:false}});
  expect(result.decisions).toHaveLength(8);
  expect(result.decisions.every(decision=>decision.state==='test_assessment_admitted')).toBe(true);
  expect(result.evidence.components).toMatchObject([{classification:'base_salary',classification_status:'confirmed',amount_minor:330000}]);
  expect(result.evidence.applicability.age_18_entire_month.provenance[0].source_type).toBe('declared');
  expect(result.document_readings.every(reading=>reading.provenance.every(source=>source.source_type==='documented'))).toBe(true);
  expect(result.packet_sha256).toBe(f.originalPacket.packet_sha256);
  expect(result.assessment_sha256).toBe(canonicalSha256(f.assessment));
  expect(f.resolve()).toEqual(result);
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify({packet:f.originalPacket,facts:f.facts,assessment:f.assessment})).toBe(before);
  expect(f.originalPacket).toMatchObject({execution_allowed:false,publication_allowed:false,active_catalog:{state:'not_admitted'}});
  expect(f.originalPacket.evidence.components[0].classification_status).toBe('missing');
 });

 it('refuses real service even when all exact test assessments and document readings are supplied',()=>{
  const result=fixture().resolve({mode:'real'});
  expect(result).toMatchObject({execution_allowed:false,authority:'none',human_approval:false,legal_activation:false,customer_publication_allowed:false});
  expect(result.decisions.every(decision=>decision.state==='assessment_missing')).toBe(true);
  expect(result.preflight.state).toBe('missing_input');
  expect(result.evidence.components[0].classification_status).toBe('missing');
 });

 it('does not promote either identified declarations or confirmed source readings into a legal assessment',()=>{
  const f=fixture(),result=f.resolve({assessment:null});
  expect(result.document_readings).toHaveLength(5);
  expect(result.document_readings.every(reading=>reading.status==='confirmed')).toBe(true);
  expect(result.execution_allowed).toBe(false);
  expect(result.decisions.every(decision=>decision.state==='assessment_missing')).toBe(true);
  expect(result.evidence.applicability.sector).toMatchObject({status:'missing',value:null});
  const noAnswers=createAdmissionTestFixture(false);
  const absent=resolveJune2026Evidence({packet:noAnswers.packet(),facts:noAnswers.facts,assessment:null,evaluatedAt:admissionTestNow,mode:'synthetic_test'});
  expect(absent.execution_allowed).toBe(false);
  expect(absent.decisions.every(decision=>decision.state==='missing')).toBe(true);
 });

 it.each([[JUNE2026_UNKNOWN_ANSWER,'unknown'],[JUNE2026_CONFLICTED_ANSWER,'conflicted']] as const)(
  'retains %s and never substitutes the supplied positive test decision',(answer,state)=>{
   const f=fixture();f.collection.resolutions.shift();
   f.addAnswer({kind:'applicability',field:'age_18_entire_month'},answer,2);
   const result=f.resolve({packet:f.packet()});
   expect(result.execution_allowed).toBe(false);
   expect(result.decisions.find(decision=>decision.field==='applicability.age_18_entire_month')?.state).toBe(state);
   expect(result.evidence.applicability.age_18_entire_month).toMatchObject({status:state==='conflicted'?'conflicted':'missing',value:null});
  });

 it('preserves missing, expired and replaced source questions independently of assessment presence',()=>{
  const f=fixture();f.collection.resolutions.splice(6,1);
  expect(f.resolve({packet:f.packet()}).decisions.find(decision=>decision.field==='wage_components_complete')?.state).toBe('missing');
  const target=createJune2026CollectionTarget({checkpoint:f.checkpoint,policyVersion:admissionTestExtractionPolicy,subject:{kind:'earnings_completeness'}});
  f.collection.resolutions.push({state:'missing',request_id:randomUUID(),target,expires_at:'2026-09-10T12:00:00.000Z',
   legal_classification_status:'unreviewed',candidate_evidence_admitted:false});
  const expired=f.resolve({packet:f.packet()});
  expect(expired.execution_allowed).toBe(false);
  expect(expired.decisions.find(decision=>decision.field==='wage_components_complete')?.state).toBe('expired');
  f.extraction.warnings.push('synthetic_source_revision_changed');f.repin();
  // Recreate what the saved loader returns: original target/answer/actor pins
  // replayed against the replacement checkpoint, never a hand-edited state.
  for(const [index,row] of f.collection.resolutions.entries()){
   if(!row||typeof row!=='object'||!('declaration' in row))continue;
   const {declaration:d}=row as ReturnType<typeof f.addAnswer>;
   f.collection.resolutions[index]=resolveJune2026CollectionAnswer({target:d.target,currentCheckpoint:f.checkpoint,policyVersion:admissionTestExtractionPolicy,
    caseId:d.target.case_id,month:'2026-06',requestId:d.request_id,answerRevision:d.answer_revision,identityId:d.identity_id,answeredAt:d.answered_at,answer:d.answer});
  }
  const stale=f.resolve({packet:f.packet()});
  expect(stale.execution_allowed).toBe(false);
  expect(stale.decisions.every(decision=>decision.state==='stale')).toBe(true);
 });

 it('pins the exact answer revision and refuses a new answer even when its declared value is unchanged',()=>{
  const f=fixture();f.collection.resolutions.shift();
  f.addAnswer({kind:'applicability',field:'age_18_entire_month'},JUNE2026_DECLARATION_OPTIONS[0],2);
  const result=f.resolve({packet:f.packet()});
  const decision=result.decisions.find(entry=>entry.field==='applicability.age_18_entire_month');
  expect(decision).toMatchObject({state:'stale',customer_declaration:{answer_revision:2,interpretation:{value:true}}});
  expect(result.execution_allowed).toBe(false);
 });

 it.each(['target_sha256','declaration_sha256','decision_kind'] as const)('refuses an edited assessment decision %s',field=>{
  const f=fixture(),assessment=structuredClone(f.assessment);
  if(field==='decision_kind')assessment.decisions[0].decision_kind='inventory_assessment';
  else assessment.decisions[0][field]='f'.repeat(64);
  const result=f.resolve({assessment});
  expect(result.execution_allowed).toBe(false);
  expect(result.decisions[0].state).toBe('stale');
 });

 it.each(['case_id','order_id','input_revision','input_sha256','document_version_id','document_sha256','policy_sha256','rule_sha256','golden_cases_sha256'] as const)(
  'refuses changed assessment scope or policy pin %s',field=>{
   const f=fixture(),assessment=structuredClone(f.assessment);
   if(field==='input_revision')assessment[field]+=1;
   else if(field==='case_id'||field==='order_id'||field==='document_version_id')assessment[field]=randomUUID();
   else assessment[field]='f'.repeat(64);
   const result=f.resolve({assessment});
   expect(result.execution_allowed).toBe(false);
   expect(result.decisions.every(decision=>decision.state==='stale')).toBe(true);
  });

 it('cannot override a negative declaration with a positive assessment despite matching target and answer hashes',()=>{
  const f=fixture();f.collection.resolutions.shift();
  f.addAnswer({kind:'applicability',field:'age_18_entire_month'},JUNE2026_DECLARATION_OPTIONS[1],2);
  const packet=f.packet(),assessment=createTestAssessment(packet),result=f.resolve({packet,assessment});
  expect(result.execution_allowed).toBe(false);
  expect(result.decisions.find(decision=>decision.field==='applicability.age_18_entire_month')).toMatchObject({state:'conflicted'});
 });

 it('cannot relabel an identified expense reimbursement as an eligible base component',()=>{
  const f=fixture();f.collection.resolutions.pop();
  f.addAnswer({kind:'component',componentId:f.component.component_id},JUNE2026_COMPONENT_DECLARATIONS.expense_reimbursement,2);
  const packet=f.packet(),assessment=createTestAssessment(packet),result=f.resolve({packet,assessment});
  expect(result.execution_allowed).toBe(false);
  expect(result.decisions.find(decision=>decision.field==='components.legal_classification')?.state).toBe('conflicted');
  expect(result.evidence.components[0].classification_status).toBe('missing');
 });

 it('requires every assessment decision and never runs on an omitted inventory assessment',()=>{
  const f=fixture(),assessment={...f.assessment,decisions:f.assessment.decisions.filter(decision=>decision.field!=='wage_components_complete')};
  const result=f.resolve({assessment});
  expect(result.execution_allowed).toBe(false);
  expect(result.decisions.find(decision=>decision.field==='wage_components_complete')?.state).toBe('assessment_missing');
 });

 it.each([
  ['2026-09-10T12:59:59.999Z','stale'],
  ['2026-09-11T13:00:00.000Z','expired'],
  ['2026-09-10T15:00:00+03:00','stale'],
  ['2026-09-11T12:00:00-02:00','expired'],
 ] as const)('evaluates assessment authority at the actual instant %s',(evaluatedAt,state)=>{
  const result=fixture().resolve({evaluatedAt});
  expect(result.execution_allowed).toBe(false);
  expect(result.decisions.every(decision=>decision.state===state)).toBe(true);
 });

 it('accepts the same valid instant across timezone offsets rather than comparing ISO strings',()=>{
  const f=fixture();
  const utc=f.resolve({evaluatedAt:'2026-09-10T14:10:00Z'});
  const offset=f.resolve({evaluatedAt:'2026-09-10T12:10:00-02:00'});
  expect(utc.execution_allowed).toBe(true);expect(offset.execution_allowed).toBe(true);
  expect(offset.preflight).toMatchObject({state:'candidate_calculated',gapMinor:24058});
 });

 it('validates assessment interval chronologically across different offsets',()=>{
  const assessment=fixture().assessment;
  expect(june2026TestAssessmentSchema.safeParse({...assessment,issued_at:'2026-09-10T14:00:00Z',expires_at:'2026-09-10T16:00:00+03:00'}).success).toBe(false);
  expect(june2026TestAssessmentSchema.safeParse({...assessment,issued_at:'2026-09-10T14:00:00+03:00',expires_at:'2026-09-10T12:00:00Z'}).success).toBe(true);
 });

 it('refuses a changed packet or foreign/edited saved facts instead of trusting their shape',()=>{
  const f=fixture();
  expect(()=>f.resolve({packet:{...f.originalPacket,packet_sha256:'f'.repeat(64)}})).toThrow('JUNE_ADMISSION_SAVED_PACKET_BINDING');
  const facts=employmentSnapshotSchema.parse({...f.facts,analysis_run_id:randomUUID()});
  expect(()=>f.resolve({facts})).toThrow('JUNE_ADMISSION_SAVED_PACKET_BINDING');
  const edited=employmentSnapshotSchema.parse({...f.facts,facts:f.facts.facts.map(fact=>fact.path==='compensation.base_monthly_salary'
   ?{...fact,value:{currency:'ILS',minor_units:1}}:fact)});
  expect(()=>f.resolve({facts:edited})).toThrow('JUNE_ADMISSION_SAVED_PACKET_BINDING');
 });

 it('refuses human approval claims, duplicate decisions and document-reading decisions in a test assessment',()=>{
  const f=fixture();
  expect(june2026TestAssessmentSchema.safeParse({...f.assessment,human_approval:true}).success).toBe(false);
  expect(june2026TestAssessmentSchema.safeParse({...f.assessment,authority:'human_approved'}).success).toBe(false);
  const duplicate={...f.assessment,decisions:[f.assessment.decisions[0],...f.assessment.decisions.slice(0,7)]};
  expect(june2026TestAssessmentSchema.safeParse(duplicate).success).toBe(false);
  const reading={...f.assessment,decisions:f.assessment.decisions.map(decision=>({...decision,decision_kind:'document_reading'}))};
  expect(june2026TestAssessmentSchema.safeParse(reading).success).toBe(false);
  expect(()=>f.resolve({assessment:reading as unknown as June2026TestAssessment})).toThrow();
 });
});
