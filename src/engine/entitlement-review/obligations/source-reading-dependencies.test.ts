import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {fixture} from './product-flow.fixture.ts';
import {obligationSourceReadingDependencies} from './source-reading-dependencies.ts';
import {enableObligationCasePolicy} from './case-replay.ts';

function partial(){const f=fixture();for(const semantic of ['clause_text','amount','effective_from','effective_to'])f.answer(semantic);return f;}
describe('ordinary obligation context reading dependencies',()=>{
 it('opens only original unreviewed context cells with exact version/checkpoint/hash and clause checks',()=>{
  const f=partial(),{input,review}=f.run(),r=obligationSourceReadingDependencies(enableObligationCasePolicy(input),review);
  expect(r).toHaveLength(1);expect(r[0].observation_ids).toEqual(f.extraction.observations.filter(o=>o.original.semantic==='source_label').map(o=>o.observation_id).sort());
  expect(r[0].normalized_sha256).toBe(canonicalSha256(f.extraction));expect(r[0].checkpoint_sha256).toBe(review.non_payslip_evidence![0].checkpoint_result_sha256);
  expect(r[0].dependent_check_ids).toEqual([`${input.check_prefix}.${input.obligations[0].obligation_id}.comparison`,`${input.check_prefix}.${input.obligations[0].obligation_id}.expected`]);
  expect(obligationSourceReadingDependencies(input,review)).toEqual([]);
 });
 it('preserves answered unknown/unreadable source history without a new candidate request',()=>{
  const f=partial();f.answer('source_label',{action:'unknown'},'agreement');let r=f.run();
  expect(obligationSourceReadingDependencies(enableObligationCasePolicy(r.input),r.review)[0].observation_ids).toHaveLength(1);
  f.answer('source_label',{action:'unreadable'},'conditions');r=f.run();expect(obligationSourceReadingDependencies(enableObligationCasePolicy(r.input),r.review)).toEqual([]);
 });
 it('does not invent missing source statements or accept changed checkpoint bytes',()=>{
  const f=fixture({agreement:false,inventory:false});f.identify();const r=f.run();expect(obligationSourceReadingDependencies(enableObligationCasePolicy(r.input),r.review)).toEqual([]);
  const p=partial(),v=p.run(),changed=structuredClone(v.review);changed.non_payslip_evidence![0].checkpoint_result_sha256='f'.repeat(64);
  expect(()=>obligationSourceReadingDependencies(enableObligationCasePolicy(v.input),changed)).toThrow('NON_PAYSLIP_READING_SOURCE');
 });
});
