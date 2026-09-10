import 'server-only';
import OpenAI from 'openai';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import {extractionRequestSchema} from '@/engine/extraction/contracts';
import {SOURCE_ROW_DUPLICATE_POLICY} from '@/engine/extraction/validation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {buildOpenAiV2ResponsesRequest,OPENAI_SOL_COMPARISON_PROFILE} from '@/server/engine/extraction/providers/openai/v2-request';
import {inspectExtractionBytes} from '@/server/engine/extraction/verified-upload-source';
import {parseSolComparisonLedger,reserveSolRequest,recordSolCount,recordSolReceipt,solInputCountRequest,
 SOL_COMPARISON_POLICY,SOL_RETAINED_DRIVER_FAILURE,summarizeSolBudget} from './live-extraction-sol-comparison-budget';

const sourceSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/u),sizeBytes:z.number().int().positive().max(1024*1024),
 mimeType:z.enum(['application/pdf','image/png','image/jpeg'])}).strict();
export type SolBudgetedSource=z.infer<typeof sourceSchema>;

/** DEV proof integration only. Wraps the genuine existing extractor, preserving
 * actual worker request identity and provider origin. No transport injection,
 * source substitution, checkpoint seeding, or automatic recovery is available.
 * Keep the returned lock for the caller's bounded sequence and close in finally. */
export function createSolBudgetedExtractor(input:{apiKey:string;ledgerPath:string;artifactDirectory:string;codeRevision:string;
 allowedSources:readonly SolBudgetedSource[];maxGenerations:number;retainedDiagnosticPath?:string}){
 if(process.env.VERCEL||process.env.NODE_ENV!=='test'||process.env.TIVDOC_SOL_SAVED_WORKER_PROOF!=='1')throw Error('SOL_SAVED_WORKER_SCOPE');
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
 const lockPath=input.ledgerPath+'.lock',lock=openSync(lockPath,'wx'),instanceId=randomUUID();
 let closed=false,busy=false,entered=0;
 const close=()=>{if(closed)return;if(busy)throw Error('SOL_EXTRACTOR_STILL_RUNNING');closed=true;closeSync(lock);unlinkSync(lockPath);};
 try{
  let ledger=parseSolComparisonLedger(JSON.parse(readFileSync(input.ledgerPath,'utf8')));
  mkdirSync(input.artifactDirectory,{recursive:true});
  const persist=()=>{const temp=input.ledgerPath+'.'+instanceId+'.tmp',file=openSync(temp,'wx');
   try{writeFileSync(file,JSON.stringify(ledger,null,2)+'\n');fsyncSync(file);}finally{closeSync(file);}renameSync(temp,input.ledgerPath);};
  const sdk=new OpenAI({apiKey:input.apiKey,baseURL:'https://api.openai.com/v1',timeout:120000,maxRetries:0});
  const extractor=new OpenAiPayslipV2PassExtractor({apiKey:input.apiKey,model:SOL_COMPARISON_POLICY.model,timeoutMs:120000},
   {extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution:'skip_package_budget',componentDuplicatePolicy:SOURCE_ROW_DUPLICATE_POLICY});
  const actual=extractor.extractPreparedPass.bind(extractor);
  extractor.extractPreparedPass=async request=>{
   if(closed||busy)throw Error('SOL_EXTRACTOR_CLOSED_OR_BUSY');
   busy=true;
   try{
   if(request.kind!=='first_pass')throw Error('SOL_AUTOMATIC_RECOVERY_NOT_AUTHORIZED');
   if(entered>=input.maxGenerations)throw Error('SOL_SAVED_GENERATION_LIMIT');
   const boundRequest=extractionRequestSchema.parse(request.request),document=boundRequest.document;
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
    kind:request.kind,requested_fields:request.requestedFields,executionProfile:OPENAI_SOL_COMPARISON_PROFILE});
   const counted=solInputCountRequest(providerRequest),reservation={sourceSha256:source.sha256,requestSha256:counted.requestSha256,
    codeRevision:input.codeRevision,attempt:1,priorUnknownAcknowledgment};
   const directory=path.join(input.artifactDirectory,boundRequest.extraction_id);mkdirSync(directory,{recursive:true});
   const save=(name:string,value:unknown)=>writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n');
    save('source-context.json',{codeRevision:input.codeRevision,request:boundRequest,requestSha256:counted.requestSha256,
     sourceSha256:source.sha256,model:SOL_COMPARISON_POLICY.model,reasoningEffort:'medium',sourcePageCount:1});
    ledger=reserveSolRequest({ledger,...reservation,kind:'input_tokens',now:new Date().toISOString()});persist();
    const count=await sdk.responses.inputTokens.count(counted.request);save('input-count.json',count);
    if(count.object!=='response.input_tokens')throw Error('SOL_COUNT_RESPONSE_INVALID');
    ledger=recordSolCount(ledger,counted.requestSha256,count.input_tokens);persist();
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
  return {extractor,summary:()=>({...summarizeSolBudget(ledger),instanceGenerations:entered}),close};
 }catch(error){close();throw error;}
}
