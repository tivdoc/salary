import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {listCaseRequests} from './case-requests';
import {validateSavedReadingAnswer} from './validate-reading-answer';
import {documentEvidenceTarget} from './document-evidence-reading';
import {evidenceReadingFixture,evidenceUuid} from './document-evidence-reading.fixtures';
import type {CaseAccessDb} from '../case-access/db';
function setup(current=true){
 const f=evidenceReadingFixture(),target=documentEvidenceTarget(f),id=evidenceUuid(8),identity=evidenceUuid(9);
 const row={id,case_id:target.case_id,code:`document_field:${target.target_sha256}`,question:'קריאת מקור סינתטי',answer_kind:'choice',options:null,field_crop:null,
  blocking:false,opened_at:'2026-07-01T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',answered_at:null,answer_text:null};
 const calls:string[]=[],responses:Record<string,unknown[]>={case_request_list:[row],case_request_revision_list:[],case_request_field_states:[{request_id:id,source_current:current}],
  case_request_field_reading_targets:[{request_id:id,target}]};
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string){calls.push(fn);if(!(fn in responses))throw Error('UNEXPECTED_RPC:'+fn);return responses[fn]as T[];}};
 return {f,target,id,identity,row,calls,responses,db};
}
it.each([true,false])('projects only safe non-payroll display with currentness %s',async current=>{
 const s=setup(current),[request]=await listCaseRequests(s.target.case_id,s.db,s.identity);
 expect(request.source_current).toBe(current);
 expect(request.reading_display).toMatchObject({raw_value:'08:30',page:1,evidence_context:{value_kind:'clock_time',can_confirm:true,reading_state:'candidate',basis_origin:'system_action_context'}});
 const text=JSON.stringify(request);
 for(const forbidden of ['confidence','checkpoint_sha256','normalized_sha256','observation_id',s.target.source_sha256])expect(text).not.toContain(forbidden);
 expect(s.calls).toHaveLength(4);
});
it('rejects a foreign-case target and does not display a target without authenticated identity',async()=>{
 const s=setup();await expect(listCaseRequests(evidenceUuid(99),s.db,s.identity)).rejects.toThrow('REQUEST_FIELD_STATE_UNAVAILABLE');
 const [request]=await listCaseRequests(s.target.case_id,s.db);expect(request.reading_display).toBeUndefined();
});
it('validates identified non-payroll corrections before persistence and refuses missing identity',async()=>{
 const s=setup(),input={store:s.db,caseId:s.target.case_id,identityId:s.identity,requestId:s.id,code:s.row.code,
  answer:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'09:20'})};
 await expect(validateSavedReadingAnswer(input)).resolves.toBeUndefined();
 await expect(validateSavedReadingAnswer({...input,identityId:undefined})).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
 await expect(validateSavedReadingAnswer({...input,answer:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'wrong clock'})})).rejects.toThrow('REQUEST_ANSWER_INVALID');
 expect(s.calls.every(c=>c==='case_request_field_reading_targets')).toBe(true);
});
