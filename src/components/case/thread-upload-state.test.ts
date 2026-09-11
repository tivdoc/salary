import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ThreadView} from './thread-view';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const row:StoredRequest={id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',
 code:'document_review:'+'a'.repeat(64),question:'נא לצרף תלוש מלא לחודש יוני.',answer_kind:'document',blocking:false,field_crop:null,
 opened_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-21T00:00:00Z',answered_at:null,answer_text:null,source_current:true};
const render=(request:StoredRequest)=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[request],renderedAt:Date.parse('2026-09-11T12:00:00Z')}));
it('shows receipt pending review as an active document request without pretending the user answered or upload satisfied it',()=>{
 const html=render({...row,document_upload_state:{state:'received_pending_review',information_satisfied:false,analysis_run_id:null,reason:null}});
 expect(html).toContain('הקובץ התקבל וממתין לבדיקה');expect(html).toContain('עדיין לא נקבע שהמידע הנדרש נמצא בו');
 expect(html).toContain('צירוף מסמך נוסף לבקשה');expect(html).not.toContain('אין כרגע שאלות פתוחות');expect(html).not.toContain('מה כבר עניתם');
});
it('keeps duplicate/incomplete information actionable and uses customer wording rather than internal reason codes',()=>{
 const html=render({...row,document_upload_state:{state:'insufficient',information_satisfied:false,analysis_run_id:'saved-run',reason:'duplicate_content'}});
 expect(html).toContain('הקובץ התקבל, אך ההשלמה עדיין חסרה');expect(html).toContain('תוכן שכבר קיים בתיק');expect(html).toContain('צירוף המסמך לתיק');
 expect(html).not.toContain('duplicate_content');expect(html).not.toContain('saved-run');
});
it('shows fulfilled information only in document-completion history while preserving unanswered source truth',()=>{
 const request={...row,document_upload_state:{state:'satisfied' as const,information_satisfied:true,analysis_run_id:'saved-run',reason:'target_specific_observed_source' as const}};
 const html=render(request);expect(html).toContain('אין כרגע שאלות פתוחות');expect(html).toContain('השלמות שהמידע בהן נמצא');
 expect(html).toContain(row.question);expect(html).toContain('המידע הנדרש נמצא במסמך שהעלית');
 expect(html).not.toContain('צירוף המסמך לתיק');expect(html).not.toContain('מה כבר עניתם');expect(html).not.toContain('שאלות שנסגרו ללא תשובה');
 expect(request.answered_at).toBeNull();expect(request.source_current).toBe(true);
});
it('does not label a replaced source fulfilled or remove its history based on a prior satisfied view',()=>{
 const html=render({...row,source_current:false,document_upload_state:{state:'satisfied',information_satisfied:true,analysis_run_id:'old-run',reason:'target_specific_observed_source'}});
 expect(html).toContain('שאלות ממסמך קודם');expect(html).toContain(row.question);expect(html).not.toContain('השלמות שהמידע בהן נמצא');expect(html).not.toContain('צירוף המסמך לתיק');
});
