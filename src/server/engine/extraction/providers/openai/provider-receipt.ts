import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {openAiExtractionErrorCodeSchema} from './error-contract';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const identifier=z.string().regex(/^[A-Za-z0-9._:-]{1,240}$/u);
const usage=z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative(),
 total_tokens:z.number().int().nonnegative()}).strict();
const body=z.object({
 schema_version:z.literal('tivdoc-openai-provider-receipt-v1'),
 origin:z.enum(['openai_live','injected_test_provider','not_configured']),
 case_id:z.uuid(),analysis_run_id:z.uuid(),document_id:z.uuid(),extraction_id:z.uuid(),
 source_sha256:sha,source_size_bytes:z.number().int().positive(),source_mime_type:z.string().min(1).max(120),
 source_page_count:z.number().int().positive().max(12).optional(),
 request_sha256:sha.nullable(),raw_extraction_sha256:sha,
 pass_kind:z.enum(['first_pass','targeted_recovery']),
 requested_model:identifier,actual_model:identifier.nullable(),extractor_version:identifier,prompt_version:identifier,
 provider_response_id:identifier.nullable(),provider_request_id:identifier.nullable(),
 provider_attempted:z.boolean(),status:z.enum(['completed','failed']),error_code:openAiExtractionErrorCodeSchema.nullable(),
 http_status:z.number().int().min(100).max(599).nullable(),duration_ms:z.number().int().nonnegative(),
 token_usage:usage.nullable(),cost:z.object({status:z.literal('not_returned_by_provider'),amount_usd:z.null()}).strict(),
 created_at:z.iso.datetime({offset:true}),
}).strict().superRefine((p,ctx)=>{
 if((p.status==='completed')!==(p.error_code===null))ctx.addIssue({code:'custom',message:'PROVIDER_RECEIPT_OUTCOME_INVALID'});
 if(p.provider_attempted!==(p.request_sha256!==null))ctx.addIssue({code:'custom',message:'PROVIDER_RECEIPT_ATTEMPT_INVALID'});
 if(p.origin==='not_configured'&&p.provider_attempted)ctx.addIssue({code:'custom',message:'PROVIDER_RECEIPT_CONFIGURATION_INVALID'});
 if(p.status==='completed'&&(!p.provider_attempted||!p.provider_response_id))ctx.addIssue({code:'custom',message:'PROVIDER_RECEIPT_SUCCESS_UNPROVEN'});
 if(p.token_usage&&p.token_usage.total_tokens<p.token_usage.input_tokens+p.token_usage.output_tokens)ctx.addIssue({code:'custom',message:'PROVIDER_RECEIPT_USAGE_INVALID'});
});
const receiptSchema=body.safeExtend({receipt_sha256:sha});
export type OpenAiProviderReceipt=Readonly<z.infer<typeof receiptSchema>>;
export type OpenAiProviderReceiptBody=z.infer<typeof body>;

export function createOpenAiProviderReceipt(input:OpenAiProviderReceiptBody):OpenAiProviderReceipt{
 const parsed=body.parse(input);
 return deepFreeze({...parsed,receipt_sha256:canonicalSha256(parsed)});
}
export function parseOpenAiProviderReceipt(input:unknown):OpenAiProviderReceipt{
 const parsed=receiptSchema.parse(input),{receipt_sha256,...content}=parsed;
 if(canonicalSha256(content)!==receipt_sha256)throw Error('PROVIDER_RECEIPT_HASH_MISMATCH');
 return deepFreeze(parsed);
}
/** Only diagnostic identifiers are retained; never an SDK error message/body. */
export function safeProviderIdentifier(input:unknown){return identifier.safeParse(input).success?input as string:null;}
