import {expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {extractionRequestSchema} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {PAYSLIP_EXTRACTION_V21_VERSION,resolvePayslipExtractionPassesV21,recoveryDecisionForV21} from '@/engine/extraction/v21';
import {mapOpenAiV2Output} from '@/server/engine/extraction/providers/openai/v2-mapper';
import {openAiPayslipV2StructuredOutputSchema} from '@/server/engine/extraction/providers/openai/v2-schema';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';
vi.mock('server-only',()=>({}));
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

it.skipIf(process.env.TIVDOC_SOL_RETAINED_REPLAY!=='1')('maps the authentic retained Sol response offline without recalling the source or fabricating a missing provider receipt',()=>{
 const root='output/release-completion/live-provider-sol-comparison',old=path.join(root,'complex-c5051f3-4ec7efe8-8962-4308-aad9-abddf1cb22f6');
 const diagnosticPath=path.join(old,'he-clear-structured.json'),bytes=readFileSync(diagnosticPath),diagnostic=JSON.parse(bytes.toString('utf8'));
 expect(hash(bytes)).toBe('f5a9c589f2954e227385e7ad881281053204e56160a0f9517906adaf22fb5937');
 const output=openAiPayslipV2StructuredOutputSchema.parse(diagnostic.structured_output);
 expect(canonicalSha256(output)).toBe(diagnostic.structured_output_sha256);expect(diagnostic.origin).toBe('openai_live');
 const entry=loadLiveExtractionCorpus('hebrew-june2026','he-clear')[0];expect(diagnostic.source_sha256).toBe(entry.sha256);
 const ledgerPath=path.join(root,'package-budget-ledger.json'),ledgerBytes=readFileSync(ledgerPath);
 const now='2026-09-10T16:05:46.488Z',extractionId=randomUUID();
 const request=extractionRequestSchema.parse({case_id:diagnostic.case_id,analysis_run_id:diagnostic.analysis_run_id,extraction_id:extractionId,
  declared_document_type:'payslip',requested_at:now,document:{document_id:diagnostic.document_id,case_id:diagnostic.case_id,document_type:'payslip',
   original_filename:path.basename(entry.path),mime_type:entry.mimeType,size_bytes:entry.sizeBytes,content_sha256:entry.sha256,
   storage_path:`cases/${diagnostic.case_id}/documents/${diagnostic.document_id}/original.pdf`,document_period:null,supersedes_document_id:null,created_at:now}});
 const mapped=mapOpenAiV2Output({request,output,model:'gpt-5.6-sol',extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,
  durationMs:0,providerResponseId:diagnostic.provider_response_id,tokenUsage:null,extractedAt:now});
 const first=buildPassEvaluation({pass_id:extractionId,kind:'first_pass',requested_fields:[],selected_regions:[],prompt_version:diagnostic.prompt_version,
  model:'gpt-5.6-sol',raw_extraction:mapped.extraction,salary_type_assessment:mapped.salary_type_assessment,pension_section_visible:mapped.pension_section_visible,
  totals_section_visible:mapped.totals_section_visible,critical_context:mapped.critical_context,reference_year:2026});
 const result=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),
  final_extraction_id:randomUUID(),critical_context:mapped.critical_context,reference_year:2026});
 const comparison=checkLiveExtractionCorpus({entry,extraction:result.final_extraction,validation:result.final_validation});
 const critical=['salary_type','salary_period','regular_hours','hourly_rate','base_monthly_salary'];
 const criticalFailures=comparison.failures.filter(code=>critical.some(field=>code===`FIELD_${field}`));
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),directory=path.join(root,'offline-clear-'+gitSha.slice(0,7));mkdirSync(directory,{recursive:true});
 writeFileSync(path.join(directory,'he-clear-mapped.json'),JSON.stringify(mapped,null,2)+'\n');
 writeFileSync(path.join(directory,'he-clear-result.json'),JSON.stringify(result,null,2)+'\n');
 writeFileSync(path.join(directory,'proof.json'),JSON.stringify({schemaVersion:'tivdoc-sol-retained-offline-replay-v1',gitSha,
  actualProviderResponseId:diagnostic.provider_response_id,actualProviderRequestId:diagnostic.provider_request_id,
  actualSourceSha256:entry.sha256,diagnosticFileSha256:hash(bytes),structuredOutputSha256:canonicalSha256(output),
  originalFailure:'test_harness_invalid_extractor_version_after_authentic_sdk_response',
  rawProviderOutputRetained:true,offlineMappingOnly:true,newProviderCalls:0,actualModelUnavailable:true,requestedModel:'gpt-5.6-sol',
  tokenUsageUnavailable:true,providerReceiptUnavailable:true,unknownBudgetReservationPreserved:true,
  comparison,minimumWageCriticalFieldFailures:criticalFailures,pensionFailures:comparison.failures.filter(code=>/pension|severance/u.test(code)),
  validation:result.final_validation,confidence:result.final_confidence_assessment,canonicalSingleBaseEligible:false,
  reason:'Five original paid components are preserved; no legal component classification or activation is granted.',
  resultSha256:canonicalSha256(result),financialReportGenerated:false},null,2)+'\n');
 expect(readFileSync(diagnosticPath)).toEqual(bytes);expect(readFileSync(ledgerPath)).toEqual(ledgerBytes);
 expect(criticalFailures).toEqual([]);
});
