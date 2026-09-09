import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PreparedPayslipDocument} from '@/server/engine/extraction/preprocessing';
import {buildOpenAiV2ResponsesRequest} from '@/server/engine/extraction/providers/openai/v2-request';
import {parseOpenAiProviderReceipt,type OpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';

/** A test-runner spending ceiling, never a production model selection. Reserve
 * the whole published context window rather than estimating PDF/image tokens.
 * No tools, extra service fees, caching discounts or unknown model aliases. */
export const LIVE_EXTRACTION_BUDGET_POLICY=Object.freeze({
 version:'tivdoc-live-corpus-budget-v1',model:'gpt-4o-mini-2024-07-18',
 pricingSource:'https://developers.openai.com/api/docs/models/gpt-4o-mini',pricingCheckedAt:'2026-09-09',
 pricingValidUntil:'2026-09-16T00:00:00Z',inputTokenCeiling:128000,outputTokenCeiling:10000,
 inputUsdPerMillion:0.15,outputUsdPerMillion:0.60,
 // Integer micro-dollars: 128000 * .15 + 10000 * .60 = 25200.
 perPassReservedMicroUsd:25200,maxReservedMicroUsd:5000000,maxPasses:22,
 maxSourceBytes:1024*1024,maxPages:1,maxRasterWidth:2500,maxRasterHeight:3600,maxRasterPixels:9000000,
 maxImagesPerRequest:5,maxImageBytes:2*1024*1024,maxRequestTextBytes:64000,
 sdkRetries:0,
} as const);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const reservation=z.object({key:z.string(),sourceSha256:sha,requestSha256:sha,passKind:z.enum(['first_pass','targeted_recovery']),
 reservedMicroUsd:z.literal(25200),reservedAt:z.iso.datetime({offset:true}),
 receipt:z.unknown().nullable(),outcome:z.enum(['reserved_unknown','receipt_recorded'])}).strict();
const ledgerSchema=z.object({version:z.literal('tivdoc-live-corpus-budget-v1'),model:z.literal('gpt-4o-mini-2024-07-18'),
 reservations:z.array(reservation).max(22)}).strict();
export type LiveExtractionBudgetLedger=z.infer<typeof ledgerSchema>;
export function newLiveExtractionBudgetLedger(model:string,now:string):LiveExtractionBudgetLedger{
 assertLiveExtractionBudgetModel(model,now);
 return {version:LIVE_EXTRACTION_BUDGET_POLICY.version,model:LIVE_EXTRACTION_BUDGET_POLICY.model,reservations:[]};
}
export function assertLiveExtractionBudgetModel(model:string,now:string){
 if(model!==LIVE_EXTRACTION_BUDGET_POLICY.model)throw Error('LIVE_BUDGET_UNPRICED_MODEL');
 const checked=Date.parse(now);
 if(!Number.isFinite(checked)||checked<Date.parse('2026-09-09T00:00:00Z')||checked>=Date.parse(LIVE_EXTRACTION_BUDGET_POLICY.pricingValidUntil))
  throw Error('LIVE_BUDGET_PRICING_REVIEW_EXPIRED');
}
export function parseLiveExtractionBudgetLedger(input:unknown){
 const parsed=ledgerSchema.parse(input);
 if(new Set(parsed.reservations.map(r=>r.key)).size!==parsed.reservations.length
  ||parsed.reservations.some(r=>r.key!==`${r.sourceSha256}:${r.passKind}`))throw Error('LIVE_BUDGET_LEDGER_INVALID');
 return parsed;
}
export function reserveLiveExtractionPass(input:{ledger:LiveExtractionBudgetLedger;sourceSha256:string;requestSha256:string;
 passKind:'first_pass'|'targeted_recovery';now:string}){
 const ledger=parseLiveExtractionBudgetLedger(input.ledger);assertLiveExtractionBudgetModel(ledger.model,input.now);
 const key=`${input.sourceSha256}:${input.passKind}`;
 if(ledger.reservations.some(row=>row.key===key))throw Error('LIVE_BUDGET_REPLAY_REQUIRES_REVIEW');
 if(ledger.reservations.length>=LIVE_EXTRACTION_BUDGET_POLICY.maxPasses
  ||(ledger.reservations.length+1)*LIVE_EXTRACTION_BUDGET_POLICY.perPassReservedMicroUsd>LIVE_EXTRACTION_BUDGET_POLICY.maxReservedMicroUsd)
  throw Error('LIVE_BUDGET_EXHAUSTED');
 return parseLiveExtractionBudgetLedger({...ledger,reservations:[...ledger.reservations,{key,sourceSha256:input.sourceSha256,
  requestSha256:input.requestSha256,passKind:input.passKind,reservedMicroUsd:LIVE_EXTRACTION_BUDGET_POLICY.perPassReservedMicroUsd,
  reservedAt:input.now,receipt:null,outcome:'reserved_unknown'}]});
}
export function recordLiveExtractionPassReceipt(ledger:LiveExtractionBudgetLedger,receipt:OpenAiProviderReceipt){
 receipt=parseOpenAiProviderReceipt(receipt);
 const parsed=parseLiveExtractionBudgetLedger(ledger),key=`${receipt.source_sha256}:${receipt.pass_kind}`;
 const row=parsed.reservations.find(r=>r.key===key);
 if(!row||row.outcome!=='reserved_unknown'||receipt.origin!=='openai_live'||receipt.request_sha256!==row.requestSha256
  ||receipt.requested_model!==parsed.model||(receipt.actual_model!==null&&receipt.actual_model!==parsed.model)
  ||(receipt.token_usage&&(receipt.token_usage.input_tokens>LIVE_EXTRACTION_BUDGET_POLICY.inputTokenCeiling
   ||receipt.token_usage.output_tokens>LIVE_EXTRACTION_BUDGET_POLICY.outputTokenCeiling)))throw Error('LIVE_BUDGET_RECEIPT_OUTSIDE_BOUND');
 row.receipt=receipt;row.outcome='receipt_recorded';return parsed;
}
export function summarizeLiveExtractionBudget(ledger:LiveExtractionBudgetLedger){
 const parsed=parseLiveExtractionBudgetLedger(ledger);
 return {policy:LIVE_EXTRACTION_BUDGET_POLICY,reservedPasses:parsed.reservations.length,
  reservedUpperBoundUsd:parsed.reservations.length*LIVE_EXTRACTION_BUDGET_POLICY.perPassReservedMicroUsd/1000000,
  supplierReturnedCost:{status:'not_returned_by_provider',amountUsd:null},
  // Unknown outcomes keep the complete reservation; neither errors nor a
  // process restart release budget or silently retry the source/pass.
  unknownOutcomes:parsed.reservations.filter(r=>r.outcome==='reserved_unknown').length};
}

/** Called before every actual SDK pass, including targeted recovery. The fixed
 * corpus manifest SHA must already match the source; no caller-supplied file
 * paths or arbitrary documents are accepted by the live proof runner. */
export async function preflightLiveExtractionRequest(input:{model:string;prepared:PreparedPayslipDocument;
 sourceSha256:string;kind:'first_pass'|'targeted_recovery';requestedFields:Parameters<typeof buildOpenAiV2ResponsesRequest>[0]['requested_fields'];now:string}){
 assertLiveExtractionBudgetModel(input.model,input.now);
 const p=LIVE_EXTRACTION_BUDGET_POLICY,original=input.prepared.original;
 if(original.bytes.length>p.maxSourceBytes||createHash('sha256').update(original.bytes).digest('hex')!==input.sourceSha256
  ||original.sha256!==input.sourceSha256)throw Error('LIVE_BUDGET_SOURCE_BOUND');
 if(original.mime_type==='application/pdf'){
  const pdf=await PDFDocument.load(original.bytes);const page=pdf.getPages()[0];
  if(pdf.getPageCount()!==1||!page||Math.abs(page.getWidth()-595)>1||Math.abs(page.getHeight()-842)>1
   ||input.prepared.crops.length)throw Error('LIVE_BUDGET_PDF_BOUND');
 }else if(['image/png','image/jpeg'].includes(original.mime_type)){
  const dimensions=await sharp(original.bytes,{limitInputPixels:p.maxRasterPixels}).metadata();
  if(!dimensions.width||!dimensions.height||dimensions.width>p.maxRasterWidth||dimensions.height>p.maxRasterHeight
   ||(dimensions.pages??1)!==1)throw Error('LIVE_BUDGET_RASTER_BOUND');
 }else throw Error('LIVE_BUDGET_MIME_BOUND');
 if(input.prepared.crops.length+1>p.maxImagesPerRequest)throw Error('LIVE_BUDGET_IMAGE_COUNT');
 for(const {image} of input.prepared.crops){
  const dimensions=await sharp(image.bytes,{limitInputPixels:p.maxRasterPixels}).metadata();
  if(image.bytes.length>p.maxImageBytes||dimensions.width!==image.width||dimensions.height!==image.height
   ||image.width>p.maxRasterWidth||image.height>p.maxRasterHeight||(dimensions.pages??1)!==1
   ||createHash('sha256').update(image.bytes).digest('hex')!==image.sha256)throw Error('LIVE_BUDGET_CROP_BOUND');
 }
 const request=buildOpenAiV2ResponsesRequest({model:input.model,prepared:input.prepared,kind:input.kind,requested_fields:input.requestedFields});
 const textBytes=Buffer.byteLength(request.instructions+JSON.stringify(request.text)+request.input[0].content
  .filter(item=>item.type==='input_text').map(item=>item.text).join(''),'utf8');
 if(request.max_output_tokens!==p.outputTokenCeiling||textBytes>p.maxRequestTextBytes||'tools' in request)
  throw Error('LIVE_BUDGET_REQUEST_BOUND');
 return {requestSha256:canonicalSha256(request),pageCount:1,inputImages:original.mime_type==='application/pdf'?1:1+input.prepared.crops.length,textBytes};
}
