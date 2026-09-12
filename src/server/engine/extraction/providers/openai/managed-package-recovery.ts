import 'server-only';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {ExtractionRequest} from '@/engine/extraction/contracts';
import {readManagedSolLiveWindow} from '@/server/product/processing/managed-sol-live-window';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const source=z.object({sha256:sha,sizeBytes:z.number().int().positive().max(1024*1024),mimeType:z.enum(['application/pdf','image/png','image/jpeg'])}).strict();
const packet=z.object({version:z.literal('sol-scheduled-dev-package-20260911-v1'),enabled:z.literal(true),
 buildSha:z.string().regex(/^[a-f0-9]{40}$/u),expiresAt:z.iso.datetime({offset:true}),ledgerPath:z.string(),artifactDirectory:z.string(),
 allowedCaseIds:z.array(z.uuid()).min(1).max(4),allowedSources:z.array(source).min(1).max(4)}).strict();
export type ManagedOpenAiRecoveryAuthority=Readonly<{kind:'managed-openai-package-recovery-v1'}>;
type Grant={apiKeySha256:string;packagePath:string;packageSha256:string;packet:Pick<z.infer<typeof packet>,'expiresAt'|'allowedCaseIds'|'allowedSources'>;
 liveWindow?:ReturnType<typeof readManagedSolLiveWindow>};
const grants=new WeakMap<ManagedOpenAiRecoveryAuthority,Grant>();
function fail():never{throw new TypeError('OPENAI_MANAGED_RECOVERY_AUTHORITY');}
function local(environment:Readonly<Record<string,string|undefined>>){
 if(environment.NODE_ENV!=='development'||environment.VERCEL||environment.VERCEL_ENV)fail();
}
function current(grant:Grant){
 local(process.env);
 grant.liveWindow?.assertActive();
 if(Date.now()>=Date.parse(grant.packet.expiresAt)||hash(readFileSync(grant.packagePath))!==grant.packageSha256)fail();
}

/** Separate server-only authority for one already validated private managed
 * package. The opaque in-process object cannot be reconstructed from JSON.
 * This grants only recovery suppression, never a source/case/payment grant. */
export function authorizeManagedOpenAiRecovery(input:{apiKey:string;buildSha:string;packageSha256:string;environment:Readonly<Record<string,string|undefined>>}):ManagedOpenAiRecoveryAuthority{
 local(input.environment);local(process.env);
 const expected=path.resolve('../release-work/sol-scheduled-package-20260911.private.json');
 if(input.environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE&&path.resolve(input.environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE)!==expected){
  const liveWindow=readManagedSolLiveWindow(input.environment,input.buildSha),config=liveWindow.config;
  if(!input.apiKey||input.environment.OPENAI_API_KEY!==input.apiKey||liveWindow.packageSha256!==sha.parse(input.packageSha256))fail();
  const authority=Object.freeze({kind:'managed-openai-package-recovery-v1' as const});
  grants.set(authority,{apiKeySha256:hash(input.apiKey),packagePath:path.resolve(input.environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE),
   packageSha256:input.packageSha256,liveWindow,packet:{expiresAt:config.expiresAt,
    allowedCaseIds:[config.source.caseId],allowedSources:[{sha256:config.source.sha256,sizeBytes:config.source.sizeBytes,mimeType:config.source.mimeType}]}});
  return authority;
 }
 if(!input.environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE||path.resolve(input.environment.TIVDOC_MANAGED_SOL_PACKAGE_FILE)!==expected
  ||input.environment.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true'||input.environment.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED!=='true'
  ||input.environment.OPENAI_EXTRACTION_MODEL!=='gpt-5.6-sol'||!input.apiKey||input.environment.OPENAI_API_KEY!==input.apiKey
  ||!/^[A-Za-z0-9._-]{32,256}$/u.test(input.environment.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY??''))fail();
 const bytes=readFileSync(expected);if(hash(bytes)!==sha.parse(input.packageSha256))fail();
 const config=packet.parse(JSON.parse(bytes.toString('utf8')));
 if(config.buildSha!==input.buildSha||Date.parse(config.expiresAt)<=Date.now()||Date.parse(config.expiresAt)>Date.parse('2026-09-11T04:19:48Z')
  ||path.resolve(config.ledgerPath)!==path.resolve('output/release-completion/sol-scheduled-20260911/package-budget-ledger.json')
  ||path.resolve(config.artifactDirectory)!==path.resolve('output/release-completion/sol-scheduled-20260911/provider'))fail();
 const authority=Object.freeze({kind:'managed-openai-package-recovery-v1' as const});
 grants.set(authority,{apiKeySha256:hash(input.apiKey),packagePath:expected,packageSha256:input.packageSha256,packet:config});
 return authority;
}

export function assertManagedOpenAiRecovery(authority:ManagedOpenAiRecoveryAuthority|undefined,apiKey:string|null,request?:ExtractionRequest){
 const grant=authority&&grants.get(authority);if(!grant||!apiKey||hash(apiKey)!==grant.apiKeySha256)fail();
 current(grant);
 if(request){
  const document=request.document;
  if(grant.liveWindow&&(document.document_id!==grant.liveWindow.config.source.versionId||document.document_type!=='payslip'||request.declared_document_type!=='payslip'))fail();
  if(request.case_id!==document.case_id||!grant.packet.allowedCaseIds.includes(request.case_id)
   ||!grant.packet.allowedSources.some(item=>item.sha256===document.content_sha256&&item.sizeBytes===document.size_bytes&&item.mimeType===document.mime_type))fail();
 }
}
