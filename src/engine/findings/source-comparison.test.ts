import {describe,expect,it} from 'vitest';
import {sourceComparisonFixture} from './source-comparison.fixtures.ts';
import {sourceTraceFixture} from '../calculations/source-trace.fixtures.ts';
import {createSourceCalculationTrace} from '../calculations/source-trace.ts';
import {createSourceMonetaryComparison,sourceMonetaryComparisonSchema} from './source-comparison.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {findingSchema} from './contracts.ts';
const rehash=(value:ReturnType<typeof sourceComparisonFixture>['comparison'])=>{const {sha256,...seed}=value;void sha256;return {...seed,sha256:canonicalSha256(seed)};};

describe('source-bound expected versus recorded monetary comparison',()=>{
 it.each([['positive',501,1],['negative',499,-1],['zero',500,0]] as const)('retains %s difference from the existing interpreter without labelling it a debt or settlement', (direction,expected,difference)=>{
  const {comparison}=sourceComparisonFixture(direction);
  expect(comparison.expected).toEqual({currency:'XTS',minor_units:expected});
  expect(comparison.recorded).toEqual({currency:'XTS',minor_units:500});
  expect(comparison.signed_difference).toEqual({currency:'XTS',minor_units:difference});
  expect(comparison.pricing_allowed).toBe(false);expect(comparison.is_finding).toBe(false);
  expect(findingSchema.safeParse(comparison).success).toBe(false);
  expect(sourceMonetaryComparisonSchema.parse(JSON.parse(JSON.stringify(comparison)))).toEqual(comparison);
 });
 it('refuses an entitlement trace that a caller tries to present as a difference',()=>{
  const {trace}=sourceTraceFixture();
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})).toThrow('COMPARISON_REQUIRES_EXPLICIT_SUBTRACTION');
 });
 it.each(['expected','recorded','signed_difference','expected_ref','recorded_ref'] as const)('rejects a changed %s after outer rehash',field=>{
  const comparison=structuredClone(sourceComparisonFixture().comparison);
  if(field==='expected_ref'||field==='recorded_ref')comparison[field]='parameter.amount';
  else comparison[field]={currency:'XTS',minor_units:999};
  expect(sourceMonetaryComparisonSchema.safeParse(rehash(comparison)).success).toBe(false);
 });
 it('refuses to turn a declaration into a recorded-document payment amount',()=>{
  const {traceInput}=sourceComparisonFixture();
  const declared=sourceTraceFixture().input.facts.facts[0].provenance;
  const facts=employmentSnapshotSchema.parse({...traceInput.facts,facts:traceInput.facts.facts.map(f=>({...f,provenance:declared}))});
  const trace=createSourceCalculationTrace({...traceInput,facts});
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})).toThrow('COMPARISON_RECORDED_DOCUMENT_REQUIRED');
 });
 it('refuses to compare a whole-period entitlement to a recorded hourly rate',()=>{
  const {traceInput}=sourceComparisonFixture();
  const facts=employmentSnapshotSchema.parse({...traceInput.facts,facts:traceInput.facts.facts.map(f=>({...f,path:'compensation.hourly_rate'}))});
  const trace=createSourceCalculationTrace({...traceInput,facts});
  expect(()=>createSourceMonetaryComparison({trace,expectedRef:'result.amount',recordedRef:'fact.salary'})).toThrow('COMPARISON_RECORDED_COMPONENT_REQUIRED');
 });
});
