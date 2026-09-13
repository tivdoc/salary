import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect,vi} from 'vitest';
import {DocumentFieldAnswer} from './document-field-answer';
import {ThreadView} from './thread-view';
import {buildSourcePeriodIntakeAnswer,initialSourcePeriodIntakeDraft,displaySourcePeriodIntakeAnswer} from '@/lib/source-period-intake-display';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const context={page_count:2,month:null},draft={document_kind:'payslip',period_shown:'yes',from:'2026-06-01',to:'2026-06-30',page:'2',source_label:'כותרת תקופה סינתטית'};
function row(saved?:string):StoredRequest{return {id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',code:'document_field:'+'b'.repeat(64),
 question:'זיהוי מקור סינתטי',answer_kind:'choice',blocking:true,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text:null,
 ...(saved?{draft_text:saved}:{}),source_current:true,reading_display:{question:'זיהוי מקור סינתטי',field:'source.period_and_type',raw_value:null,page:1,text_fragment:null,bounding_box:null,period_intake_context:context}};}
const render=(request:StoredRequest)=>renderToStaticMarkup(createElement(DocumentFieldAnswer,{request,publicId:'TV-SYNTH001',onAnswered:()=>{}}));
it('opens the original physical document and offers only source-copy/unknown/unreadable with no suggested month or page answer',()=>{
 const body=render(row());expect(body.match(/option-button/g)).toHaveLength(3);expect(body).toContain('?source=11111111-1111-4111-8111-111111111111#page=1');expect(body).not.toContain('זה הערך בתא');
 expect(initialSourcePeriodIntakeDraft(context,null).draft).toEqual({document_kind:'',period_shown:'',from:'',to:'',page:'',source_label:''});expect(body).not.toContain('value="2026');
});
it.each([false,undefined])('refuses UI submission without explicit current source state %s',source_current=>{const body=render({...row(),source_current});expect(body.match(/disabled=""/g)).toHaveLength(3);expect(body).toContain('לא ניתן לאמת שהמסמך עדיין נוכחי');});
it('restores dated source copy with exact page, independent dates and correction/draft controls',()=>{
 const wire=buildSourcePeriodIntakeAnswer(context,'correct',draft),body=render(row(JSON.stringify(wire)));
 expect(body.match(/type="date"/g)).toHaveLength(2);expect(body).toContain('min="1" max="2"');expect(body).toContain('value="2"');expect(body).toContain('כותרת תקופה סינתטית');expect(body).toContain('שמירת טיוטה');
});
it('keeps explicitly absent printed period null and does not fill it from retained date controls',()=>{
 const wire=buildSourcePeriodIntakeAnswer(context,'correct',{...draft,period_shown:'no'});expect(wire).toMatchObject({value:{period:null,page:2}});
 const body=render(row(JSON.stringify(wire)));expect(body).not.toContain('type="date"');expect(displaySourcePeriodIntakeAnswer(JSON.stringify(wire),context)).toContain('לא מופיעה תקופה');
});
it.each([{page:'0'},{page:'3'},{page:'1.5'},{from:'2026-02-30'},{from:'2026-07-01'},{source_label:''},{document_kind:'legal_approval'},{period_shown:''}])('refuses invalid source copy %j',change=>{
 expect(buildSourcePeriodIntakeAnswer(context,'correct',{...draft,...change})).toBeNull();
});
it.each(['unknown','unreadable'] as const)('preserves %s history in ordinary thread without wire JSON or an affirmative period',action=>{
 const answer=JSON.stringify(buildSourcePeriodIntakeAnswer(context,action,draft)),request={...row(),answered_at:'2026-09-12T12:00:00Z',answer_text:answer};
 const body=renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[request],renderedAt:Date.parse('2026-09-12T13:00:00Z')}));
 expect(body).toContain('מה כבר עניתם');expect(body).not.toContain('&quot;v&quot;');expect(body).not.toContain('2026-06-01');expect(body).toContain(action==='unknown'?'נשארו להשלמה':'נדרש מקור ברור יותר');
});
