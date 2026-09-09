import {describe,it,expect} from 'vitest';
import {normalizeSalaryPeriod,normalizePayslipExtraction,PAYSLIP_NORMALIZATION_POLICY_VERSION} from './normalization';
import {syntheticPayslipFixtures} from './fixtures/source-fixtures';
import {validatePayslipGate0} from './validation';
import {assessExtractionConfidence} from './confidence-policy';

// Exact visible raw period returned by the live SDK for legacy clear and the
// Hebrew raster on 2026-09-09. This test reuses only the literal string; it is
// neither a provider mock nor a claim that a new API call took place.
const observedLivePeriod='01/06/2026 - 30/06/2026';
const june={year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'};
describe('explicit full-month salary periods observed by the live provider',()=>{
 it('normalizes the actual raw date range and exposes a distinct normalization policy',()=>{
  expect(normalizeSalaryPeriod(observedLivePeriod)).toEqual(june);
  expect(PAYSLIP_NORMALIZATION_POLICY_VERSION).toBe('payslip-normalization-v2-explicit-full-month');
 });
 it.each(['1/6/2026–30/6/2026','01/06/2026 — 30/06/2026',' 01/06/2026  -  30/06/2026 '])('accepts the same explicit full calendar month: %s',raw=>{
  expect(normalizeSalaryPeriod(raw)).toEqual(june);
 });
 it.each([
  '30/06/2026 - 01/06/2026', // Actual Hebrew PDF output: reversed order remains rejected.
  '02/06/2026 - 30/06/2026','01/06/2026 - 29/06/2026','01/06/2026 - 31/06/2026',
  '01/06/2026 - 30/07/2026','01/06/2026 - 30/06/2025','01/06/26 - 30/06/26',
  '06/01/2026 - 06/30/2026','01/13/2026 - 31/13/2026','01/02/2025 - 29/02/2025',
  'salary period 01/06/2026 - 30/06/2026','01/06/2026','01/06 - 30/06/2026',
 ])('refuses reversed, partial, cross-month or ambiguous evidence: %s',raw=>{
  expect(normalizeSalaryPeriod(raw)).toBeNull();
 });
 it('uses actual month length, including leap years',()=>{
  expect(normalizeSalaryPeriod('01/02/2024 - 29/02/2024')).toEqual({year:2024,month:2,start_date:'2024-02-01',end_date:'2024-02-29'});
  expect(normalizeSalaryPeriod('01/01/2026 - 31/01/2026')).toEqual({year:2026,month:1,start_date:'2026-01-01',end_date:'2026-01-31'});
 });
 it('preserves source/raw/confidence and still requires P95 confirmation after successful normalization',()=>{
  const fixture=syntheticPayslipFixtures[0].extraction;
  const input={...structuredClone(fixture),fields:[{...structuredClone(fixture.fields[0]),field:'salary_period' as const,
   raw_value:observedLivePeriod,confidence:0.94,warning_flags:[]}]};
  const before=structuredClone(input),normalized=normalizePayslipExtraction(input);
  expect(input).toEqual(before);expect(normalized.fields[0].normalized_value).toEqual(june);
  expect(normalized.fields[0]).toMatchObject({raw_value:observedLivePeriod,confidence:0.94,source:input.fields[0].source});
  const validation=validatePayslipGate0(normalized,{reference_year:2026});
  expect(assessExtractionConfidence(normalized,validation).decisions.find(d=>d.field==='salary_period'))
   .toMatchObject({status:'needs_confirmation',effective_confidence:0.94,threshold:0.95});
 });
});
