import {describe,it,expect} from 'vitest';
import {sourcePeriodAssociationValueSchema} from '@/engine/extraction/source-structure';
import {buildSourceStructureAnswer,initialSourceStructureDraft,displaySourceStructureAnswer,type SourceStructureContext,type SourceStructureDraft} from './source-structure-display';
import {displayDocumentReadingAnswer,groupDocumentReadingRequests} from './document-reading-display';

const context:SourceStructureContext={kind:'period_association',month:'2026-06',refs:[{label:'סכום סינתטי',raw_value:'120.00',page:2},{label:'כמות סינתטית',raw_value:'3.00',page:2}],proposed_value:null};
const draft=():SourceStructureDraft=>({...initialSourceStructureDraft(context).draft,period_kind:'current',period_from:'2026-06-01',period_to:'2026-06-30',locator:'טבלה סינתטית',text:'כותרת התקופה במקור'});
describe('period association client form contract',()=>{
 it('pins the source page without defaulting a period or confirming the displayed numbers',()=>{
  const initial=initialSourceStructureDraft(context);expect(initial).toMatchObject({action:null,draft:{page:'2',period_kind:'',period_from:'',period_to:'',amount:''}});
  expect(buildSourceStructureAnswer(context,'correct',initial.draft)).toBeNull();expect(buildSourceStructureAnswer(context,'confirm',draft())).toBeNull();
 });
 it.each(['current','retroactive','cumulative'] as const)('serializes %s as period evidence only, compatible with the server value schema',period_kind=>{
  const dates=period_kind==='current'?{period_from:'2026-06-01',period_to:'2026-06-30'}:period_kind==='retroactive'?{period_from:'2025-01-01',period_to:'2025-12-31'}:{period_from:'2026-01-01',period_to:'2026-06-30'};
  const answer=buildSourceStructureAnswer(context,'correct',{...draft(),period_kind,...dates});
  if(!answer||answer.action!=='correct')throw Error('TEST_PERIOD_ANSWER_REQUIRED');
  expect(sourcePeriodAssociationValueSchema.parse(answer.structured_value)).toEqual(answer.structured_value);
  const wire=JSON.stringify(answer);expect(wire).not.toContain('120.00');expect(wire).not.toContain('3.00');expect(wire).not.toContain('identity');expect(wire).not.toContain('sha256');
  expect(initialSourceStructureDraft(context,wire)).toMatchObject({action:'correct',draft:{period_kind,...dates}});
  expect(displayDocumentReadingAnswer(wire)).toContain('המספרים נשמרו ללא אישור מחדש');
 });
 it.each([{period_from:'2026-02-30'},{period_to:'2026-06-31'},{period_from:'2026-6-01'},{period_to:'2026-05-31'},
  {period_from:'2026-06-02'},{period_to:'2026-06-29'},{period_from:'2026-07-01',period_to:'2026-07-31'},{page:'1'},{locator:''},{text:''}])('rejects incomplete, impossible or mismatched source data %j',patch=>{
  expect(buildSourceStructureAnswer(context,'correct',{...draft(),...patch})).toBeNull();
 });
 it('rejects mixed-page context and restores no affirmative period from a forbidden confirm or old numeric answer',()=>{
  expect(buildSourceStructureAnswer({...context,refs:[context.refs[0],{...context.refs[1],page:3}]},'correct',draft())).toBeNull();
  const valid=buildSourceStructureAnswer(context,'correct',draft());
  expect(initialSourceStructureDraft(context,JSON.stringify({...valid,action:'confirm'}))).toMatchObject({action:null,draft:{period_kind:'',period_from:'',period_to:''}});
  expect(initialSourceStructureDraft(context,JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'120.00'})).draft.period_kind).toBe('');
 });
 it.each(['unknown','unreadable'] as const)('retains %s without hidden source values or numeric approval',action=>{
  const answer=buildSourceStructureAnswer(context,action,draft());expect(answer).toEqual({schema_version:'document-field-answer-v3',action});
  expect(displaySourceStructureAnswer(JSON.stringify(answer),context)).toContain(action==='unknown'?'שיוך התקופה נשאר לא מאומת':'הבדיקה התלויה בו נשארה חסרה');
 });
 it('keeps separate period targets outside row and balance grouping',()=>{
  const requests=[1,2].map(id=>({id:String(id),source_current:true,reading_display:{question:'מקור סינתטי',field:'source_structure.period_association',raw_value:null,page:2,text_fragment:null,bounding_box:null,structure_context:context}}));
  expect(groupDocumentReadingRequests(requests).map(g=>g.kind)).toEqual(['single','single']);
 });
});
