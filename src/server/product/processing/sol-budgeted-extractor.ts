import 'server-only';
import OpenAI from 'openai';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import path from 'node:path';
import {managedWorkerControlConfig} from './managed-worker-config';
import {readManagedSolLiveWindow,assertManagedSolLiveLedger,type ManagedSolLiveWindow} from './managed-sol-live-window';
import {acquireSolBudgetLock,recoverStaleSolBudgetLock} from './sol-budget-lock';
import {z} from 'zod';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import {extractionRequestSchema,extractionResultSchema,payslipFieldKeySchema} from '@/engine/extraction/contracts';
import {salaryTypeAssessmentSchema} from '@/engine/extraction/v2';
import {SOURCE_ROW_DUPLICATE_POLICY} from '@/engine/extraction/validation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {authorizeManagedOpenAiRecovery,assertManagedOpenAiRecovery,type ManagedOpenAiRecoveryAuthority} from '@/server/engine/extraction/providers/openai/managed-package-recovery';
import {buildOpenAiV2ResponsesRequest,OPENAI_SOL_COMPARISON_PROFILE,OPENAI_SOURCE_FILE_PAGE_POLICY} from '@/server/engine/extraction/providers/openai/v2-request';
import {inspectExtractionBytes} from '@/server/engine/extraction/verified-upload-source';
import {createOpenAiDocumentEvidenceExtractorFromEnv,type DocumentEvidenceExtractor} from '@/server/engine/extraction/providers/openai/document-evidence-adapter';
import {buildOpenAiDocumentEvidenceRequest} from '@/server/engine/extraction/providers/openai/document-evidence-request';
import {parseSolComparisonLedger,reserveSolRequest,recordSolCount,recordSolReceipt,solInputCountRequest,
 SOL_COMPARISON_POLICY,SOL_RETAINED_DRIVER_FAILURE,summarizeSolBudget,solPolicyRevalidationSchema,type SolPolicyRevalidation} from './live-extraction-sol-comparison-budget';

const sourceSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/u),sizeBytes:z.number().int().positive().max(1024*1024),
 mimeType:z.enum(['application/pdf','image/png','image/jpeg'])}).strict();
export type SolBudgetedSource=z.infer<typeof sourceSchema>;
export const solDocumentEvidenceScopeSchema=z.object({schema_version:z.literal('sol-document-evidence-scope-v1'),sources:z.array(z.object({
 caseId:z.uuid(),versionId:z.uuid(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/u),kind:z.enum(['attendance','contract']),maxPages:z.number().int().min(1).max(12),
}).strict()).min(1).max(4)}).strict();

/** DEV proof integration only. Wraps the genuine existing extractor, preserving
 * actual worker request identity and provider origin. No transport injection,
 * source substitution, checkpoint seeding, or automatic recovery is available.
 * Keep the returned lock for the caller's bounded sequence and close in finally. */
type SolBudgetedInput={apiKey:string;ledgerPath:string;artifactDirectory:string;codeRevision:string;
 allowedSources:readonly SolBudgetedSource[];maxGenerations:number;retainedDiagnosticPath?:string;
 reviewedRetry?:{sourceSha256:string;priorReceiptSha256:string;reason:'header-observation-classification-r5'|'literal-label-cell-transcription-r7'};
 reviewedPolicyRevalidation?:SolPolicyRevalidation;allowedVersionIds?:readonly string[];assertActive?:()=>void;
 allowedCaseIds?:readonly string[];expiresAt?:string;documentEvidenceScope?:z.infer<typeof solDocumentEvidenceScopeSchema>;liveWindow?:ManagedSolLiveWindow};
export function createSolBudgetedExtractor(input:SolBudgetedInput){
 if(process.env.VERCEL||process.env.NODE_ENV!=='test'||process.env.TIVDOC_SOL_SAVED_WORKER_PROOF!=='1')throw Error('SOL_SAVED_WORKER_SCOPE');
 return createBoundedSolExtractor(input);
}
function createBoundedSolExtractor(input:SolBudgetedInput,managedRecoveryAuthority?:ManagedOpenAiRecoveryAuthority){
 const sources=z.array(sourceSchema).min(1).max(4).parse(input.allowedSources);
 if(new Set(sources.map(source=>source.sha256)).size!==sources.length||!Number.isSafeInteger(input.maxGenerations)
  ||input.maxGenerations<1||input.maxGenerations>4||!input.apiKey||!/^[a-f0-9]{40}$/u.test(input.codeRevision))throw Error('SOL_SAVED_WORKER_CONFIGURATION');
 let priorUnknownAcknowledgment:string|undefined;
 if(input.retainedDiagnosticPath){
  const bytes=readFileSync(input.retainedDiagnosticPath);
  if(createHash('sha256').update(bytes).digest('hex')!==SOL_RETAINED_DRIVER_FAILURE.diagnosticFileSha256)throw Error('SOL_RETAINED_DIAGNOSTIC_MISMATCH');
  priorUnknownAcknowledgment=SOL_RETAINED_DRIVER_FAILURE.diagnosticFileSha256;
 }
 // Never initialize/reset a ledger here. It must be the same package ledger
 // already used by the model comparison, including its unknown charged row.
 const lock=acquireSolBudgetLock(input),instanceId=randomUUID();
 let closed=false,busy=false,entered=0;
 const close=()=>{if(closed)return;if(busy)throw Error('SOL_EXTRACTOR_STILL_RUNNING');closed=true;lock.close();};
 try{
  const originalLedgerBytes=readFileSync(input.ledgerPath);
  let persistedLedgerSha256=createHash('sha256').update(originalLedgerBytes).digest('hex');
  let ledger=parseSolComparisonLedger(JSON.parse(originalLedgerBytes.toString('utf8')));
  if(input.liveWindow)assertManagedSolLiveLedger(input.liveWindow,ledger,originalLedgerBytes);
  const evidenceScope=input.documentEvidenceScope?solDocumentEvidenceScopeSchema.parse(input.documentEvidenceScope):undefined;
  if(evidenceScope&&(!input.expiresAt||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)>Date.now()+4*60*60*1000||!input.allowedCaseIds?.length||!input.allowedVersionIds?.length
   ||input.reviewedRetry||input.reviewedPolicyRevalidation||new Set(evidenceScope.sources.map(s=>s.versionId)).size!==evidenceScope.sources.length
   ||evidenceScope.sources.some(s=>!sources.some(allowed=>allowed.sha256===s.sourceSha256)||!input.allowedCaseIds?.includes(s.caseId)||!input.allowedVersionIds?.includes(s.versionId))))throw Error('SOL_DOCUMENT_EVIDENCE_SCOPE');
  const reviewed=input.reviewedRetry;
  const policy=input.reviewedPolicyRevalidation?solPolicyRevalidationSchema.parse(input.reviewedPolicyRevalidation):undefined;
  const policyPrior=policy?ledger.reservations.find(r=>r.sourceSha256===sources[0].sha256&&r.kind==='generation'&&r.outcome==='receipt_recorded'
   &&(r.receipt as {receipt_sha256?:string})?.receipt_sha256===policy.priorReceiptSha256):undefined;
  if(policy){
   const receipt=policyPrior&&parseOpenAiProviderReceipt(policyPrior.receipt);
   if(reviewed||sources.length!==1||input.maxGenerations!==1||input.allowedCaseIds?.length!==1||input.allowedVersionIds?.length!==1
    ||!input.expiresAt||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)>Date.now()+4*60*60*1000
    ||!receipt||receipt.status!=='completed'||receipt.origin!=='openai_live'||receipt.source_sha256!==sources[0].sha256
    ||receipt.prompt_version!==policy.fromPromptVersion||receipt.request_sha256!==policyPrior!.requestSha256)throw Error('SOL_POLICY_REVALIDATION_SCOPE');
   z.array(z.uuid()).parse(input.allowedVersionIds);z.array(z.uuid()).parse(input.allowedCaseIds);input.assertActive?.();
  }
  const prior=reviewed?ledger.reservations.find(r=>r.sourceSha256===reviewed.sourceSha256&&r.kind==='generation'&&r.attempt===1&&r.outcome==='receipt_recorded'):undefined;
  if(reviewed){
   const receipt=prior?.receipt as {receipt_sha256?:string;status?:string;prompt_version?:string}|undefined;
   if(!['header-observation-classification-r5','literal-label-cell-transcription-r7'].includes(reviewed.reason)||sources.length!==1||sources[0].sha256!==reviewed.sourceSha256
    ||!prior||receipt?.receipt_sha256!==reviewed.priorReceiptSha256||receipt.status!=='completed'
    ||(reviewed.reason==='literal-label-cell-transcription-r7'&&receipt.prompt_version!=='payslip-extraction-openai-v2-first-r6'))throw Error('SOL_REVIEWED_RETRY_RECEIPT_REQUIRED');
   const authenticatedReceipt=parseOpenAiProviderReceipt(prior.receipt);
   if(authenticatedReceipt.source_sha256!==reviewed.sourceSha256||authenticatedReceipt.request_sha256!==prior.requestSha256)
    throw Error('SOL_REVIEWED_RETRY_RECEIPT_REQUIRED');
  }
  mkdirSync(input.artifactDirectory,{recursive:true});
  const persist=()=>{if(input.liveWindow){assertManagedSolLiveLedger(input.liveWindow,ledger);
   if(createHash('sha256').update(readFileSync(input.ledgerPath)).digest('hex')!==persistedLedgerSha256)throw Error('SOL_LIVE_WINDOW_LEDGER_CHANGED');}
   const temp=input.ledgerPath+'.'+instanceId+'.tmp',file=openSync(temp,'wx');
   try{writeFileSync(file,JSON.stringify(ledger,null,2)+'\n');fsyncSync(file);}finally{closeSync(file);}renameSync(temp,input.ledgerPath);
   persistedLedgerSha256=createHash('sha256').update(readFileSync(input.ledgerPath)).digest('hex');};
  const sdk=new OpenAI({apiKey:input.apiKey,baseURL:'https://api.openai.com/v1',timeout:120000,maxRetries:0});
  const extractor=new OpenAiPayslipV2PassExtractor({apiKey:input.apiKey,model:SOL_COMPARISON_POLICY.model,timeoutMs:120000},
   {extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,
    recoveryExecution:managedRecoveryAuthority?'skip_managed_package_budget':'skip_package_budget',managedRecoveryAuthority,componentDuplicatePolicy:SOURCE_ROW_DUPLICATE_POLICY,
    ...(policy?{sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY}:{})});
  const actual=extractor.extractPreparedPass.bind(extractor);
  extractor.extractPreparedPass=async request=>{
   if(closed||busy)throw Error('SOL_EXTRACTOR_CLOSED_OR_BUSY');
   input.assertActive?.();
   if(input.expiresAt&&Date.now()>=Date.parse(input.expiresAt))throw Error('SOL_MANAGED_PACKAGE_EXPIRED');
   busy=true;
   try{
   if(request.kind!=='first_pass')throw Error('SOL_AUTOMATIC_RECOVERY_NOT_AUTHORIZED');
   if(entered>=input.maxGenerations&&!policy)throw Error('SOL_SAVED_GENERATION_LIMIT');
   const boundRequest=extractionRequestSchema.parse(request.request),document=boundRequest.document;
   if(input.liveWindow&&(boundRequest.declared_document_type!=='payslip'||document.document_type!=='payslip'))throw Error('SOL_SAVED_SOURCE_NOT_ALLOWED');
   if(input.allowedCaseIds&&!input.allowedCaseIds.includes(boundRequest.case_id))throw Error('SOL_SAVED_CASE_NOT_ALLOWED');
   if(input.allowedVersionIds&&!input.allowedVersionIds.includes(document.document_id))throw Error('SOL_SAVED_VERSION_NOT_ALLOWED');
   if(document.case_id!==boundRequest.case_id)throw Error('SOL_SAVED_REQUEST_CASE_MISMATCH');
   const source=sources.find(source=>source.sha256===document.content_sha256);
   const bytes=request.prepared.original.bytes;
   if(!source||source.sizeBytes!==document.size_bytes||source.mimeType!==document.mime_type||bytes.length!==source.sizeBytes
    ||request.prepared.original.sha256!==source.sha256||request.prepared.original.mime_type!==source.mimeType
    ||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('SOL_SAVED_SOURCE_NOT_ALLOWED');
   const inspected=await inspectExtractionBytes(bytes,source.mimeType);
   if(inspected.pages!==1||(request.sourcePageCount!==undefined&&request.sourcePageCount!==1)||request.prepared.crops.length>4)throw Error('SOL_SAVED_SOURCE_PAGE_BOUND');
   for(const crop of request.prepared.crops){if(crop.image.bytes.length>2*1024*1024
    ||createHash('sha256').update(crop.image.bytes).digest('hex')!==crop.image.sha256)throw Error('SOL_SAVED_CROP_BOUND');}
   // Journal before any content request; the request hash includes actual
   // source bytes/crops/schema/model/effort. The oracle is never referenced.
   const providerRequest=buildOpenAiV2ResponsesRequest({model:SOL_COMPARISON_POLICY.model,prepared:request.prepared,
    kind:request.kind,requested_fields:request.requestedFields,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,...(policy?{sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY}:{})});
   const counted=solInputCountRequest(providerRequest);
   const retryPrompt=reviewed?.reason==='literal-label-cell-transcription-r7'?'payslip-extraction-openai-v2-first-r7':'payslip-extraction-openai-v2-first-r5';
   if(reviewed&&(providerRequest.text.format.name!==retryPrompt||prior?.requestSha256===counted.requestSha256))throw Error('SOL_REVIEWED_RETRY_NEW_PROMPT_REQUIRED');
   if(policy&&(providerRequest.text.format.name!==policy.toPromptVersion||policyPrior?.requestSha256===counted.requestSha256))throw Error('SOL_POLICY_REVALIDATION_NEW_PROMPT_REQUIRED');
   const reservation={sourceSha256:source.sha256,requestSha256:counted.requestSha256,
    codeRevision:input.codeRevision,attempt:policy?policyPrior!.attempt+1:reviewed?2:1,priorUnknownAcknowledgment,...(policy?{policyRevalidation:policy}:{})};
   if(policy){
    const existing=ledger.reservations.find(r=>r.sourceSha256===source.sha256&&r.attempt===reservation.attempt&&r.kind==='generation');
    if(existing){
     if(existing.outcome!=='receipt_recorded'||existing.requestSha256!==counted.requestSha256||canonicalSha256(existing.policyRevalidation??null)!==canonicalSha256(policy))throw Error('SOL_POLICY_REVALIDATION_UNSETTLED');
     const receipt=parseOpenAiProviderReceipt(existing.receipt),directory=path.join(input.artifactDirectory,receipt.extraction_id);
     const savedValue=z.object({extraction:extractionResultSchema,salary_type_assessment:salaryTypeAssessmentSchema,
      critical_context:z.object({required_fields:z.array(payslipFieldKeySchema).optional(),hourly_analysis_implied:z.boolean().optional(),pension_section_visible:z.boolean().optional(),totals_section_visible:z.boolean().optional()}).strict(),
      pension_section_visible:z.boolean(),totals_section_visible:z.boolean(),provider_receipt:z.unknown()}).strict().parse(JSON.parse(readFileSync(path.join(directory,'mapped.json'),'utf8')));
     const saved={...savedValue,provider_receipt:parseOpenAiProviderReceipt(savedValue.provider_receipt)};
     if(receipt.case_id!==boundRequest.case_id||receipt.document_id!==document.document_id||receipt.extraction_id!==boundRequest.extraction_id
      ||receipt.analysis_run_id!==boundRequest.analysis_run_id||canonicalSha256(saved.provider_receipt)!==canonicalSha256(receipt)
      ||canonicalSha256(saved.extraction)!==receipt.raw_extraction_sha256)throw Error('SOL_POLICY_REVALIDATION_REPLAY_BINDING');
     return saved;
    }
   }
   if(entered>=input.maxGenerations)throw Error('SOL_SAVED_GENERATION_LIMIT');
   if(policy&&(ledger.reservations.length+2>SOL_COMPARISON_POLICY.maxRequests
    ||ledger.reservations.reduce((total,row)=>total+row.reservedMicroUsd,0)+SOL_COMPARISON_POLICY.countReservedMicroUsd+SOL_COMPARISON_POLICY.generationReservedMicroUsd>SOL_COMPARISON_POLICY.maxReservedMicroUsd))throw Error('SOL_POLICY_REVALIDATION_BUDGET_CAPACITY');
   const directory=path.join(input.artifactDirectory,boundRequest.extraction_id);mkdirSync(directory,{recursive:true});
   const save=(name:string,value:unknown)=>writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n',policy?{flag:'wx',mode:0o600}:undefined);
    save('source-context.json',{codeRevision:input.codeRevision,request:boundRequest,requestSha256:counted.requestSha256,
     sourceSha256:source.sha256,model:SOL_COMPARISON_POLICY.model,reasoningEffort:'medium',sourcePageCount:1,...(policy?{policyRevalidation:policy,ledgerSequence:reservation.attempt}:{}),
     ...(input.liveWindow?{managedLiveWindow:{version:input.liveWindow.version,authorizationId:input.liveWindow.authorizationId,
      configSha256:canonicalSha256(input.liveWindow),baselineLedgerSha256:input.liveWindow.baseline.fileSha256,
      authorizedAt:input.liveWindow.authorizedAt,expiresAt:input.liveWindow.expiresAt}}:{})});
    if(input.expiresAt&&Date.now()>=Date.parse(input.expiresAt))throw Error('SOL_MANAGED_PACKAGE_EXPIRED');
    input.assertActive?.();
    if(managedRecoveryAuthority)assertManagedOpenAiRecovery(managedRecoveryAuthority,input.apiKey,boundRequest);
    ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens',now:new Date().toISOString()});persist();
    const count=await sdk.responses.inputTokens.count(counted.request);save('input-count.json',count);
    if(count.object!=='response.input_tokens')throw Error('SOL_COUNT_RESPONSE_INVALID');
    ledger=recordSolCount(ledger,counted.requestSha256,count.input_tokens);persist();
    input.assertActive?.();
    if(input.expiresAt&&Date.now()>=Date.parse(input.expiresAt))throw Error('SOL_MANAGED_PACKAGE_EXPIRED');
    if(managedRecoveryAuthority)assertManagedOpenAiRecovery(managedRecoveryAuthority,input.apiKey,boundRequest);
    ledger=reserveSolRequest({ledger,...reservation,kind:'generation',now:new Date().toISOString()});persist();entered++;
    const result=await actual({...request,request:boundRequest,sourcePageCount:1,onStructuredOutput:diagnostic=>{
     if(diagnostic.origin!=='openai_live'||diagnostic.request_sha256!==counted.requestSha256||diagnostic.source_sha256!==source.sha256)
      throw Error('SOL_SAVED_DIAGNOSTIC_BINDING');
     save('structured.json',diagnostic);request.onStructuredOutput?.(diagnostic);
    }});
    if(!result.provider_receipt||result.provider_receipt.raw_extraction_sha256!==canonicalSha256(result.extraction))throw Error('SOL_SAVED_RECEIPT_MISSING');
    save('mapped.json',result);ledger=recordSolReceipt(ledger,result.provider_receipt);persist();
    save('budget-after.json',summarizeSolBudget(ledger));return result;
   }finally{busy=false;}
  };
  const documentEvidenceExtractor:DocumentEvidenceExtractor|undefined=evidenceScope?{async extract(request){
   if(closed||busy)throw Error('SOL_EXTRACTOR_CLOSED_OR_BUSY');
   busy=true;
   try{
    const active=()=>{input.assertActive?.();if(!input.expiresAt||Date.now()>=Date.parse(input.expiresAt))throw Error('SOL_MANAGED_PACKAGE_EXPIRED');};
    active();
    const document=request.document;
    const allowed=evidenceScope.sources.find(s=>s.caseId===document.case_id&&s.versionId===document.document_id&&s.sourceSha256===document.content_sha256&&s.kind===document.document_type);
    const source=sources.find(s=>s.sha256===document.content_sha256);
    if(!allowed||!source||source.sizeBytes!==document.size_bytes||source.mimeType!==document.mime_type)throw Error('SOL_DOCUMENT_EVIDENCE_SOURCE_NOT_ALLOWED');
    if(entered>=input.maxGenerations)throw Error('SOL_SAVED_GENERATION_LIMIT');
    // Existing history is never repurposed as a new policy/attempt. A retained
    // success/failure requires explicit future authorization, not auto retry.
    if(ledger.reservations.some(r=>r.sourceSha256===source.sha256))throw Error('SOL_REPLAY_REQUIRES_REVIEW');
    const bytes=await request.source.read(document);
    if(bytes.length!==source.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('SOL_SAVED_SOURCE_NOT_ALLOWED');
    const inspected=await inspectExtractionBytes(bytes,source.mimeType);if(inspected.pages>allowed.maxPages)throw Error('SOL_DOCUMENT_EVIDENCE_PAGE_BOUND');
    const providerRequest=buildOpenAiDocumentEvidenceRequest({model:SOL_COMPARISON_POLICY.model,bytes,mimeType:source.mimeType,kind:allowed.kind});
    const counted=solInputCountRequest(providerRequest);
    if(ledger.reservations.length+2>SOL_COMPARISON_POLICY.maxRequests||ledger.reservations.reduce((sum,r)=>sum+r.reservedMicroUsd,0)
     +SOL_COMPARISON_POLICY.countReservedMicroUsd+SOL_COMPARISON_POLICY.generationReservedMicroUsd>SOL_COMPARISON_POLICY.maxReservedMicroUsd)throw Error('SOL_DOCUMENT_EVIDENCE_BUDGET_CAPACITY');
    const directory=path.join(input.artifactDirectory,request.extractionId);mkdirSync(directory,{recursive:true});
    const save=(name:string,value:unknown)=>writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    save('document-evidence-source-context.json',{schema_version:'sol-document-evidence-dispatch-v1',codeRevision:input.codeRevision,
     caseId:document.case_id,versionId:document.document_id,sourceSha256:source.sha256,analysisRunId:request.analysisRunId,
     extractionId:request.extractionId,requestSha256:counted.requestSha256,scope:allowed,physicalPages:inspected.pages});
    const reservation={sourceSha256:source.sha256,requestSha256:counted.requestSha256,codeRevision:input.codeRevision,attempt:1,priorUnknownAcknowledgment};
    const bounded=createOpenAiDocumentEvidenceExtractorFromEnv({OPENAI_API_KEY:input.apiKey,OPENAI_EXTRACTION_MODEL:SOL_COMPARISON_POLICY.model},async authorization=>{
     if(authorization.caseId!==document.case_id||authorization.versionId!==document.document_id||authorization.sourceSha256!==source.sha256
      ||authorization.requestSha256!==counted.requestSha256||authorization.maxOutputTokens!==SOL_COMPARISON_POLICY.outputTokenCeiling)throw Error('SOL_DOCUMENT_EVIDENCE_REQUEST_BINDING');
     active();ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens',now:new Date().toISOString()});persist();
     const count=await sdk.responses.inputTokens.count(counted.request);save('document-evidence-input-count.json',count);
     if(count.object!=='response.input_tokens')throw Error('SOL_COUNT_RESPONSE_INVALID');
     ledger=recordSolCount(ledger,counted.requestSha256,count.input_tokens);persist();active();
     ledger=reserveSolRequest({ledger,...reservation,kind:'generation',now:new Date().toISOString()});persist();entered++;
    });
    const result=await bounded.extract({...request,source:{async read(asked){
     if(canonicalSha256(asked)!==canonicalSha256(document))throw Error('SOL_DOCUMENT_EVIDENCE_SOURCE_CHANGED');return bytes;
    }}});
    const receipt=parseOpenAiProviderReceipt(result.provider_receipt);
    if(receipt.case_id!==document.case_id||receipt.document_id!==document.document_id||receipt.analysis_run_id!==request.analysisRunId
     ||receipt.extraction_id!==request.extractionId||receipt.request_sha256!==counted.requestSha256)throw Error('SOL_DOCUMENT_EVIDENCE_RECEIPT_BINDING');
    save('document-evidence-result.json',result);ledger=recordSolReceipt(ledger,receipt);persist();
    save('document-evidence-budget-after.json',summarizeSolBudget(ledger));return result;
   }finally{busy=false;}
  }}:undefined;
  return {extractor,...(documentEvidenceExtractor?{documentEvidenceExtractor}:{}),summary:()=>({...summarizeSolBudget(ledger),instanceGenerations:entered,
   ...(input.liveWindow?{unknownOutcomes:ledger.reservations.filter(row=>row.outcome==='reserved_unknown'||row.kind==='generation'&&row.outcome==='receipt_recorded'
    &&parseOpenAiProviderReceipt(row.receipt).status==='failed'&&parseOpenAiProviderReceipt(row.receipt).provider_response_id===null&&parseOpenAiProviderReceipt(row.receipt).token_usage===null).length}:{}),
   generationReceiptsWithoutTokenUsage:ledger.reservations.filter(row=>row.kind==='generation'&&row.outcome==='receipt_recorded'
    &&parseOpenAiProviderReceipt(row.receipt).token_usage===null).length}),close};
 }catch(error){close();throw error;}
}


/** Owner-provisioned, finite DEV package. It wraps the genuine SDK transport,
 * never a test response. Enrollment/session authorization is still enforced
 * by the managed host before any source is passed to this extractor. */
export function createManagedSolBudgetedExtractor(environment:Readonly<Record<string,string|undefined>>,buildSha:string){
 const control=managedWorkerControlConfig({...environment,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha});
 if(!control.enabled||environment.VERCEL||environment.OPENAI_EXTRACTION_MODEL!=='gpt-5.6-sol')throw Error('SOL_MANAGED_PACKAGE_SCOPE');
 const expected=path.resolve('../release-work/sol-scheduled-package-20260911.private.json');
 if(environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE&&path.resolve(environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE)!==expected){
  const window=readManagedSolLiveWindow(environment,buildSha),config=window.config;
  if(!environment.OPENAI_API_KEY)throw Error('SOL_MANAGED_PACKAGE_PATH');
  const authority=authorizeManagedOpenAiRecovery({apiKey:environment.OPENAI_API_KEY,buildSha,environment,packageSha256:window.packageSha256});
  return createBoundedSolExtractor({apiKey:environment.OPENAI_API_KEY,ledgerPath:config.ledgerPath,artifactDirectory:config.artifactDirectory,
   codeRevision:buildSha,allowedSources:[{sha256:config.source.sha256,sizeBytes:config.source.sizeBytes,mimeType:config.source.mimeType}],
   allowedCaseIds:[config.source.caseId],allowedVersionIds:[config.source.versionId],expiresAt:config.expiresAt,maxGenerations:1,
   reviewedPolicyRevalidation:config.policyRevalidation,assertActive:window.assertActive,liveWindow:config},authority);
 }
 if(!environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE||path.resolve(environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE)!==expected)throw Error('SOL_MANAGED_PACKAGE_REQUIRED');
 const packageBytes=readFileSync(expected);
 const config=z.object({version:z.literal('sol-scheduled-dev-package-20260911-v1'),enabled:z.literal(true),
  buildSha:z.literal(buildSha),expiresAt:z.iso.datetime({offset:true}),
  ledgerPath:z.string(),artifactDirectory:z.string(),allowedCaseIds:z.array(z.uuid()).min(1).max(4),
  allowedSources:z.array(sourceSchema).min(1).max(4),allowedVersionIds:z.array(z.uuid()).min(1).max(4).optional(),documentEvidenceScope:solDocumentEvidenceScopeSchema.optional()}).strict().parse(JSON.parse(packageBytes.toString('utf8')));
 const expiry=Date.parse(config.expiresAt);
 if(expiry<=Date.now()||expiry>Date.parse('2026-09-11T04:19:48Z'))throw Error('SOL_MANAGED_PACKAGE_EXPIRED');
 const ledger=path.resolve('output/release-completion/sol-scheduled-20260911/package-budget-ledger.json');
 const artifacts=path.resolve('output/release-completion/sol-scheduled-20260911/provider');
 if(path.resolve(config.ledgerPath)!==ledger||path.resolve(config.artifactDirectory)!==artifacts||!environment.OPENAI_API_KEY)throw Error('SOL_MANAGED_PACKAGE_PATH');
 const authority=authorizeManagedOpenAiRecovery({apiKey:environment.OPENAI_API_KEY,buildSha,environment,packageSha256:createHash('sha256').update(packageBytes).digest('hex')});
 return createBoundedSolExtractor({apiKey:environment.OPENAI_API_KEY,ledgerPath:ledger,artifactDirectory:artifacts,codeRevision:buildSha,
  allowedSources:config.allowedSources,allowedCaseIds:config.allowedCaseIds,allowedVersionIds:config.allowedVersionIds,
  ...(config.documentEvidenceScope?{documentEvidenceScope:config.documentEvidenceScope,assertActive(){
   if(createHash('sha256').update(readFileSync(expected)).digest('hex')!==createHash('sha256').update(packageBytes).digest('hex'))throw Error('SOL_MANAGED_PACKAGE_CHANGED');
  }}:{}),expiresAt:config.expiresAt,maxGenerations:2},authority);
}

export function recoverManagedSolBudgetLock(input:{expectedLockSha256:string;expectedLedgerSha256:string},environment:Readonly<Record<string,string|undefined>>=process.env){
 const packagePath=path.resolve('../release-work/sol-scheduled-package-20260911.private.json');
 const ledgerPath=path.resolve('output/release-completion/sol-scheduled-20260911/package-budget-ledger.json');
 const assertOwnerPaused=()=>{
  if(environment.VERCEL||environment.VERCEL_ENV||environment.NODE_ENV!=='development'||environment.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='false'
   ||environment.TIVDOC_MANAGED_DEV_OWNER_RECOVERY!=='true'||!environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE
   ||path.resolve(environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE)!==packagePath)throw Error('SOL_LEDGER_OWNER_RECOVERY_REQUIRED');
  const config=JSON.parse(readFileSync(packagePath,'utf8')) as Record<string,unknown>;
  if(config.version!=='sol-scheduled-dev-package-20260911-v1'||config.enabled!==false||typeof config.ledgerPath!=='string'
   ||path.resolve(config.ledgerPath)!==ledgerPath)throw Error('SOL_LEDGER_OWNER_RECOVERY_REQUIRED');
 };
 return recoverStaleSolBudgetLock({...input,ledgerPath,assertOwnerPaused});
}
