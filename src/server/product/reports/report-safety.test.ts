import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseProjection,PROJECTION_TOPICS,scopeInitialTopics,renderPermission,type TopicProjection} from './case-report-projection';
import {ALL_AWAITING_VERIFICATION,S04_HIGH_CERTAINTY,S04_HIGH_CERTAINTY_FINDING,S06_REFUSED} from './case-report-projection.fixtures';
import {ReportView} from '@/components/case/report-view';
import {customerReports} from './customer-reports';
import type {CaseAccessDb} from '../case-access/db';
const finding=S04_HIGH_CERTAINTY_FINDING;
function report(topic:unknown){return {...S04_HIGH_CERTAINTY,topics:[topic,...S04_HIGH_CERTAINTY.topics.slice(1)]};}
describe('P02 report safety regressions',()=>{
 it.each(['draft','derived','owner_recorded'])('rejects an active claim backed by %s',grade=>{
  expect(()=>parseProjection(report({...finding,parameter_grades:{rate:grade}}))).toThrow('inactive_parameter');
 });
 it.each(['high','medium'])('initial %s certainty cannot carry money on incomplete basis',certainty=>{
  const topic={...finding,basis_complete:false,certainty,display:certainty==='high'?'amount':'range',certainty_sentence:certainty==='high'?'הנתון נשען על המסמכים':'הנתון תלוי במה שמסרת',amount:certainty==='high'?{currency:'ILS',minor_units:912345}:null,range:certainty==='medium'?{low:{currency:'ILS',minor_units:912345},high:{currency:'ILS',minor_units:912346}}:null};
  expect(()=>parseProjection(report(topic))).toThrow('initial_incomplete_basis');
  const html=renderToStaticMarkup(createElement(ReportView,{projection:report(topic) as typeof S04_HIGH_CERTAINTY}));
  expect(html).not.toContain('9,123');expect(renderPermission(topic as TopicProjection).showsNumber).toBe(false);
 });
 it('rejects reversed ranges and preserves a measured zero',()=>{
  expect(()=>parseProjection(report({...finding,range:{low:{currency:'ILS',minor_units:2},high:{currency:'ILS',minor_units:1}}}))).toThrow('range_out_of_order');
  expect(parseProjection(report({...finding,amount:{currency:'ILS',minor_units:0}})).topics[0]).toMatchObject({amount:{minor_units:0}});
 });
 it('selects fixed topic order regardless of amount and labels excluded coverage',()=>{
  const all=PROJECTION_TOPICS.map((topic,i)=>({...finding,topic,amount:{currency:'ILS' as const,minor_units:(i+1)*100}}));
  expect(()=>parseProjection({...S04_HIGH_CERTAINTY,topics:all})).toThrow('initial_max_three');
  const selected=parseProjection({...S04_HIGH_CERTAINTY,topics:scopeInitialTopics([...all].reverse())});
  expect(selected.topics.filter(t=>t.gate==='checked').map(t=>t.topic).sort()).toEqual(['minimum_wage','pension','working_time']);
  expect(selected.topics.filter(t=>t.gate==='not_selected')).toHaveLength(4);
 });
 it('mixed refused and awaiting never claims no gaps',()=>{
  const html=renderToStaticMarkup(createElement(ReportView,{projection:S06_REFUSED}));
  expect(html).toContain('עדיין לא נבדק אף נושא');expect(html).not.toContain('לא נמצאו פערים');
 });
 it('keeps two case months separate and distinguishes missing DB from no report',async()=>{
  const db:CaseAccessDb={provider:'fake',async rpc<T>(_fn:string,args:Readonly<Record<string,unknown>>){return [{value:{caseId:args.target_case,publicId:args.target_case==='one'?'TV-TEST0001':'TV-TEST0002',checkPeriodMonth:args.target_case==='one'?'2025-02':'2024-03',reports:[]}}] as T[];}};
  expect((await customerReports('one','identity','TV-TEST0001',db)).checkPeriodMonth).toBe('2025-02');
  expect((await customerReports('two','identity','TV-TEST0002',db)).checkPeriodMonth).toBe('2024-03');
  await expect(customerReports('one','identity','TV-TEST0002',db)).rejects.toThrow('REPORT_SCOPE');
  const broken:CaseAccessDb={provider:'fake',async rpc(){throw new Error('unavailable');}};
  await expect(customerReports('one','identity','TV-TEST0001',broken)).rejects.toThrow('unavailable');
 });
 it('empty report fixture contains no personal report substitution',()=>{
  expect(ALL_AWAITING_VERIFICATION.topics.every(t=>t.gate!=='checked')).toBe(true);
 });
});
