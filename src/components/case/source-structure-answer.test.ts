import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {DocumentFieldAnswer} from './document-field-answer';
import {ThreadView} from './thread-view';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import type {SourceStructureContext} from '@/lib/source-structure-display';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const basis={page:1,locator:'טבלה סינתטית',text:'כיתוב המקור הסינתטי'};
const relation:SourceStructureContext={kind:'source_relationship',component_kind:'pension_employee',contribution:{label:'הפרשה סינתטית',raw_value:'60.00'},base:{label:'בסיס סינתטי',raw_value:'1000.00'},proposed_value:null};
const group:SourceStructureContext={kind:'deduction_group',rows:[{component_id:'33333333-3333-4333-8333-333333333333',label:'ניכוי א',raw_value:'20.00'},
 {component_id:'44444444-4444-4444-8444-444444444444',label:'ניכוי ב',raw_value:'30.00'}],proposed_value:null};
const balance:SourceStructureContext={kind:'balance_movement',group_id:'a'.repeat(64),label:'חופשה',cell:'opening',proposed_value:null};
function row(context:SourceStructureContext,index=0,answer_text:string|null=null):StoredRequest{return {id:`11111111-1111-4111-8111-11111111111${index}`,case_id:'22222222-2222-4222-8222-222222222222',
 code:'document_field:'+'b'.repeat(64),question:'בדיקת מקור סינתטי',answer_kind:'text',blocking:false,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text,
 source_current:true,reading_display:{question:'בדיקת מקור סינתטי',field:context.kind,raw_value:null,page:1,text_fragment:null,bounding_box:null,structure_context:context,dependent_checks:['בדיקה חשבונית סינתטית']}};}
const render=(request:StoredRequest,correction=false)=>renderToStaticMarkup(createElement(DocumentFieldAnswer,{request,publicId:'TV-SYNTH001',correction,onAnswered:()=>{}}));
it.each([relation,group,balance])('offers three source-only actions without a confirm proposal or inferred value: $kind',context=>{
 const html=render(row(context));expect(html.match(/option-button/g)).toHaveLength(3);expect(html).toContain(context.kind==='source_relationship'?'תיקון או פירוט הקשר':'העתקת הפרט מהמקור');
 expect(html).not.toContain('אישור השיוך המוצג ושמירה');expect(html).not.toContain('אישור תא היתרה ושמירה');
 expect(html).toContain('view=marked');expect(html).toContain('בדיקה חשבונית סינתטית');expect(html).not.toContain('confidence');
});
it('presents an explicit source relationship without another numeric confirmation input',()=>{
 const value={kind:'source_relationship' as const,relationship:'same_base' as const,component_kind:'pension_employee' as const,fund_kind:'pension' as const,source_kind:'same_row' as const,fund_label:'קרן סינתטית',basis};
 const context={...relation,proposed_value:value,allows_explicit_confirmation:true};
 const html=render(row(context));expect(html.match(/option-button/g)).toHaveLength(4);expect(html).toContain('אישור קשר בין הרכיב לבסיס');
 expect(html).toContain('<bdi>60.00</bdi>');expect(html).toContain('<bdi>1000.00</bdi>');expect(html).not.toContain('<input');
 const corrected=render(row(context,0,JSON.stringify({schema_version:'document-field-answer-v3',action:'correct',structured_value:{...value,relationship:'different_base'}})),true);
 expect(corrected).toContain('value="different_base" selected=""');expect(corrected).not.toContain('value="60.00"');expect(corrected).not.toContain('value="1000.00"');
 expect(corrected).toContain('הכיתוב במקור');expect(corrected).toContain('שמירת תיקון בדיקת המקור');
});
it('shows explicit confirmation fields and source evidence rather than a one-click numeric approval',()=>{
 const value={kind:'source_relationship',relationship:'same_base',component_kind:'pension_employee',fund_kind:'pension',source_kind:'labelled_section',fund_label:'קרן סינתטית',basis};
 const html=render(row({...relation,allows_explicit_confirmation:true},0,JSON.stringify({schema_version:'document-field-answer-v3',action:'confirm',structured_value:value})),true);
 expect(html).toContain('סוג הקרן או הרכיב לפי המקור');expect(html).toContain('value="labelled_section" selected=""');
 expect(html).toContain('שמירת אישור הקשר');expect(html).toContain('הכיתוב במקור');expect(html).not.toContain('אישור הערך בתא ושמירה');
});
it('edits each deduction membership and inventory explicitly, while row amounts stay read-only',()=>{
 const answer={schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'deduction_group',members:group.rows.map((r,i)=>({component_id:r.component_id,group:i?'unknown':'mandatory'})),inventory:'partial',basis}};
 const html=render(row(group,0,JSON.stringify(answer)),true);
 expect(html.match(/<select/g)).toHaveLength(3);expect(html).toContain('value="partial" selected=""');expect(html).toContain('value="unknown" selected=""');
 expect(html).not.toContain('value="20.00"');expect(html).not.toContain('value="30.00"');expect(html).toContain('התאמה בסכום אינה ראיה לשיוך');
 expect(html).not.toContain('value="voluntary"');expect(render(row({...group,allows_voluntary:true},0,JSON.stringify(answer)),true)).toContain('value="voluntary"');
});
it('keeps explicit unknown native units in the balance editor and history',()=>{
 const answer=JSON.stringify({schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'balance_movement',state:'value',amount:'2.5',unit:'source_native_unknown',period:'2026-07',basis}});
 const request=row(balance,0,answer),html=render(request,true);expect(html).toContain('value="source_native_unknown" selected=""');
 expect(html).toContain('value="2.5"');expect(html).toContain('type="month"');expect(html).toContain('value="2026-07"');expect(html).not.toContain('type="checkbox"');
 const history=renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[{...request,answered_at:'2026-09-12T00:00:00Z'}],renderedAt:Date.parse('2026-09-12T12:00:00Z')}));
 expect(history).toContain('ביחידה שאינה מודפסת במקור');expect(history).not.toContain('document-field-answer-v3');expect(history).not.toContain('structured_value');
});
it('groups distinct balance cells with one protected source and independent decisions; answered cells remain in history',()=>{
 const contexts=(['opening','accrued','used']as const).map(cell=>({...balance,cell})),requests=contexts.map((context,i)=>row(context,i));
 const html=renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests,renderedAt:Date.parse('2026-09-12T12:00:00Z')}));
 expect(html).toContain('בדיקת תאים בטבלת יתרות');expect(html.match(/view=marked/g)).toHaveLength(1);expect(html.match(/העתקת הפרט מהמקור/g)).toHaveLength(3);
 for(const request of requests)expect(html).toContain(`id="request-${request.id}"`);
 const withAnswer=[{...requests[0],answered_at:'2026-09-12T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'})},...requests.slice(1)];
 const history=renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:withAnswer,renderedAt:Date.parse('2026-09-12T12:00:00Z')}));
 expect(history).toContain('מה כבר עניתם');expect(history).toContain('נשארו לא מאומתים');expect(history).toContain('תאים שכבר נענו נשארים בהיסטוריה');
});
it('disables stale relationship controls and preserves the prior literal answer',()=>{
 const request={...row(relation),source_current:false,answer_text:'תשובה היסטורית'};
 const html=render(request,true);expect(html.match(/disabled=""/g)).toHaveLength(3);
 expect(request.answer_text).toBe('תשובה היסטורית');expect(request.source_current).toBe(false);
});
const periodAssociation:SourceStructureContext={kind:'period_association',month:'2026-06',refs:[
 {label:'רכיב סינתטי',raw_value:'120.00',page:1},{label:'כמות סינתטית',raw_value:'3.00',page:1}],proposed_value:null};
it('offers three period-source actions and displays existing amounts without editable numeric cells',()=>{
 const html=render(row(periodAssociation));expect(html.match(/option-button/g)).toHaveLength(3);
 expect(html).toContain('<bdi>120.00</bdi>');expect(html).toContain('<bdi>3.00</bdi>');expect(html).toContain('אין צורך לאשר אותם שוב');
 expect(html).toContain('2026-06');expect(html).not.toContain('אישור קשר');expect(html).not.toContain('<input');
});
it('edits only the source period, preserving cumulative dates and a fixed protected page',()=>{
 const answer=JSON.stringify({schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'period_association',period_kind:'cumulative',
  period:{from:'2026-01-01',to:'2026-06-30'},basis}});
 const request=row(periodAssociation,0,answer),html=render(request,true);
 expect(html).toContain('value="cumulative" selected=""');expect(html.match(/type="date"/g)).toHaveLength(2);
 expect(html).toContain('value="2026-01-01"');expect(html).toContain('value="2026-06-30"');expect(html).toContain('עמוד המקור: 1');
 expect(html).not.toContain('value="120.00"');expect(html).not.toContain('value="3.00"');expect(html).not.toContain('inputMode="numeric"');
 expect(html).toContain('שמירת תיקון בדיקת המקור');expect(html).toContain('שמירת טיוטה');
 const history=renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[{...request,answered_at:'2026-09-12T00:00:00Z'}],renderedAt:Date.parse('2026-09-12T12:00:00Z')}));
 expect(history).toContain('נתון מצטבר');expect(history).toContain('המספרים נשמרו ללא אישור מחדש');expect(history).not.toContain('structured_value');
});
it.each([false,undefined])('requires current source proof for the new period controls: %s',source_current=>{
 const html=render({...row(periodAssociation),source_current});expect(html.match(/disabled=""/g)).toHaveLength(3);
});
