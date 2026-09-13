import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {DocumentFieldAnswer} from './document-field-answer';
import {ThreadView} from './thread-view';
import {buildTravelTariffAnswer,initialTravelTariffDraft,type TravelTariffContext} from '@/lib/travel-tariff-display';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const context:TravelTariffContext={subject:'daily_fare',page:2,locator:'מקטע תעריף סינתטי'};
function row(c=context,saved?:string):StoredRequest{return {id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',
 code:'document_field:'+'b'.repeat(64),question:'קריאת תעריף סינתטי',answer_kind:'choice',blocking:false,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text:null,
 ...(saved?{draft_text:saved}:{}),source_current:true,reading_display:{question:'קריאת תעריף סינתטי',field:'travel_tariff.'+c.subject,raw_value:null,page:c.page,text_fragment:null,bounding_box:null,tariff_context:c,dependent_checks:['השוואת נסיעות סינתטית']}};}
const render=(request:StoredRequest,correction=false)=>renderToStaticMarkup(createElement(DocumentFieldAnswer,{request,publicId:'TV-SYNTH001',correction,onAnswered:()=>{}}));
function saved(c:TravelTariffContext){const draft={...initialTravelTariffDraft(c).draft,route_reference:'מסלול סינתטי',from:'2026-05-01',to:'2026-07-31',discount_profile:'standard_adult',directions:'both',
 ticket_inventory:'partial',monthly_pass_availability:'available',amount:'9.50',text:'כיתוב המקור הסינתטי'};return JSON.stringify(buildTravelTariffAnswer(c,'correct',draft));}

describe('ordinary document_field tariff form',()=>{
 it.each(['context','daily_fare','ticket_inventory','monthly_pass_cost'] as const)('offers three source-only actions for %s without a confirmation button or default price',subject=>{
  const html=render(row({...context,subject}));expect(html.match(/option-button/g)).toHaveLength(3);
  expect(html).toContain('העתקת הפרט מהמקור');expect(html).toContain('לא קריא');expect(html).toContain('לא יודע');
  expect(html).not.toContain('זה הערך בתא');expect(html).not.toContain('אישור הערך בתא');expect(html).not.toContain('value="0"');
  expect(html).toContain('view=marked#page=2');expect(html).toContain('השוואת נסיעות סינתטית');expect(html).not.toContain('confidence');
 });
 it.each([false,undefined])('disables every action when source currentness is %s',source_current=>{
  const html=render({...row(),source_current});expect(html.match(/disabled=""/g)).toHaveLength(3);expect(html).toContain('לרענן את מצב המקור');
 });
 it('edits the source amount independently, keeps the pinned page read-only and offers a draft and correction',()=>{
  const request={...row(),answer_text:saved(context)},html=render(request,true);
  expect(html).toContain('value="9.50"');expect(html).toContain('inputMode="decimal"');expect(html).toContain('שמירת תיקון קריאת התעריף');expect(html).toContain('שמירת טיוטה');
  expect(html).toContain('עמוד המקור הקשור לבקשה: 2');expect(html).not.toContain('value="2"');expect(html).not.toContain('type="date"');expect(html).toContain('כיתוב המקור הסינתטי');
 });
 it('shows explicit route, discount, direction and date controls rather than a legal choice',()=>{
  const c={...context,subject:'context' as const},html=render(row(c,saved(c)));
  expect(html.match(/type="date"/g)).toHaveLength(2);expect(html).toContain('value="2026-05-01"');expect(html).toContain('value="standard_adult" selected=""');
  expect(html).toContain('value="both" selected=""');expect(html).toContain('אין לבחור אותם לפי חודש התלוש');expect(html).not.toContain('inputMode="decimal"');
 });
 it('preserves a partial ticket inventory and asks availability independently of price',()=>{
  const c={...context,subject:'ticket_inventory' as const},html=render(row(c,saved(c)));
  expect(html).toContain('value="partial" selected=""');expect(html).toContain('value="available" selected=""');expect(html).toContain('היעדר מחיר');expect(html).not.toContain('inputMode="decimal"');
 });
 it('retains an answered unknown in ordinary history without exposing wire JSON or reusing an affirmative price',()=>{
  const answer=JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'}),request={...row(),answered_at:'2026-09-12T12:00:00Z',answer_text:answer};
  const html=renderToStaticMarkup(createElement(ThreadView,{publicId:'TV-SYNTH001',requests:[request],renderedAt:Date.parse('2026-09-12T13:00:00Z')}));
  expect(html).toContain('מה כבר עניתם');expect(html).toContain('פרט התעריף נשאר חסר');expect(html).not.toContain('document-field-answer-v3');expect(html).not.toContain('value="9.50"');
 });
});
