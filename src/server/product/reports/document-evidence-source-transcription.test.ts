import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentEvidenceSourceTranscriptionTarget,documentEvidenceSourceTranscriptionTargetSchema,validateDocumentEvidenceSourceAnswer,
 resolveDocumentEvidenceSourceReading,parseDocumentEvidenceSourceReading,evidenceSourceReadingDependencies,documentEvidenceSourceTranscriptionDisplay,
 type EvidenceSourceDocument,type EvidenceSourcePurchase} from './document-evidence-source-transcription';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=(v:string)=>canonicalSha256(v);
function fixture(){
 const source:EvidenceSourceDocument={case_id:uuid(1),product_document_id:uuid(2),version_id:uuid(3),source_sha256:hash('synthetic immutable contract'),document_kind:'contract',document_month:null,page_count:7,reading_dependencies:[]};
 const purchase:EvidenceSourcePurchase={order_id:uuid(4),origin:'legacy_paid_receipt',receipt_sha256:hash('synthetic purchase'),topics:['contract','bonuses']};
 const target=documentEvidenceSourceTranscriptionTarget({source,purchase,month:'2026-06',page:3});
 const answer={schema_version:'document-evidence-source-answer-v1',action:'correct',value:{raw_value:'Synthetic financial clause, including all conditions.',locator:'Synthetic section 2'}};
 const input={target,currentSource:source,currentPurchase:purchase,caseId:uuid(1),month:'2026-06',requestId:uuid(5),answerRevision:1,identityId:uuid(6),answeredAt:'2026-09-13T00:00:00Z',answer};
 return {source,purchase,target,answer,input};
}
describe('identified contract source transcription without provider output',()=>{
 it('pins one document target and records the identified selected physical page in v2',()=>{
  const f=fixture(),target=documentEvidenceSourceTranscriptionTarget({source:f.source,purchase:f.purchase,month:'2026-06',page:null});
  expect(target).toMatchObject({schema_version:'document-evidence-source-transcription-v2',page:null,page_count:7});
  const answer={schema_version:'document-evidence-source-answer-v2',action:'correct',value:{...f.answer.value,page:3}};
  const resolved=resolveDocumentEvidenceSourceReading({...f.input,target,answer});expect(resolved).toMatchObject({state:'current',reading:{value:{page:3}}});
  if(resolved.state!=='current')throw Error('EXPECTED_CURRENT');expect(parseDocumentEvidenceSourceReading(resolved.reading)).toEqual(resolved.reading);
  for(const page of [0,8,1.5])expect(()=>validateDocumentEvidenceSourceAnswer(target,{...answer,value:{...answer.value,page}})).toThrow('REQUEST_ANSWER_INVALID');
  expect(()=>validateDocumentEvidenceSourceAnswer(target,f.answer)).toThrow('REQUEST_ANSWER_INVALID');
  expect(()=>validateDocumentEvidenceSourceAnswer(f.target,answer)).toThrow('REQUEST_ANSWER_INVALID');
  expect(documentEvidenceSourceTranscriptionDisplay(target).source_transcription_context).toEqual({kind:'financial_clause',page:null,page_count:7,max_characters:1600});
  expect(resolveDocumentEvidenceSourceReading({...f.input,target,answer,currentSource:{...f.source,page_count:6}})).toEqual({state:'stale'});
 });
 it('keeps a source reading with authentic journal identity and no OCR candidate, amount or legal approval',()=>{
  const f=fixture(),before=canonicalSha256(f),r=resolveDocumentEvidenceSourceReading(f.input);expect(r.state).toBe('current');if(r.state!=='current')throw Error();
  expect(r.reading).toMatchObject({origin:'identified_document_transcription',identity_id:uuid(6),answer_revision:1,state:'identified_reading',legal_applicability_approved:false,
   value:{kind:'text',page:3,text:f.answer.value.raw_value},basis:'system_action_context:identified_source_transcription'});
  expect(parseDocumentEvidenceSourceReading(r.reading)).toEqual(r.reading);expect(canonicalSha256(f)).toBe(before);
  expect(JSON.stringify(r.reading)).not.toMatch(/provider_receipt|normalized_observation|minor_units|checkpoint_sha256/);
 });
 it.each(['unknown','unreadable'] as const)('retains %s without reusing a prior clause',action=>{
  const f=fixture(),r=resolveDocumentEvidenceSourceReading({...f.input,answerRevision:2,answer:{schema_version:'document-evidence-source-answer-v1',action}});
  expect(r).toMatchObject({state:'current',reading:{state:action,value:null,answer_revision:2}});
 });
 it.each(['confirm','empty','extra_identity','extra_amount'] as const)('rejects %s answer instead of manufacturing source evidence',kind=>{
  const f=fixture();let a:unknown=f.answer;
  if(kind==='confirm')a={schema_version:'document-evidence-source-answer-v1',action:'confirm'};
  if(kind==='empty')a={...f.answer,value:{...f.answer.value,raw_value:' '}};
  if(kind==='extra_identity')a={...f.answer,identity_id:uuid(9)};
  if(kind==='extra_amount')a={...f.answer,value:{...f.answer.value,amount:'500'}};
  expect(()=>validateDocumentEvidenceSourceAnswer(f.target,a)).toThrow('REQUEST_ANSWER_INVALID');
 });
 it.each(['version','hash','page_count','document_month','month','purchase','topics','dependency'] as const)('stales changed %s from current server context',kind=>{
  const f=fixture(),i=structuredClone(f.input);
  if(kind==='version')i.currentSource.version_id=uuid(20);
  if(kind==='hash')i.currentSource.source_sha256=hash('replacement');
  if(kind==='page_count')i.currentSource.page_count=6;
  if(kind==='document_month')i.currentSource.document_month='2026-07';
  if(kind==='month')i.month='2026-07';
  if(kind==='purchase')i.currentPurchase.receipt_sha256=hash('new purchase');
  if(kind==='topics')i.currentPurchase.topics=['contract'];
  if(kind==='dependency')i.currentSource.reading_dependencies=[{version_id:f.source.version_id,request_id:uuid(21),answer_revision:2,answer_sha256:hash('new source period reading')}];
  expect(resolveDocumentEvidenceSourceReading(i)).toEqual({state:'stale'});
 });
 it('rejects foreign case, invalid page and a non-full-month target even with recomputed hashes',()=>{
  const f=fixture();expect(()=>resolveDocumentEvidenceSourceReading({...f.input,caseId:uuid(50)})).toThrow('REQUEST_FIELD_CASE_MISMATCH');
  expect(()=>documentEvidenceSourceTranscriptionTarget({source:f.source,purchase:f.purchase,month:'2026-06',page:8})).toThrow();
  const {target_sha256,...body}=f.target;void target_sha256;const changed={...body,period:{from:'2026-06-02',to:'2026-06-30'}};
  expect(()=>documentEvidenceSourceTranscriptionTargetSchema.parse({...changed,target_sha256:canonicalSha256(changed)})).toThrow();
 });
 it('detects even rehashed receipt value corruption',()=>{
  const f=fixture(),r=resolveDocumentEvidenceSourceReading(f.input);if(r.state!=='current')throw Error();
  const {verification_sha256,...body}=r.reading;void verification_sha256;const changed={...body,value:{...body.value!,text:'altered'}};
  expect(()=>parseDocumentEvidenceSourceReading({...changed,verification_sha256:canonicalSha256(changed)})).toThrow('SOURCE_TRANSCRIPTION_READING_CHANGED');
 });
 it('collects every authenticated source answer, excludes own/link history, and detects a newly added period reading',()=>{
  const f=fixture(),row={id:uuid(10),case_id:f.source.case_id,code:'document_field:'+hash('period'),answer_revision:1,answer:'source period answer',
   answer_identity_id:uuid(6),answer_created_at:'2026-09-13T00:00:00Z',field_target:{case_id:f.source.case_id,version_id:f.source.version_id,schema_version:'document-source-period-intake-v1'}};
  const own={...row,id:uuid(11),field_target:f.target},other={...row,id:uuid(12),field_target:{...row.field_target,version_id:uuid(20)}};
  expect(evidenceSourceReadingDependencies({answers:[row,own,other]},f.source.case_id,f.source.version_id)).toEqual([{version_id:f.source.version_id,request_id:row.id,answer_revision:1,answer_sha256:hash(row.answer)}]);
  expect(()=>evidenceSourceReadingDependencies({answers:[row,row]},f.source.case_id,f.source.version_id)).toThrow('SOURCE_TRANSCRIPTION_DUPLICATE_DEPENDENCY');
  expect(()=>evidenceSourceReadingDependencies({answers:[{...row,answer_identity_id:null}]},f.source.case_id,f.source.version_id)).toThrow();
 });
 it('exposes only a page and transcription purpose with no proposed source text',()=>{
  const d=documentEvidenceSourceTranscriptionDisplay(fixture().target);expect(d.raw_value).toBeNull();expect(d.source_transcription_context).toEqual({kind:'financial_clause',page:3,max_characters:1600});
 });
});
