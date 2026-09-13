import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {parseOpenAiProviderReceipt, type OpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {OPENAI_SOL_COMPARISON_PROFILE, type OpenAiV2ResponsesRequest} from '@/server/engine/extraction/providers/openai/v2-request';

/** Independent package ledger. Count requests conservatively consume both a
 * request slot and a full input-price reservation; no free-endpoint assumption.
 * Reasoning tokens are covered by max_output_tokens. No cache discount. */
export const SOL_COMPARISON_POLICY=Object.freeze({version:'tivdoc-sol-comparison-budget-v1',model:'gpt-5.6-sol',
 executionProfile:OPENAI_SOL_COMPARISON_PROFILE,reasoningEffort:'medium',serviceTier:'default',
 pricingSource:'https://developers.openai.com/api/docs/models/gpt-5.6-sol',pricingCheckedAt:'2026-09-10',
 pricingValidUntil:'2026-09-17T00:00:00Z',inputUsdPerMillion:4,outputUsdPerMillion:20,
 inputTokenCeiling:64000,outputTokenCeiling:10000,maxRequests:12,maxReservedMicroUsd:5000000,
 countReservedMicroUsd:256000,generationReservedMicroUsd:456000,sdkRetries:0} as const);
// One reviewed driver defect after a real structured response. This does NOT
// settle the missing receipt, refund budget, or authorize recalling that source.
export const SOL_RETAINED_DRIVER_FAILURE=Object.freeze({
 sourceSha256:'f74f83f18beed42de39c8fc02615a0d05e0f25bc53b2410314dd4f9a56c05a6b',
 requestSha256:'cbe273b063863ad15736893e3d29b9c84eb563793e6a56a412b8023895675773',
 codeRevision:'c5051f3e8a53f254ca824dbe85ec36eadc4a49a6',
 diagnosticFileSha256:'f5a9c589f2954e227385e7ad881281053204e56160a0f9517906adaf22fb5937'} as const);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const solPolicyRevalidationSchema=z.object({purpose:z.literal('policy_revalidation'),reason:z.literal('explicit-source-scope-r8'),
 priorReceiptSha256:sha,fromPromptVersion:z.literal('payslip-extraction-openai-v2-first-r7-fp1'),toPromptVersion:z.literal('payslip-extraction-openai-v2-first-r8-fp1')}).strict();
export type SolPolicyRevalidation=z.infer<typeof solPolicyRevalidationSchema>;
const reservationSchema=z.object({key:z.string().min(1),sourceSha256:sha,requestSha256:sha,codeRevision:z.string().regex(/^[a-f0-9]{40}$/u),
 attempt:z.number().int().min(1).max(6),kind:z.enum(['input_tokens','generation']),reservedAt:z.iso.datetime({offset:true}),
 reservedMicroUsd:z.number().int().positive(),outcome:z.enum(['reserved_unknown','count_recorded','receipt_recorded']),
 inputTokens:z.number().int().nonnegative().nullable(),receipt:z.unknown().nullable(),priorUnknownAcknowledgment:sha.optional(),policyRevalidation:solPolicyRevalidationSchema.optional()}).strict();
const ledgerSchema=z.object({version:z.literal(SOL_COMPARISON_POLICY.version),model:z.literal(SOL_COMPARISON_POLICY.model),
 reservations:z.array(reservationSchema).max(SOL_COMPARISON_POLICY.maxRequests)}).strict();
export type SolComparisonLedger=z.infer<typeof ledgerSchema>;
export function newSolComparisonLedger():SolComparisonLedger{return {version:SOL_COMPARISON_POLICY.version,model:SOL_COMPARISON_POLICY.model,reservations:[]};}
export function parseSolComparisonLedger(value:unknown):SolComparisonLedger{
 const ledger=ledgerSchema.parse(value),seen=new Set<string>();
 for(const row of ledger.reservations){
  if(seen.has(row.key)||row.key!==`${row.sourceSha256}:${row.attempt}:${row.kind}`
   ||row.reservedMicroUsd!==(row.kind==='input_tokens'?SOL_COMPARISON_POLICY.countReservedMicroUsd:SOL_COMPARISON_POLICY.generationReservedMicroUsd)
   ||(row.inputTokens!==null&&row.inputTokens>SOL_COMPARISON_POLICY.inputTokenCeiling)
   ||(row.outcome==='reserved_unknown'&&(row.receipt!==null||row.inputTokens!==null))
   ||(row.outcome==='count_recorded'&&(row.kind!=='input_tokens'||row.inputTokens===null||row.receipt!==null))
   ||(row.outcome==='receipt_recorded'&&(row.kind!=='generation'||row.receipt===null)))throw Error('SOL_LEDGER_INVALID');
  seen.add(row.key);
  if(row.priorUnknownAcknowledgment!==undefined&&(row.priorUnknownAcknowledgment!==SOL_RETAINED_DRIVER_FAILURE.diagnosticFileSha256
   ||row.sourceSha256===SOL_RETAINED_DRIVER_FAILURE.sourceSha256||!ledger.reservations.some(isKnownRetainedUnknown)))throw Error('SOL_UNKNOWN_ACKNOWLEDGMENT_INVALID');
  if(row.kind==='generation'&&!ledger.reservations.some(prior=>prior.kind==='input_tokens'&&prior.sourceSha256===row.sourceSha256
   &&prior.attempt===row.attempt&&prior.requestSha256===row.requestSha256&&prior.codeRevision===row.codeRevision
   &&prior.outcome==='count_recorded'&&Date.parse(prior.reservedAt)<=Date.parse(row.reservedAt)))throw Error('SOL_GENERATION_WITHOUT_COUNT');
  if(row.attempt>1&&!ledger.reservations.some(prior=>prior.sourceSha256===row.sourceSha256&&prior.attempt===row.attempt-1
   &&prior.kind==='generation'&&prior.outcome==='receipt_recorded'))throw Error('SOL_RETRY_HISTORY_MISSING');
  if(row.policyRevalidation){
   const prior=ledger.reservations.find(p=>p.sourceSha256===row.sourceSha256&&p.attempt===row.attempt-1&&p.kind==='generation'&&p.outcome==='receipt_recorded');
   const receipt=prior&&parseOpenAiProviderReceipt(prior.receipt);
   if(!receipt||receipt.status!=='completed'||receipt.origin!=='openai_live'||receipt.source_sha256!==row.sourceSha256
    ||receipt.receipt_sha256!==row.policyRevalidation.priorReceiptSha256||receipt.prompt_version!==row.policyRevalidation.fromPromptVersion
    ||receipt.request_sha256===row.requestSha256)throw Error('SOL_POLICY_REVALIDATION_HISTORY');
   if(ledger.reservations.some(other=>other!==row&&other.sourceSha256===row.sourceSha256&&other.policyRevalidation
    &&other.policyRevalidation.priorReceiptSha256===row.policyRevalidation!.priorReceiptSha256
    &&(other.attempt!==row.attempt||canonicalSha256(other.policyRevalidation)!==canonicalSha256(row.policyRevalidation))))throw Error('SOL_POLICY_REVALIDATION_DUPLICATE');
   if(row.kind==='generation'&&!ledger.reservations.some(p=>p.kind==='input_tokens'&&p.sourceSha256===row.sourceSha256&&p.attempt===row.attempt
    &&canonicalSha256(p.policyRevalidation??null)===canonicalSha256(row.policyRevalidation)))throw Error('SOL_POLICY_REVALIDATION_COUNT');
   if(row.outcome==='receipt_recorded'&&parseOpenAiProviderReceipt(row.receipt).prompt_version!==row.policyRevalidation.toPromptVersion)throw Error('SOL_POLICY_REVALIDATION_PROMPT');
  }
 }
 if(ledger.reservations.reduce((sum,row)=>sum+row.reservedMicroUsd,0)>SOL_COMPARISON_POLICY.maxReservedMicroUsd)throw Error('SOL_BUDGET_EXHAUSTED');
 return ledger;
}
export function reserveSolRequest(input:{ledger:SolComparisonLedger;sourceSha256:string;requestSha256:string;codeRevision:string;
 attempt:number;kind:'input_tokens'|'generation';now:string;priorUnknownAcknowledgment?:string;policyRevalidation?:SolPolicyRevalidation}){
 const ledger=parseSolComparisonLedger(input.ledger),now=Date.parse(input.now);
 if(!Number.isFinite(now)||now<Date.parse('2026-09-10T00:00:00Z')||now>=Date.parse(SOL_COMPARISON_POLICY.pricingValidUntil))throw Error('SOL_PRICING_EXPIRED');
 if(ledger.reservations.some(row=>row.outcome==='reserved_unknown'&&(!isKnownRetainedUnknown(row)
  ||input.priorUnknownAcknowledgment!==SOL_RETAINED_DRIVER_FAILURE.diagnosticFileSha256
  ||input.sourceSha256===SOL_RETAINED_DRIVER_FAILURE.sourceSha256)))throw Error('SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW');
 const key=`${input.sourceSha256}:${input.attempt}:${input.kind}`;
 if(ledger.reservations.some(row=>row.key===key))throw Error('SOL_REPLAY_REQUIRES_REVIEW');
 return parseSolComparisonLedger({...ledger,reservations:[...ledger.reservations,{key,sourceSha256:input.sourceSha256,
  requestSha256:input.requestSha256,codeRevision:input.codeRevision,attempt:input.attempt,kind:input.kind,reservedAt:input.now,
  reservedMicroUsd:input.kind==='input_tokens'?SOL_COMPARISON_POLICY.countReservedMicroUsd:SOL_COMPARISON_POLICY.generationReservedMicroUsd,
  outcome:'reserved_unknown',inputTokens:null,receipt:null,
  ...(input.priorUnknownAcknowledgment?{priorUnknownAcknowledgment:input.priorUnknownAcknowledgment}:{}),
  ...(input.policyRevalidation?{policyRevalidation:input.policyRevalidation}:{})}]});
}
function isKnownRetainedUnknown(row:SolComparisonLedger['reservations'][number]){
 return row.outcome==='reserved_unknown'&&row.kind==='generation'&&row.attempt===1
  &&row.sourceSha256===SOL_RETAINED_DRIVER_FAILURE.sourceSha256&&row.requestSha256===SOL_RETAINED_DRIVER_FAILURE.requestSha256
  &&row.codeRevision===SOL_RETAINED_DRIVER_FAILURE.codeRevision;
}
export function recordSolCount(ledger:SolComparisonLedger,requestSha256:string,inputTokens:number){
 const parsed=parseSolComparisonLedger(ledger),pending=parsed.reservations.filter(row=>row.kind==='input_tokens'&&row.outcome==='reserved_unknown'&&row.requestSha256===requestSha256);
 if(pending.length!==1||!Number.isSafeInteger(inputTokens)||inputTokens<1||inputTokens>SOL_COMPARISON_POLICY.inputTokenCeiling)throw Error('SOL_COUNT_OUTSIDE_BOUND');
 pending[0].inputTokens=inputTokens;pending[0].outcome='count_recorded';return parseSolComparisonLedger(parsed);
}
export function recordSolReceipt(ledger:SolComparisonLedger,value:OpenAiProviderReceipt){
 const receipt=parseOpenAiProviderReceipt(value),parsed=parseSolComparisonLedger(ledger);
 const pending=parsed.reservations.filter(row=>row.kind==='generation'&&row.outcome==='reserved_unknown'
  &&row.requestSha256===receipt.request_sha256&&row.sourceSha256===receipt.source_sha256);
 const row=pending[0];
 if(pending.length!==1||!row||receipt.origin!=='openai_live'||!receipt.provider_attempted
  ||receipt.requested_model!==SOL_COMPARISON_POLICY.model||(receipt.actual_model!==null
   &&receipt.actual_model!==SOL_COMPARISON_POLICY.model&&!/^gpt-5\.6-sol-\d{4}-\d{2}-\d{2}$/u.test(receipt.actual_model))
  ||Date.parse(receipt.created_at)<Date.parse(row.reservedAt)
  ||(receipt.token_usage&&(receipt.token_usage.input_tokens>SOL_COMPARISON_POLICY.inputTokenCeiling||receipt.token_usage.output_tokens>SOL_COMPARISON_POLICY.outputTokenCeiling))
  ||(receipt.provider_response_id!==null&&parsed.reservations.some(other=>other.outcome==='receipt_recorded'
   &&(other.receipt as {provider_response_id?:unknown})?.provider_response_id===receipt.provider_response_id)))throw Error('SOL_RECEIPT_OUTSIDE_BOUND');
 row.outcome='receipt_recorded';row.receipt=receipt;row.inputTokens=receipt.token_usage?.input_tokens??null;
 return parseSolComparisonLedger(parsed);
}
export function summarizeSolBudget(ledger:SolComparisonLedger){
 const parsed=parseSolComparisonLedger(ledger);
 return {policy:SOL_COMPARISON_POLICY,contentRequests:parsed.reservations.length,
  generations:parsed.reservations.filter(row=>row.kind==='generation').length,
  countRequests:parsed.reservations.filter(row=>row.kind==='input_tokens').length,
  reservedUpperBoundUsd:parsed.reservations.reduce((sum,row)=>sum+row.reservedMicroUsd,0)/1000000,
  unknownOutcomes:parsed.reservations.filter(row=>row.outcome==='reserved_unknown').length,
  supplierReturnedCost:{status:'not_returned_by_provider',amountUsd:null},
  countEndpointTariff:'not_separately_documented_reserved_at_full_input_price'};
}
/** Count exactly the model-visible request, including PDF/image/schema tokens.
 * No conversation, tool or remote URL is accepted. SDK retries stay zero. */
export type SolCountableRequest=Omit<OpenAiV2ResponsesRequest,'text'>&{text:{format:{type:'json_schema';name:string;
 schema:Record<string,unknown>;strict?:boolean|null;description?:string}}};
export function solInputCountRequest(request:SolCountableRequest){
 if(request.model!==SOL_COMPARISON_POLICY.model||request.reasoning?.effort!=='medium'||request.service_tier!=='default'
  ||request.max_output_tokens!==SOL_COMPARISON_POLICY.outputTokenCeiling||request.store!==false
  ||Object.keys(request).some(key=>!['model','instructions','input','text','max_output_tokens','store','reasoning','service_tier'].includes(key)))throw Error('SOL_REQUEST_PROFILE_INVALID');
 return {requestSha256:canonicalSha256(request),request:{model:request.model,instructions:request.instructions,input:request.input,text:request.text,reasoning:request.reasoning}};
}
