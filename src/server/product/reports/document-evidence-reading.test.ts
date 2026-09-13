import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentEvidenceTarget,documentEvidenceReadingDisplay,validateDocumentEvidenceAnswer,resolveDocumentEvidenceAnswer} from './document-evidence-reading';
import {evidenceReadingFixture,evidenceUuid} from './document-evidence-reading.fixtures';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {resolveDocumentReadingVerification,materializeDocumentVerification,validateDocumentReadingAnswerForTarget} from './reading-verification';

describe('non-payroll cell reading bridge',()=>{
 it.each(['confirm','correct','unknown','unreadable'] as const)('routes %s through the shared target and reading API without payroll projection',action=>{
  const f=evidenceReadingFixture(),target=documentEvidenceTarget(f);
  expect(documentReadingTargetSchema.parse(target)).toEqual(target);
  const input={target,currentCheckpoint:f.checkpoint,nonPayslipDocument:f.document,nonPayslipProductDocumentId:f.productDocumentId,
   caseId:target.case_id,month:target.month,policyVersion:target.policy_version,requestId:evidenceUuid(8),identityId:evidenceUuid(9),answerRevision:2,
   answeredAt:'2026-07-02T00:00:00Z',answer:{schema_version:'document-field-answer-v2',action,...(action==='correct'?{corrected_raw_value:'09:20'}:{})}};
  expect(documentReadingTargetForCheckpoint(input)).toEqual(target);
  expect(validateDocumentReadingAnswerForTarget(target,input.answer)).toEqual(input.answer);
  const resolved=resolveDocumentReadingVerification(input),materialized=materializeDocumentVerification(resolved,target.normalized_sha256);
  expect(materialized?.kind).toBe('document_evidence');
  if(materialized?.kind!=='document_evidence')throw Error('EXPECTED_NONPAY');
  expect(materialized.reading.target.observation.original.raw_value).toBe('08:30');
  expect(materialized.reading.state).toBe(action==='unknown'||action==='unreadable'?action:'identified_reading');
  if(action==='correct')expect(materialized.reading.answer).toMatchObject({basis:'system_action_context:identified_source_correction'});
  expect(resolveDocumentReadingVerification({...input,policyVersion:'other-policy'}).state).toBe('stale');
  expect(()=>resolveDocumentReadingVerification({...input,nonPayslipDocument:undefined})).toThrow('DOCUMENT_CONTEXT_REQUIRED');
 });
 it('maps invalid non-payroll readings to the existing pre-save answer contract',()=>{
  const target=documentEvidenceTarget(evidenceReadingFixture('conflict'));
  for(const answer of [{schema_version:'document-field-answer-v2',action:'confirm'},{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'97 days'}]){
   expect(()=>validateDocumentReadingAnswerForTarget(target,answer)).toThrow('REQUEST_ANSWER_INVALID');
  }
 });
 it('constructs a source-bound target and safe display without confidence approval',()=>{
  const f=evidenceReadingFixture(),t=documentEvidenceTarget(f),display=documentEvidenceReadingDisplay(t);
  expect(t.observation.original.confidence).toBe(.94);expect(t.observation.state).toBe('candidate');expect(display.can_confirm).toBe(true);
  expect(display.source).toEqual({document_id:f.document.document_id,page:1,locator:'row1.entry'});
  expect(display).not.toHaveProperty('checkpoint_sha256');expect(display).not.toHaveProperty('confidence');
 });
 it.each(['unknown','unreadable'])('retains identified %s without a numeric value or provider mutation',action=>{
  const f=evidenceReadingFixture(),target=documentEvidenceTarget(f),before=canonicalSha256(f.checkpoint);
  const result=resolveDocumentEvidenceAnswer({...f,target,caseId:f.document.case_id,requestId:evidenceUuid(8),answerRevision:2,identityId:evidenceUuid(9),
   answeredAt:'2026-07-02T00:00:00Z',answer:{schema_version:'document-field-answer-v2',action}});
  expect(result.state).toBe('current');if(result.state!=='current')throw Error('TEST_CURRENT');expect(result.reading.state).toBe(action);expect(result.reading.value).toBeNull();
  expect(canonicalSha256(f.checkpoint)).toBe(before);expect(result.reading.answer_revision).toBe(2);
 });
 it('reuses v2 correction with a separate reading and exact original value',()=>{
  const f=evidenceReadingFixture(),target=documentEvidenceTarget(f);
  const result=resolveDocumentEvidenceAnswer({...f,target,caseId:f.document.case_id,requestId:evidenceUuid(8),answerRevision:3,identityId:evidenceUuid(9),
   answeredAt:'2026-07-02T00:00:00Z',answer:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'09:20'})});
  expect(result.state).toBe('current');if(result.state!=='current')throw Error('TEST_CURRENT');expect(result.reading.value).toEqual({kind:'clock_time',value:'09:20'});
  expect(result.reading.target.observation.original.raw_value).toBe('08:30');
 });
 it('rejects affirmative confirmation of a conflict and malformed correction',()=>{
  const target=documentEvidenceTarget(evidenceReadingFixture('conflict'));
  expect(documentEvidenceReadingDisplay(target).can_confirm).toBe(false);
  expect(()=>validateDocumentEvidenceAnswer(target,{schema_version:'document-field-answer-v2',action:'confirm'})).toThrow('CONFIRM_UNAVAILABLE');
  expect(()=>validateDocumentEvidenceAnswer(target,{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'31:80'})).toThrow('VALUE_INVALID');
 });
 it('rejects foreign case and changes of source/checkpoint/period',()=>{
  const f=evidenceReadingFixture(),target=documentEvidenceTarget(f),input={...f,target,caseId:f.document.case_id,requestId:evidenceUuid(8),answerRevision:1,identityId:evidenceUuid(9),
   answeredAt:'2026-07-02T00:00:00Z',answer:{schema_version:'document-field-answer-v2',action:'unknown'}};
  expect(()=>resolveDocumentEvidenceAnswer({...input,caseId:evidenceUuid(99)})).toThrow('CASE_MISMATCH');
  expect(resolveDocumentEvidenceAnswer({...input,month:'2026-06'}).state).toBe('stale');
  expect(resolveDocumentEvidenceAnswer({...input,document:{...f.document,content_sha256:'f'.repeat(64)}}).state).toBe('stale');
  expect(()=>documentEvidenceTarget({...f,checkpoint:{...f.checkpoint,result_sha256:'f'.repeat(64)}})).toThrow();
 });
});
