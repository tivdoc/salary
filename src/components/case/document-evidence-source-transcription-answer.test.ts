import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {DocumentEvidenceSourceTranscriptionAnswer,buildEvidenceSourceAnswer,initialEvidenceSourceDraft,displayEvidenceSourceAnswer} from './document-evidence-source-transcription-answer';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {DocumentFieldAnswer} from './document-field-answer';
import {displayDocumentReadingAnswer} from '@/lib/document-reading-display';

const context={kind:'financial_clause' as const,page:3,max_characters:1600 as const};
const row:StoredRequest={id:'00000000-0000-4000-8000-000000000001',case_id:'00000000-0000-4000-8000-000000000002',
 code:'document_field:'+'b'.repeat(64),question:'Synthetic clause source reading',answer_kind:'choice',blocking:false,field_crop:null,
 opened_at:'2026-09-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',answered_at:null,answer_text:null,source_current:true};
const render=(request=row,correction=false)=>renderToStaticMarkup(createElement(DocumentEvidenceSourceTranscriptionAnswer,{request,context,publicId:'TV-SYNTH001',correction,onAnswered:()=>{}}));
describe('financial clause transcription form',()=>{
 it('lets a document-level request select one exact page without proposing a clause',()=>{
  const context={kind:'financial_clause' as const,page:null,page_count:7,max_characters:1600 as const},draft={raw_value:'Synthetic full clause',locator:'Synthetic section',page:'3'};
  const answer=buildEvidenceSourceAnswer('correct',draft,context);expect(answer).toMatchObject({schema_version:'document-evidence-source-answer-v2',value:{page:3}});
  for(const page of ['', '0','8','1.5'])expect(buildEvidenceSourceAnswer('correct',{...draft,page},context)).toBeNull();
  const html=renderToStaticMarkup(createElement(DocumentEvidenceSourceTranscriptionAnswer,{request:{...row,answer_text:JSON.stringify(answer)},context,publicId:'TV-SYNTH001',correction:true,onAnswered:()=>{}}));
  expect(html).toContain('מתוך 7 עמודים');expect(html).toContain('max="7"');expect(html).toContain('#page=3');expect(html).toContain('value="3"');
  expect(displayEvidenceSourceAnswer(JSON.stringify(answer))).toContain('בעמוד 3');
  const blank=renderToStaticMarkup(createElement(DocumentEvidenceSourceTranscriptionAnswer,{request:row,context,publicId:'TV-SYNTH001',onAnswered:()=>{}}));
  expect(blank).not.toContain(draft.raw_value);expect(blank).not.toContain('מעבר לעמוד הבא');
 });
 it('uses the ordinary field dispatcher and readable history instead of exposing wire JSON',()=>{
  const display={question:row.question,field:'source_transcription.financial_clause',raw_value:null,page:1,text_fragment:null,bounding_box:null,source_transcription_context:context};
  const html=renderToStaticMarkup(createElement(DocumentFieldAnswer,{request:{...row,reading_display:display},publicId:'TV-SYNTH001',onAnswered:()=>{}}));
  expect(html).toContain('פתיחת עמוד המקור לקריאת הסעיף');
  const answer=JSON.stringify(buildEvidenceSourceAnswer('unknown',{raw_value:'',locator:''}));
  expect(displayDocumentReadingAnswer(answer,display)).toContain('לא נשמרה קריאה');expect(displayDocumentReadingAnswer(answer,display)).not.toContain('document-evidence-source-answer-v1');
 });
 it('offers source transcription, unknown and unreadable without a proposed amount or confirm action',()=>{
  const html=render();expect(html.match(/option-button/g)).toHaveLength(3);expect(html).toContain('העתקת הסעיף מהמקור');expect(html).toContain('אינה מאשרת זכאות');
  expect(html).toContain('תנאים, חריגים והפניות');expect(html).toContain('#page=3');expect(html).not.toContain('זה הערך בתא');expect(html).not.toContain('value="0"');
 });
 it.each([false,undefined])('requires authenticated currentness %s before any action',source_current=>{
  const html=render({...row,source_current});expect(html.match(/disabled=""/g)).toHaveLength(3);expect(html).toContain('לרענן את מצב המקור');
 });
 it('reopens a versioned draft/correction with full text and locator, keeping page immutable',()=>{
  const answer=buildEvidenceSourceAnswer('correct',{raw_value:'Synthetic complete clause including conditions.',locator:'Synthetic section 3'}),html=render({...row,answer_text:JSON.stringify(answer)},true);
  expect(html).toContain('Synthetic complete clause including conditions.');expect(html).toContain('Synthetic section 3');expect(html).toContain('maxLength="1600"');
  expect(html).toContain('שמירת תיקון קריאת הסעיף');expect(html).toContain('שמירת טיוטה');expect(html).not.toContain('type="date"');expect(html).not.toContain('value="3"');
 });
 it('never submits an empty, truncated or locator-free clause',()=>{
  expect(buildEvidenceSourceAnswer('correct',{raw_value:' ',locator:'section'})).toBeNull();expect(buildEvidenceSourceAnswer('correct',{raw_value:'x'.repeat(1601),locator:'section'})).toBeNull();
  expect(buildEvidenceSourceAnswer('correct',{raw_value:'full clause',locator:''})).toBeNull();
 });
 it('keeps unknown/unreadable history without carrying an earlier affirmative draft',()=>{
  const value=JSON.stringify(buildEvidenceSourceAnswer('unknown',{raw_value:'old clause',locator:'old'}));
  expect(initialEvidenceSourceDraft(value)).toEqual({action:'unknown',draft:{raw_value:'',locator:''}});expect(displayEvidenceSourceAnswer(value)).not.toContain('old clause');
  expect(initialEvidenceSourceDraft('Historical free text')).toEqual({action:null,draft:{raw_value:'',locator:''}});
 });
});
