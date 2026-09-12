import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {produceObligationSourceEvidence} from './product-source-evidence.ts';
import {fixture,observation,uuid} from './product-flow.fixture.ts';

describe('ordinary obligation source producer',()=>{
 it.each([{}, {linear:true}, {bonus:true}])('reconstructs exact positive source statements independently of amounts or old reports: %j',options=>{
  const f=fixture(options);f.identify();const r=f.run();expect(r.result.entries.map(e=>e.kind)).toEqual(['literal_promise','payment_period','agreement_acceptance','complete_conditions']);
  expect(r.result.unresolved).toEqual([]);expect(r.input.obligations[0].assessments).toEqual([]);
  expect(r.result.receipt).toEqual(f.run().result.receipt);expect(r.input.obligations[0].conditions).toEqual([]);
 });
 it('an empty extracted list supplies neither positive agreement nor complete conditions',()=>{
  const f=fixture({agreement:false,inventory:false});f.identify();const r=f.run();
  expect(r.result.entries.map(e=>e.kind)).toEqual(['literal_promise','payment_period']);
  expect(r.result.unresolved).toEqual(expect.arrayContaining(['positive_exact_agreement_statement_required','positive_complete_condition_inventory_required']));
 });
 it.each(['unknown','unreadable'])('retains %s source decisions; no repeated candidate request or false positive',action=>{
  const f=fixture();f.identify();f.answer('source_label',{action},'agreement');const r=f.run();
  expect(r.result.entries.some(e=>e.kind==='agreement_acceptance')).toBe(false);expect(r.result.reading_dependencies).toEqual([]);
  expect(r.result.unresolved).toContain('additional_or_unread_context_requires_interpretation');
 });
 it('reads corrected agreement date, preserving original observation and changing only its witness',()=>{
  const f=fixture();f.identify();const before=f.run();f.answer('source_label',{action:'correct',corrected_raw_value:'הצדדים הסכימו ביום 2026-02-02 להחיל את ההתחייבות שבסעיף זה.',basis:'Synthetic source correction'},'agreement');const after=f.run();
  expect(after.result.entries.find(e=>e.kind==='agreement_acceptance')?.value).toMatchObject({agreed_on:'2026-02-02'});
  expect(after.result.receipt.receipt_sha256).not.toBe(before.result.receipt.receipt_sha256);
  expect(f.extraction.observations.find(o=>o.original.row_id==='agreement')?.original.raw_value).toContain('2026-02-01');
 });
 it('refuses to infer condition completeness from partial coverage or an additional annex',()=>{
  const partial=fixture({partial:true});partial.identify();expect(partial.run().result.entries).toEqual([]);
  const annex=fixture({extra:[observation('annex_reference','text','כפוף לנספח נוסף',null,'annex')]});annex.identify();
  expect(annex.run().result.entries.some(e=>e.kind==='complete_conditions')).toBe(false);
 });
 it('does not take a witness from a different block or copy source values without the exact locator',()=>{
  const f=fixture({agreement:false,extra:[{...observation('source_label','text','הצדדים הסכימו ביום 2026-02-01 להחיל את ההתחייבות שבסעיף זה.',null,'agreement','הסכמת הצדדים'),block_id:'unrelated.block'}]});f.identify();
  expect(f.run().result.entries.some(e=>e.kind==='agreement_acceptance')).toBe(false);
  const good=fixture();good.identify();const {input,review}=good.run(),o=input.obligations[0];
  const altered=structuredClone(input);altered.obligations[0].clause.source.locator='borrowed.numeric.source';
  expect(()=>produceObligationSourceEvidence(altered,o.obligation_id,review)).toThrow('OBLIGATION_PRODUCER_CLAUSE_LOCATOR');
  expect(()=>produceObligationSourceEvidence(input,o.obligation_id,{...review,case_id:uuid(999)})).toThrow('OBLIGATION_PRODUCER_SCOPE');
  expect(()=>produceObligationSourceEvidence(input,o.obligation_id,{...review,documents:review.documents.map(d=>({...d,reading_sha256:'f'.repeat(64)}))})).toThrow('OBLIGATION_PRODUCER_CURRENT_SOURCE');
 });
 it('does not mutate the source, accept a stale reading hash, or substitute another quantity period',()=>{
  const f=fixture({linear:true});f.identify();const {input,review}=f.run(),prior=canonicalSha256({input,review}),id=input.obligations[0].obligation_id;
  produceObligationSourceEvidence(input,id,review);expect(canonicalSha256({input,review})).toBe(prior);
  const bad=structuredClone(input);bad.obligations[0].clause.source.reading_receipt_sha256='a'.repeat(64);
  expect(()=>produceObligationSourceEvidence(bad,id,review)).toThrow('OBLIGATION_PRODUCER_CURRENT_SOURCE');
  f.answer('period_end',{action:'correct',corrected_raw_value:'2026-05-31',basis:'Synthetic different period'});const next=f.run();
  expect(next.result.entries.some(e=>e.kind==='payment_period')).toBe(false);expect(next.result.unresolved).toContain('exact_same_period_performed_quantity_required');
 });
});
