import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {evidenceReadingFixture,evidenceUuid} from '../reports/document-evidence-reading.fixtures';
import {documentEvidenceTarget} from '../reports/document-evidence-reading';
import {savedNonPayslipReadings} from './saved-non-payslip-readings';

function fixture(action='confirm'){
 const f=evidenceReadingFixture(),target=documentEvidenceTarget(f);
 const answer={id:evidenceUuid(8),case_id:f.document.case_id,scope_month:f.month,code:'document_field:'+target.target_sha256,answer_kind:'choice',
  answer:JSON.stringify({schema_version:'document-field-answer-v2',action,...(action==='correct'?{corrected_raw_value:'09:15'}:{})}),
  answer_revision:2,answer_identity_id:evidenceUuid(9),answer_created_at:'2026-07-02T00:00:00Z',field_target:target};
 return {...f,caseId:f.document.case_id,journal:{answers:[answer]},answer};
}
describe('authenticated non-payslip journal materialization',()=>{
 it.each(['confirm','correct','unknown','unreadable'])('replays identified %s without changing provider bytes',action=>{
  const f=fixture(action),hash=canonicalSha256(f.checkpoint),readings=savedNonPayslipReadings(f);
  expect(readings).toHaveLength(1);expect(readings[0].identity_id).toBe(evidenceUuid(9));expect(readings[0].answer_revision).toBe(2);
  expect(readings[0].state).toBe(['unknown','unreadable'].includes(action)?action:'identified_reading');
  expect(readings[0].target.observation.original.raw_value).toBe('08:30');
  expect(readings[0].value).toEqual(action==='correct'?{kind:'clock_time',value:'09:15'}:action==='confirm'?{kind:'clock_time',value:'08:30'}:null);
  expect(canonicalSha256(f.checkpoint)).toBe(hash);expect(savedNonPayslipReadings(f)).toEqual(readings);
 });
 it('does not borrow a reading from another month or replaced source',()=>{
  const f=fixture();expect(savedNonPayslipReadings({...f,month:'2026-06'})).toEqual([]);
  expect(savedNonPayslipReadings({...f,document:{...f.document,document_id:evidenceUuid(11)}})).toEqual([]);
 });
 it('rejects a forged actor journal scope and duplicate targets',()=>{
  const f=fixture();expect(()=>savedNonPayslipReadings({...f,caseId:evidenceUuid(11)})).toThrow('CASE_MISMATCH');
  expect(()=>savedNonPayslipReadings({...f,journal:{answers:[f.answer,f.answer]}})).toThrow('ID_AMBIGUOUS');
  expect(()=>savedNonPayslipReadings({...f,journal:{answers:[f.answer,{...f.answer,id:evidenceUuid(11)}]}})).toThrow('READING_AMBIGUOUS');
 });
 it('retains stale checkpoints only in history, not current materialized facts',()=>{
  const f=fixture(),{target_sha256,...body}=f.answer.field_target;void target_sha256;
  const changed={...body,checkpoint_sha256:'f'.repeat(64)},target={...changed,target_sha256:canonicalSha256(changed)};
  expect(savedNonPayslipReadings({...f,journal:{answers:[{...f.answer,field_target:target,code:'document_field:'+target.target_sha256}]}})).toEqual([]);
 });
});
