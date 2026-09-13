import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ThreadView} from './thread-view';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const renderedAt=Date.parse('2026-09-12T12:00:00Z');
function waiting():StoredRequest{return {
 id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',code:'legacy.source.document:synthetic-order',
 question:'נא לצרף מקור לזיהוי התקופה',answer_kind:'document',blocking:true,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2026-10-01T00:00:00Z',
 answered_at:null,answer_text:null,source_current:true,source_intake_upload_state:{state:'received_pending_reading',information_satisfied:false,reason:null,reading_request_ids:[]},
};}
function reading():StoredRequest{return {...waiting(),id:'33333333-3333-4333-8333-333333333333',code:'document_field:'+'a'.repeat(64),
 question:'זיהוי סוג המקור והתקופה',answer_kind:'choice',source_intake_upload_state:undefined,
 reading_display:{question:'זיהוי סוג המקור והתקופה',field:'source.period_and_type',page:1,raw_value:null,text_fragment:null,bounding_box:null,
  period_intake_context:{page_count:2,month:null}}};}
const render=(requests:readonly StoredRequest[])=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests,renderedAt}));
it('keeps a received file visible and unanswered without counting it as user work or pausing the clock',()=>{
 const request=waiting(),before=JSON.stringify(request),html=render([request]);
 expect(html).toContain('0 פעולות נדרשות כעת');expect(html).toContain('ממתינים לעיבוד המידע');expect(html).toContain('אין כרגע פעולה שנדרשת ממך');
 expect(html).not.toContain('שעון הזמנים עצור');expect(html).not.toContain('ממתינים לתשובה כדי להמשיך');expect(html).not.toContain('צירוף המסמך לתיק');
 expect(html).not.toContain('מה כבר עניתם');expect(html).not.toContain('השלמות שהמידע בהן נמצא');expect(JSON.stringify(request)).toBe(before);
 expect(html).toContain('עד שתי דקות');expect(html).toContain('רענון השאלות');
});
it('still counts the linked reading and every independent question, with the file remaining a separate waiting card',()=>{
 const field=reading(),other:StoredRequest={...field,id:'44444444-4444-4444-8444-444444444444',code:'synthetic.independent',question:'מידע עובדתי עצמאי',answer_kind:'text',reading_display:undefined};
 const intake:StoredRequest={...waiting(),source_intake_upload_state:{state:'received_pending_reading',information_satisfied:false,reason:null,reading_request_ids:[field.id]}};
 const html=render([intake,field,other]);
 expect(html).toContain('2 פעולות נדרשות כעת');expect(html).toContain(`href="#request-${field.id}"`);expect(html).toContain(`id="request-${field.id}"`);
 expect(html).toContain('מידע עובדתי עצמאי');expect(html).toContain('שליחת תשובה');expect(html).toContain('העתקת הפרט מהמקור');expect(html).toContain('שעון הזמנים עצור');
 expect(html.match(/requests\?source=33333333-3333-4333-8333-333333333333/g)).toHaveLength(1);
 expect(html).toContain('#page=1');expect(html).not.toContain('פתיחת המסמך לאימות השדה');
});
it.each(['unknown','unreadable']as const)('preserves %s source history and actionable insufficient information',action=>{
 const field={...reading(),answered_at:'2026-09-12T11:00:00Z',answer_text:JSON.stringify({v:1,action})};
 const intake:StoredRequest={...waiting(),source_intake_upload_state:{state:'insufficient',information_satisfied:false,reason:'source_reading_unresolved',reading_request_ids:[field.id]}};
 const html=render([intake,field]);expect(html).toContain('1 פעולות נדרשות כעת');expect(html).toContain('מה כבר עניתם');
 expect(html).toContain('צירוף המסמך לתיק');expect(html).toContain('תיקון התשובה');expect(html).toContain(action==='unknown'?'נשארו להשלמה':'נדרש מקור ברור יותר');
});
it('keeps stale, expired and satisfied upload history out of the waiting and action lists',()=>{
 const first=waiting(),stale={...first,source_current:false},expired={...first,id:'55555555-5555-4555-8555-555555555555',expires_at:'2026-09-11T00:00:00Z'};
 const satisfied:StoredRequest={...first,id:'66666666-6666-4666-8666-666666666666',source_intake_upload_state:{state:'satisfied',information_satisfied:true,reason:'source_period_identified',reading_request_ids:[]}};
 const html=render([stale,expired,satisfied]);expect(html).toContain('0 פעולות נדרשות כעת');expect(html).toContain('שאלות ממסמך קודם');expect(html).toContain('שאלות שנסגרו ללא תשובה');expect(html).toContain('השלמות שהמידע בהן נמצא');
 expect(html).not.toContain('ממתינים לעיבוד המידע');expect(html).not.toContain('צירוף המסמך לתיק');
});
