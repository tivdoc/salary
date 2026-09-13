import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {sourceJobSchema} from './source-dispatch.ts';
import {recordSavedSourceIntakeUploadAssessments} from './saved-source-intake-planning.ts';
import {sourceIntakeUploadFixture} from '../documents/source-intake-upload.fixture.ts';
function setup(){
 const f=sourceIntakeUploadFixture();
 const row={scope:f.scope,receipt:f.receipt as typeof f.receipt|null,journalContext:f.context,reading_request_ids:[f.answerRow.id]};
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f.caseId,revision:f.context.revision,input_sha256:f.context.inputSha256,mode:'draft',processing_profile:'qualified_ai_v1'});
 const calls:PostgresStatement[]=[],assessments:unknown[]=[];
 const state={ack:true};
 const context:PostgresTransactionContext={transaction_id:'upload-assessment-unit',client:{async query(q){calls.push(q);
  if(q.name==='saved_runner_source_upload_context')return {rows:[{contexts:[row]}],row_count:1};
  if(q.name==='saved_runner_source_upload_assessment'){assessments.push(JSON.parse(String(q.values[3])));return {rows:state.ack?[{recorded:null}]:[],row_count:state.ack?1:0};}
  throw Error('UNEXPECTED_SQL:'+q.name);
 }}};
 const run=()=>recordSavedSourceIntakeUploadAssessments(context,job,f.context.journal);
 return {f,row,job,context,calls,assessments,state,run};
}
describe('ordinary source intake upload receipt persistence',()=>{
 it('replays and records source satisfaction at the exact current head without claiming financial completion',async()=>{
  const f=setup(),original=canonicalSha256(f.f.context);expect(await f.run()).toBe(1);
  expect(f.assessments).toEqual([expect.objectContaining({state:'satisfied',information_satisfied:true,financial_analysis_completed:false,source_revision:f.job.revision,source_input_sha256:f.job.input_sha256})]);
  expect(f.assessments[0]).not.toHaveProperty('analysis_run_id');expect(canonicalSha256(f.f.context)).toBe(original);
  expect(f.calls[1].values.slice(0,3)).toEqual([f.job.case_id,f.job.revision,f.job.input_sha256]);
 });
 it('does not invent an assessment before any authenticated upload receipt',async()=>{
  const f=setup();f.row.receipt=null;expect(await f.run()).toBe(0);expect(f.assessments).toEqual([]);
 });
 it.each(['unknown','unreadable'])('records %s as insufficient with no information satisfaction',async action=>{
  const f=setup();f.f.answerRow.answer=JSON.stringify({v:1,action});f.f.context.journalSha256=canonicalSha256(f.f.context.journal);
  await f.run();expect(f.assessments[0]).toMatchObject({state:'insufficient',reason:'source_reading_unresolved',information_satisfied:false,financial_analysis_completed:false});
 });
 it.each(['revision','stored_hash','canonical_hash','journal'])('rejects a changed %s before recording',async kind=>{
  const f=setup();if(kind==='revision')f.row.journalContext={...f.f.context,revision:f.job.revision+1};
  if(kind==='stored_hash')f.row.journalContext={...f.f.context,inputSha256:'a'.repeat(64)};
  if(kind==='canonical_hash')f.row.journalContext={...f.f.context,journalSha256:'a'.repeat(64)};
  if(kind==='journal'){const journal={...f.f.context.journal,answers:[]};f.row.journalContext={...f.f.context,journal,journalSha256:canonicalSha256(journal)};}
  await expect(f.run()).rejects.toThrow('SOURCE_INTAKE_CURRENT_HASH');expect(f.assessments).toEqual([]);
 });
 it('refuses a missing append acknowledgment instead of calling the request satisfied',async()=>{
  const f=setup();f.state.ack=false;await expect(f.run()).rejects.toThrow('SOURCE_INTAKE_UPLOAD_ASSESSMENT_ACK');
 });
});
