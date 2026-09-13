import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',async original=>({...await original<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
vi.mock('./saved-admission',()=>({admitSavedSource:vi.fn(async()=>{})}));
const state=vi.hoisted(()=>({order:null as unknown}));
vi.mock('./saved-order-scope',async original=>({...await original<typeof import('./saved-order-scope')>(),readSavedOrders:vi.fn(async()=>[state.order]),purchasedMonths:()=>['2026-06']}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {attachAutomaticNonPayslipEvidence} from '@/engine/entitlement-review/automatic-nonpay';
import {documentEvidenceSourceTranscriptionTarget,evidenceSourceReadingDependencies,type EvidenceSourceDocument} from '../reports/document-evidence-source-transcription';
import {readSavedDocumentSourceTranscriptions,attachSavedDocumentSourceTranscriptions,openSavedDocumentSourceTranscriptionRequests} from './saved-document-source-transcription';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import {validateSavedReadingAnswer} from '../reports/validate-reading-answer';
import {validateRequestAnswer} from '../reports/request-answer';
import type {CaseAccessDb} from '../case-access/db';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(text='Synthetic unsupported clause with all its conditions.'){
 const source:EvidenceSourceDocument={case_id:uuid(1),product_document_id:uuid(2),version_id:uuid(3),source_sha256:canonicalSha256('synthetic contract source'),document_kind:'contract',document_month:null,page_count:7,reading_dependencies:[]};
 const purchase={order_id:uuid(4),origin:'saved_order' as const,receipt_sha256:'a'.repeat(64),topics:['contract' as const]};
 state.order={id:purchase.order_id,kind:'initial',offer_sha256:purchase.receipt_sha256,topics:purchase.topics};
 const target=documentEvidenceSourceTranscriptionTarget({source,purchase,month:'2026-06',page:null});
 const answer=JSON.stringify({schema_version:'document-evidence-source-answer-v2',action:'correct',value:{page:3,raw_value:text,locator:'Synthetic complete paragraph'}});
 const journal={answers:[{id:uuid(5),case_id:source.case_id,code:`document_field:${target.target_sha256}`,scope_month:'2026-06',answer_kind:'choice',answer,answer_revision:1,answer_identity_id:uuid(6),answer_created_at:'2026-09-13T00:00:00Z',field_target:target}]};
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:source.case_id,revision:2,input_sha256:'b'.repeat(64),mode:'draft',processing_profile:'qualified_ai_v1'};
 const queries:PostgresStatement[]=[],saved={case_id:source.case_id,source_documents:[source],journal};
 const context:PostgresTransactionContext={transaction_id:'synthetic',client:{async query(q){queries.push(q);
  if(q.name==='saved_evidence_source_transcription_sources')return {row_count:1,rows:[{value:saved}]};
  if(q.name==='saved_evidence_source_transcription_open')return {row_count:1,rows:[{id:uuid(5)}]};throw Error(q.name);}}};
 const review=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:source.case_id,purchased_scope:purchase,period:target.period,documents:[{
  case_id:source.case_id,document_id:source.version_id,version_id:source.version_id,file_sha256:source.source_sha256,page_count:1,kind:'contract',label:'Synthetic contract',period:null,reading_origin:'source_inventory',reading_sha256:source.source_sha256}],checks:[],coverage_gaps:[],completion_input:{case_id:source.case_id,period:target.period,documents:[],needs:[],evidence:[]}});
 return {source,purchase,target,answer,journal,job,queries,saved,context,review};
}
describe('ordinary saved contract transcription integration',()=>{
 it.each(['missing','recorded'] as const)('opens a contract request with %s purchase-period evidence while preserving that review metadata',async periodState=>{
  const f=fixture(),purchase={...f.purchase,origin:'legacy_paid_receipt' as const};
  const review=documentReviewInputSchema.parse({...f.review,purchased_scope:{...purchase,purchase_period_evidence:{
   schema_version:'document-review-purchase-period-v1',receipt_sha256:purchase.receipt_sha256,state:periodState,
   periods:periodState==='recorded'?[f.target.period]:[],
  }}});
  const before=canonicalSha256(review),expected=documentEvidenceSourceTranscriptionTarget({source:f.source,purchase,month:'2026-06',page:null});
  // The target's closed purchase contract remains strict. The integration
  // boundary must select its fields, not remove period evidence from a review.
  expect(()=>documentEvidenceSourceTranscriptionTarget({source:f.source,purchase:review.purchased_scope,month:'2026-06',page:null})).toThrow();
  expect(await openSavedDocumentSourceTranscriptionRequests(f.context,f.job,'2026-06',review)).toEqual([
   {requestId:uuid(5),month:'2026-06',versionId:f.source.version_id,page:null},
  ]);
  expect(f.queries.find(q=>q.name==='saved_evidence_source_transcription_open')?.values[3]).toBe(JSON.stringify(expected));
  expect(canonicalSha256(review)).toBe(before);expect(review.purchased_scope.purchase_period_evidence?.state).toBe(periodState);
 });
 it('replays latest authenticated text separately, opens one document target across seven physical pages, and emits a semantic gap without replacing extraction bytes',async()=>{
  const f=fixture(),readings=await readSavedDocumentSourceTranscriptions(f.context,f.job,'2026-06',f.journal);
  expect(readings).toHaveLength(1);expect(readings[0].identity_id).toBe(uuid(6));
  const original=buildSyntheticCaseFixture({fixture_id:'source-transcription',mode:'real'}).stored,bytes=canonicalSha256(original.extractions),snapshot={...original,document_source_transcriptions:readings};
  const review=attachSavedDocumentSourceTranscriptions(f.review,snapshot),result=attachAutomaticNonPayslipEvidence(review,snapshot).input;
  expect(result.document_source_transcriptions).toEqual(readings);expect(result.entitlement_evidence?.obligations).toBeUndefined();
  expect(result.coverage_gaps).toMatchObject([{kind:'missing_rule'}]);expect(canonicalSha256(snapshot.extractions)).toBe(bytes);
  expect(await openSavedDocumentSourceTranscriptionRequests(f.context,f.job,'2026-06',review)).toEqual([{requestId:uuid(5),month:'2026-06',versionId:f.source.version_id,page:null}]);
  expect(f.queries.find(q=>q.name==='saved_evidence_source_transcription_open')?.values[3]).toBe(JSON.stringify(f.target));
 });
 it('passes a supported literal through the same parser but refuses to invent effective dates from the purchased month',async()=>{
  const f=fixture('המעסיק ישלם לעובד 500 ש״ח בכל חודש.'),readings=await readSavedDocumentSourceTranscriptions(f.context,f.job,'2026-06',f.journal);
  const snapshot={...buildSyntheticCaseFixture({fixture_id:'source-literal',mode:'real'}).stored,document_source_transcriptions:readings};
  const result=attachAutomaticNonPayslipEvidence(attachSavedDocumentSourceTranscriptions(f.review,snapshot),snapshot).input;
  expect(result.coverage_gaps).toMatchObject([{kind:'missing_source'}]);expect(result.coverage_gaps[0].next_step).toContain('חודש הבדיקה אינו תחליף');expect(result.entitlement_evidence?.obligations).toBeUndefined();
 });
 it('retains unknown as its own receipt, but a changed source period dependency makes the prior answer inactive',async()=>{
  const f=fixture();f.journal.answers[0].answer=JSON.stringify({schema_version:'document-evidence-source-answer-v2',action:'unknown'});
  expect(await readSavedDocumentSourceTranscriptions(f.context,f.job,'2026-06',f.journal)).toMatchObject([{state:'unknown',value:null}]);
  const periodAnswer={...f.journal.answers[0],id:uuid(7),answer:'new period answer',field_target:{...f.target,schema_version:'document-source-period-intake-v1'}};
  f.saved.journal.answers.push(periodAnswer as typeof f.journal.answers[number]);f.source.reading_dependencies=evidenceSourceReadingDependencies(f.journal,f.job.case_id,f.source.version_id);
  expect(await readSavedDocumentSourceTranscriptions(f.context,f.job,'2026-06',f.journal)).toEqual([]);
 });
 it('rejects mismatched authenticated context dependencies and forged snapshot receipts',async()=>{
  const f=fixture();f.source.reading_dependencies=[{version_id:f.source.version_id,request_id:uuid(50),answer_revision:1,answer_sha256:'c'.repeat(64)}];
  await expect(readSavedDocumentSourceTranscriptions(f.context,f.job,'2026-06',f.journal)).rejects.toThrow('SOURCE_TRANSCRIPTION_DEPENDENCIES_CHANGED');
  f.source.reading_dependencies=[];const readings=await readSavedDocumentSourceTranscriptions(f.context,f.job,'2026-06',f.journal);
  const snapshot={...buildSyntheticCaseFixture({fixture_id:'source-forgery',mode:'real'}).stored,document_source_transcriptions:readings};
  const review=attachSavedDocumentSourceTranscriptions(f.review,snapshot);
  expect(()=>attachAutomaticNonPayslipEvidence(review,{...snapshot,document_source_transcriptions:[]})).toThrow('CLAUSE_TRANSCRIPTION_SNAPSHOT_BINDING');
 });
 it('routes the real wire parser through protected source-context reconstruction and current-state lookup',async()=>{
  const f=fixture(),request={code:f.journal.answers[0].code,field_crop:'source_transcription.financial_clause',answer_kind:'choice' as const};
  expect(validateRequestAnswer(request,f.answer)).toBe(f.answer);
  let current=true;const calls:string[]=[];const store:CaseAccessDb={provider:'fake',async rpc<T>(name:string){calls.push(name);let value:unknown;
   if(name==='case_request_field_reading_targets')value=[{request_id:uuid(5),target:f.target}];
   else if(name==='case_request_evidence_source_context')value=[{value:{source:f.source,purchase:f.purchase,month:'2026-06',page:null}}];
   else if(name==='case_request_field_states')value=[{request_id:uuid(5),source_current:current}];else throw Error(name);
   return value as T[];}};
  await validateSavedReadingAnswer({store,caseId:f.source.case_id,identityId:uuid(6),requestId:uuid(5),code:request.code,answer:f.answer});
  expect(calls).toEqual(['case_request_field_reading_targets','case_request_evidence_source_context','case_request_field_states']);
  current=false;await expect(validateSavedReadingAnswer({store,caseId:f.source.case_id,identityId:uuid(6),requestId:uuid(5),code:request.code,answer:f.answer})).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
 });
});
