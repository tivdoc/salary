import 'server-only';
import {zodTextFormat} from 'openai/helpers/zod';
import {openAiDocumentEvidenceSchema} from './document-evidence-schema';
import {OPENAI_DOCUMENT_EVIDENCE_INSTRUCTIONS,OPENAI_DOCUMENT_EVIDENCE_PROMPT_VERSION} from './document-evidence-prompt';
export function buildOpenAiDocumentEvidenceRequest(input:{model:string;bytes:Uint8Array;mimeType:string;kind:'attendance'|'contract'}){
 if(input.model!=='gpt-5.6-sol')throw Error('DOCUMENT_EVIDENCE_MODEL_PROFILE');
 if(!['application/pdf','image/png','image/jpeg'].includes(input.mimeType))throw Error('DOCUMENT_EVIDENCE_MIME');
 const data=`data:${input.mimeType};base64,${Buffer.from(input.bytes).toString('base64')}`;
 const source=input.mimeType==='application/pdf'?{type:'input_file' as const,filename:'document.pdf',file_data:data,detail:'high' as const}
  :{type:'input_image' as const,image_url:data,detail:'high' as const};
 return {model:input.model,instructions:OPENAI_DOCUMENT_EVIDENCE_INSTRUCTIONS,
  input:[{role:'user' as const,content:[{type:'input_text' as const,text:`Uploaded document category: ${input.kind}. This declaration is not proof of the detected type. Read the original source.`},source]}],
  text:{format:zodTextFormat(openAiDocumentEvidenceSchema,OPENAI_DOCUMENT_EVIDENCE_PROMPT_VERSION)},
  reasoning:{effort:'medium' as const},service_tier:'default' as const,max_output_tokens:10000,store:false};
}
export type OpenAiDocumentEvidenceRequest=ReturnType<typeof buildOpenAiDocumentEvidenceRequest>;
