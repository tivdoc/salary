import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preprocessPayslipDocument} from '../../preprocessing';
import {buildOpenAiV2ResponsesRequest} from './v2-request';
import {OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,OPENAI_PAYSLIP_V2_INSTRUCTIONS,OPENAI_PAYSLIP_V2_R6_INSTRUCTIONS} from './v2-prompt';
import {openAiPayslipV2R6StructuredOutputSchema,openAiPayslipV2StructuredOutputSchema} from './v2-schema';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
vi.mock('server-only',()=>({}));

// Request-construction checks only. They do not establish that a model follows
// these instructions or that a consumed source was called again.
describe('versioned prompt correction after actual live transcription errors',()=>{
 it('preserves exact historical r6 instructions/schema and distinguishes a printed cell from the row classification',()=>{
  expect(createHash('sha256').update(OPENAI_PAYSLIP_V2_R6_INSTRUCTIONS).digest('hex')).toBe('7be593a29692b07d46e4866530b6d8ed7009434c3bbe786f4f9888d252a22c4d');
  expect(openAiPayslipV2StructuredOutputSchema).toBe(openAiPayslipV2R6StructuredOutputSchema);
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS.startsWith(OPENAI_PAYSLIP_V2_R6_INSTRUCTIONS)).toBe(true);
  const added=OPENAI_PAYSLIP_V2_INSTRUCTIONS.slice(OPENAI_PAYSLIP_V2_R6_INSTRUCTIONS.length);
  expect(added).toContain('an unheaded neighboring cell does not become part of the description cell');
  expect(added).toContain('Distinct rows can have identical description labels');
  expect(added).toContain('do not mechanically remove suffixes');
  expect(added).toContain('classification must not add words or numbers');
  expect(added).not.toMatch(/125|150|שעות נוספות|442\.50|106\.20|June|2026/u);
 });
 it.skipIf(!process.env.TIVDOC_R6_LABEL_REPLAY_FILE)('replays the actual retained failed r6 labels without modifying them or claiming new live reading',()=>{
  const bytes=readFileSync(process.env.TIVDOC_R6_LABEL_REPLAY_FILE!),saved=JSON.parse(bytes.toString('utf8'));
  expect(saved).toMatchObject({origin:'openai_live',prompt_version:'payslip-extraction-openai-v2-first-r6',source_sha256:'f74f83f18beed42de39c8fc02615a0d05e0f25bc53b2410314dd4f9a56c05a6b'});
  expect(canonicalSha256(saved.structured_output)).toBe(saved.structured_output_sha256);
  const old=openAiPayslipV2R6StructuredOutputSchema.parse(saved.structured_output),current=openAiPayslipV2StructuredOutputSchema.parse(saved.structured_output);
  expect(canonicalSha256(current)).toBe(canonicalSha256(old));
  expect(current.payroll_rows.filter(row=>row.semantic_kind==='overtime_125'||row.semantic_kind==='overtime_150').map(row=>row.source_label)).toEqual(['שעות נוספות 125%','שעות נוספות 150%']);
  expect(readFileSync(process.env.TIVDOC_R6_LABEL_REPLAY_FILE!)).toEqual(bytes);
 });
 it('pins the new instruction version in both real request formats without a fixture value or new tool',async()=>{
  const prepared=await preprocessPayslipDocument({bytes:readFileSync('docs/release-evidence/automatic-dev-live-extraction/live-ocr-clear-june-2026.pdf'),mime_type:'application/pdf'});
  for(const [kind,version] of [['first_pass',OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION],['targeted_recovery',OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION]] as const){
   const request=buildOpenAiV2ResponsesRequest({model:'gpt-4o-mini-2024-07-18',prepared,kind,requested_fields:['salary_period']});
   expect(request.text.format.name).toBe(version);expect(version).toMatch(/-r7$/u);
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
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('generic_fields explicitly supports regular_hours and hourly_rate');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('A conflict is not a reason to suppress readable observations');
  expect(OPENAI_PAYSLIP_V2_INSTRUCTIONS).toContain('Do not append a percentage');
 });
 it('keeps recovery restricted to requested fields rather than supplying earlier source values',async()=>{
  const prepared=await preprocessPayslipDocument({bytes:readFileSync('docs/release-evidence/automatic-dev-live-extraction/live-ocr-clear-june-2026.pdf'),mime_type:'application/pdf'});
  const request=buildOpenAiV2ResponsesRequest({model:'gpt-4o-mini-2024-07-18',prepared,kind:'targeted_recovery',requested_fields:['salary_period']});
  expect(request.input[0].content[0]).toMatchObject({type:'input_text',text:expect.stringContaining('Return evidence only for these fields: salary_period.')});
  expect(request.input[0].content[0]).toMatchObject({text:expect.stringContaining('Leave every unrelated field, row, total, and pension slot empty.')});
 });
});
