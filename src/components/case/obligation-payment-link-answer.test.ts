import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {DocumentFieldAnswer} from './document-field-answer';
import {ThreadView} from './thread-view';
import {buildObligationPaymentLinkAnswer,initialObligationPaymentLinkDraft,obligationPaymentLinkSubmission} from './obligation-payment-link-answer';
import {obligationPaymentLinkAnswerSchema} from '@/engine/entitlement-review/obligations/payment-link';
import type {StoredRequest} from '@/server/product/reports/case-requests';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
const context={payroll_page:2,payroll_locator:'טבלת תשלומים, שורה סינתטית',clause_page:4,clause_locator:'סעיף סינתטי בחוזה',period:{from:'2026-06-01',to:'2026-06-30'}};
const choices={...context,candidates:[{target_sha256:'a'.repeat(64),payroll_page:2,payroll_locator:'שורה ראשונה',amount:'450.00'},
 {target_sha256:'b'.repeat(64),payroll_page:3,payroll_locator:'שורה שנייה',amount:'440.00'}]};
const draft={relationship:'same_obligation' as const,locator:'שם הטבלה והשורה בתלוש',text:'הפניה סינתטית מפורשת לסעיף המסומן',selectedCandidate:''};
function request(saved?:string,shown:Parameters<typeof buildObligationPaymentLinkAnswer>[0]=context):StoredRequest{return {id:'11111111-1111-4111-8111-111111111111',case_id:'22222222-2222-4222-8222-222222222222',
 code:'document_field:'+'c'.repeat(64),question:'בדיקת מקור לקשר בין התשלום לסעיף הסינתטי',answer_kind:'choice',blocking:false,field_crop:null,opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text:null,
 answer_revision:3,draft_revision:7,source_current:true,...(saved?{draft_text:saved}:{}),reading_display:{question:'קשר במקור',field:'obligation_payment_link',raw_value:'450.00',page:2,text_fragment:null,bounding_box:null,obligation_context:shown,dependent_checks:['התחייבות מול תשלום רשום']}};}
const render=(r:StoredRequest,correction=false)=>renderToStaticMarkup(createElement(DocumentFieldAnswer,{request:r,publicId:'TV-SYNTH001',onAnswered:()=>{},correction}));
it('uses the dedicated form with both request-scoped sources and read-only amount',()=>{
 const html=render(request());expect(html.match(/option-button/g)).toHaveLength(3);expect(html).toContain('<bdi>450.00</bdi>');expect(html).toContain('עמוד 2');expect(html).toContain('עמוד 4');
 expect(html).toContain(context.payroll_locator);expect(html).toContain(context.clause_locator);expect(html).toContain('view=marked#page=2');expect(html).toContain('linked=clause#page=4');
 expect(html.match(/source=11111111-1111-4111-8111-111111111111/g)).toHaveLength(2);expect(html).not.toContain('<input');expect(html).not.toContain('אישור הערך בתא');expect(html).not.toContain('confidence');
});
it.each(['same_obligation','different_obligation'] as const)('restores %s correction without editable amount or page',relationship=>{
 const wire=buildObligationPaymentLinkAnswer(context,'correct',{...draft,relationship}),r={...request(),answer_text:JSON.stringify(wire)},html=render(r,true);
 expect(html).toContain(`value="${relationship}" selected=""`);expect(html.match(/<input/g)).toHaveLength(1);expect(html.match(/<textarea/g)).toHaveLength(1);
 expect(html).toContain('שמירת תיקון הקשר במקור');expect(html).toContain('שמירת טיוטה');expect(html).toContain(draft.text);expect(html).not.toContain('value="450.00"');expect(html).not.toContain('type="number"');
});
it('submits the raw engine answer, with a fixed payroll basis and separate draft/correction revisions',()=>{
 const r=request(),answer=buildObligationPaymentLinkAnswer(context,'correct',draft);expect(obligationPaymentLinkAnswerSchema.parse(answer)).toEqual(answer);
 expect(answer).toMatchObject({action:'correct',value:{basis:{page:2,locator:draft.locator,text:draft.text}}});
 const first=obligationPaymentLinkSubmission(r,answer),correction=obligationPaymentLinkSubmission(r,answer,false,true),savedDraft=obligationPaymentLinkSubmission(r,answer,true,true);
 expect(first).toMatchObject({requestId:r.id,action:'answer',expectedRevision:3});expect(correction).toMatchObject({action:'correction',expectedRevision:3});expect(savedDraft).toMatchObject({action:'draft',expectedRevision:7});
 expect(JSON.parse(first!.answer)).not.toHaveProperty('schema_version');expect(first).not.toHaveProperty('document_id');expect(first).not.toHaveProperty('version_id');
});
it.each([false,undefined])('disables controls and refuses submission without current sources: %s',source_current=>{
 const r={...request(),source_current};expect(render(r).match(/disabled=""/g)).toHaveLength(3);expect(render(r)).toContain('לא ניתן לאמת ששני המקורות עדיין נוכחיים');
 expect(obligationPaymentLinkSubmission(r,buildObligationPaymentLinkAnswer(context,'correct',draft))).toBeNull();expect(obligationPaymentLinkSubmission(r,{action:'unknown'})).toBeNull();
});
it.each([{relationship:'' as const},{locator:''},{text:''},{locator:'x'.repeat(121)},{text:'x'.repeat(161)}])('does not turn incomplete source details into a positive link: %j',change=>{
 expect(buildObligationPaymentLinkAnswer(context,'correct',{...draft,...change})).toBeNull();
});
it('does not restore source evidence for another page or an affirmative scalar answer',()=>{
 const wire=buildObligationPaymentLinkAnswer(context,'correct',draft)!;expect(initialObligationPaymentLinkDraft({...context,payroll_page:5},JSON.stringify(wire)).action).toBeNull();
 expect(initialObligationPaymentLinkDraft(context,JSON.stringify({schema_version:'document-field-answer-v2',action:'confirm'})).action).toBeNull();
});
it('requires an explicit choice between current payroll candidates and puts the chosen hash in its source URL',()=>{
 const initial=render(request(undefined,choices));expect(initial).toContain('שורת התשלום לבדיקה');expect(initial).not.toContain('view=marked');expect(initial).toContain('linked=clause');
 expect(initial).toContain('450.00');expect(initial).toContain('440.00');expect(buildObligationPaymentLinkAnswer(choices,'correct',draft)).toBeNull();
 const chosen={...draft,selectedCandidate:'b'.repeat(64)},answer=buildObligationPaymentLinkAnswer(choices,'correct',chosen)!;
 expect(answer).toMatchObject({candidate_target_sha256:'b'.repeat(64),value:{basis:{page:3}}});
 const html=render(request(JSON.stringify(answer),choices));expect(html).toContain(`candidate=${'b'.repeat(64)}&amp;view=marked#page=3`);expect(html).toContain('<bdi>440.00</bdi>');
 expect(html).toContain(`value="${'b'.repeat(64)}" selected=""`);expect(html).not.toContain('value="440.00"');
});
it('wraps a singleton choice but leaves an old per-pair answer unchanged',()=>{
 const single={...choices,candidates:choices.candidates.slice(0,1)},answer=buildObligationPaymentLinkAnswer(single,'correct',draft);
 expect(answer).toMatchObject({candidate_target_sha256:'a'.repeat(64),value:{basis:{page:2}}});expect(buildObligationPaymentLinkAnswer(context,'correct',draft)).not.toHaveProperty('candidate_target_sha256');
});
it('rejects changed or unrecognized candidate choices while restoring valid drafts exactly',()=>{
 const chosen={...draft,selectedCandidate:'b'.repeat(64)},answer=buildObligationPaymentLinkAnswer(choices,'correct',chosen);
 expect(initialObligationPaymentLinkDraft(choices,JSON.stringify(answer))).toEqual({action:'correct',draft:chosen});
 expect(initialObligationPaymentLinkDraft({...choices,candidates:choices.candidates.slice(0,1)},JSON.stringify(answer)).action).toBeNull();
 expect(buildObligationPaymentLinkAnswer(choices,'correct',{...draft,selectedCandidate:'f'.repeat(64)})).toBeNull();
});
it.each(['unknown','unreadable'] as const)('keeps %s valid without candidate selection and readable in ordinary history',action=>{
 const answer=buildObligationPaymentLinkAnswer(choices,action,draft);expect(answer).toEqual({action});expect(obligationPaymentLinkAnswerSchema.parse(answer)).toEqual(answer);
 const r={...request(undefined,choices),answered_at:'2026-09-12T12:00:00Z',answer_text:JSON.stringify(answer)};
 const html=renderToStaticMarkup(createElement(ThreadView,{requests:[r],publicId:'TV-SYNTH001',renderedAt:Date.parse('2026-09-12T13:00:00Z')}));
 expect(html).toContain('מה כבר עניתם');expect(html).not.toContain('&quot;action&quot;');expect(html).not.toContain('candidate_target_sha256');
});
it.each(['same_obligation','different_obligation'] as const)('shows readable %s history with no allocation approval or wire keys',relationship=>{
 const r={...request(),answered_at:'2026-09-12T12:00:00Z',answer_text:JSON.stringify(buildObligationPaymentLinkAnswer(context,'correct',{...draft,relationship}))};
 const html=renderToStaticMarkup(createElement(ThreadView,{requests:[r],publicId:'TV-SYNTH001',renderedAt:Date.parse('2026-09-12T13:00:00Z')}));
 expect(html).toContain('מה כבר עניתם');expect(html).not.toContain('&quot;relationship&quot;');expect(html).not.toContain('same_obligation&quot;');expect(html).not.toContain('different_obligation&quot;');
});
