import 'server-only';
import OpenAI from 'openai';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {immutableDocumentSchema,type ImmutableDocument} from '@/engine/domain/documents';
import {documentEvidenceProviderResultSchema} from '../../saved-document-evidence-contract';
export {documentEvidenceProviderResultSchema} from '../../saved-document-evidence-contract';
import type {PrivateDocumentSource} from '@/engine/extraction/provider';
import {inspectExtractionBytes} from '../../verified-upload-source';
import {createHash} from 'node:crypto';
import {resolveOpenAiExtractionConfig} from './config';
import {buildOpenAiDocumentEvidenceRequest,type OpenAiDocumentEvidenceRequest} from './document-evidence-request';
import {OPENAI_DOCUMENT_EVIDENCE_PROMPT_VERSION} from './document-evidence-prompt';
import {mapOpenAiDocumentEvidence} from './document-evidence-mapper';
import {createOpenAiProviderReceipt,safeProviderIdentifier} from './provider-receipt';
import {classifyOpenAiError,type OpenAiExtractionErrorCode} from './errors';

export interface OpenAiDocumentEvidenceTransport {
 parse(request:OpenAiDocumentEvidenceRequest):Promise<{id:string;status:string;outputParsed:unknown;model?:string|null;requestId?:string|null;
  usage:{input_tokens:number;output_tokens:number;total_tokens:number}|null}>;
}
export type DocumentEvidenceCallAuthorization=(input:{caseId:string;versionId:string;sourceSha256:string;requestSha256:string;
 model:string;maxOutputTokens:number;purpose:'attendance'|'contract'})=>Promise<void>;
export type DocumentEvidenceExtractorInput={document:ImmutableDocument;source:PrivateDocumentSource;analysisRunId:string;extractionId:string;createdAt:string};
export interface DocumentEvidenceExtractor {extract(input:DocumentEvidenceExtractorInput):Promise<z.infer<typeof documentEvidenceProviderResultSchema>>}

/** Host supplies the existing spend ledger authorization. There is deliberately
 * no unbudgeted/default overload, retry loop or private proof dispatch. */
export function createOpenAiDocumentEvidenceExtractor(options:{transport:OpenAiDocumentEvidenceTransport;
 origin:'openai_live'|'injected_test_provider';model:string;authorize:DocumentEvidenceCallAuthorization}):DocumentEvidenceExtractor{
 return {async extract(input){
  const document=immutableDocumentSchema.parse(input.document);
  z.uuid().parse(input.analysisRunId);z.uuid().parse(input.extractionId);z.iso.datetime({offset:true}).parse(input.createdAt);
  if(document.document_type!=='attendance'&&document.document_type!=='contract')throw Error('DOCUMENT_EVIDENCE_KIND');
  const bytes=await input.source.read(document);
  if(bytes.length!==document.size_bytes||createHash('sha256').update(bytes).digest('hex')!==document.content_sha256)throw Error('DOCUMENT_EVIDENCE_SOURCE_CHANGED');
  const physical=await inspectExtractionBytes(bytes,document.mime_type);
  const request=buildOpenAiDocumentEvidenceRequest({model:options.model,bytes,mimeType:document.mime_type,kind:document.document_type});
  const requestSha=canonicalSha256(request);
  await options.authorize({caseId:document.case_id,versionId:document.document_id,sourceSha256:document.content_sha256,
   requestSha256:requestSha,model:options.model,maxOutputTokens:request.max_output_tokens,purpose:document.document_type});
  const started=Date.now();let output:z.infer<ReturnType<typeof z.json>>|null=null;
  let mapped:ReturnType<typeof mapOpenAiDocumentEvidence>|null=null,errorCode:OpenAiExtractionErrorCode|null=null;
  let response:Awaited<ReturnType<OpenAiDocumentEvidenceTransport['parse']>>|null=null;
  try{
   response=await options.transport.parse(request);
   const serialized=JSON.stringify(response.outputParsed??null);
   if(Buffer.byteLength(serialized,'utf8')>512*1024)throw Error('DOCUMENT_EVIDENCE_RESPONSE_LIMIT');
   output=z.json().parse(JSON.parse(serialized));
   if(response.status!=='completed'||!safeProviderIdentifier(response.id))throw Error('DOCUMENT_EVIDENCE_PROVIDER_INCOMPLETE');
   mapped=mapOpenAiDocumentEvidence({output,document,physicalPageCount:physical.pages});
  }catch(error){errorCode=classifyOpenAiError(error);}
  const receipt=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:options.origin,
   case_id:document.case_id,analysis_run_id:input.analysisRunId,document_id:document.document_id,extraction_id:input.extractionId,
   source_sha256:document.content_sha256,source_size_bytes:document.size_bytes,source_mime_type:document.mime_type,source_page_count:physical.pages,
   request_sha256:requestSha,raw_extraction_sha256:canonicalSha256(output),pass_kind:'first_pass',requested_model:options.model,
   actual_model:safeProviderIdentifier(response?.model),extractor_version:'document-evidence-v1',prompt_version:OPENAI_DOCUMENT_EVIDENCE_PROMPT_VERSION,
   provider_response_id:safeProviderIdentifier(response?.id),provider_request_id:safeProviderIdentifier(response?.requestId),provider_attempted:true,
   status:mapped?'completed':'failed',error_code:mapped?null:errorCode??'extraction_failed',http_status:null,duration_ms:Date.now()-started,
   token_usage:response?.usage??null,cost:{status:'not_returned_by_provider',amount_usd:null},created_at:new Date(started).toISOString()});
  return deepFreeze(documentEvidenceProviderResultSchema.parse({schema_version:'document-evidence-provider-result-v1',status:mapped?'completed':'failed',
   raw:mapped?.raw??null,normalized:mapped?.normalized??null,provider_output:output,provider_receipt:receipt,physical_page_count:physical.pages}));
 }};
}
export function createOpenAiDocumentEvidenceExtractorFromEnv(environment:Readonly<Record<string,string|undefined>>,authorize:DocumentEvidenceCallAuthorization):DocumentEvidenceExtractor{
 const config=resolveOpenAiExtractionConfig(environment);if(!config.apiKey)throw Error('DOCUMENT_EVIDENCE_PROVIDER_NOT_CONFIGURED');
 const client=new OpenAI({apiKey:config.apiKey,baseURL:'https://api.openai.com/v1',timeout:config.timeoutMs,maxRetries:0});
 return createOpenAiDocumentEvidenceExtractor({model:config.model,authorize,origin:'openai_live',transport:{async parse(request){
  const result=await client.responses.parse(request);
  return {id:result.id,status:result.status??'failed',outputParsed:result.output_parsed,model:result.model,requestId:result._request_id,
   usage:result.usage?{input_tokens:result.usage.input_tokens,output_tokens:result.usage.output_tokens,total_tokens:result.usage.total_tokens}:null};
 }}});
}
