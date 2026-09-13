import 'server-only';
import OpenAI from 'openai';
import {createHash} from 'node:crypto';
import {mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {extractionRequestSchema,payslipFieldKeySchema} from '@/engine/extraction/contracts';
import {immutableDocumentSchema,type ImmutableDocument} from '@/engine/domain/documents';
import {PAYSLIP_EXTRACTION_V21_VERSION} from '@/engine/extraction/v21';
import {SOURCE_ROW_DUPLICATE_POLICY} from '@/engine/extraction/validation';
import {OpenAiPayslipV2PassExtractor,type OpenAiV2StructuredDiagnostic} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {buildOpenAiV2ResponsesRequest,OPENAI_SOL_COMPARISON_PROFILE,OPENAI_SOURCE_FILE_PAGE_POLICY} from '@/server/engine/extraction/providers/openai/v2-request';
import {createOpenAiDocumentEvidenceExtractorFromEnv,type DocumentEvidenceExtractor} from '@/server/engine/extraction/providers/openai/document-evidence-adapter';
import {buildOpenAiDocumentEvidenceRequest} from '@/server/engine/extraction/providers/openai/document-evidence-request';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {inspectExtractionBytes,EXTRACTION_INPUT_LIMITS} from '@/server/engine/extraction/verified-upload-source';
import {statement} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-worker-contracts';
import {realServiceClaimAdmissionSchema,type RealServiceClaimAdmission,type RealServiceBudgetedExtraction} from './real-service-managed-case';
import {getCompiledAiReleaseBuild} from './ai-release-build';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true}),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Conservative pricing guard only; this record grants neither credit nor REAL
 * execution. Independently authenticated policy207 supplies every spend limit.
 * Same reviewed OpenAI tariff as existing product extraction, no cache discount. */
export const REAL_SERVICE_PROVIDER_PRICING=Object.freeze({model:'gpt-5.6-sol',inputMicroUsdPerToken:4,outputMicroUsdPerToken:20,
 checkedAt:'2026-09-10',validUntil:'2026-09-17T00:00:00Z',source:'https://developers.openai.com/api/docs/models/gpt-5.6-sol'});
export const realServiceProviderPolicySchema=z.object({schema_version:z.literal('real-service-provider-budget-policy-v1'),namespace:z.literal('real'),purpose:z.literal('real_customer_service'),
 database_name:z.string().min(1),target_id:z.string().min(1),extraction_mode:z.literal('budgeted_provider'),provider_calls_allowed:z.literal(true),
 maximum_claims:integer.min(1),maximum_active_claims:integer.min(1).max(2),maximum_total_micro_usd:integer.min(1),maximum_claim_micro_usd:integer.min(1),maximum_calls_per_claim:integer.min(2).max(64),
 issued_at:time,expires_at:time,request_limits:z.object({model:z.literal('gpt-5.6-sol'),input_token_ceiling:integer.min(1).max(64000),output_token_ceiling:z.literal(10000),
 count_reserved_micro_usd:integer.min(1),generation_reserved_micro_usd:integer.min(1)}).strict(),
}).strict().superRefine((p,ctx)=>{
 const r=p.request_limits;
 if(r.count_reserved_micro_usd<r.input_token_ceiling*REAL_SERVICE_PROVIDER_PRICING.inputMicroUsdPerToken
  ||r.generation_reserved_micro_usd<r.input_token_ceiling*REAL_SERVICE_PROVIDER_PRICING.inputMicroUsdPerToken+r.output_token_ceiling*REAL_SERVICE_PROVIDER_PRICING.outputMicroUsdPerToken
  ||r.count_reserved_micro_usd+r.generation_reserved_micro_usd>p.maximum_claim_micro_usd||p.maximum_claim_micro_usd>p.maximum_total_micro_usd)
  ctx.addIssue({code:'custom',message:'REAL_SERVICE_PROVIDER_PRICING_BOUND'});
});
const contextSchema=z.object({state:z.literal('authorized'),admission:realServiceClaimAdmissionSchema,policy:realServiceProviderPolicySchema,evaluated_at:time,expires_at:time}).strict();
const requestAckSchema=z.object({state:z.literal('reserved'),dispatch:z.boolean(),request_id:z.uuid(),reservation_id:z.uuid(),policy_sha256:hash,case_id:z.uuid(),version_id:z.uuid(),
 source_sha256:hash,request_sha256:hash,request_kind:z.enum(['input_tokens','generation']),reserved_micro_usd:integer.min(1),evaluated_at:time,expires_at:time}).strict();
type ProviderRequest=ReturnType<typeof buildOpenAiV2ResponsesRequest>|ReturnType<typeof buildOpenAiDocumentEvidenceRequest>;
type Config=Readonly<{transactions:SavedWorkerTransactions;apiKey:string;artifactDirectory:string;signal?:AbortSignal}>;
function active(expiresAt:string,signal?:AbortSignal){
 if(signal?.aborted)throw Error('SAVED_JOB_INTERRUPTED');
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_PROVIDER_ENABLED!=='1')throw Error('REAL_SERVICE_PROVIDER_DISABLED');
 if(Date.now()>=Date.parse(expiresAt))throw Error('REAL_SERVICE_BUDGET_EXPIRED');
 if(Date.now()>=Date.parse(REAL_SERVICE_PROVIDER_PRICING.validUntil))throw Error('REAL_SERVICE_PROVIDER_PRICING_EXPIRED');
}
function persist(directory:string,name:string,value:unknown){
 const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized)>2*1024*1024)throw Error('REAL_SERVICE_PROVIDER_ARTIFACT_LIMIT');
 mkdirSync(directory,{recursive:true,mode:0o700});const file=openSync(path.join(directory,name),'wx',0o600);
 try{writeFileSync(file,serialized+'\n');fsyncSync(file);}finally{closeSync(file);}
}

/** Real saved-job factory. Only its configured verified transaction host may
 * read policy/reserve credit; callers cannot supply a policy, SDK transport or
 * live-origin label. Reservation commit precedes every count and generation.
 * Missing/uncertain acknowledgments never dispatch, refund or reset history. */
export function createRealServiceBudgetedExtraction(input:Config):Extract<RealServiceBudgetedExtraction,{mode:'budgeted_provider'}>{
 if(!input.apiKey?.trim()||!path.isAbsolute(input.artifactDirectory))throw Error('REAL_SERVICE_PROVIDER_CONFIGURATION');
 const config={...input,artifactDirectory:path.resolve(input.artifactDirectory)},build=getCompiledAiReleaseBuild().manifest.sha256;
 return Object.freeze({mode:'budgeted_provider' as const,async forClaim(candidate:RealServiceClaimAdmission){
  const admission=deepFreeze(realServiceClaimAdmissionSchema.parse(candidate));active(admission.expires_at,config.signal);
  if(admission.extraction_mode!=='budgeted_provider')throw Error('REAL_SERVICE_BUDGET_MODE');
  const loaded=await config.transactions(async context=>{
   const r=await context.client.query(statement('real_service_provider_context','select private.real_service_provider_context($1::uuid,$2) value',[admission.reservation_id,build]));
   if(r.row_count!==1||r.rows.length!==1)throw Error('REAL_SERVICE_PROVIDER_CONTEXT_ACK');return contextSchema.parse(r.rows[0].value);
  });
  if(canonicalSha256(loaded.admission)!==canonicalSha256(admission))throw Error('REAL_SERVICE_PROVIDER_CLAIM_CHANGED');
  const policy=deepFreeze(loaded.policy),at=Date.parse(loaded.evaluated_at),expires=Date.parse(loaded.expires_at);
  if(at<Date.parse(policy.issued_at)||at>=expires||expires>Date.parse(policy.expires_at)||expires>Date.parse(admission.expires_at))throw Error('REAL_SERVICE_BUDGET_EXPIRED');
  active(loaded.expires_at,config.signal);
  const limits=policy.request_limits,sdk=new OpenAI({apiKey:config.apiKey,baseURL:'https://api.openai.com/v1',timeout:120000,maxRetries:0});
  let busy=false;
  const current=()=>active(loaded.expires_at,config.signal);
  const directory=(requestId:string)=>path.join(config.artifactDirectory,admission.reservation_id,requestId);
  async function reserve(document:ImmutableDocument,request:ProviderRequest,kind:'input_tokens'|'generation'){
   current();const requestSha=canonicalSha256(request);
   if(document.case_id!==admission.case_id||request.model!==limits.model||request.max_output_tokens!==limits.output_token_ceiling
    ||request.store!==false||request.reasoning?.effort!=='medium'||request.service_tier!=='default')throw Error('REAL_SERVICE_PROVIDER_REQUEST_SCOPE');
   const result=await config.transactions(async context=>{
    const r=await context.client.query(statement('real_service_provider_request_reserve',
     'select private.real_service_provider_request_reserve($1::uuid,$2::uuid,$3,$4,$5,$6,$7::integer,$8) value',
     [admission.reservation_id,document.document_id,document.content_sha256,requestSha,kind,request.model,request.max_output_tokens,build]));
    if(r.row_count!==1||r.rows.length!==1)throw Error('REAL_SERVICE_PROVIDER_RESERVATION_ACK');return requestAckSchema.parse(r.rows[0].value);
   });
   if(result.reservation_id!==admission.reservation_id||result.policy_sha256!==admission.provider_budget_policy_sha256||result.case_id!==document.case_id
    ||result.version_id!==document.document_id||result.source_sha256!==document.content_sha256||result.request_sha256!==requestSha||result.request_kind!==kind
    ||result.reserved_micro_usd!==(kind==='input_tokens'?limits.count_reserved_micro_usd:limits.generation_reserved_micro_usd)
    ||Date.parse(result.evaluated_at)>=Date.parse(result.expires_at)||Date.parse(result.expires_at)>expires)throw Error('REAL_SERVICE_PROVIDER_RESERVATION_CHANGED');
   if(!result.dispatch)throw Error('REAL_SERVICE_PROVIDER_REPLAY_HELD');
   current();active(result.expires_at,config.signal);
   persist(directory(result.request_id),'reservation.json',result);return result;
  }
  async function record(requestId:string,payload:unknown){
   const expected=canonicalSha256(payload);
   await config.transactions(async context=>{
    const r=await context.client.query(statement('real_service_provider_receipt_record','select private.real_service_provider_receipt_record($1::uuid,$2::jsonb) value',[requestId,JSON.stringify(payload)]));
    const ack=z.object({state:z.literal('recorded'),request_id:z.uuid(),payload_sha256:hash}).strict().parse(r.rows[0]?.value);
    if(r.row_count!==1||r.rows.length!==1||ack.request_id!==requestId||ack.payload_sha256!==expected)throw Error('REAL_SERVICE_PROVIDER_RECEIPT_ACK');
   });
  }
  async function counted(document:ImmutableDocument,request:ProviderRequest){
   const count=await reserve(document,request,'input_tokens');current();
   // The count request contains exactly the model-visible source/schema/prompt.
   const response=await sdk.responses.inputTokens.count({model:request.model,instructions:request.instructions,input:request.input,text:request.text,reasoning:request.reasoning});
   persist(directory(count.request_id),'input-count.json',response);
   const parsed=z.object({object:z.literal('response.input_tokens'),input_tokens:integer.min(1)}).passthrough().parse(response);
   await record(count.request_id,{schema_version:'real-service-input-count-receipt-v1',request_sha256:count.request_sha256,object:parsed.object,input_tokens:parsed.input_tokens});
   if(parsed.input_tokens>limits.input_token_ceiling)throw Error('REAL_SERVICE_PROVIDER_INPUT_LIMIT');
   return reserve(document,request,'generation');
  }
  async function receipt(reservation:z.infer<typeof requestAckSchema>,value:unknown,document:ImmutableDocument){
   const r=parseOpenAiProviderReceipt(value);
   if(r.origin!=='openai_live'||!r.provider_attempted||r.case_id!==document.case_id||r.document_id!==document.document_id||r.source_sha256!==document.content_sha256
    ||r.request_sha256!==reservation.request_sha256||r.requested_model!==limits.model||r.source_size_bytes!==document.size_bytes||r.source_mime_type!==document.mime_type
    ||r.actual_model!==null&&r.actual_model!==limits.model&&!/^gpt-5\.6-sol-\d{4}-\d{2}-\d{2}$/u.test(r.actual_model)
    ||r.token_usage&&(r.token_usage.input_tokens>limits.input_token_ceiling||r.token_usage.output_tokens>limits.output_token_ceiling))throw Error('REAL_SERVICE_PROVIDER_RECEIPT_CHANGED');
   await record(reservation.request_id,r);
  }
  const extractor=new OpenAiPayslipV2PassExtractor({apiKey:config.apiKey,model:limits.model,timeoutMs:120000},{extractorVersion:PAYSLIP_EXTRACTION_V21_VERSION,
   executionProfile:OPENAI_SOL_COMPARISON_PROFILE,sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY,componentDuplicatePolicy:SOURCE_ROW_DUPLICATE_POLICY});
  const actual=extractor.extractPreparedPass.bind(extractor);
  extractor.extractPreparedPass=async candidate=>{
   if(busy)throw Error('REAL_SERVICE_PROVIDER_BUSY');busy=true;
   try{
    current();const request=extractionRequestSchema.parse(candidate.request),document=request.document,prepared=structuredClone(candidate.prepared),fields=z.array(payslipFieldKeySchema).parse(candidate.requestedFields),
     kind=z.enum(['first_pass','targeted_recovery']).parse(candidate.kind),diagnosticSink=candidate.onStructuredOutput;
    if(document.case_id!==admission.case_id||document.document_type!=='payslip'||request.declared_document_type!=='payslip'
     ||prepared.original.bytes.length!==document.size_bytes||prepared.original.sha256!==document.content_sha256||prepared.original.mime_type!==document.mime_type
     ||createHash('sha256').update(prepared.original.bytes).digest('hex')!==document.content_sha256||prepared.crops.length>4
     ||prepared.crops.some(c=>c.image.bytes.length>2*1024*1024||createHash('sha256').update(c.image.bytes).digest('hex')!==c.image.sha256))throw Error('REAL_SERVICE_PROVIDER_SOURCE_CHANGED');
    const inspected=await inspectExtractionBytes(prepared.original.bytes,document.mime_type);
    if(candidate.sourcePageCount!==undefined&&candidate.sourcePageCount!==inspected.pages)throw Error('REAL_SERVICE_PROVIDER_SOURCE_CHANGED');
    const providerRequest=buildOpenAiV2ResponsesRequest({model:limits.model,prepared,kind,requested_fields:fields,
     executionProfile:OPENAI_SOL_COMPARISON_PROFILE,sourcePagePolicy:OPENAI_SOURCE_FILE_PAGE_POLICY});
    const reservation=await counted(document,providerRequest);current();
    const result=await actual({request,prepared,kind,requestedFields:fields,sourcePageCount:inspected.pages,onStructuredOutput:(diagnostic:OpenAiV2StructuredDiagnostic)=>{
     if(diagnostic.origin!=='openai_live'||diagnostic.request_sha256!==reservation.request_sha256||diagnostic.source_sha256!==document.content_sha256)throw Error('REAL_SERVICE_PROVIDER_DIAGNOSTIC_CHANGED');
     persist(directory(reservation.request_id),'structured.json',diagnostic);diagnosticSink?.(diagnostic);
    }});
    persist(directory(reservation.request_id),'mapped.json',result);
    if(!result.provider_receipt||result.provider_receipt.raw_extraction_sha256!==canonicalSha256(result.extraction))throw Error('REAL_SERVICE_PROVIDER_RECEIPT_CHANGED');
    await receipt(reservation,result.provider_receipt,document);return result;
   }finally{busy=false;}
  };
  const documentEvidence:DocumentEvidenceExtractor={async extract(candidate){
   if(busy)throw Error('REAL_SERVICE_PROVIDER_BUSY');busy=true;
   try{
    current();const document=immutableDocumentSchema.parse(candidate.document);
    if(document.case_id!==admission.case_id||!['attendance','contract'].includes(document.document_type)||document.size_bytes>EXTRACTION_INPUT_LIMITS.bytes)throw Error('REAL_SERVICE_PROVIDER_SOURCE_CHANGED');
    const bytes=new Uint8Array(await candidate.source.read(document));
    if(bytes.length!==document.size_bytes||createHash('sha256').update(bytes).digest('hex')!==document.content_sha256)throw Error('REAL_SERVICE_PROVIDER_SOURCE_CHANGED');
    await inspectExtractionBytes(bytes,document.mime_type);
    const providerRequest=buildOpenAiDocumentEvidenceRequest({model:limits.model,bytes,mimeType:document.mime_type,kind:document.document_type as 'attendance'|'contract'});
    let reservation:z.infer<typeof requestAckSchema>|undefined;
    // FromEnv constructs the real SDK and origin itself. Authorization executes
    // after that adapter rebuilt the actual request, immediately before parse.
    const actualEvidence=createOpenAiDocumentEvidenceExtractorFromEnv({OPENAI_API_KEY:config.apiKey,OPENAI_EXTRACTION_MODEL:limits.model,OPENAI_EXTRACTION_TIMEOUT_MS:'120000'},async auth=>{
     if(auth.caseId!==document.case_id||auth.versionId!==document.document_id||auth.sourceSha256!==document.content_sha256||auth.requestSha256!==canonicalSha256(providerRequest)
      ||auth.model!==limits.model||auth.maxOutputTokens!==limits.output_token_ceiling||auth.purpose!==document.document_type)throw Error('REAL_SERVICE_PROVIDER_AUTHORIZATION_CHANGED');
     reservation=await counted(document,providerRequest);current();
    });
    const result=await actualEvidence.extract({...candidate,document,source:{async read(selected){if(canonicalSha256(selected)!==canonicalSha256(document))throw Error('REAL_SERVICE_PROVIDER_SOURCE_CHANGED');return new Uint8Array(bytes);}}});
    if(!reservation)throw Error('REAL_SERVICE_PROVIDER_RESERVATION_ACK');persist(directory(reservation.request_id),'mapped.json',result);
    await receipt(reservation,result.provider_receipt,document);return result;
   }finally{busy=false;}
  }};
  return {extractor,documentEvidence:{extractor:documentEvidence}};
 }});
}
