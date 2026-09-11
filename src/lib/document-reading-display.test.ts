import {expect,it} from 'vitest';
import {displayDocumentReadingAnswer,groupDocumentReadingRequests,type DocumentReadingDisplay} from './document-reading-display';
const display=(cell:'quantity'|'rate'|'amount',group='a'.repeat(64)):DocumentReadingDisplay=>({question:'תא במקור סינתטי',field:'row_cell.'+cell,
 raw_value:'96.1',page:1,text_fragment:'בונוס סינתטי',bounding_box:null,row_context:{group_id:group,label:'בונוס',cell}});
const requests=[{id:'quantity',source_current:true,reading_display:display('quantity')},{id:'rate',source_current:true,reading_display:display('rate')},
 {id:'amount',source_current:true,reading_display:display('amount')}];
it('groups distinct cells only under the same server-derived row identity and preserves each request',()=>{
 const result=groupDocumentReadingRequests(requests);expect(result).toHaveLength(1);expect(result[0].kind).toBe('row');
 expect(result[0].requests.map(r=>r.id)).toEqual(['quantity','rate','amount']);expect(requests).toHaveLength(3);
});
it('never groups labels across different source identities, missing currentness, or changed pages',()=>{
 for(const change of ['identity','page','currentness','label']as const){
  const original=requests[1],second={...original,source_current:change==='currentness'?false:original.source_current,
   reading_display:{...original.reading_display,page:change==='page'?2:1,row_context:{...original.reading_display.row_context!,
    group_id:change==='identity'?'b'.repeat(64):'a'.repeat(64),label:change==='label'?'שורה אחרת':'בונוס'}}};
  const rows=[requests[0],second];
  expect(groupDocumentReadingRequests(rows).every(g=>g.kind==='single')).toBe(true);
 }
});
it('keeps duplicate cells and historical scalar requests separate instead of implying one decision covers both',()=>{
 const duplicate=[...requests,{...requests[0],id:'another-quantity'}];expect(groupDocumentReadingRequests(duplicate).every(g=>g.kind==='single')).toBe(true);
 const {row_context:ignored,...legacy}=display('quantity');void ignored;
 const row={id:'legacy',source_current:true,reading_display:{...legacy,field:'regular_hours'}};
 expect(groupDocumentReadingRequests([row,...requests])[0]).toEqual({kind:'single',requests:[row]});
 expect(displayDocumentReadingAnswer('כן, בדקתי במסמך והערך נכון')).toBe('כן, בדקתי במסמך והערך נכון');
 expect(displayDocumentReadingAnswer('96.1')).toBe('96.1');
});
it('labels only the new transcription history as unit completion and preserves historical correction wording',()=>{
 const answer=JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'days'});
 const {row_context:ignored,...base}=display('quantity');void ignored;
 expect(displayDocumentReadingAnswer(answer)).toBe('הקריאה תוקנה לערך: days');
 expect(displayDocumentReadingAnswer(answer,{...base,transcription_context:{kind:'balance_unit'}})).toBe('יחידת היתרה הועתקה מהמסמך: ימים. המספר המקורי נשמר ללא שינוי.');
});
