import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ThreadView} from './thread-view';
import {HOURS_CONFLICT_ANSWER_VERSION,HOURS_CONFLICT_NAMESPACE} from '@/server/product/reports/document-hours-conflict-answer';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const row:StoredRequest={id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',code:HOURS_CONFLICT_NAMESPACE+'a'.repeat(64),
 question:'Synthetic hours conflict',answer_kind:'text',blocking:false,field_crop:'regular_hours',opened_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-12T00:00:00Z',
 answered_at:null,answer_text:null,source_current:true,hours_conflict_source:{conflict_reason:'conflicting_observations',source_observations:[
  {candidate_id:'33333333-3333-4333-8333-333333333333',raw_value:'100',page:1,source_label:'שעות רגילות בכותרת'},
  {candidate_id:'44444444-4444-4444-8444-444444444444',raw_value:'120',page:1,source_label:'שעות בסיכום נוכחות'}]}};
const render=(request:StoredRequest)=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[request],renderedAt:Date.parse('2026-09-11T00:00:00Z')}));
it('shows both source readings, a blank hours field, basis and explicit unknown without claiming legal approval',()=>{
 const html=render(row);expect(html).toContain('100');expect(html).toContain('120');expect(html).toContain('שעות בסיכום נוכחות');
 expect(html).toContain('שעות רגילות בחודש');expect(html).toContain('value=""');expect(html).toContain('<textarea');
 expect(html).toContain('לא ניתן לקבוע את מספר השעות');expect(html).toContain('אינה אישור משפטי');expect(html).toContain('requests?source='+row.id);
 expect(html).not.toContain('לא מעכב את הבדיקה');expect(html).not.toContain('השדה בתלוש: regular_hours');
});
it('shows omitted observations honestly and preserves unknown answer history without raw JSON',()=>{
 const empty=render({...row,hours_conflict_source:{conflict_reason:'provider_reported_conflict',source_observations:[]}});expect(empty).toContain('אין כאן מספר שעות שנבחר עבורך');
 const html=render({...row,answered_at:'2026-09-11T00:00:00Z',answer_revision:2,answer_text:JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'unknown',basis:'חסר רישום נוכחות'})});
 expect(html).toContain('לא ניתן לקבוע את מספר השעות');expect(html).toContain('חסר רישום נוכחות');expect(html).toContain('גרסה 2');expect(html).not.toContain('schema_version');
});
it('does not offer an answer or correction for a replaced source',()=>{
 for(const answered_at of [null,'2026-09-11T00:00:00Z']){
  const html=render({...row,source_current:false,answered_at,answer_text:JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'declared',hours:'100',basis:'Synthetic attendance basis'})});
  expect(html).not.toContain('שליחת תשובה');expect(html).not.toContain('תיקון התשובה');expect(html).not.toContain('<textarea');
 }
});
