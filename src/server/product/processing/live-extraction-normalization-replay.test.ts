import {it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizePayslipExtraction,PAYSLIP_NORMALIZATION_POLICY_VERSION} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {assessExtractionConfidence} from '@/engine/extraction/confidence-policy';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {readSavedExtractionProvenance} from './live-extraction-provenance';

// Offline derivative of immutable observed first-pass raw results. No SDK,
// provider factory, database, customer answer, finding or report is invoked.
it.skipIf(process.env.TIVDOC_LIVE_NORMALIZATION_REPLAY!=='1')('replays actual raw periods under the new policy without replacing live checkpoints',()=>{
 const directory='output/release-completion/live-provider-june2026',results=[];
 for(const id of ['clear','he-clear','he-scan-clear']){
  const path=`${directory}/live-checkpoint-${id}.json`,bytes=readFileSync(path),checkpoint=JSON.parse(bytes.toString('utf8'));
  const provenance=readSavedExtractionProvenance(checkpoint),first=checkpoint.run.result.first_pass;
  expect(provenance.kind).toBe('openai_live');expect(provenance.allPassesSucceeded).toBe(true);
  const rawBefore=canonicalSha256(first.raw_extraction),normalized=normalizePayslipExtraction(first.raw_extraction);
  const validation=validatePayslipGate0(normalized,{reference_year:2026});
  const period=normalized.fields.find(field=>field.field==='salary_period');
  const decision=assessExtractionConfidence(normalized,validation).decisions.find(item=>item.field==='salary_period');
  expect(period?.normalized_value).toEqual(id==='he-clear'?null:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'});
  expect(period?.confidence).toBe(0.94);expect(decision?.status).toBe('needs_confirmation');
  expect(canonicalSha256(first.raw_extraction)).toBe(rawBefore);expect(readFileSync(path)).toEqual(bytes);
  results.push({id,sourceSha256:checkpoint.input_sha256,originalCheckpointFileSha256:createHash('sha256').update(bytes).digest('hex'),
   originalCheckpointResultSha256:checkpoint.result_sha256,originalRawPassSha256:rawBefore,providerReceiptSha256:first?provenance.receipts[0].receipt_sha256:null,
   originalRawPeriod:period?.raw_value,originalNormalizedPeriod:first.normalized_extraction.fields.find((field:{field:string})=>field.field==='salary_period')?.normalized_value,
   derivativeNormalizedPeriod:period?.normalized_value,confidence:period?.confidence,confidenceDecision:decision,
   remainingValidationIssues:validation.issues.map(issue=>issue.code)});
 }
 writeFileSync(`${directory}/normalization-replay-v2.json`,JSON.stringify({schemaVersion:'tivdoc-live-normalization-diagnostic-v1',
  checkedAt:new Date().toISOString(),normalizationPolicyVersion:PAYSLIP_NORMALIZATION_POLICY_VERSION,
  normalizationCodeSha256:createHash('sha256').update(readFileSync('src/engine/extraction/normalization.ts')).digest('hex'),
  providerCalledForReplay:false,originalCheckpointsChanged:false,databaseChanged:false,financialRunCreated:false,legalReadinessProved:false,
  scope:'Offline first-pass normalization diagnostic only; the original corpus runs remain failed. No new extraction or successful end-to-end report is claimed.',results},null,2)+'\n');
});
