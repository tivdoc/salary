import {expect,it,vi} from 'vitest';
import OpenAI from 'openai';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {extractionRequestSchema} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {PAYSLIP_V21_RESOLUTION_POLICY_VERSION,resolvePayslipExtractionPassesV21,recoveryDecisionForV21} from '@/engine/extraction/v21';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {inspectExtractionBytes} from '@/server/engine/extraction/verified-upload-source';
import {OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION} from '@/server/engine/extraction/providers/openai/v2-prompt';
import {OpenAiPayslipV2PassExtractor,type OpenAiV2StructuredDiagnostic} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {buildOpenAiV2ResponsesRequest,OPENAI_SOL_COMPARISON_PROFILE} from '@/server/engine/extraction/providers/openai/v2-request';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';
import {SOL_COMPARISON_POLICY as policy,newSolComparisonLedger,parseSolComparisonLedger,reserveSolRequest,
 recordSolCount,recordSolReceipt,solInputCountRequest,summarizeSolBudget} from './live-extraction-sol-comparison-budget';
vi.mock('server-only',()=>({}));
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** Same original bytes, prompt and independent oracle as the failed 4o-mini
 * run. This test neither calls the worker nor publishes a financial result. */
it.skipIf(process.env.TIVDOC_SOL_COMPARISON!=='1')('compares the two original Hebrew sources using actual Sol medium SDK responses under a separate bounded ledger',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test'||process.env.TIVDOC_SOL_COMPARISON_MAX_GENERATIONS!=='2')throw Error('SOL_COMPARISON_SCOPE');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 expect(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()).toBe('');
 const config=z.object({OPENAI_API_KEY:z.string().min(1)}).parse(JSON.parse(readFileSync('../release-work/live-provider-worker-private.json','utf8')));
 const sdk=new OpenAI({apiKey:config.OPENAI_API_KEY,timeout:120000,maxRetries:0});
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:config.OPENAI_API_KEY,model:policy.model,timeoutMs:120000},
  {executionProfile:OPENAI_SOL_COMPARISON_PROFILE,extractorVersion:'payslip-extraction-2.1'});
 const root='output/release-completion/live-provider-sol-comparison',ledgerPath=path.join(root,'package-budget-ledger.json');
 const proofId=randomUUID(),directory=path.join(root,`complex-${gitSha.slice(0,7)}-${proofId}`);mkdirSync(directory,{recursive:true});
 const oldRoot='output/release-completion/live-provider-june2026';
 const baseline=path.join(oldRoot,'hebrew-scan-probe-047fa41-caeb6644-d78f-478b-bd84-a575e69e1b6e');
 const entries=loadLiveExtractionCorpus('hebrew-june2026','he-clear,he-scan-clear');
 const immutableFiles=[path.join(oldRoot,'live-provider-budget-ledger.json'),path.join(baseline,'proof.json'),
  'docs/release-evidence/live-provider-june2026/independent-input-oracles.json',
  ...entries.flatMap(entry=>[entry.path,path.join(baseline,`${entry.id}-structured.json`),path.join(baseline,`${entry.id}-mapped.json`),path.join(baseline,`${entry.id}-new-result.json`)])];
 const immutable=immutableFiles.map(file=>({file,sha256:sha(readFileSync(file))}));
 const lockPath=ledgerPath+'.lock',lock=openSync(lockPath,'wx');
 let ledger=existsSync(ledgerPath)?parseSolComparisonLedger(JSON.parse(readFileSync(ledgerPath,'utf8'))):newSolComparisonLedger();
 let entered=0,counts=0,state='RUNNING',phase='preflight';const results:Record<string,unknown>[]=[],failures:string[]=[];
 const save=()=>writeFileSync(path.join(directory,'proof.json'),JSON.stringify({schemaVersion:'tivdoc-sol-comparison-v1',proofId,gitSha,state,phase,
  checkedAt:new Date().toISOString(),model:policy.model,reasoningEffort:'medium',executionProfile:OPENAI_SOL_COMPARISON_PROFILE,
  promptVersion:OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,resolutionPolicy:PAYSLIP_V21_RESOLUTION_POLICY_VERSION,
  contentApiRequests:counts+entered,generationsEntered:entered,countRequestsEntered:counts,budget:summarizeSolBudget(ledger),
  sdkRetries:0,automaticRecovery:false,oracleSentToProvider:false,immutable,results,failures,
  financialResultGenerated:false,databaseChanged:false,humanReview:false,legalActivation:false,
  scope:'Two synthetic complex payslips; actual provider output compared with unchanged oracle. Field correctness, global quality and eligibility for the narrow one-base calculation are separate.'},null,2)+'\n');
 const persist=()=>{const temp=ledgerPath+'.'+proofId+'.tmp',file=openSync(temp,'wx');
  try{writeFileSync(file,JSON.stringify(ledger,null,2)+'\n');fsyncSync(file);}finally{closeSync(file);}renameSync(temp,ledgerPath);};
 try{
  // All local source checks complete before either content API request.
  const sources=[];
  for(const entry of entries){const bytes=readFileSync(entry.path);expect(sha(bytes)).toBe(entry.sha256);expect(bytes.length).toBe(entry.sizeBytes);
   expect(await inspectExtractionBytes(bytes,entry.mimeType)).toMatchObject({pages:1});
   const prepared=await preprocessPayslipDocument({bytes,mime_type:entry.mimeType});
   expect(prepared.crops.length).toBeLessThanOrEqual(4);
   const request=buildOpenAiV2ResponsesRequest({model:policy.model,prepared,kind:'first_pass',executionProfile:OPENAI_SOL_COMPARISON_PROFILE});
   const countRequest=solInputCountRequest(request);sources.push({entry,prepared,countRequest});
  }
  persist();save();
  for(const {entry,prepared,countRequest} of sources){
   const recorded:Record<string,unknown>={id:entry.id,sourceSha256:entry.sha256,state:'RUNNING'};results.push(recorded);
   const reservation={sourceSha256:entry.sha256,requestSha256:countRequest.requestSha256,codeRevision:gitSha,attempt:1};
   phase='reserve-count-'+entry.id;ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens',now:new Date().toISOString()});persist();counts++;save();
   const count=await sdk.responses.inputTokens.count(countRequest.request);
   writeFileSync(path.join(directory,`${entry.id}-input-count.json`),JSON.stringify({requestSha256:countRequest.requestSha256,...count},null,2)+'\n');
   expect(count.object).toBe('response.input_tokens');ledger=recordSolCount(ledger,countRequest.requestSha256,count.input_tokens);persist();
   const now=new Date().toISOString(),caseId=randomUUID(),documentId=randomUUID(),runId=randomUUID(),extractionId=randomUUID();
   const request=extractionRequestSchema.parse({case_id:caseId,analysis_run_id:runId,extraction_id:extractionId,declared_document_type:'payslip',requested_at:now,
    document:{document_id:documentId,case_id:caseId,document_type:'payslip',original_filename:path.basename(entry.path),mime_type:entry.mimeType,
     size_bytes:entry.sizeBytes,content_sha256:entry.sha256,storage_path:`cases/${caseId}/documents/${documentId}/original.${entry.mimeType==='application/pdf'?'pdf':'png'}`,
     document_period:null,supersedes_document_id:null,created_at:now}});
   expect(entered).toBeLessThan(2);phase='reserve-generation-'+entry.id;
   ledger=reserveSolRequest({ledger,...reservation,kind:'generation',now});persist();entered++;phase='sdk-'+entry.id;save();
   let diagnostic:OpenAiV2StructuredDiagnostic|undefined;
   const mapped=await extractor.extractPreparedPass({request,prepared,kind:'first_pass',requestedFields:[],sourcePageCount:1,
    onStructuredOutput:value=>{expect(value.origin).toBe('openai_live');expect(value.request_sha256).toBe(countRequest.requestSha256);
     diagnostic=value;writeFileSync(path.join(directory,`${entry.id}-structured.json`),JSON.stringify(value,null,2)+'\n');}});
   if(!mapped.provider_receipt)throw Error('SOL_RECEIPT_MISSING');
   ledger=recordSolReceipt(ledger,mapped.provider_receipt);persist();recorded.receipt=mapped.provider_receipt;
   expect(mapped.provider_receipt.raw_extraction_sha256).toBe(canonicalSha256(mapped.extraction));
   writeFileSync(path.join(directory,`${entry.id}-mapped.json`),JSON.stringify(mapped,null,2)+'\n');
   if(mapped.extraction.status==='failed'){recorded.state='PROVIDER_OR_MAPPING_FAIL';failures.push(entry.id);save();break;}
   expect(diagnostic).toBeDefined();
   const first=buildPassEvaluation({pass_id:extractionId,kind:'first_pass',requested_fields:[],selected_regions:prepared.crops.map(c=>c.region),
    prompt_version:OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,model:policy.model,raw_extraction:mapped.extraction,salary_type_assessment:mapped.salary_type_assessment,
    pension_section_visible:mapped.pension_section_visible,totals_section_visible:mapped.totals_section_visible,critical_context:mapped.critical_context,reference_year:2026});
   const result=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),
    final_extraction_id:randomUUID(),critical_context:mapped.critical_context,reference_year:2026});
   const comparison=checkLiveExtractionCorpus({entry,extraction:result.final_extraction,validation:result.final_validation});
   const critical=['salary_type','salary_period','regular_hours','hourly_rate','base_monthly_salary'];
   const old=JSON.parse(readFileSync(path.join(baseline,`${entry.id}-new-result.json`),'utf8'));
   const before=checkLiveExtractionCorpus({entry,extraction:old.result.final_extraction,validation:old.result.final_validation});
   recorded.oracleComparison=comparison;recorded.baselineOracleComparison=before;
   recorded.minimumWageReading={criticalFieldFailures:comparison.failures.filter(code=>critical.some(field=>code===`FIELD_${field}`)),
    normalizedFields:result.final_extraction.fields.filter(field=>critical.includes(field.field)),
    wageInventoryFailures:comparison.failures.filter(code=>code.startsWith('ROW_')||['WAGE_COMPONENT_COUNT','EARNINGS_COMPLETENESS','SOURCE_BINDING'].includes(code)),
    canonicalSingleBaseEligible:false,reason:'Original source has five paid components; no rows discarded or legally classified by this comparison'};
   recorded.pensionFailures=comparison.failures.filter(code=>/pension|severance/u.test(code));
   recorded.validationIssues=result.final_validation.issues;recorded.confidenceDecisions=result.final_confidence_assessment.decisions;
   recorded.state=comparison.passed?'PASS':'QUALITY_FAIL';recorded.resultSha256=canonicalSha256(result);
   writeFileSync(path.join(directory,`${entry.id}-new-result.json`),JSON.stringify({schemaVersion:'tivdoc-sol-first-pass-v1',sourceSha256:entry.sha256,
    resultSha256:canonicalSha256(result),result,providerReceipt:mapped.provider_receipt,structuredOutputSha256:diagnostic!.structured_output_sha256,
    run:{result,snapshot:null,preprocessing:[prepared.metadata],provider_receipts:[mapped.provider_receipt]}},null,2)+'\n');
   if(!comparison.passed)failures.push(entry.id);save();
  }
  phase='immutable-history-and-budget';for(const item of immutable)expect(sha(readFileSync(item.file))).toBe(item.sha256);
  expect(entered).toBe(2);expect(counts).toBe(2);expect(summarizeSolBudget(ledger).reservedUpperBoundUsd).toBeLessThanOrEqual(5);
  expect(summarizeSolBudget(ledger).contentRequests).toBeLessThanOrEqual(12);
  state=failures.length?'QUALITY_FAIL':'PASS';phase='complete';save();expect(failures).toEqual([]);
 }catch(error){if(state==='RUNNING'){state='FAIL';failures.push(error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'SOL_ASSERTION_OR_ENVIRONMENT_FAILURE');}save();throw error;
 }finally{closeSync(lock);unlinkSync(lockPath);}
},7*60*1000);
