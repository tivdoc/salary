import 'server-only';
import OpenAI from 'openai';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,mkdirSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {extractionRequestSchema,payslipFieldKeySchema,type ExtractionRequest} from '@/engine/extraction/contracts';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {PAYSLIP_EXTRACTION_V21_VERSION,resolvePayslipExtractionPassesV21,selectTargetedRecoveryV21,recoveryDecisionForV21} from '@/engine/extraction/v21';
import {SOURCE_ROW_DUPLICATE_POLICY} from '@/engine/extraction/validation';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,snapshotResolutionContextSchema,type SnapshotResolutionContext} from '@/engine/extraction/resolver';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import type {MappedOpenAiV2Pass} from '@/server/engine/extraction/providers/openai/v2-mapper';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import type {ExtractionRegion} from '@/engine/extraction/v2';
import {buildOpenAiV2ResponsesRequest,OPENAI_SOL_COMPARISON_PROFILE,OPENAI_SOURCE_FILE_PAGE_POLICY,openAiV2PromptVersion} from '@/server/engine/extraction/providers/openai/v2-request';
import {preprocessPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {inspectExtractionBytes} from '@/server/engine/extraction/verified-upload-source';
import {parseSolComparisonLedger,reserveSolRequest,recordSolCount,recordSolReceipt,solInputCountRequest,summarizeSolBudget,SOL_COMPARISON_POLICY} from '@/server/product/processing/live-extraction-sol-comparison-budget';
import {acquireSolBudgetLock} from '@/server/product/processing/sol-budget-lock';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const jobSchema=z.object({work_id:z.string().regex(/^CASE-[0-9]{2,3}$/u),case_id:z.uuid(),document_id:z.uuid(),
 filename:z.string().regex(/^[a-z0-9-]+\.(pdf|jpg|png)$/u),mime_type:z.enum(['application/pdf','image/jpeg','image/png']),
 source_sha256:sha,size_bytes:z.number().int().positive().max(10*1024*1024),
 printed_page_count:z.number().int().min(1).max(12),reference_file:z.string().min(1),reference_sha256:sha,
 source_created_at:z.iso.datetime({offset:true}),source_classification:z.literal('payslip'),
 source_qa_classification:z.enum(['non_qa_paid','paid_qa_ownership_unresolved']),
 }).strict();
export const privateExtractionAuthorizationSchema=z.object({version:z.literal('private-paid-analysis-20260911-v1'),
 source_project:z.string().regex(/^[a-z0-9-]{8,64}$/u),
 enabled:z.boolean(),authorized_max_requests:z.literal(40),authorized_max_usd:z.literal(15),
 // Deliberately stricter first tranche, using the existing unchanged budget policy.
 operative_max_requests:z.literal(12),operative_max_usd:z.literal(5),
 production_read_only:z.literal(true),customer_delivery:z.literal(false),
 jobs:z.array(jobSchema).min(1).max(6),created_at:z.iso.datetime({offset:true}),
 }).strict().superRefine((a,c)=>{if(new Set(a.jobs.map(j=>j.document_id)).size!==a.jobs.length)c.addIssue({code:'custom',message:'Duplicate source job'});});

const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
/** Resolve junctions. A parent home-directory repository is allowed only when
 * the artifact is explicitly ignored locally AND no file below it is tracked. */
export function privateArtifactPath(value:string){
 const absolute=path.resolve(value);let ancestor=absolute;
 while(!existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw Error('PRIVATE_PATH_UNAVAILABLE');ancestor=parent;}
 const resolved=path.join(realpathSync(ancestor),path.relative(ancestor,absolute));
 let current=existsSync(resolved)?resolved:path.dirname(resolved);
 while(true){if(existsSync(path.join(current,'.git'))){
   const relative=path.relative(current,resolved).replaceAll('\\','/');
   try{if(!relative||execFileSync('git',['-C',current,'ls-files','-z','--',relative],{stdio:['ignore','pipe','pipe']}).length)throw Error('tracked');
    execFileSync('git',['-C',current,'check-ignore','--quiet','--no-index','--',relative],{stdio:'ignore'});
   }catch{throw Error('PRIVATE_ARTIFACT_IN_GIT');}
  }const parent=path.dirname(current);if(parent===current)break;current=parent;}
 return resolved;
}
function child(root:string,relative:string){const target=privateArtifactPath(path.resolve(root,relative));if(!target.startsWith(root+path.sep))throw Error('PRIVATE_PATH_SCOPE');return target;}
function saveNew(file:string,value:unknown){writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
function privateBudgetSummary(ledger:ReturnType<typeof parseSolComparisonLedger>){
 const summary=summarizeSolBudget(ledger);
 const unknownGenerationReceipts=ledger.reservations.filter(r=>r.kind==='generation'&&r.outcome==='receipt_recorded').filter(r=>{
  const receipt=parseOpenAiProviderReceipt(r.receipt);return receipt.status==='failed'&&receipt.provider_response_id===null&&receipt.token_usage===null;
 }).length;
 return {...summary,unknownGenerationReceipts,unknownOutcomes:summary.unknownOutcomes+unknownGenerationReceipts};
}

export function derivePrivateExtraction(request:ExtractionRequest,mapped:MappedOpenAiV2Pass,regions:ExtractionRegion[],candidateContext:SnapshotResolutionContext){
 const context=snapshotResolutionContextSchema.parse(candidateContext);
 if(context.case_id!==request.case_id||context.analysis_run_id!==request.analysis_run_id)throw Error('PRIVATE_FACT_CONTEXT_SCOPE');
 const firstPass=buildPassEvaluation({pass_id:request.extraction_id,kind:'first_pass',requested_fields:payslipFieldKeySchema.options,selected_regions:regions,
  prompt_version:openAiV2PromptVersion('first_pass',OPENAI_SOURCE_FILE_PAGE_POLICY),model:mapped.extraction.provider.model_version??SOL_COMPARISON_POLICY.model,raw_extraction:mapped.extraction,
  salary_type_assessment:mapped.salary_type_assessment,pension_section_visible:mapped.pension_section_visible,totals_section_visible:mapped.totals_section_visible,
  critical_context:mapped.critical_context,reference_year:2026,component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY});
 const plan=mapped.extraction.status==='failed'?null:selectTargetedRecoveryV21(firstPass);
 const recoveryDecision=plan?{requested:false,skipped:true,fields_requested:plan.fields,regions:plan.regions,
  reason_codes:[...plan.reason_codes,'recovery_skipped_package_budget'],expected_information_gain:plan.expected_information_gain}:recoveryDecisionForV21(null);
 const resolved=resolvePayslipExtractionPassesV21({first_pass:firstPass,recovery_passes:[],recovery_decision:recoveryDecision,final_extraction_id:request.extraction_id,critical_context:mapped.critical_context,reference_year:2026});
 const facts=resolved.final_extraction.status==='failed'?null:resolvePayslipSnapshot({document:request.document,extraction:resolved.final_extraction,validation:resolved.final_validation,context});
 return {resolved,facts};
}

/** Local owner-only analysis of frozen paid-case copies. This entry has no DB,
 * storage mutation, customer-session, notification or publication dependency.
 * One count and one genuine existing extractor pass; no automatic retry.
 * The reference is hash-checked only and is NEVER supplied to the model. */
export async function runPrivatePayslipExtraction(input:{privateRoot:string;documentId:string;apiKey:string;codeRevision:string;attempt?:number}){
 if(process.env.VERCEL||process.env.VERCEL_ENV||!input.apiKey||!/^[a-f0-9]{40}$/u.test(input.codeRevision))throw Error('PRIVATE_LOCAL_SCOPE');
 const attempt=z.number().int().min(1).max(6).parse(input.attempt??1);
 const root=privateArtifactPath(input.privateRoot);
 const authorizationBytes=readFileSync(child(root,'authorization.private.json'));
 const authorization=privateExtractionAuthorizationSchema.parse(JSON.parse(authorizationBytes.toString('utf8')));
 if(!authorization.enabled)throw Error('PRIVATE_ANALYSIS_DISABLED');
 const job=authorization.jobs.find(j=>j.document_id===input.documentId);if(!job)throw Error('PRIVATE_SOURCE_NOT_ENROLLED');
 const sourceFile=child(root,`${job.work_id}/source/${job.filename}`),reference=child(root,job.reference_file);
 const bytes=readFileSync(sourceFile);
 if(bytes.length!==job.size_bytes||hash(bytes)!==job.source_sha256||hash(readFileSync(reference))!==job.reference_sha256)throw Error('PRIVATE_SOURCE_OR_REFERENCE_CHANGED');
 const inspected=await inspectExtractionBytes(bytes,job.mime_type);
 if(job.mime_type==='application/pdf'&&inspected.pages!==job.printed_page_count)throw Error('PRIVATE_PAGE_COUNT_MISMATCH');
 const sourceReceipt=JSON.parse(readFileSync(child(root,`${job.work_id}/source/download-receipt.private.json`),'utf8'));
 const imported=sourceReceipt.documents?.find((d:{source_document:{id:string}})=>d.source_document.id===job.document_id);
 if(sourceReceipt.source_case_id!==job.case_id||sourceReceipt.source_project!==authorization.source_project||!imported||imported.observed_sha256!==job.source_sha256
  ||imported.private_filename!==job.filename||imported.source_document.case_id!==job.case_id||imported.observed_size!==job.size_bytes
  ||imported.source_document.size!==job.size_bytes||imported.source_document.mime_type!==job.mime_type||imported.source_document.document_type!=='payslip'
  ||imported.source_document.created_at!==job.source_created_at
  ||sourceReceipt.source_is_qa!==(job.source_qa_classification==='paid_qa_ownership_unresolved'))throw Error('PRIVATE_SOURCE_RECEIPT_MISMATCH');
 const originalDirectory=child(root,`${job.work_id}/provider/${job.document_id}`);
 const directory=attempt===1?originalDirectory:path.join(originalDirectory,`attempt-${attempt}`);
 if(attempt>1){
  const previousDirectory=attempt===2?originalDirectory:path.join(originalDirectory,`attempt-${attempt-1}`);
  const previousPath=path.join(previousDirectory,'result.private.json');
  if(!existsSync(previousPath))throw Error('PRIVATE_RETRY_HISTORY_REQUIRED');
  const previous=JSON.parse(readFileSync(previousPath,'utf8'));
  const receipt=parseOpenAiProviderReceipt(previous.payload?.mapped?.provider_receipt);
  if(previous.source_sha256!==job.source_sha256||previous.document_id!==job.document_id||previous.case_id!==job.case_id
   ||receipt.status!=='failed'||receipt.origin!=='openai_live'||!receipt.provider_attempted)throw Error('PRIVATE_RETRY_REQUIRES_FAILED_RECEIPT');
 }
 mkdirSync(directory,{recursive:true});
 const resultPath=path.join(directory,'result.private.json'),ledgerPath=child(root,'package-budget-ledger.private.json');
 const lock=acquireSolBudgetLock({ledgerPath,codeRevision:input.codeRevision});
 try{
  let ledger=parseSolComparisonLedger(JSON.parse(readFileSync(ledgerPath,'utf8')));
  if(existsSync(resultPath)){
   const saved=JSON.parse(readFileSync(resultPath,'utf8'));
   const receipt=parseOpenAiProviderReceipt(saved.payload.mapped.provider_receipt);
   const originalContext=JSON.parse(readFileSync(path.join(directory,'request-context.private.json'),'utf8'));
   const originalMapped=JSON.parse(readFileSync(path.join(directory,'mapped.private.json'),'utf8'));
   const request=extractionRequestSchema.parse(originalContext.request);
   const derived=derivePrivateExtraction(request,originalMapped,saved.payload.first_pass_regions,saved.payload.evaluation_context);
   if(saved.source_sha256!==job.source_sha256||saved.document_id!==job.document_id||saved.case_id!==job.case_id
    ||saved.reference_sha256!==job.reference_sha256||request.document.content_sha256!==job.source_sha256||request.case_id!==job.case_id||request.document.document_id!==job.document_id
    ||receipt.case_id!==job.case_id||receipt.document_id!==job.document_id||receipt.analysis_run_id!==request.analysis_run_id||receipt.source_sha256!==job.source_sha256
    ||receipt.request_sha256!==originalContext.request_sha256||receipt.raw_extraction_sha256!==canonicalSha256(originalMapped.extraction)
    ||canonicalSha256(originalMapped)!==canonicalSha256(saved.payload.mapped)||canonicalSha256(derived.resolved)!==canonicalSha256(saved.payload.resolved)
    ||canonicalSha256(derived.facts)!==canonicalSha256(saved.payload.facts)||saved.payload_sha256!==canonicalSha256(saved.payload)
    ||!ledger.reservations.some(r=>r.kind==='generation'&&r.outcome==='receipt_recorded'&&r.sourceSha256===job.source_sha256&&canonicalSha256(r.receipt)===canonicalSha256(receipt)))throw Error('PRIVATE_REPLAY_BINDING');
   return {work_id:job.work_id,state:'reused',resultPath,budget:privateBudgetSummary(ledger)};
  }
  const persist=()=>{const temp=ledgerPath+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(ledger,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,ledgerPath);};
  const now=new Date().toISOString(),runId=randomUUID();
  const request=extractionRequestSchema.parse({case_id:job.case_id,analysis_run_id:runId,extraction_id:randomUUID(),declared_document_type:'payslip',requested_at:now,
   document:{document_id:job.document_id,case_id:job.case_id,document_type:'payslip',original_filename:job.filename,mime_type:job.mime_type,size_bytes:bytes.length,
    content_sha256:job.source_sha256,storage_path:`cases/${job.case_id}/documents/${job.document_id}/original.${job.filename.split('.').at(-1)}`,
    document_period:null,supersedes_document_id:null,created_at:job.source_created_at}});
  const prepared=await preprocessPayslipDocument({bytes,mime_type:job.mime_type,regions:['header','earnings','totals','pension']});
  const providerRequest=buildOpenAiV2ResponsesRequest({model:SOL_COMPARISON_POLICY.model,prepared,kind:'first_pass',requested_fields:payslipFieldKeySchema.options,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY});
  const counted=solInputCountRequest(providerRequest),reservation={sourceSha256:job.source_sha256,requestSha256:counted.requestSha256,codeRevision:input.codeRevision,attempt};
  saveNew(path.join(directory,'request-context.private.json'),{request,source_job:job,authorization_sha256:hash(authorizationBytes),codeRevision:input.codeRevision,request_sha256:counted.requestSha256,
   scope:'private_actual_paid_copy_no_legal_admission',historical_version_id:null,observed_version:'observed-sha256:'+job.source_sha256,container_pages:inspected.pages,printed_pages:job.printed_page_count,
   actual_source_storage_path:imported.source_document.storage_path,virtual_engine_path:request.document.storage_path,
   import_receipt_sha256:hash(readFileSync(child(root,`${job.work_id}/source/download-receipt.private.json`)))});
  ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens',now:new Date().toISOString()});persist();
  const sdk=new OpenAI({apiKey:input.apiKey,baseURL:'https://api.openai.com/v1',maxRetries:0,timeout:120000});
  const count=await sdk.responses.inputTokens.count(counted.request);saveNew(path.join(directory,'input-count.private.json'),count);
  if(count.object!=='response.input_tokens')throw Error('PRIVATE_COUNT_RESPONSE_INVALID');
  ledger=recordSolCount(ledger,counted.requestSha256,count.input_tokens);persist();
  // A second operator pause takes effect before the paid generation as well.
  if(!readFileSync(child(root,'authorization.private.json')).equals(authorizationBytes))throw Error('PRIVATE_AUTHORIZATION_CHANGED');
  ledger=reserveSolRequest({ledger,...reservation,kind:'generation',now:new Date().toISOString()});persist();
  const extractor=new OpenAiPayslipV2PassExtractor({apiKey:input.apiKey,model:SOL_COMPARISON_POLICY.model,timeoutMs:120000},
   {extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,componentDuplicatePolicy:SOURCE_ROW_DUPLICATE_POLICY,sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY});
  const mapped=await extractor.extractPreparedPass({request,prepared,kind:'first_pass',requestedFields:payslipFieldKeySchema.options,sourcePageCount:inspected.pages,
   onStructuredOutput:diagnostic=>saveNew(path.join(directory,'structured.private.json'),diagnostic)});
  saveNew(path.join(directory,'mapped.private.json'),mapped);
  if(!mapped.provider_receipt||mapped.provider_receipt.raw_extraction_sha256!==canonicalSha256(mapped.extraction))throw Error('PRIVATE_PROVIDER_RECEIPT_MISSING');
  ledger=recordSolReceipt(ledger,mapped.provider_receipt);persist();
  const context={snapshot_id:randomUUID(),case_id:job.case_id,analysis_run_id:runId,schema_version:'1.0',created_at:new Date().toISOString(),fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,randomUUID()]))};
  const regions=prepared.crops.map(c=>c.region),derived=derivePrivateExtraction(request,mapped,regions,context);
  const payload={mapped,...derived,evaluation_context:context,first_pass_regions:regions,preprocessing:prepared.metadata};
  saveNew(resultPath,{version:'private-live-extraction-v1',case_id:job.case_id,document_id:job.document_id,analysis_run_id:runId,source_sha256:job.source_sha256,
   reference_sha256:job.reference_sha256,codeRevision:input.codeRevision,scope:'private_not_customer_admission',customer_answers_added:0,automatic_recovery:false,payload,payload_sha256:canonicalSha256(payload)});
  return {work_id:job.work_id,state:mapped.extraction.status,resultPath,budget:privateBudgetSummary(ledger)};
 }finally{lock.close();}
}
