import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentFieldTarget} from './document-field-confirmation';
import {documentSourceTranscriptionTarget} from './document-source-transcription';
import {validateSavedReadingAnswer} from './validate-reading-answer';
import type {CaseAccessDb} from '../case-access/db';
import {answerCaseRequest,editCaseRequest} from './case-requests';
vi.mock('server-only',()=>({}));
function fixture(kind:'scalar'|'source_transcription'='scalar'){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-server-reading-validation',mode:'real'}),document=f.stored.documents[0],extraction=f.stored.extractions[0];
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction,first_pass:{normalized_extraction:extraction}}}};checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const target=kind==='source_transcription'?documentSourceTranscriptionTarget({checkpoint,policyVersion:'server-validation-test',subject:{kind:'reported_work_hours',page:1}}):documentFieldTarget({checkpoint,policyVersion:'server-validation-test',candidateId:extraction.fields.find(c=>c.field==='gross_salary')!.candidate_id});
 const requestId=randomUUID(),identityId=randomUUID(),calls:string[]=[],request={id:requestId,case_id:document.case_id,code:'document_field:'+target.target_sha256,question:'Synthetic reading',answer_kind:'choice',options:['כן, בדקתי במסמך והערך נכון'],field_crop:'gross_salary',blocking:false,opened_at:'2025-02-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text:null};
 const store={async rpc(name:string){calls.push(name);if(name==='case_request_field_reading_targets')return [{request_id:requestId,target}];if(name==='case_request_list')return [request];if(name==='case_request_revision_list')return [];throw Error('UNEXPECTED_WRITE:'+name);}} as unknown as CaseAccessDb;
 const input={store,caseId:document.case_id,identityId,requestId,code:request.code,answer:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'6200.25'})};
 return {input,store,target,calls};
}
it('validates the exact authorized target and refuses foreign or missing request identity',async()=>{
 const s=fixture();await expect(validateSavedReadingAnswer(s.input)).resolves.toBeUndefined();
 await expect(validateSavedReadingAnswer({...s.input,identityId:undefined})).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
 await expect(validateSavedReadingAnswer({...s.input,requestId:randomUUID()})).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
 await expect(validateSavedReadingAnswer({...s.input,caseId:randomUUID()})).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
});
it.each(['answer','correction','draft'] as const)('rejects an unusable monetary correction before the %s writer captures it',action=>{
 const s=fixture(),input={...s.input,answer:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'not a monetary cell'})};
 const result=action==='answer'?answerCaseRequest(input,s.store):editCaseRequest({...input,kind:action,identityId:input.identityId,expectedRevision:0},s.store);
 return expect(result).rejects.toThrow('REQUEST_ANSWER_INVALID').then(()=>{expect(s.calls).not.toContain('case_request_answer_identified');expect(s.calls).not.toContain('case_request_edit');});
});

it.each(['answer','correction','draft'] as const)('rejects legacy confirmation of an absent source value before the %s writer',async action=>{
 const s=fixture('source_transcription'),input={...s.input,answer:'כן, בדקתי במסמך והערך נכון'};
 const result=action==='answer'?answerCaseRequest(input,s.store):editCaseRequest({...input,kind:action,identityId:input.identityId,expectedRevision:0},s.store);
 await expect(result).rejects.toThrow('REQUEST_ANSWER_INVALID');
 expect(s.calls).toContain('case_request_field_reading_targets');
 expect(s.calls).not.toContain('case_request_answer_identified');expect(s.calls).not.toContain('case_request_edit');
});
