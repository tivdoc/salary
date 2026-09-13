import {expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {extractionRequestSchema} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {PAYSLIP_V21_RESOLUTION_POLICY_VERSION,resolvePayslipExtractionPassesV21,recoveryDecisionForV21} from '@/engine/extraction/v21';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION} from '@/server/engine/extraction/providers/openai/v2-prompt';
import type {OpenAiV2StructuredDiagnostic} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {createLiveExtractionRuntime} from './live-extraction-runtime';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';
import {LIVE_EXTRACTION_HEBREW_SCAN_RETRY as attempt,parseLiveExtractionBudgetLedger,preflightLiveExtractionRequest,
 reserveLiveExtractionPass,recordLiveExtractionPassReceipt,summarizeLiveExtractionBudget} from './live-extraction-budget';
vi.mock('server-only',()=>({}));
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** Two explicitly permitted first-pass observations, not a full corpus rerun.
 * Uses the original paid ledger and source files; never calls automatic recovery,
 * seeds customer data, repairs an output value, or replaces an old checkpoint. */
it.skipIf(process.env.TIVDOC_LIVE_HEBREW_SCAN_PROBE!=='1')('observes the two archived Hebrew/scan sources with the actual SDK and at most two newly charged first passes',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test'||process.env.TIVDOC_LIVE_HEBREW_SCAN_MAX_CALLS!=='2')throw Error('LIVE_HEBREW_PROBE_SCOPE');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 expect(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()).toBe('');
 expect(OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION).toBe(attempt.promptVersion);
 const config=z.object({OPENAI_API_KEY:z.string().min(1),OPENAI_EXTRACTION_MODEL:z.literal('gpt-4o-mini-2024-07-18')})
  .parse(JSON.parse(readFileSync('../release-work/live-provider-worker-private.json','utf8')));
 const runtime=createLiveExtractionRuntime({...config,OPENAI_EXTRACTION_TIMEOUT_MS:'90000'});
 if(runtime.state!=='configured')throw Error('LIVE_HEBREW_PROBE_CONFIGURATION');
 const root='output/release-completion/live-provider-june2026';
 const ledgerPath=path.join(root,'live-provider-budget-ledger.json'),lockPath=ledgerPath+'.lock';
 // Absence is a hard failure. No new ledger and no budget reset are permitted.
 const initialBytes=readFileSync(ledgerPath),initial=parseLiveExtractionBudgetLedger(JSON.parse(initialBytes.toString('utf8')));
 expect(initial.reservations).toHaveLength(19);expect(summarizeLiveExtractionBudget(initial)).toMatchObject({unknownOutcomes:0,reservedUpperBoundUsd:0.4788});
 const entries=loadLiveExtractionCorpus('hebrew-june2026','he-clear,he-scan-clear');
 expect(entries.map(e=>e.sha256)).toEqual([...attempt.sourceSha256s]);
 const reviewedRetry={version:attempt.version,attemptRevision:5 as const,reasonCode:attempt.reasonCode,promptVersion:attempt.promptVersion,codeRevision:gitSha};
 const proofId=randomUUID(),directory=path.join(root,`hebrew-scan-probe-${gitSha.slice(0,7)}-${proofId}`);
 mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'ledger-before.json'),initialBytes);
 const archived=entries.map(entry=>{const file=path.join(root,`live-checkpoint-${entry.id}.json`),bytes=readFileSync(file);
  const p=JSON.parse(bytes.toString('utf8'));expect(p.input_sha256).toBe(entry.sha256);
  return {id:entry.id,file,sha256:sha(bytes),resultSha256:p.result_sha256,sourceSha256:entry.sha256};});
 let ledger=initial,entered=0,receiptCalls=0,phase='preflight',state='RUNNING';const results:Record<string,unknown>[]=[],failures:string[]=[];
 const save=()=>writeFileSync(path.join(directory,'proof.json'),JSON.stringify({schemaVersion:'tivdoc-live-hebrew-scan-probe-v1',proofId,gitSha,state,phase,
  checkedAt:new Date().toISOString(),model:runtime.provider.model,promptVersion:attempt.promptVersion,resolutionPolicy:PAYSLIP_V21_RESOLUTION_POLICY_VERSION,
  initialLedgerSha256:sha(initialBytes),budget:summarizeLiveExtractionBudget(ledger),maxNewCalls:2,providerInvocationEntered:entered,providerReceipts:receiptCalls,
  noAutomaticRecovery:true,sdkRetries:0,reviewedRetry,reviewKind:'bounded_engineering_probe_not_human_review',archived,results,failures,
  databaseChanged:false,customerDataCreated:false,providerOutputInjected:false,humanReview:false,legalActivation:false,financialReportCreated:false,
  scope:'Actual provider reads of two existing synthetic files. New responses are compared with the unchanged literal oracle; original failed checkpoints remain unchanged. No employee-payslip accuracy or legal readiness claim.'},null,2)+'\n');
 const lock=openSync(lockPath,'wx');
 const persist=()=>{const temp=ledgerPath+'.'+proofId+'.tmp',file=openSync(temp,'wx');
  try{writeFileSync(file,JSON.stringify(ledger,null,2)+'\n');fsyncSync(file);}finally{closeSync(file);}renameSync(temp,ledgerPath);};
 try{
  expect(readFileSync(ledgerPath)).toEqual(initialBytes);
  // Prepare and validate both inputs before spending on either. No new source,
  // raster transformation policy, corpus oracle, or model is introduced.
  const sources=[];
  for(const entry of entries){const bytes=readFileSync(entry.path);expect(sha(bytes)).toBe(entry.sha256);expect(bytes.length).toBe(entry.sizeBytes);
   const prepared=await preprocessPayslipDocument({bytes,mime_type:entry.mimeType});
   const preflight=await preflightLiveExtractionRequest({model:runtime.provider.model,prepared,sourceSha256:entry.sha256,
    kind:'first_pass',requestedFields:[],now:new Date().toISOString()});sources.push({entry,bytes,prepared,preflight});}
  save();
  for(const {entry,prepared,preflight} of sources){
   const recorded:Record<string,unknown>={id:entry.id,sourceSha256:entry.sha256,state:'RUNNING'};results.push(recorded);
   const now=new Date().toISOString(),caseId=randomUUID(),documentId=randomUUID(),runId=randomUUID(),extractionId=randomUUID();
   const request=extractionRequestSchema.parse({case_id:caseId,analysis_run_id:runId,extraction_id:extractionId,declared_document_type:'payslip',requested_at:now,
    document:{document_id:documentId,case_id:caseId,document_type:'payslip',original_filename:path.basename(entry.path),mime_type:entry.mimeType,
     size_bytes:entry.sizeBytes,content_sha256:entry.sha256,storage_path:`cases/${caseId}/documents/${documentId}/original.${entry.mimeType==='application/pdf'?'pdf':entry.mimeType==='image/png'?'png':'jpg'}`,
     document_period:null,supersedes_document_id:null,created_at:now}});
   phase='reserve-'+entry.id;expect(entered).toBeLessThan(2);
   ledger=reserveLiveExtractionPass({ledger,sourceSha256:entry.sha256,requestSha256:preflight.requestSha256,passKind:'first_pass',now,reviewedRetry});
   persist();phase='sdk-'+entry.id;entered++;save();
   let diagnostic:OpenAiV2StructuredDiagnostic|undefined;
   const mapped=await runtime.extractor.extractPreparedPass({request,prepared,kind:'first_pass',requestedFields:[],sourcePageCount:1,
    onStructuredOutput:value=>{expect(value.origin).toBe('openai_live');expect(value.source_sha256).toBe(entry.sha256);expect(value.request_sha256).toBe(preflight.requestSha256);
     diagnostic=value;writeFileSync(path.join(directory,`${entry.id}-structured.json`),JSON.stringify(value,null,2)+'\n');}});
   if(!mapped.provider_receipt)throw Error('LIVE_HEBREW_PROBE_RECEIPT_MISSING');
   expect(mapped.provider_receipt.raw_extraction_sha256).toBe(canonicalSha256(mapped.extraction));
   ledger=recordLiveExtractionPassReceipt(ledger,mapped.provider_receipt);persist();
   if(mapped.provider_receipt.provider_attempted)receiptCalls++;
   recorded.receipt=mapped.provider_receipt;writeFileSync(path.join(directory,`${entry.id}-mapped.json`),JSON.stringify(mapped,null,2)+'\n');
   if(mapped.extraction.status==='failed'){recorded.state='PROVIDER_OR_MAPPING_FAIL';recorded.errorCode=mapped.extraction.error_code;failures.push(entry.id);save();break;}
   expect(mapped.provider_receipt).toMatchObject({origin:'openai_live',provider_attempted:true,status:'completed',requested_model:runtime.provider.model,
    source_sha256:entry.sha256,source_page_count:1,prompt_version:attempt.promptVersion});
   expect(diagnostic).toBeDefined();expect(diagnostic?.structured_output_sha256).toBe(canonicalSha256(diagnostic!.structured_output));
   const first=buildPassEvaluation({pass_id:extractionId,kind:'first_pass',requested_fields:[],selected_regions:prepared.crops.map(c=>c.region),
    prompt_version:attempt.promptVersion,model:runtime.provider.model,raw_extraction:mapped.extraction,salary_type_assessment:mapped.salary_type_assessment,
    pension_section_visible:mapped.pension_section_visible,totals_section_visible:mapped.totals_section_visible,critical_context:mapped.critical_context,reference_year:2026});
   // The pure resolver processes this one real response. It cannot request a
   // provider pass here; no scheduler or runSaved entrypoint is called.
   const result=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),
    final_extraction_id:randomUUID(),critical_context:mapped.critical_context,reference_year:2026});
   const comparison=checkLiveExtractionCorpus({entry,extraction:result.final_extraction,validation:result.final_validation});
   recorded.oracleComparison=comparison;recorded.state=comparison.passed?'PASS':'QUALITY_FAIL';
   recorded.structuredOutputSha256=diagnostic!.structured_output_sha256;recorded.resultSha256=canonicalSha256(result);
   recorded.validationStatus=result.final_validation.status;recorded.validationIssues=result.final_validation.issues.map(i=>({code:i.code,fields:i.field_keys}));
   recorded.confidenceDecisions=result.final_confidence_assessment.decisions;
   writeFileSync(path.join(directory,`${entry.id}-new-result.json`),JSON.stringify({schemaVersion:'tivdoc-single-live-pass-probe-v1',sourceSha256:entry.sha256,
    resultSha256:canonicalSha256(result),result,providerReceipt:mapped.provider_receipt,structuredOutputSha256:diagnostic!.structured_output_sha256},null,2)+'\n');
   if(!comparison.passed)failures.push(entry.id);save();
  }
  phase='immutable-history-and-budget';expect(entered).toBeLessThanOrEqual(2);
  expect(ledger.reservations.slice(0,19)).toEqual(initial.reservations);expect(ledger.reservations.length).toBe(19+entered);
  for(const item of archived)expect(sha(readFileSync(item.file))).toBe(item.sha256);
  expect(parseLiveExtractionBudgetLedger(JSON.parse(readFileSync(ledgerPath,'utf8')))).toEqual(ledger);
  expect(summarizeLiveExtractionBudget(ledger).reservedUpperBoundUsd).toBeLessThanOrEqual(0.5292);
  state=failures.length?'FAIL':'PASS';phase='complete';save();expect(results).toHaveLength(2);expect(receiptCalls).toBe(2);expect(failures).toEqual([]);
 }catch(error){if(state==='RUNNING'){state='FAIL';failures.push(error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'PROBE_ASSERTION_OR_ENVIRONMENT_FAILURE');}
  save();throw error;
 }finally{closeSync(lock);unlinkSync(lockPath);}
},5*60*1000);
