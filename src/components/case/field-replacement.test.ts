import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {ThreadView} from './thread-view';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const row:StoredRequest={id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',code:'document_field:'+'a'.repeat(64),question:'Synthetic field question',answer_kind:'choice',options:['הערך שונה במסמך'],blocking:false,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2026-09-11T00:00:00Z',answered_at:'2026-09-08T00:00:00Z',answer_text:'הערך שונה במסמך',source_current:true};
const render=(request:StoredRequest)=>renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[request],renderedAt:Date.parse('2026-09-09T00:00:00Z')}));
it.each(['הערך שונה במסמך','לא ניתן לקרוא את השדה'])('offers the current source replacement after %s without inventing a value',answer_text=>{
 const html=render({...row,answer_text});expect(html).toContain('החלפת המסמך של השאלה');expect(html).toContain('המסמך הקודם נשמר עד להשלמת ההחלפה');expect(html).toContain(answer_text);
});
it.each([false,undefined])('does not offer replacement when source currency is %s',source_current=>{
 expect(render({...row,source_current})).not.toContain('החלפת המסמך של השאלה');
});
it('does not attach this source action to affirmative readings or ordinary questions',()=>{
 expect(render({...row,answer_text:'כן, בדקתי במסמך והערך נכון'})).not.toContain('החלפת המסמך של השאלה');
 expect(render({...row,code:'fact.missing:work.regular_hours'})).not.toContain('החלפת המסמך של השאלה');
});
