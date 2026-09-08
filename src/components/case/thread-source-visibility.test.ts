import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect,vi} from 'vitest';
import {ThreadView} from './thread-view';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
const row:StoredRequest={id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',code:'document_field:'+ 'a'.repeat(64),question:'Synthetic source question',answer_kind:'choice',options:['Synthetic answer'],blocking:false,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-11T00:00:00Z',answered_at:null,answer_text:null,source_current:true};
const render=(request:StoredRequest)=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[request],renderedAt:Date.parse('2026-09-08T12:00:00Z')}));
it('offers an exact source link and answer form only for the current source',()=>{
 const html=render(row);expect(html).toContain('requests?source='+row.id);expect(html).toContain('שליחת תשובה');expect(html).toContain('אינו אישור של החישוב');
});
it('shows an unanswered superseded question as history without expiry or actionable controls',()=>{
 const html=render({...row,source_current:false});expect(html).toContain('שאלות ממסמך קודם');expect(html).toContain(row.question);expect(html).not.toContain('שליחת תשובה');expect(html).not.toContain('requests?source=');expect(html).not.toContain('שאלות שנסגרו ללא תשובה');
});
it('preserves an answered superseded reading without presenting it as current approval',()=>{
 const html=render({...row,source_current:false,answered_at:'2026-09-08T11:00:00Z',answer_text:'Synthetic answer'});expect(html).toContain('Synthetic answer');expect(html).toContain('היא אינה מאשרת נתונים מהמסמך העדכני');expect(html).not.toContain('תיקון התשובה');
});
