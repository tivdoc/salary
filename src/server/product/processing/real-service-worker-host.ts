import 'server-only';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {z} from 'zod';
import {CANONICAL_POSTGRES_SCHEMA_VERSION,installVerifiedRuntimeContext,assertVerifiedTransactionInput,
 type CanonicalVerifiedRuntimeIdentity} from '@/server/platform/composition/canonical-postgres';
import {CanonicalPostgresTransactionManager,type PostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/transaction-manager';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {realServiceActivationWorkerContextSchema} from './real-service-activation-contract';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {savedCaseTenant} from './saved-admission';
import type {SavedWorkerTransactions} from './saved-worker-contracts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const targetSchema=z.object({schema_version:z.literal('real-service-worker-target-v1'),target_id:z.string().min(1).max(200),
 host:z.string().regex(/^[a-z0-9.-]+$/u),port:z.number().int().min(1).max(65535),database:z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/u),
 login:z.string().regex(/^tivdoc_worker_runtime(?:\.[a-z0-9]+)?$/u),environment:z.enum(['development','preview','production','test']),
 deployment_sha256:hash,machine_issuer_sha256:hash,provider_budget_policy_sha256:hash}).strict();
export type RealServiceWorkerTarget=z.infer<typeof targetSchema>;
type Input={caseId:string;identity:CanonicalVerifiedRuntimeIdentity;buildSha:string;buildManifestSha256:string;planSha256:string;target:RealServiceWorkerTarget};

/** Separate service boundary. The historical disposable root remains unchanged.
 * Provisioning is external: this host neither issues SID/JTI, enrolls a case,
 * creates a plan, renews authority nor reserves spend. Every transaction uses
 * the existing canonical manager and database-authenticated identity installer. */
export async function createRealServiceWorkerHost(candidate:Input,driver:PostgresConnectionFactory):Promise<SavedWorkerTransactions>{
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1')throw Error('REAL_SERVICE_WORKER_DISABLED');
 const caseId=z.uuid().parse(candidate.caseId),target=Object.freeze(targetSchema.parse(candidate.target));
 const buildSha=z.string().regex(/^[a-f0-9]{40}$/u).parse(candidate.buildSha),buildManifest=hash.parse(candidate.buildManifestSha256),planSha=hash.parse(candidate.planSha256);
 if(buildManifest!==getCompiledAiReleaseBuild().manifest.sha256)throw Error('REAL_SERVICE_WORKER_COMPILED_BUILD');
 const identity=Object.freeze({...candidate.identity});
 assertVerifiedTransactionInput({identity,runtime_role:'worker',case_id:caseId,correlation_id:'real-worker:startup'});
 if(identity.tenant_id!==savedCaseTenant(caseId)||identity.reviewer_organization_id!==null)throw Error('REAL_SERVICE_WORKER_SCOPE');
 const manager=new CanonicalPostgresTransactionManager(driver);
 async function validate(context:PostgresTransactionContext){
  if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1')throw Error('REAL_SERVICE_WORKER_DISABLED');
  await context.client.query(statement('runtime_build_context_set',"select pg_catalog.set_config('tivdoc.engine_git_sha', $1, true)",[buildSha]));
  await installVerifiedRuntimeContext(context,{identity,runtime_role:'worker',case_id:caseId,correlation_id:`real-worker:${randomUUID()}`});
  const actual=await context.client.query(statement('real_service_host_actual',
   `select current_database() database,session_user::text principal,private.runtime_verified_tenant() tenant_id,
    (select schema_version from public.engine_schema_metadata where component='canonical_postgresql_composition') schema_version`,[]));
  if(actual.row_count!==1||actual.rows.length!==1||actual.rows[0].database!==target.database||actual.rows[0].principal!=='tivdoc_worker_runtime'
   ||actual.rows[0].tenant_id!==identity.tenant_id||actual.rows[0].schema_version!==CANONICAL_POSTGRES_SCHEMA_VERSION)throw Error('REAL_SERVICE_WORKER_DATABASE');
  const rows=await context.client.query(statement('real_service_activation_worker_context',
   'select private.real_service_activation_worker_context($1::uuid,$2,$3) value',[caseId,planSha,buildManifest]));
  if(rows.row_count!==1||rows.rows.length!==1)throw Error('REAL_SERVICE_WORKER_CONTEXT_ACK');
  const scope=realServiceActivationWorkerContextSchema.parse(rows.rows[0].value);
  if(scope.state!=='authorized')throw Error(`REAL_SERVICE_WORKER_${scope.reason.toUpperCase()}`);
  const p=scope.plan,at=Date.parse(scope.evaluated_at);
  if(scope.case_id!==caseId||p.sha256!==planSha||p.state!=='active'||p.build_manifest_sha256!==buildManifest
   ||p.database_name!==target.database||p.target_id!==target.target_id||p.environment!==target.environment
   ||p.deployment_sha256!==target.deployment_sha256||p.machine_issuer_sha256!==target.machine_issuer_sha256
   ||p.provider_budget_policy_sha256!==target.provider_budget_policy_sha256)throw Error('REAL_SERVICE_WORKER_PLAN_SCOPE');
  if(at<Date.parse(p.issued_at)||at>=Date.parse(p.expires_at)||at>=Date.parse(scope.expires_at)
   ||Date.parse(scope.expires_at)>Date.parse(p.expires_at))throw Error('REAL_SERVICE_WORKER_EXPIRED');
  await context.client.query(statement('saved_host_timeouts',
   "select set_config('statement_timeout','30000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)",[]));
 }
 await manager.transaction(validate);
 return async operation=>{
  let applicationFailure:{error:unknown}|undefined;
  try{return await manager.transaction(async context=>{
   await validate(context);
   try{return await operation(context);}catch(error){applicationFailure={error};throw error;}
  });}catch(error){if(applicationFailure)throw applicationFailure.error;throw error;}
 };
}

/** Private deployment configuration, never HTTP input. Exact URL coordinates,
 * dedicated worker login and CA-verified TLS are mandatory. Secrets remain in
 * the pg Pool; no connection string is exposed in target/health receipts. */
export async function connectRealServiceWorker(input:Input&{connectionUrl:string;certificateAuthority:string}){
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1')throw Error('REAL_SERVICE_WORKER_DISABLED');
 const target=targetSchema.parse(input.target);let url:URL;
 try{url=new URL(input.connectionUrl);}catch{throw Error('REAL_SERVICE_WORKER_CONNECTION');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==target.host||Number(url.port||5432)!==target.port
  ||decodeURIComponent(url.pathname.slice(1))!==target.database||decodeURIComponent(url.username)!==target.login||!url.password
  ||url.hash||[...url.searchParams.keys()].some(k=>k!=='sslmode')
  ||!input.certificateAuthority.includes('-----BEGIN CERTIFICATE-----'))throw Error('REAL_SERVICE_WORKER_CONNECTION');
 if(url.searchParams.has('sslmode')&&!['require','verify-full'].includes(url.searchParams.get('sslmode')!))throw Error('REAL_SERVICE_WORKER_TLS');
 url.search='';
 const pool=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:15000,statement_timeout:30000,
  ssl:{rejectUnauthorized:true,ca:input.certificateAuthority},application_name:'tivdoc-real-service-worker-v1'});
 let active=0,idleConnectionFailures=0,lastIdleConnectionFailureAt:string|null=null;
 // pg emits idle-client network errors on the pool, outside any transaction.
 // Keep the service alive; the failed client is removed by pg-pool. Publish
 // only safe operational metadata, never the error's connection details.
 pool.on('error',()=>{idleConnectionFailures++;lastIdleConnectionFailureAt=new Date().toISOString();});
 const driver:PostgresConnectionFactory={async acquire(){const client=await pool.connect();active++;
  return new NodePostgresManagedClient(client,{query(){},release(){active--;}});
 }};
 try{
  const transactions=await createRealServiceWorkerHost(input,driver);
  return Object.freeze({transactions,target:Object.freeze(target),health:()=>({activeTransactions:active,idleConnectionFailures,lastIdleConnectionFailureAt}),
   async close(){if(active)throw Error('REAL_SERVICE_WORKER_TRANSACTIONS_ACTIVE');await pool.end();}});
 }catch(error){await pool.end();throw error;}
}
