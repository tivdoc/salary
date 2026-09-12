import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {attachWorkingTimeSourceFacts,assertWorkingTimeSourceFacts,workingTimeLiteralClause} from './source-facts.ts';
import {evaluateWorkingTimeCaseRecipe} from './product-decisions.ts';
import {workingTimeProductFactsV2Schema} from './product-fact-contracts.ts';
import {productFlowFixture,literalRows,clause,date} from './product-flow.fixture.ts';

describe('ordinary identified working-time source facts',()=>{
 it('keeps confidence .94 clauses as candidates and opens only their existing observation IDs',()=>{
  const f=productFlowFixture(),before=f.sourceHash(),r=attachWorkingTimeSourceFacts(f.input,f.review());
  expect(r.input.arrangement.state).toBe('missing');expect(r.input.product_facts?.regular_wage_basis?.state).toBe('missing');
  expect(r.reading_dependencies[0].observation_ids).toEqual(f.extraction.observations.filter(o=>o.original.semantic==='clause_text').map(o=>o.observation_id));
  expect(f.sourceHash()).toBe(before);expect(r.input.applicability).toEqual([]);
 });
 it('produces exact associations from identified literal clauses with current document dates',()=>{
  const f=productFlowFixture();f.identify();const r=attachWorkingTimeSourceFacts(f.input,f.review());
  expect(r.input.arrangement).toMatchObject({state:'observed',value:'adult_hourly_six_day_42'});expect(r.input.scheduled_weekdays.value).toEqual([0,1,2,3,4,5]);
  expect(r.input.workdays[0].ordinary_limit).toMatchObject({state:'observed',printed_value:'08:00'});
  expect(r.input.product_facts?.regular_wage_basis).toMatchObject({state:'observed',value:{composition:'single_rate_no_regular_supplements',hourly_wage_operand_sha256:canonicalSha256(f.input.regular_hourly_wage)}});
  expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',r.input,{review:f.review()}).allowed).toBe(true);
  expect(evaluateWorkingTimeCaseRecipe('wt.arrangement.day.0',r.input,{review:f.review()}).allowed).toBe(true);
  expect(()=>assertWorkingTimeSourceFacts(r.input,f.review())).not.toThrow();expect(attachWorkingTimeSourceFacts(r.input,f.review())).toEqual(r);
 });
 it('does not accept absence of a regular supplement clause or select a nearby matching number',()=>{
  const f=productFlowFixture(literalRows().map(o=>o.row_id==='wage'?clause('שכר הבסיס הוא 40 ש״ח, בכפוף לתוספות שייקבעו.','wage'):o));f.identify();const r=attachWorkingTimeSourceFacts(f.input,f.review());
  expect(r.input.product_facts?.regular_wage_basis?.state).toBe('missing');expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',r.input).allowed).toBe(false);
 });
 it('blocks a different identified wage and duplicate source clauses without choosing by result',()=>{
  for(const rows of [literalRows().map(o=>o.row_id==='wage'?clause('השכר הרגיל לשעה הוא 41 ש״ח ואין רכיבי שכר רגילים נוספים','wage'):o),[...literalRows(),clause('השכר הרגיל לשעה הוא 40 ש״ח ואין רכיבי שכר רגילים נוספים','second.wage')]]){
   const f=productFlowFixture(rows);f.identify();expect(attachWorkingTimeSourceFacts(f.input,f.review()).input.product_facts?.regular_wage_basis?.state).toBe('conflict');
  }
 });
 it('retains unknown source history without reopening or accepting the candidate text',()=>{
  const f=productFlowFixture();f.identify();f.answer('wage',{action:'unknown'});const r=attachWorkingTimeSourceFacts(f.input,f.review());
  expect(r.input.product_facts?.regular_wage_basis?.state).toBe('missing');expect(r.reading_dependencies).toEqual([]);expect(f.extraction.observations.find(o=>o.original.row_id==='wage')?.original.raw_value).toContain('40.00');
 });
 it('rebuilds from a corrected source receipt and rejects replay of an obsolete association',()=>{
  const f=productFlowFixture();f.identify();const before=attachWorkingTimeSourceFacts(f.input,f.review()).input;
  f.answer('wage',{action:'correct',corrected_raw_value:'השכר הרגיל לשעה הוא 41 ש״ח ואין רכיבי שכר רגילים נוספים',basis:'Synthetic source correction'});
  expect(()=>assertWorkingTimeSourceFacts(before,f.review())).toThrow('WT_SOURCE_FACT_REPLAY');
  expect(attachWorkingTimeSourceFacts(before,f.review()).input.product_facts?.regular_wage_basis?.state).toBe('conflict');
 });
 it('cannot use a current-terms declaration to override an explicit out-of-period source',()=>{
  const f=productFlowFixture([...literalRows().filter(o=>o.row_id!=='start'),date('2026-07-01')]);f.identify();
  const p=workingTimeProductFactsV2Schema.parse(f.input.product_facts),source={...f.input.regular_hourly_wage.source,document_id:'synthetic.answer',version_id:'synthetic.answer.v1',reading:'customer_declaration' as const};
  p.contract_terms_current={state:'declared',value:true,source};f.input.product_facts=p;
  expect(attachWorkingTimeSourceFacts(f.input,f.review()).input.arrangement.state).toBe('missing');
 });
 it('binds an exact contractual temporal declaration and invalidates it when corrected to unknown',()=>{
  const f=productFlowFixture(literalRows().filter(o=>!['effective_from','effective_to'].includes(o.semantic)));f.identify();
  const p=workingTimeProductFactsV2Schema.parse(f.input.product_facts),source={...f.input.regular_hourly_wage.source,document_id:'synthetic.answer',version_id:'synthetic.answer.v1',reading:'customer_declaration' as const};
  f.input.source_manifest.push({document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'customer_answer',case_id:f.input.case_id});
  p.contract_terms_current={state:'declared',value:true,source};f.input.product_facts=p;
  const r=attachWorkingTimeSourceFacts(f.input,f.review()).input,ready=evaluateWorkingTimeCaseRecipe('wt.regular_wage',r);
  expect(ready.allowed).toBe(true);expect(ready.consumed_paths).toContain('product_facts.contract_terms_current');
  const changed=workingTimeProductFactsV2Schema.parse(r.product_facts);changed.contract_terms_current={state:'unknown',value:null,source};r.product_facts=changed;
  expect(evaluateWorkingTimeCaseRecipe('wt.regular_wage',r).reason).toBe('contract_temporal_association_changed');
  expect(attachWorkingTimeSourceFacts(r,f.review()).input.product_facts?.regular_wage_basis?.state).toBe('missing');
 });
 it('preserves original declared money and refuses hand-authored observed regular-wage associations',()=>{
  const f=productFlowFixture();f.identify();f.input.regular_hourly_wage.state='declared';
  const r=attachWorkingTimeSourceFacts(f.input,f.review()).input;expect(r.product_facts?.regular_wage_basis?.state).toBe('missing');
  const p=workingTimeProductFactsV2Schema.parse(r.product_facts);p.regular_wage_basis={state:'observed',value:{period:r.period,hourly_wage_operand_sha256:canonicalSha256(r.regular_hourly_wage),composition:'single_rate_no_regular_supplements'},source:r.regular_hourly_wage.source};r.product_facts=p;
  expect(()=>assertWorkingTimeSourceFacts(r,f.review())).toThrow('WT_REGULAR_BASIS_PRODUCER_REQUIRED');
 });
 it('builds exact cross-midnight assignment without using classification as the clock witness',()=>{
  const row=clause('משמרת אחת בתאריך 2026-06-07: 2026-06-07 22:00 עד 2026-06-08 08:00','assignment'),f=productFlowFixture([row]);f.identify();
  const interval=f.input.workdays[0].intervals[0];interval.start_at='2026-06-07T22:00:00+03:00';interval.end_at='2026-06-08T08:00:00+03:00';
  const r=attachWorkingTimeSourceFacts(f.input,f.review()).input;
  expect(r.product_facts?.assignment_witnesses?.[0].fact.state).toBe('observed');expect(evaluateWorkingTimeCaseRecipe('wt.workday_assignment.day.0',r,{review:f.review()}).allowed).toBe(true);
  interval.end_at='2026-06-08T09:00:00+03:00';expect(attachWorkingTimeSourceFacts(f.input,f.review()).input.product_facts?.assignment_witnesses?.[0].fact.state).toBe('conflict');
 });
 it('refuses a foreign case or a stale physical source receipt',()=>{
  const f=productFlowFixture();f.identify();const r=f.review();expect(()=>attachWorkingTimeSourceFacts(f.input,{...r,case_id:'foreign'})).toThrow('WT_SOURCE_FACT_SCOPE');
  expect(()=>attachWorkingTimeSourceFacts(f.input,{...r,documents:r.documents.map(d=>d.document_id===f.document.document_id?{...d,reading_sha256:'0'.repeat(64)}:d)})).toThrow('WT_SOURCE_FACT_RECORD_BINDING');
 });
 it.each(['שבוע העבודה הוא בן חמישה ימים בכפוף להסדר אחר','השכר הרגיל לשעה הוא 40 ש״ח','משמרת אחת בתאריך 2026-06-07: 22:00 עד 08:00'])('does not interpret an incomplete literal: %s',text=>expect(workingTimeLiteralClause(text)).toBeNull());
});
