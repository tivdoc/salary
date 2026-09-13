import {describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {syntheticPayslipFixtures} from './fixtures/source-fixtures.ts';
import {normalizePayslipExtraction} from './normalization.ts';
import {assessExtractionConfidence} from './confidence-policy.ts';
import {gate0ValidationSchema,SOURCE_ROW_DUPLICATE_POLICY,validatePayslipGate0} from './validation.ts';
import {buildPassEvaluation,resolvePayslipExtractionPasses} from './v2.ts';
import {payslipExtractionV21ResultSchema,recoveryDecisionForV21,resolvePayslipExtractionPassesV21} from './v21.ts';
vi.mock('server-only',()=>({}));
const policy={reference_year:2026,component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY};
function rawDeductions(){
 const source=syntheticPayslipFixtures[0].extraction;
 const labels=['Employee pension','National insurance','Health insurance','Income tax'];
 return {...source,additional_components:labels.map((source_label,index)=>({component_id:randomUUID(),source_label,
  normalized_label:'deduction',semantic_kind:'deduction' as const,quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:String([212.40,80,120,0][index]),
  confidence:0.94,source:{document_id:source.document_id,page:1,text_fragment:source_label},extraction_method:'ai_vision' as const,warning_flags:[]}))};
}
function deductions(){return normalizePayslipExtraction(rawDeductions());}
const duplicateGroups=(value:ReturnType<typeof validatePayslipGate0>)=>value.issues.filter(issue=>issue.code==='duplicate_mapped_component');
describe('explicit deduction source-row validation policy',()=>{
 it('reproduces legacy category grouping, keeps legacy output shape, and distinguishes four separate deductions only when opted in',()=>{
  const extraction=deductions(),legacy=validatePayslipGate0(extraction,{reference_year:2026}),current=validatePayslipGate0(extraction,policy);
  expect(duplicateGroups(legacy)).toHaveLength(1);expect(duplicateGroups(legacy)[0].field_candidate_ids).toHaveLength(4);
  expect(legacy).not.toHaveProperty('component_duplicate_policy');expect(canonicalSha256(gate0ValidationSchema.parse(legacy))).toBe(canonicalSha256(legacy));
  expect(duplicateGroups(current)).toEqual([]);expect(current.component_duplicate_policy).toBe(SOURCE_ROW_DUPLICATE_POLICY);
  expect(current.field_assessments).toEqual(legacy.field_assessments);
  expect(current.issues).toEqual(legacy.issues.filter(issue=>issue.code!=='duplicate_mapped_component'));
 });
 it('still warns when one actual row and its cells are read twice under different candidate IDs',()=>{
  const extraction=deductions(),original=extraction.additional_components[0],copy={...original,component_id:randomUUID(),confidence:0.9};
  const result=validatePayslipGate0({...extraction,additional_components:[...extraction.additional_components,copy]},policy);
  expect(duplicateGroups(result)).toHaveLength(1);
  expect(duplicateGroups(result)[0].field_candidate_ids).toEqual([original.component_id,copy.component_id]);
 });
 it.each(['label','amount','quantity','rate','percentage','page','locator'] as const)('does not merge separately observed %s cells into a duplicate',kind=>{
  const extraction=deductions(),original=extraction.additional_components[0];
  const copy={...original,component_id:randomUUID(),
   ...(kind==='label'?{source_label:'Another printed deduction'}:{}),
   ...(kind==='amount'?{amount_raw:'213.00',amount:{currency:'ILS' as const,minor_units:21300}}:{}),
   ...(kind==='quantity'?{quantity_raw:'2',quantity:'2'}:{}),
   ...(kind==='rate'?{rate_raw:'12.00',rate:{currency:'ILS' as const,minor_units:1200}}:{}),
   ...(kind==='percentage'?{percentage_raw:'5%',percentage:{basis_points:500}}:{}),
   source:{...original.source,...(kind==='page'?{page:2}:{}),...(kind==='locator'?{text_fragment:'Separate documented row'}:{})}};
  expect(duplicateGroups(validatePayslipGate0({...extraction,additional_components:[original,copy]},policy))).toEqual([]);
 });
 it('keeps the historic duplicate rule for non-deduction components',()=>{
  const extraction=deductions(),original=extraction.additional_components[0];
  const rows=[original,{...original,component_id:randomUUID(),source_label:'Other base row'}].map(row=>({...row,normalized_label:'hourly_base',semantic_kind:'hourly_base' as const}));
  expect(duplicateGroups(validatePayslipGate0({...extraction,additional_components:rows},policy))).toHaveLength(1);
 });
 it('carries the explicit policy through V2 and V21 recomputation while rejecting mixed-policy passes',()=>{
  const raw=rawDeductions(),input={pass_id:randomUUID(),kind:'first_pass' as const,requested_fields:[],selected_regions:[],
   prompt_version:'synthetic-source-policy-test',model:'synthetic-unit-only',raw_extraction:raw,salary_type_assessment:{documented:null,inferred:null},
   pension_section_visible:false,totals_section_visible:false,critical_context:{},reference_year:2026};
  const first=buildPassEvaluation({...input,component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY}),legacy=buildPassEvaluation(input);
  const common={first_pass:first,recovery_passes:[],final_extraction_id:randomUUID(),critical_context:{},reference_year:2026};
  expect(resolvePayslipExtractionPasses(common).final_validation.component_duplicate_policy).toBe(SOURCE_ROW_DUPLICATE_POLICY);
  const v21=resolvePayslipExtractionPassesV21({...common,recovery_decision:recoveryDecisionForV21(null)});
  for(const stage of [v21.first_pass.validation,v21.historical_validation,v21.current_validation,v21.final_validation]){
   expect(stage.component_duplicate_policy).toBe(SOURCE_ROW_DUPLICATE_POLICY);expect(duplicateGroups(stage)).toEqual([]);
  }
  const old=resolvePayslipExtractionPassesV21({...common,first_pass:legacy,recovery_decision:recoveryDecisionForV21(null)});
  expect(old.final_validation).not.toHaveProperty('component_duplicate_policy');
  expect(canonicalSha256(payslipExtractionV21ResultSchema.parse(old))).toBe(canonicalSha256(old));
  expect(()=>resolvePayslipExtractionPasses({...common,recovery_passes:[legacy]})).toThrow('POLICY_MISMATCH');
  expect(()=>resolvePayslipExtractionPassesV21({...common,recovery_passes:[legacy],recovery_decision:recoveryDecisionForV21(null)})).toThrow('POLICY_MISMATCH');
 });
});

it.skipIf(process.env.TIVDOC_SOL_VALIDATION_REPLAY!=='1')('reassesses the authentic retained scan without altering old validation bytes, receipts, scores, or the ledger',()=>{
 const directory='output/release-completion/live-provider-sol-comparison/complex-6983156-22d822b2-c0a6-431e-a9f0-675fd7436b36';
 const file=directory+'/he-scan-clear-new-result.json',bytes=readFileSync(file),record=JSON.parse(bytes.toString('utf8'));
 expect(canonicalSha256(record.result)).toBe('2f6aa3b151d573f82b48240032f51f3ffbf99890adb3333410622e251c453ea6');
 const old=record.result.final_validation,extraction=record.result.final_extraction;
 expect(canonicalSha256(payslipExtractionV21ResultSchema.parse(record.result))).toBe(record.resultSha256);
 expect(canonicalSha256(gate0ValidationSchema.parse(old))).toBe(canonicalSha256(old));expect(duplicateGroups(old)).toHaveLength(1);
 const current=validatePayslipGate0(extraction,policy);expect(duplicateGroups(current)).toEqual([]);
 const before=assessExtractionConfidence(extraction,old),after=assessExtractionConfidence(extraction,current);
 expect(after.decisions).toEqual(before.decisions);
 expect(after.decisions.filter(d=>d.field==='regular_hours'||d.field==='salary_type')).toEqual(expect.arrayContaining([
  expect.objectContaining({field:'regular_hours',status:'needs_confirmation',effective_confidence:0.94,threshold:0.95}),
  expect.objectContaining({field:'salary_type',status:'needs_confirmation',effective_confidence:0.94,threshold:0.95})]));
 const out='output/release-completion/live-provider-sol-comparison/validation-source-rows';mkdirSync(out,{recursive:true});
 writeFileSync(out+'/proof.json',JSON.stringify({schemaVersion:'sol-authentic-source-row-validation-replay-v1',gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceReceiptSha256:record.providerReceipt.receipt_sha256,originalResultSha256:record.resultSha256,
  originalArtifactSha256:createHash('sha256').update(bytes).digest('hex'),originalValidationSha256:canonicalSha256(old),
  newValidation:current,newValidationSha256:canonicalSha256(current),confidenceUnchanged:true,providerCalls:0,
  oldArtifactUnchanged:true,financialResultGenerated:false,policy:SOURCE_ROW_DUPLICATE_POLICY},null,2)+'\n');
 expect(readFileSync(file)).toEqual(bytes);
});
