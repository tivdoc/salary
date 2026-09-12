import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildSourcePeriodIntakeAnswer,initialSourcePeriodIntakeDraft,displaySourcePeriodIntakeAnswer} from '@/lib/source-period-intake-display';
import {validateDocumentSourcePeriodIntakeAnswer} from './document-source-period-intake';
import {legacySourceIntakeFixture} from '../processing/saved-legacy-source-intake.fixture';
import {savedLegacySourceIntake,effectiveLegacySourcePeriods} from '../processing/saved-legacy-source-intake';

const context={page_count:2,month:null} as const;
function answer(month='2026-06'){
 return buildSourcePeriodIntakeAnswer(context,'correct',{document_kind:'payslip',period_shown:'calendar_month',month,
  from:'',to:'',page:'1',source_label:'Synthetic printed month'});
}
describe('identified printed month, version two',()=>{
 it.each([['2026-06','2026-06-30'],['2026-07','2026-07-31'],['2024-02','2024-02-29'],['2100-02','2100-02-28'],['2000-02','2000-02-29'],['0001-01','0001-01-31'],['9999-12','9999-12-31']])('derives calendar boundaries for %s independently of employment duration',(month,to)=>{
  const f=legacySourceIntakeFixture(),raw=answer(month);
  expect(raw).toMatchObject({v:2,value:{period:{from:month+'-01',to},source_period:{kind:'calendar_month',month}}});
  expect(validateDocumentSourcePeriodIntakeAnswer(f.target,raw)).toEqual(raw);
 });
 it.each(['0000-06','2026-00','2026-13','2026-6','June 2026'])('refuses an invalid month %s',month=>expect(answer(month)).toBeNull());
 it.each(['boundaries','month','extra','page','kind','version'])('refuses changed %s without inferring a replacement',change=>{
  const f=legacySourceIntakeFixture(),raw=JSON.parse(JSON.stringify(answer()));
  if(change==='boundaries')raw.value.period.to='2026-06-29';
  if(change==='month')raw.value.source_period.month='2026-07';
  if(change==='extra')raw.value.source_period.confirmed=true;
  if(change==='page')raw.value.page=3;
  if(change==='kind')raw.value.source_period.kind='employment_period';
  if(change==='version')raw.v=3;
  expect(()=>validateDocumentSourcePeriodIntakeAnswer(f.target,raw)).toThrow('REQUEST_ANSWER_INVALID');
 });
 it('retains original v1 answers and negative answers byte-for-byte',()=>{
  const f=legacySourceIntakeFixture();
  for(const raw of [f.answer,{v:1,action:'unknown'},{v:1,action:'unreadable'}]){
   expect(JSON.stringify(validateDocumentSourcePeriodIntakeAnswer(f.target,raw))).toBe(JSON.stringify(raw));
  }
  expect(()=>validateDocumentSourcePeriodIntakeAnswer(f.target,{v:2,action:'unknown'})).toThrow();
 });
 it('replays the identified month through the ordinary source evidence without changing the purchase',()=>{
  const f=legacySourceIntakeFixture(),raw=answer(),journal={...f.journal,answers:[{...f.answerRow,answer:JSON.stringify(raw)}]};
  const input={...f.input,journal,journalSha256:canonicalSha256(journal)},saved=savedLegacySourceIntake(input);
  expect(saved.readings[0].answer).toEqual(raw);
  const evidence=effectiveLegacySourcePeriods(f.scope,saved);
  expect(evidence.periods).toHaveLength(1);
  expect(evidence.periods[0]).toMatchObject({period:{from:'2026-06-01',to:'2026-06-30'},source_document_kind:'payslip',reading_sha256:saved.readings[0].reading_sha256});
  expect(saved.scopes[0]).toEqual(f.scope);expect(f.scope.periods).toEqual([]);
  expect(evidence.purchase_period_unchanged).toBe(true);
 });
 it('defaults a page only when the authenticated physical source has one page',()=>{
  expect(initialSourcePeriodIntakeDraft(context,null).draft.page).toBe('');
  expect(initialSourcePeriodIntakeDraft({page_count:1,month:null},null).draft.page).toBe('1');
 });
 it('restores the actual month and describes derived boundaries separately',()=>{
  const raw=JSON.stringify(answer());
  expect(initialSourcePeriodIntakeDraft(context,raw)).toMatchObject({action:'correct',draft:{period_shown:'calendar_month',month:'2026-06'}});
  expect(displaySourcePeriodIntakeAnswer(raw,context)).toContain('גבולות החודש שנגזרו');
  expect(displaySourcePeriodIntakeAnswer(raw,context)).toContain('אין בכך קביעה שעבדתם בכל החודש');
 });
});
