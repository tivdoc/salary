import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {preprocessPayslipDocument} from '../../preprocessing';
import {buildOpenAiV2ResponsesRequest} from './v2-request';
import {OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,OPENAI_PAYSLIP_V2_INSTRUCTIONS} from './v2-prompt';
vi.mock('server-only',()=>({}));

// Request-construction checks only. They do not establish that a model follows
// these instructions or that a consumed source was called again.
describe('versioned prompt correction after actual live transcription errors',()=>{
 it('pins the new instruction version in both real request formats without a fixture value or new tool',async()=>{
  const prepared=await preprocessPayslipDocument({bytes:readFileSync('docs/release-evidence/automatic-dev-live-extraction/live-ocr-clear-june-2026.pdf'),mime_type:'application/pdf'});
  for(const [kind,version] of [['first_pass',OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION],['targeted_recovery',OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION]] as const){
   const request=buildOpenAiV2ResponsesRequest({model:'gpt-4o-mini-2024-07-18',prepared,kind,requested_fields:['salary_period']});
   expect(request.text.format.name).toBe(version);expect(version).toMatch(/-r5$/u);
   expect(request.max_output_tokens).toBe(10000);expect(request.store).toBe(false);expect(request).not.toHaveProperty('tools');
  }
 expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).not.toMatch(/3300|3540|3,300|3,540|06\/2026|June|יוני|2026/u);
 });
 it('asks for independent visual cells and complete Hebrew labels without supplying oracle answers or reconciling missing values',()=>{
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('do not output its reversed letters');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain("tables can use different column orders");
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('preserve both candidates');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('Separately printed header or employment-summary hours');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('never drop it merely because its amount is missing');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('Overtime quantities and overtime rates never supply missing regular-hour cells');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('Do not calculate an unprinted total from gross minus net');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('employee percentage and amount, employer percentage and amount, and severance percentage and amount');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('not permission to fill gaps, fix discrepancies, or infer legal treatment');
 });
 it('keeps recovery restricted to requested fields rather than supplying earlier source values',async()=>{
  const prepared=await preprocessPayslipDocument({bytes:readFileSync('docs/release-evidence/automatic-dev-live-extraction/live-ocr-clear-june-2026.pdf'),mime_type:'application/pdf'});
  const request=buildOpenAiV2ResponsesRequest({model:'gpt-4o-mini-2024-07-18',prepared,kind:'targeted_recovery',requested_fields:['salary_period']});
  expect(request.input[0].content[0]).toMatchObject({type:'input_text',text:expect.stringContaining('Return evidence only for these fields: salary_period.')});
  expect(request.input[0].content[0]).toMatchObject({text:expect.stringContaining('Leave every unrelated field, row, total, and pension slot empty.')});
 });
});
