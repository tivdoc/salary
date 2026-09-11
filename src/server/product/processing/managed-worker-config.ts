import 'server-only';
import {z} from 'zod';
import {DEFAULT_OPENAI_EXTRACTION_MODEL} from '@/server/engine/extraction/providers/openai/config';

type Environment=Readonly<Record<string,string|undefined>>;
export const MANAGED_DEV_TARGET=Object.freeze({host:'aws-0-eu-central-1.pooler.supabase.com',port:5432,database:'tivdoc_release_replay_20260907',project_ref:'cpzrbidxftzqcfeqqusu'});
const opaque=z.string().min(32).max(256).regex(/^[A-Za-z0-9._-]+$/u);

/** Preview is a deployed Node production build; VERCEL_ENV, branch and exact
 * database coordinates decide DEV isolation, not NODE_ENV alone. No production
 * deployment, URL fallback, credential printing, or arbitrary database opt-in. */
export function managedWorkerControlConfig(env:Environment){
 if(env.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true')return {enabled:false as const};
 try{
  if(env.VERCEL_ENV==='production'||env.VERCEL_ENV&&env.VERCEL_ENV!=='preview')throw Error();
  if(env.VERCEL_ENV==='preview'&&env.VERCEL_GIT_COMMIT_REF!=='codex/tivdoc-release-completion')throw Error();
  if(!env.VERCEL_ENV&&env.NODE_ENV==='production')throw Error();
  const buildSha=z.string().regex(/^[a-f0-9]{40}$/u).parse(env.VERCEL_GIT_COMMIT_SHA??env.TIVDOC_MANAGED_DEV_BUILD_SHA);
  const capability=opaque.parse(env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY);
  const connection=new URL(env.TIVDOC_WORKER_POSTGRES_URL??'');
  if(!['postgres:','postgresql:'].includes(connection.protocol)||connection.hostname!==MANAGED_DEV_TARGET.host
   ||connection.port!==String(MANAGED_DEV_TARGET.port)||connection.pathname!==`/${MANAGED_DEV_TARGET.database}`
   ||decodeURIComponent(connection.username)!==`tivdoc_worker_runtime.${MANAGED_DEV_TARGET.project_ref}`
   ||!connection.password||connection.hash||connection.search&&connection.search!=='?sslmode=verify-full')throw Error();
  connection.search=''; // Explicit verified CA below owns TLS; pg URL cannot override it.
  const storageUrl=`https://${MANAGED_DEV_TARGET.project_ref}.supabase.co`;
  if(env.NEXT_PUBLIC_SUPABASE_URL!==storageUrl)throw Error();
  return {enabled:true as const,capability,buildSha,connectionUrl:connection.toString(),storageUrl,target:MANAGED_DEV_TARGET};
 }catch{throw Error('MANAGED_DEV_CONFIGURATION_INVALID');}
}

/** Status and authorized retry remain accessible during a provider outage. */
export function managedWorkerConfig(env:Environment){
 const control=managedWorkerControlConfig(env);if(!control.enabled)return control;
 const receiptOnly=env.TIVDOC_MANAGED_EXTRACTION_MODE==='saved_receipts_only';
 if(env.TIVDOC_MANAGED_EXTRACTION_MODE&&!receiptOnly)throw Error('MANAGED_DEV_CONFIGURATION_INVALID');
 if(receiptOnly&&(env.NODE_ENV!=='development'||env.VERCEL||env.VERCEL_ENV))throw Error('MANAGED_DEV_CONFIGURATION_INVALID');
 if(!receiptOnly&&(env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED!=='true'||!env.OPENAI_API_KEY?.trim()))throw Error('MANAGED_DEV_PROVIDER_UNCONFIGURED');
 // Sol must use the separate source/cost-limited package wrapper. Merely
 // configuring a supported SDK model must never enable an unbudgeted worker.
 const model=env.OPENAI_EXTRACTION_MODEL?.trim()||DEFAULT_OPENAI_EXTRACTION_MODEL;
 if(![DEFAULT_OPENAI_EXTRACTION_MODEL,'gpt-4o-mini-2024-07-18','gpt-5.6-sol'].includes(model))throw Error('MANAGED_DEV_CONFIGURATION_INVALID');
 if(!receiptOnly&&model==='gpt-5.6-sol'&&!env.TIVDOC_MANAGED_SOL_PACKAGE_FILE?.trim())throw Error('MANAGED_DEV_SOL_BUDGET_UNCONFIGURED');
 if(!z.coerce.number().int().min(1000).max(120000).safeParse(env.OPENAI_EXTRACTION_TIMEOUT_MS?.trim()||120000).success)throw Error('MANAGED_DEV_CONFIGURATION_INVALID');
 const storageKey=env.SUPABASE_SERVICE_ROLE_KEY?.trim();if(!storageKey)throw Error('MANAGED_DEV_STORAGE_UNCONFIGURED');
 return {...control,storageKey,model,receiptOnly};
}
