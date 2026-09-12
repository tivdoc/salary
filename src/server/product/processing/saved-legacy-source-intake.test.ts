import {describe,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {legacySourceIntakeFixture} from './saved-legacy-source-intake.fixture.ts';
import {savedLegacySourceIntake,effectiveLegacySourcePeriods,legacySourceIntakeRequests,sourceIntakeFullMonths,sourceIntakeTechnicalDependencies} from './saved-legacy-source-intake.ts';
import {savedLegacyExecutionScope,purchasedMonths} from './saved-order-scope.ts';
import {validateDocumentSourcePeriodIntakeAnswer,documentSourcePeriodIntakeTargetSchema,documentSourcePeriodIntakeTarget} from '../reports/document-source-period-intake.ts';
vi.mock('server-only',()=>({}));
function replay(f:ReturnType<typeof legacySourceIntakeFixture>){return savedLegacySourceIntake({...f.input,journal:f.journal,journalSha256:canonicalSha256(f.journal)});}
describe('authenticated monthless source intake',()=>{
 it('uses current answered journal plus original source anchor, preserves original nine-topic scope',()=>{
  const f=legacySourceIntakeFixture(),before=canonicalSha256(f.scope),saved=replay(f),effective=effectiveLegacySourcePeriods(f.scope,saved),order=savedLegacyExecutionScope(f.scope,saved);
  expect(saved.readings[0].origin).toBe('customer_document_reading');expect(saved.readings[0].target.month).toBeNull();
  expect(effective.periods[0].period).toEqual({from:'2026-06-01',to:'2026-06-30'});expect(order).not.toBeNull();if(!order)throw Error('EXPECTED_SCOPE');
  expect(purchasedMonths(order)).toEqual(['2026-06']);expect(order.topics).toHaveLength(9);expect(order.legacy_scope).toEqual(f.scope);
  expect(canonicalSha256(f.scope)).toBe(before);expect(f.scope.periods).toEqual([]);expect(f.scope.publication_authority).toBe(false);
  expect(savedLegacyExecutionScope(f.scope)).toBeNull();expect(legacySourceIntakeRequests(saved)).toEqual([]);
 });
 it.each(['unknown','unreadable'])('latest %s correction removes only source-derived coverage and does not reopen',action=>{
  const f=legacySourceIntakeFixture();f.answerRow.answer=JSON.stringify({v:1,action});f.answerRow.answer_revision=2;
  const saved=replay(f);expect(savedLegacyExecutionScope(f.scope,saved)).toBeNull();expect(legacySourceIntakeRequests(saved)).toEqual([]);
  expect(saved.history).toEqual([{request_id:f.answerRow.id,answer_revision:2,current:true}]);
 });
 it('null period and non-payroll contract classification never create executable months',()=>{
  for(const patch of [{period:null},{document_kind:'contract'}]){const f=legacySourceIntakeFixture();f.answerRow.answer=JSON.stringify({...f.answer,value:{...f.answer.value,...patch}});
   expect(savedLegacyExecutionScope(f.scope,replay(f))).toBeNull();}
 });
 it('does not merge crossing attendance cycles to invent a full month',()=>{
  expect(sourceIntakeFullMonths({from:'2026-06-18',to:'2026-07-17'})).toEqual([]);
  expect(sourceIntakeFullMonths({from:'2026-07-18',to:'2026-08-17'})).toEqual([]);
  expect(sourceIntakeFullMonths({from:'2026-06-18',to:'2026-08-17'})).toEqual(['2026-07']);
 });
 it('conflicting current readings of one source remain blocked',()=>{
  const f=legacySourceIntakeFixture();f.journal.answers.push({...f.answerRow,id:'77777777-7777-4777-8777-777777777777',answer:JSON.stringify({v:1,action:'unknown'})});
  const saved=replay(f);expect(effectiveLegacySourcePeriods(f.scope,saved).conflicts).toEqual([f.document.version_id]);expect(savedLegacyExecutionScope(f.scope,saved)).toBeNull();
 });
 it('replacement invalidates historical reading and opens only the new current document',()=>{
  const f=legacySourceIntakeFixture(),replacement={...f.document,version_id:'88888888-8888-4888-8888-888888888888',sha256:'f'.repeat(64)};
  f.journal.documents=[replacement];f.input.currentDocuments=[replacement];const saved=replay(f);
  expect(saved.history[0].current).toBe(false);expect(savedLegacyExecutionScope(f.scope,saved)).toBeNull();
  expect(legacySourceIntakeRequests(saved)[0]).toMatchObject({kind:'document_field',target:{version_id:replacement.version_id,month:null}});
 });
 it('missing source produces a monthless document need without fake document or month',()=>{
  const f=legacySourceIntakeFixture();f.journal.documents=[];f.journal.answers=[];f.input.currentDocuments=[];
  const requests=legacySourceIntakeRequests(replay(f));expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({kind:'document',target:{month:null,purchased_topics:f.scope.topics}});
  expect(requests[0].target).not.toHaveProperty('product_document_id');
 });
 it('unknown physical page count is a technical dependency, not a fabricated page or document request',()=>{
  const f=legacySourceIntakeFixture();f.journal.answers=[];const unavailable={...f.document,page_count:null};f.journal.documents=[unavailable];f.input.currentDocuments=[unavailable];
  const saved=replay(f);expect(sourceIntakeTechnicalDependencies(saved)).toEqual([{code:'source_page_count_required',document_id:f.document.id,version_id:f.document.version_id,source_sha256:f.document.sha256}]);
  expect(legacySourceIntakeRequests(saved)).toEqual([]);expect(()=>documentSourcePeriodIntakeTarget({scope:f.scope,source:{document:unavailable,anchor:f.anchor}})).toThrow('SOURCE_INTAKE_PAGE_COUNT_REQUIRED');
 });
 it.each(['canonical','pg_anchor','foreign_anchor_document','foreign_anchor_scope','missing_anchor','current_document','future_anchor','foreign_actor_case'])('rejects or makes stale %s without effective coverage',kind=>{
  const f=legacySourceIntakeFixture();
  if(kind==='canonical'){expect(()=>savedLegacySourceIntake({...f.input,journalSha256:'0'.repeat(64)})).toThrow();return;}
  if(kind==='pg_anchor')f.input.sourceAnchors=[{...f.anchor,input_sha256:'0'.repeat(64)}];
  if(kind==='missing_anchor')f.input.sourceAnchors=[];
  if(kind==='current_document')f.input.currentDocuments=[{...f.document,sha256:'0'.repeat(64)}];
  if(kind==='foreign_actor_case')f.answerRow.case_id='99999999-9999-4999-8999-999999999999';
  if(kind==='future_anchor'){f.input.revision=0;}
  if(kind==='foreign_anchor_document'||kind==='foreign_anchor_scope'){
   const altered={...f.anchor.input as object,...(kind==='foreign_anchor_document'?{documents:[]}:{legacy_orders:[]})};
   f.input.sourceAnchors=[{...f.anchor,input:altered,journal_sha256:canonicalSha256(altered)}];
  }
  expect(()=>replay(f)).toThrow();
 });
 it.each([{v:1,action:'confirm'},{v:1,action:'correct',value:{document_kind:'payslip',period:{from:'2026-06-30',to:'2026-06-01'},page:1,source_label:'x'}},
  {v:1,action:'correct',value:{document_kind:'payslip',period:null,page:3,source_label:'x'}}])('rejects invalid reading %j',answer=>{
  expect(()=>validateDocumentSourcePeriodIntakeAnswer(legacySourceIntakeFixture().target,answer)).toThrow();
 });
 it('rejects altered target bytes and derived period evidence',()=>{
  const f=legacySourceIntakeFixture();expect(()=>documentSourcePeriodIntakeTargetSchema.parse({...f.target,source_sha256:'0'.repeat(64)})).toThrow();
  const order=savedLegacyExecutionScope(f.scope,replay(f));if(!order?.source_period_evidence)throw Error('EXPECTED_SCOPE');
  const changed={...order,source_period_evidence:{...order.source_period_evidence,periods:order.source_period_evidence.periods.map(p=>({...p,period:{...p.period,to:'2026-07-31'}}))}};expect(()=>purchasedMonths(changed)).toThrow('SAVED_ORDER_SCOPE');
 });
});

it('rejects the 600-month answer boundary before journal persistence while retaining the bounded 599-month span',()=>{
 const f=legacySourceIntakeFixture(),answer=(to:string)=>({...f.answer,value:{...f.answer.value,period:{from:'2026-01-01',to}}});
 expect(()=>validateDocumentSourcePeriodIntakeAnswer(f.target,answer('2075-12-31'))).not.toThrow();
 expect(()=>validateDocumentSourcePeriodIntakeAnswer(f.target,answer('2076-01-01'))).toThrow('REQUEST_ANSWER_INVALID');
});
