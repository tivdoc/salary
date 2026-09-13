import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ThreadView} from './thread-view';
import {DocumentFieldAnswer} from './document-field-answer';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const fields=['quantity','rate','amount']as const;
const rows:StoredRequest[]=fields.map((cell,i)=>({id:`11111111-1111-4111-8111-11111111111${i}`,case_id:'22222222-2222-4222-8222-222222222222',
 code:'document_field:'+String(i).repeat(64),question:`תא ${cell} בשורה הסינתטית`,answer_kind:'choice',blocking:false,field_crop:null,
 opened_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-21T00:00:00Z',answered_at:null,answer_text:null,source_current:true,
 reading_display:{question:`תא ${cell}`,field:'row_cell.'+cell,raw_value:i===0?'96.1':i===1?'10.00':'961.00',page:1,text_fragment:'בונוס סינתטי',bounding_box:null,
 row_context:{group_id:'a'.repeat(64),label:'בונוס',cell},dependent_checks:['כמות כפול תעריף מול הסכום בשורה']}}));
const render=(requests:readonly StoredRequest[])=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests,renderedAt:Date.parse('2026-09-11T12:00:00Z')}));
it.each([true,false])('offers non-payroll cell actions only when the original supports confirmation: %s',canConfirm=>{
 const {row_context:ignored,...display}=rows[0].reading_display!;void ignored;
 const request:StoredRequest={...rows[0],reading_display:{...display,field:'document_evidence.entry_time',evidence_context:{value_kind:'clock_time',can_confirm:canConfirm,
  reading_state:canConfirm?'candidate':'conflict',basis_origin:'system_action_context'}}};
 const html=render([request]);expect(html.match(/option-button/g)).toHaveLength(canConfirm?4:3);
 expect(html.includes('אישור הערך בתא ושמירה')).toBe(canConfirm);expect(html).toContain('view=marked');
 const stale=renderToStaticMarkup(createElement(DocumentFieldAnswer,{request:{...request,source_current:false},publicId:'TV-SYNTH001',onAnswered:()=>{}}));
 expect(stale.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(canConfirm?4:3);
});
it('provides a paragraph correction control while distinguishing system context from user testimony',()=>{
 const {row_context:ignored,...display}=rows[0].reading_display!;void ignored;
 const request:StoredRequest={...rows[0],draft_text:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'סעיף סינתטי מועתק'}),
  reading_display:{...display,field:'document_evidence.clause_text',evidence_context:{value_kind:'text',can_confirm:true,reading_state:'candidate',basis_origin:'system_action_context'}}};
 const html=render([request]);expect(html).toContain('<textarea');expect(html).toContain('סעיף סינתטי מועתק');expect(html).not.toContain('confidence');
 expect(html).toContain('סימון מערכת של פעולת ההעתקה');
});
it('opens one protected source for one exact row while retaining three independent cell actions and anchors',()=>{
 const html=render(rows);expect(html.match(/view=marked/g)).toHaveLength(1);
 expect(html.match(/אישור הערך בתא ושמירה/g)).toHaveLength(3);expect(html.match(/הערך בתא שונה/g)).toHaveLength(3);
 for(const row of rows)expect(html).toContain(`id="request-${row.id}"`);
 expect(html).toContain('כמות כפול תעריף מול הסכום בשורה');expect(html).toContain('<bdi>96.1</bdi>');
 expect(html).not.toContain('96.1%');expect(html).not.toContain('אישור כל');expect(html).not.toContain('confidence');
 expect(html).not.toContain('שמירת בדיקת התא'); // No second click to save a new row-cell confirmation.
});
it('does not reuse a source link for an identical label with a different immutable row identity',()=>{
 const other={...rows[1],reading_display:{...rows[1].reading_display!,row_context:{...rows[1].reading_display!.row_context!,group_id:'b'.repeat(64)}}};
 const html=render([rows[0],other]);expect(html.match(/view=marked/g)).toHaveLength(2);
 expect(html).not.toContain('פותחים את המקור פעם אחת');
});
it('leaves a previously answered cell in history and does not roll it into its unanswered siblings',()=>{
 const answered={...rows[0],answered_at:'2026-09-10T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v2',action:'unknown'})};
 const html=render([answered,...rows.slice(1)]);expect(html).toContain('מה כבר עניתם');expect(html).toContain('לא יודע — הקריאה נשארה לא מאומתת');
 expect(html.match(/אישור הערך בתא ושמירה/g)).toHaveLength(3); // Two active cells + the independent correction form in history.
 expect(html).toContain('אישור של תא אינו מאשר את השורה כולה');
});
it('preserves the historical scalar two-step form and literal source value',()=>{
 const {row_context:ignored,dependent_checks:ignoredChecks,...legacy}=rows[0].reading_display!;void ignored;void ignoredChecks;
 const request={...rows[0],reading_display:{...legacy,field:'regular_hours'}};
 const html=renderToStaticMarkup(createElement(DocumentFieldAnswer,{request,publicId:'TV-SYNTH001',onAnswered:()=>{}}));
 expect(html).toContain('זה הערך בתא');expect(html).toContain('שמירת בדיקת התא');expect(html).toContain('שמירת טיוטה');
 expect(html).not.toContain('אישור הערך בתא ושמירה');expect(html).toContain('<bdi>96.1</bdi>');
});

function transcription(kind:'reported_work_hours'|'balance_unit'|'grand_total',draft=false):StoredRequest{
 const {row_context:ignored,dependent_checks:ignoredChecks,...source}=rows[0].reading_display!;void ignored;void ignoredChecks;
 return {...rows[0],question:'העתקת מידע מהמקור הסינתטי',draft_text:draft?JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:kind==='balance_unit'?'hours':'97.5'}):null,
  reading_display:{...source,field:'source_transcription.'+kind,raw_value:kind==='balance_unit'?'7.25':null,transcription_context:{kind}}};
}
it('renders grand-total amount, printed label and locator independently, retaining drafts without showing encoded data',()=>{
 const value={schema_version:'grand-total-source-value-v1',amount:'20.00',label:'סך הניכויים',locator:'טבלה סינתטית תחתונה, שורת סך'};
 const request={...transcription('grand_total'),draft_text:JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:JSON.stringify(value)})};
 const html=render([request]);expect(html.match(/<input/g)).toHaveLength(3);
 expect(html).toContain('value="20.00"');expect(html).toContain('סך הניכויים');expect(html).toContain(value.locator);
 expect(html).not.toContain('grand-total-source-value-v1');expect(html).not.toContain('זה הערך בתא');expect(html).toContain('ללא חיבור של סיכומי מסים');
 const stale=renderToStaticMarkup(createElement(DocumentFieldAnswer,{request:{...request,source_current:false},publicId:'TV-SYNTH001',onAnswered:()=>{}}));expect(stale.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
 const history=render([{...request,draft_text:null,answered_at:'2026-09-10T00:00:00Z',answer_text:request.draft_text}]);
 expect(history).toContain('20.00');expect(history).toContain(value.locator);expect(history).not.toContain('grand-total-source-value-v1');
});
it.each(['reported_work_hours','balance_unit']as const)('offers only three actions for missing %s without a confirm action or invented value',kind=>{
 const html=render([transcription(kind)]);
 expect(html.match(/option-button/g)).toHaveLength(3);expect(html.match(/view=marked/g)).toHaveLength(1);
 expect(html).not.toContain('זה הערך בתא');expect(html).not.toContain('אישור הערך בתא ושמירה');
 expect(html).not.toContain('<bdi>96.1</bdi>');expect(html).not.toContain('confidence');
 if(kind==='balance_unit')expect(html).toContain('<bdi>7.25</bdi>');else expect(html).not.toContain('הקריאה המקורית');
});
it('edits a missing balance unit through days/hours choices while the retained amount stays read-only',()=>{
 const html=render([transcription('balance_unit',true)]);
 expect(html).toContain('<select');expect(html).toContain('value="days"');expect(html).toContain('value="hours" selected=""');
 expect(html).not.toContain('<input');expect(html).toContain('<bdi>7.25</bdi>');expect(html).toContain('המספר המקורי אינו משתנה');
});
it('copies the reported total as source information and retains that limited meaning in history',()=>{
 const request=transcription('reported_work_hours',true),html=render([request]);
 expect(html).toContain('inputMode="decimal"');expect(html).toContain('value="97.5"');
 expect(html).toContain('שעות מדווחות אינן בהכרח שעות רגילות או שעות בתשלום');
 const saved=render([{...request,answered_at:'2026-09-10T00:00:00Z',answer_text:request.draft_text??null}]);
 expect(saved).toContain('סך השעות המדווחות הועתק מהמסמך: 97.5');expect(saved).toContain('אין בכך סיווג כשעות רגילות או בתשלום');
});
it('separates explicitly deferred actions without claiming an answer or dropping their question from history',()=>{
 const request={...rows[0],not_required_for_current_review:true as const};
 const html=render([request,...rows.slice(1)]);
 expect(html).toContain('2 פעולות נדרשות כעת');expect(html).toContain('1 שאלות נשמרו');expect(html).toContain('לא נדרש לבדיקה הנוכחית');
 expect(html).toContain('שאלות אלה נשמרו ללא תשובה');expect(html).toContain(request.question);
 expect(html.match(/אישור הערך בתא ושמירה/g)).toHaveLength(2);expect(request.answered_at).toBeNull();expect(request.source_current).toBe(true);
});
