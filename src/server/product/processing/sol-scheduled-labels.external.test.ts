import {expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {extractionRequestSchema} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21,PAYSLIP_V21_RESOLUTION_POLICY_VERSION} from '@/engine/extraction/v21';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {inspectExtractionBytes} from '@/server/engine/extraction/verified-upload-source';
import {OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION} from '@/server/engine/extraction/providers/openai/v2-prompt';
import type {OpenAiV2StructuredDiagnostic} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {createSolBudgetedExtractor} from './sol-budgeted-extractor';
import {SOL_COMPARISON_POLICY,parseSolComparisonLedger,summarizeSolBudget} from './live-extraction-sol-comparison-budget';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';
vi.mock('server-only',()=>({}));

const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const packageRoot='output/release-completion/sol-scheduled-20260911';
const ledgerPath=path.resolve(packageRoot,'package-budget-ledger.json');
const expiresAt='2026-09-11T04:19:48Z';

/** Live SDK only. One existing synthetic complex PDF, unchanged oracle, no
 * scan, retry, checkpoint seeding, worker invocation or financial output.
 * The shared package lock/ledger belongs to createSolBudgetedExtractor. */
it.skipIf(process.env.TIVDOC_SOL_SCHEDULED_LABELS_PROOF!=='1')('compares the two retained Hebrew overtime labels with one real r6 generation',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test'||process.env.TIVDOC_SOL_SAVED_WORKER_PROOF!=='1'
  ||!process.env.OPENAI_API_KEY||Date.now()>=Date.parse(expiresAt))throw Error('SOL_LABEL_PROOF_SCOPE');
 if(OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION!=='payslip-extraction-openai-v2-first-r6')throw Error('SOL_LABEL_R6_REQUIRED');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 expect(gitSha).toMatch(/^[a-f0-9]{40}$/u);
 expect(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()).toBe('');
 const [entry]=loadLiveExtractionCorpus('hebrew-june2026','he-clear');
 expect(entry.id).toBe('he-clear');expect(entry.mimeType).toBe('application/pdf');
 expect(entry.sha256).toBe('f74f83f18beed42de39c8fc02615a0d05e0f25bc53b2410314dd4f9a56c05a6b');
 if(!('language' in entry.oracle))throw Error('SOL_LABEL_HEBREW_ORACLE_REQUIRED');
 const expected=entry.oracle.components.filter(row=>row.semanticKind==='overtime_125'||row.semanticKind==='overtime_150');
 expect(expected).toHaveLength(2);
 const bytes=readFileSync(entry.path);expect(digest(bytes)).toBe(entry.sha256);expect(bytes.length).toBe(entry.sizeBytes);
 expect(await inspectExtractionBytes(bytes,entry.mimeType)).toMatchObject({pages:1});
 const historyFiles=[entry.path,'docs/release-evidence/live-provider-june2026/independent-input-oracles.json',
  'docs/release-evidence/sol-comparison-20260910/sol-clear-structured.json'];
 const immutable=historyFiles.map(file=>({file,sha256:digest(readFileSync(file))}));
 const retained=JSON.parse(readFileSync(historyFiles[2],'utf8'));
 expect(retained.origin).toBe('openai_live');expect(canonicalSha256(retained.structured_output)).toBe(retained.structured_output_sha256);
 const prepared=await preprocessPayslipDocument({bytes,mime_type:entry.mimeType});
 const proofId=randomUUID(),caseId=randomUUID(),documentId=randomUUID(),extractionId=randomUUID(),now=new Date().toISOString();
 const directory=path.resolve(packageRoot,`labels-r6-${gitSha.slice(0,7)}-${proofId}`);mkdirSync(directory,{recursive:true});
 const request=extractionRequestSchema.parse({case_id:caseId,analysis_run_id:randomUUID(),extraction_id:extractionId,declared_document_type:'payslip',requested_at:now,
  document:{document_id:documentId,case_id:caseId,document_type:'payslip',original_filename:path.basename(entry.path),mime_type:entry.mimeType,
   size_bytes:entry.sizeBytes,content_sha256:entry.sha256,storage_path:`cases/${caseId}/documents/${documentId}/original.pdf`,document_period:null,supersedes_document_id:null,created_at:now}});
 let runtime:ReturnType<typeof createSolBudgetedExtractor>|undefined;
 let phase='preflight',state='RUNNING',providerInvocationEntered=false;
 let diagnostic:OpenAiV2StructuredDiagnostic|undefined;
 let before:ReturnType<typeof summarizeSolBudget>|undefined;
 let comparison:ReturnType<typeof checkLiveExtractionCorpus>|undefined;
 let labels:unknown,receipt:unknown,resultSha256:string|undefined,safeError:string|undefined;
 const save=(name:string,value:unknown)=>writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n');
 const proof=()=>save('proof.json',{schemaVersion:'tivdoc-sol-scheduled-labels-v1',proofId,gitSha,checkedAt:new Date().toISOString(),state,phase,
  source:{id:entry.id,path:entry.path,sha256:entry.sha256,sizeBytes:entry.sizeBytes,pageCount:1},model:SOL_COMPARISON_POLICY.model,reasoningEffort:'medium',
  promptVersion:OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,resolutionPolicy:PAYSLIP_V21_RESOLUTION_POLICY_VERSION,
  focusedLabelOracle:expected,labels,fullOracleComparison:comparison,receipt,resultSha256,immutable,budgetBefore:before,
  budgetAfter:runtime?.summary(),providerInvocationEntered,providerOutcome:receipt?'receipt_recorded':providerInvocationEntered?'check_durable_ledger_unknown_possible':'not_entered',
  sdkRetries:0,maxGenerations:1,maxContentRequestsForThisTest:2,automaticRecovery:false,oracleSentToProvider:false,safeError,
  realProviderReceiptRequired:true,syntheticDocument:true,databaseChanged:false,financialResultGenerated:false,legalActivation:false,humanReview:false,
  scope:'Only the two previously mismatched printed overtime labels. Full oracle failures remain separately visible; labels passing does not establish global extraction quality.'});
 try{
  proof();
  runtime=createSolBudgetedExtractor({apiKey:process.env.OPENAI_API_KEY,ledgerPath,artifactDirectory:path.join(directory,'provider'),codeRevision:gitSha,
   allowedSources:[{sha256:entry.sha256,sizeBytes:entry.sizeBytes,mimeType:entry.mimeType}],allowedCaseIds:[caseId],maxGenerations:1,expiresAt});
  before=runtime.summary();
  const ledger=parseSolComparisonLedger(JSON.parse(readFileSync(ledgerPath,'utf8')));
  // Under the shared lock, reserve capacity for BOTH calls before starting.
  // The factory durably reserves each call itself; no reset or extra budget.
  expect(before.unknownOutcomes).toBe(0);expect(before.contentRequests+2).toBeLessThanOrEqual(SOL_COMPARISON_POLICY.maxRequests);
  expect(Math.round(before.reservedUpperBoundUsd*1e6)+SOL_COMPARISON_POLICY.countReservedMicroUsd+SOL_COMPARISON_POLICY.generationReservedMicroUsd)
   .toBeLessThanOrEqual(SOL_COMPARISON_POLICY.maxReservedMicroUsd);
  expect(ledger.reservations.some(row=>row.sourceSha256===entry.sha256)).toBe(false);
  phase='actual-provider';providerInvocationEntered=true;proof();
  const mapped=await runtime.extractor.extractPreparedPass({request,prepared,kind:'first_pass',requestedFields:[],sourcePageCount:1,
   onStructuredOutput:value=>{diagnostic=value;save('structured.json',value);}});
  receipt=mapped.provider_receipt;save('mapped.json',mapped);proof();
  expect(mapped.provider_receipt).toMatchObject({origin:'openai_live',provider_attempted:true,status:'completed',source_sha256:entry.sha256,document_id:documentId,source_page_count:1});
  expect(mapped.provider_receipt?.raw_extraction_sha256).toBe(canonicalSha256(mapped.extraction));
  expect(diagnostic?.source_sha256).toBe(entry.sha256);expect(diagnostic?.request_sha256).toBe(mapped.provider_receipt?.request_sha256);
  expect(mapped.extraction.status).not.toBe('failed');
  phase='offline-normalization-and-oracle';
  const first=buildPassEvaluation({pass_id:extractionId,kind:'first_pass',requested_fields:[],selected_regions:prepared.crops.map(c=>c.region),prompt_version:OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
   model:SOL_COMPARISON_POLICY.model,raw_extraction:mapped.extraction,salary_type_assessment:mapped.salary_type_assessment,totals_section_visible:mapped.totals_section_visible,
   pension_section_visible:mapped.pension_section_visible,critical_context:mapped.critical_context,reference_year:2026});
  const result=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:{requested:false,skipped:true,fields_requested:[],regions:[],
   reason_codes:['bounded_label_proof_no_recovery'],expected_information_gain:'none'},final_extraction_id:randomUUID(),critical_context:mapped.critical_context,reference_year:2026});
  resultSha256=canonicalSha256(result);save('normalized-result.json',{resultSha256,result});
  comparison=checkLiveExtractionCorpus({entry,extraction:result.final_extraction,validation:result.final_validation});
  labels=expected.map(row=>({expected:row,actual:result.final_extraction.additional_components.filter(value=>value.semantic_kind===row.semanticKind)
   .map(value=>({componentId:value.component_id,sourceLabel:value.source_label,quantity:value.quantity,rate:value.rate,amount:value.amount,source:value.source}))}));
  const labelFailures=comparison.failures.filter(code=>code==='ROW_overtime_125'||code==='ROW_overtime_150'||code==='SOURCE_BINDING');
  phase='history-and-budget';for(const file of immutable)expect(digest(readFileSync(file.file))).toBe(file.sha256);
  const after=runtime.summary();expect(after.contentRequests-before.contentRequests).toBe(2);expect(after.generations-before.generations).toBe(1);
  expect(after.countRequests-before.countRequests).toBe(1);expect(after.unknownOutcomes).toBe(0);
  state=labelFailures.length?'LABEL_QUALITY_FAIL':'LABELS_PASS';phase='complete';proof();expect(labelFailures).toEqual([]);
 }catch(error){
  if(state==='RUNNING')state='FAIL';safeError=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'SOL_LABEL_ASSERTION_OR_ENVIRONMENT_FAILURE';
  proof();throw Error(safeError);
 }finally{runtime?.close();}
},5*60*1000);
