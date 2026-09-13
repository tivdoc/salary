import {it,expect,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
vi.mock('server-only',()=>({}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {ThreadView} from '@/components/case/thread-view';
import {sourceIntakeUploadFixture} from '../documents/source-intake-upload.fixture';
import {listCaseRequests,documentRequestSatisfied,caseSlaPaused} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
function fixture(state:'pending'|'positive'|'unknown'|'requested'='positive'){
 const f=sourceIntakeUploadFixture();
 if(state==='pending'||state==='requested')f.context.journal.answers=[];
 if(state==='unknown'){f.answerRow.answer=JSON.stringify({v:1,action:'unknown'});f.answerRow.answer_revision=2;}
 f.context.journalSha256=canonicalSha256(f.context.journal);
 const base={case_id:f.caseId,options:null,field_crop:null,blocking:true,opened_at:'2026-09-12T10:00:00Z',expires_at:'2099-09-21T00:00:00Z',answered_at:null,answer_text:null};
 const row={...base,id:f.scope.request_id,code:`legacy.source.document:${f.scope.target.order_id}`,question:'נא לצרף מקור לתקופה לבדיקה',answer_kind:'document'};
 const field={...base,id:f.answerRow.id,code:f.answerRow.code,question:'סוג המקור ותקופתו',answer_kind:'choice',
  ...(state==='positive'||state==='unknown'?{answered_at:f.answerRow.answer_created_at,answer_text:f.answerRow.answer}:{})};
 const context={scope:f.scope,receipt:state==='requested'?null:f.receipt,journalContext:f.context,reading_request_ids:state==='requested'?[]:[field.id]};
 const responses:Record<string,unknown[]>={case_request_list:[row,...(state==='requested'?[]:[field])],case_request_revision_list:[],
  case_request_source_intake_upload_context:[{value:[context]}],case_request_field_states:[{request_id:field.id,source_current:true}],case_request_field_reading_targets:[{request_id:field.id,target:f.target}]};
 const calls:string[]=[];const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string){calls.push(fn);if(!(fn in responses))throw Error('UNEXPECTED_RPC:'+fn);return responses[fn] as T[];}};
 return {...f,row,field,context,responses,calls,db};
}
const render=(requests:Awaited<ReturnType<typeof listCaseRequests>>)=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests,renderedAt:Date.parse('2026-09-12T13:00:00Z')}));
it('projects actual received bytes through the same saved journal reader and links the one source question without another upload or fake answer',async()=>{
 const f=fixture('pending'),before=canonicalSha256(f.context),rows=await listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id),row=rows[0];
 expect(row).toMatchObject({answered_at:null,answer_text:null,source_current:true,source_intake_upload_state:{state:'received_pending_reading',information_satisfied:false,reading_request_ids:[f.field.id]}});
 expect(documentRequestSatisfied(row)).toBe(false);expect(caseSlaPaused([row])).toBe(true);
 const html=render(rows);expect(html).toContain('הקובץ התקבל');expect(html).toContain('#request-'+f.field.id);expect(html).not.toContain('צירוף המסמך לתיק');
 expect(row.source_intake_upload_state).not.toHaveProperty('receipt_sha256');expect(row).not.toHaveProperty('target');expect(canonicalSha256(f.context)).toBe(before);
 expect(f.calls).not.toContain('case_request_review_upload_states');expect(f.calls.some(c=>c.includes('answer')||c.includes('record'))).toBe(false);
});
it('only positive replay moves the source upload to information history while nine-topic analysis stays separate',async()=>{
 const f=fixture(),rows=await listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id),row=rows[0];
 expect(documentRequestSatisfied(row)).toBe(true);expect(caseSlaPaused([row])).toBe(false);expect(row.answered_at).toBeNull();expect(row.answer_text).toBeNull();
 const html=render(rows);expect(html).toContain('השלמות שהמידע בהן נמצא');expect(html).toContain('הבדיקות בתשעת הנושאים נמשכות בנפרד');expect(html).toContain(f.row.question);
 expect(row.source_intake_upload_state).not.toHaveProperty('analysis_run_id');
});
it('keeps an unknown reading unresolved with its original history and an option for a clearer source',async()=>{
 const f=fixture('unknown'),rows=await listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id);
 expect(rows[0]).toMatchObject({answered_at:null,source_intake_upload_state:{state:'insufficient',information_satisfied:false,reason:'source_reading_unresolved'}});
 expect(rows[1].answer_text).toBe(f.answerRow.answer);expect(render(rows)).toContain('לא ידועה או לא קריאה');expect(render(rows)).toContain('צירוף המסמך לתיק');
});
it('shows the identified partial attendance range and the precise missing payroll source without changing satisfaction',async()=>{
 const f=fixture();f.answerRow.answer=JSON.stringify({...f.answer,value:{...f.answer.value,document_kind:'attendance',period:{from:'2026-06-18',to:'2026-07-17'}}});
 f.context.journalContext.journalSha256=canonicalSha256(f.context.journalContext.journal);
 const rows=await listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id);
 expect(rows[0].source_intake_coverage).toEqual([{state:'partial_period',kind:'attendance',period:{from:'2026-06-18',to:'2026-07-17'},months:[]}]);
 expect(documentRequestSatisfied(rows[0])).toBe(false);const html=render(rows);
 expect(html).toContain('2026-06-18');expect(html).toContain('2026-07-17');expect(html).toContain('תלוש שכר מלא המציג את חודש השכר');
 expect(html).toContain('אין צורך לקרוא שוב');expect(JSON.stringify(rows[0].source_intake_coverage)).not.toContain(f.document.sha256);
});
it.each(['missing_anchor','wrong_code','foreign_link','missing_context','duplicate_context'] as const)('refuses %s context instead of projecting satisfaction',async kind=>{
 const f=fixture();if(kind==='missing_anchor')f.context.journalContext.sourceAnchors=[];
 if(kind==='wrong_code')f.row.code+=':2026-07';if(kind==='foreign_link')f.context.reading_request_ids=[f.scope.request_id];
 if(kind==='missing_context')f.responses.case_request_source_intake_upload_context=[{value:[]}];
 if(kind==='duplicate_context')f.responses.case_request_source_intake_upload_context=[{value:[f.context,f.context]}];
 await expect(listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id)).rejects.toThrow();
});
it('shows requested intake before upload and leaves unrelated historical cases independent of the new RPC',async()=>{
 const f=fixture('requested'),rows=await listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id);
 expect(rows[0].source_intake_upload_state?.state).toBe('requested');expect(render(rows)).toContain('צירוף המסמך לתיק');
 f.responses.case_request_list=[];f.calls.length=0;await listCaseRequests(f.caseId,f.db,f.answerRow.answer_identity_id);
 expect(f.calls).toEqual(['case_request_list','case_request_revision_list']);
});
