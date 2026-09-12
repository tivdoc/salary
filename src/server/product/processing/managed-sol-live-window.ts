import 'server-only';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {parseOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {managedWorkerControlConfig} from './managed-worker-config';
import {parseSolComparisonLedger,solPolicyRevalidationSchema,SOL_COMPARISON_POLICY,type SolComparisonLedger} from './live-extraction-sol-comparison-budget';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const MANAGED_SOL_LIVE_WINDOW_VERSION='sol-managed-live-window-v2' as const;
export const managedSolLiveWindowSchema=z.object({version:z.literal(MANAGED_SOL_LIVE_WINDOW_VERSION),enabled:z.literal(true),
 authorizationId:z.uuid(),authorizedAt:z.iso.datetime({offset:true}),expiresAt:z.iso.datetime({offset:true}),buildSha:z.string().regex(/^[a-f0-9]{40}$/u),
 capabilitySha256:sha,ledgerPath:z.string().min(1),artifactDirectory:z.string().min(1),
 baseline:z.object({fileSha256:sha,reservationsSha256:sha,contentRequests:z.number().int().min(0).max(10),
  reservedMicroUsd:z.number().int().min(0).max(SOL_COMPARISON_POLICY.maxReservedMicroUsd),
  acknowledgedUnknownReceiptSha256s:z.array(sha).max(6)}).strict(),
 source:z.object({caseId:z.uuid(),versionId:z.uuid(),sha256:sha,sizeBytes:z.number().int().positive().max(1024*1024),
  mimeType:z.enum(['application/pdf','image/png','image/jpeg'])}).strict(),
 maxContentRequests:z.literal(2),maxGenerations:z.literal(1),maxReservedMicroUsd:z.literal(712000),
 recovery:z.literal('disabled'),retry:z.literal('disabled'),policyRevalidation:solPolicyRevalidationSchema,
}).strict();
export type ManagedSolLiveWindow=z.infer<typeof managedSolLiveWindowSchema>;
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function fail():never{throw Error('SOL_LIVE_WINDOW_INVALID');}
function inside(root:string,file:string){const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
function resolved(value:string){let parent=path.resolve(value);while(!existsSync(parent)){const next=path.dirname(parent);if(next===parent)fail();parent=next;}
 return path.resolve(realpathSync(parent),path.relative(parent,path.resolve(value)));}
function confined(value:string,roots:string[]){if(!path.isAbsolute(value))fail();const file=resolved(value);if(!roots.some(root=>inside(resolved(root),file)))fail();return file;}

/** An operator-owned local file grants bounded spending only. The ordinary
 * managed case/claim and verified-upload gates still establish QA, purchase,
 * current journal and source ownership. No customer JSON can grant those. */
export function readManagedSolLiveWindow(environment:Readonly<Record<string,string|undefined>>,buildSha:string){
 if(environment.NODE_ENV!=='development'||environment.VERCEL||environment.VERCEL_ENV||process.env.NODE_ENV!=='development'
  ||process.env.VERCEL||process.env.VERCEL_ENV||environment.TIVDOC_MANAGED_EXTRACTION_MODE
  ||environment.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED!=='true'||environment.OPENAI_EXTRACTION_MODEL!=='gpt-5.6-sol')fail();
 const control=managedWorkerControlConfig({...environment,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha});if(!control.enabled)fail();
 const privateRoot=path.resolve('../release-work'),outputRoot=path.resolve('output/release-completion');
 const file=confined(environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE??'',[privateRoot]),bytes=readFileSync(file);
 const config=managedSolLiveWindowSchema.parse(JSON.parse(bytes.toString('utf8'))),packageSha256=hash(bytes);
 if(config.buildSha!==buildSha||control.buildSha!==buildSha||config.capabilitySha256!==hash(control.capability))fail();
 const ledgerPath=confined(config.ledgerPath,[privateRoot,outputRoot]),artifactDirectory=confined(config.artifactDirectory,[privateRoot,outputRoot]);
 // The fixed live package remains independent of the receipt-only lifecycle.
 // Resolving junctions also prevents redirecting its ledger after validation.
 const assertActive=()=>{
  const now=Date.now(),start=Date.parse(config.authorizedAt),end=Date.parse(config.expiresAt);
  if(start>now||end<=now||end<=start||end-start>4*3600000||hash(readFileSync(file))!==packageSha256
   ||resolved(config.ledgerPath)!==ledgerPath||resolved(config.artifactDirectory)!==artifactDirectory)throw Error('SOL_LIVE_WINDOW_CHANGED_OR_EXPIRED');
 };
 assertActive();
 return {config:{...config,ledgerPath,artifactDirectory},packageSha256,assertActive};
}

/** Check the original prefix on every admission/restart. A count left pending
 * is a hold, never permission to repeat content. Failed recorded generations
 * retain their full reserve and require explicit unknown-cost acknowledgement. */
export function assertManagedSolLiveLedger(config:ManagedSolLiveWindow,ledger:SolComparisonLedger,bytes?:Uint8Array){
 const parsed=parseSolComparisonLedger(ledger),prefix=parsed.reservations.slice(0,config.baseline.contentRequests);
 if(prefix.length!==config.baseline.contentRequests||canonicalSha256(prefix)!==config.baseline.reservationsSha256
  ||prefix.reduce((sum,row)=>sum+row.reservedMicroUsd,0)!==config.baseline.reservedMicroUsd
  ||parsed.reservations.length>config.baseline.contentRequests+2
  ||(bytes&&parsed.reservations.length===prefix.length&&hash(bytes)!==config.baseline.fileSha256))throw Error('SOL_LIVE_WINDOW_LEDGER_BASELINE');
 const unknown:string[]=[];
 for(const row of prefix){
  if(row.outcome==='reserved_unknown')throw Error('SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW');
  if(row.kind==='generation'){
   const receipt=parseOpenAiProviderReceipt(row.receipt);
   if(receipt.origin!=='openai_live'||!receipt.provider_attempted||receipt.source_sha256!==row.sourceSha256||receipt.request_sha256!==row.requestSha256)throw Error('SOL_LIVE_WINDOW_LEDGER_RECEIPT');
   if(receipt.status==='failed'&&receipt.provider_response_id===null&&receipt.token_usage===null)unknown.push(receipt.receipt_sha256);
  }
 }
 if(canonicalSha256([...unknown].sort())!==canonicalSha256([...config.baseline.acknowledgedUnknownReceiptSha256s].sort()))throw Error('SOL_LIVE_WINDOW_UNKNOWN_COST_ACKNOWLEDGEMENT');
 const prior=prefix.filter(row=>row.sourceSha256===config.source.sha256&&row.kind==='generation').at(-1);
 if(!prior||prior.outcome!=='receipt_recorded'||parseOpenAiProviderReceipt(prior.receipt).receipt_sha256!==config.policyRevalidation.priorReceiptSha256)throw Error('SOL_POLICY_REVALIDATION_HISTORY');
 const appended=parsed.reservations.slice(prefix.length);
 if(appended.some(row=>row.sourceSha256!==config.source.sha256||row.attempt!==prior.attempt+1||row.codeRevision!==config.buildSha
  ||canonicalSha256(row.policyRevalidation??null)!==canonicalSha256(config.policyRevalidation))
  ||appended.reduce((sum,row)=>sum+row.reservedMicroUsd,0)>config.maxReservedMicroUsd)throw Error('SOL_LIVE_WINDOW_LEDGER_APPEND');
 for(const row of appended){if(row.kind==='generation'&&row.outcome==='receipt_recorded'){
  const receipt=parseOpenAiProviderReceipt(row.receipt);
  if(receipt.origin!=='openai_live'||!receipt.provider_attempted||receipt.case_id!==config.source.caseId||receipt.document_id!==config.source.versionId
   ||receipt.source_sha256!==config.source.sha256||receipt.source_size_bytes!==config.source.sizeBytes||receipt.source_mime_type!==config.source.mimeType
   ||receipt.source_page_count!==1||receipt.request_sha256!==row.requestSha256||receipt.requested_model!==SOL_COMPARISON_POLICY.model
   ||receipt.pass_kind!=='first_pass'||Date.parse(receipt.created_at)<Date.parse(config.authorizedAt))throw Error('SOL_LIVE_WINDOW_CURRENT_RECEIPT');
 }}
}

/** The lifecycle must retain its previous snapshot between commands as well.
 * Baseline validation alone cannot detect rollback of already appended rows. */
export function assertManagedSolLiveLedgerTransition(config:ManagedSolLiveWindow,before:SolComparisonLedger,after:SolComparisonLedger){
 assertManagedSolLiveLedger(config,before);assertManagedSolLiveLedger(config,after);
 if(after.reservations.length<before.reservations.length)throw Error('SOL_LIVE_WINDOW_LEDGER_ROLLBACK');
 before.reservations.forEach((prior,index)=>{
  const next=after.reservations[index];
  if(prior.outcome!=='reserved_unknown'){
   if(canonicalSha256(prior)!==canonicalSha256(next))throw Error('SOL_LIVE_WINDOW_LEDGER_REWRITE');
  }else{
   const {outcome:priorOutcome,inputTokens:priorTokens,receipt:priorReceipt,...priorIdentity}=prior;
   const {outcome:nextOutcome,inputTokens:nextTokens,receipt:nextReceipt,...nextIdentity}=next;
   void priorOutcome;void priorTokens;void priorReceipt;void nextOutcome;void nextTokens;void nextReceipt;
   if(canonicalSha256(priorIdentity)!==canonicalSha256(nextIdentity))throw Error('SOL_LIVE_WINDOW_LEDGER_REWRITE');
  }
 });
}
