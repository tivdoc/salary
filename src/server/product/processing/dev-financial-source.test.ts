import {describe,expect,it,vi} from 'vitest';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {mapOpenAiV2Output} from '@/server/engine/extraction/providers/openai/v2-mapper';
import {devFinancialInputFixture} from './dev-financial-flow.fixture';
import {assertDevFinancialExtractionSource} from './dev-financial-source';
vi.mock('server-only',()=>({}));

async function fixture(paidHourly=false,missingHours=false){
 const {output}=await devFinancialInputFixture(missingHours);
 if(paidHourly)output.payroll_rows=[{...output.payroll_rows[1],amount_raw:'3300.00'}];
 return normalizePayslipExtraction(mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output,
  model:'unit-mapping-only',extractorVersion:'2.1',durationMs:0,providerResponseId:'unit-no-network',
  tokenUsage:null,extractedAt:'2026-09-09T20:00:00Z'}).extraction);
}
describe('engineering financial source permits exactly one paid base observation',()=>{
 it.each([false,true])('accepts equivalent separate-detail / paid-hourly form: %s',async paidHourly=>{
  const source=await fixture(paidHourly),before=structuredClone(source);
  expect(()=>assertDevFinancialExtractionSource(source,source.document_id)).not.toThrow();
  expect(source).toEqual(before);
 });
 it('preserves missing hours for a focused completion rather than deriving them',async()=>{
  const source=await fixture(true,true);
  expect(source.fields.some(f=>f.field==='regular_hours')).toBe(false);
  expect(()=>assertDevFinancialExtractionSource(source,source.document_id)).not.toThrow();
 });
 it.each(['second_paid','bonus','wrong_amount','wrong_version','uncertain','warning','incomplete','percentage'] as const)('refuses %s',async change=>{
  const source=await fixture(true),row=source.additional_components[0];
  if(change==='second_paid')source.additional_components.push({...row,component_id:'00000000-0000-4000-8000-000000009999'});
  if(change==='bonus')source.additional_components.push({...row,semantic_kind:'bonus',component_id:'00000000-0000-4000-8000-000000009999'});
  if(change==='wrong_amount')row.amount={currency:'ILS',minor_units:329999};
  if(change==='uncertain')row.confidence=0.72;
  if(change==='warning')row.warning_flags=['unclear_amount'];
  if(change==='incomplete')source.earnings_components_complete=false;
  if(change==='percentage')row.percentage_raw='6';
  expect(()=>assertDevFinancialExtractionSource(source,change==='wrong_version'?'00000000-0000-4000-8000-000000008888':source.document_id))
   .toThrow('DEV_FINANCIAL_SCENARIO_UNSUPPORTED');
 });
});
