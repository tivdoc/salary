import 'server-only';
import pg from 'pg';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {CANONICAL_POSTGRES_SCHEMA_VERSION} from '@/server/platform/composition/canonical-postgres';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {CanonicalPostgresTransactionManager,type PostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/transaction-manager';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {realServiceCandidateBatchSchema} from './real-service-iteration';
import {realServiceCandidateSchema,realServiceClaimAdmissionSchema,type RealServiceClaimAdmissionPort,type RealServiceClaimRequest} from './real-service-managed-case';
import {enrollCurrentPaidRealServiceSources} from './real-service-purchase-enrollment';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const realServiceControllerTargetSchema=z.object({schema_version:z.literal('real-service-worker-target-v1'),target_id:z.string().min(1).max(200),
 host:z.string().regex(/^[a-z0-9.-]+$/u),port:z.number().int().min(1).max(65535),database:z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/u),
 login:z.string().regex(/^tivdoc_worker_runtime(?:\.[a-z0-9]+)?$/u),environment:z.enum(['development','preview','production','test']),
 deployment_sha256:hash,machine_issuer_sha256:hash,provider_budget_policy_sha256:hash}).strict();
export type RealServiceControllerConfiguration={target:z.infer<typeof realServiceControllerTargetSchema>;planSha256:string;capability:string};
const enabled=()=>process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1';

/** Discovery authenticates the controller capability, never a caller tenant.
 * The SQL returns selectors only; every claim still needs its issued machine. */
export async function readRealServiceCandidates(context:PostgresTransactionContext,input:RealServiceControllerConfiguration&{limit:number}){
 if(!enabled())throw Error('REAL_SERVICE_WORKER_DISABLED');
 const target=realServiceControllerTargetSchema.parse(input.target),plan=hash.parse(input.planSha256),limit=z.number().int().min(1).max(2).parse(input.limit),
  capability=z.string().regex(/^[A-Za-z0-9._-]{32,256}$/u).parse(input.capability),build=getCompiledAiReleaseBuild().manifest.sha256;
 const actual=await context.client.query(statement('real_service_controller_actual',
  `select current_database() database,session_user::text principal,
   (select schema_version from public.engine_schema_metadata where component='canonical_postgresql_composition') schema_version`,[]));
 if(actual.row_count!==1||actual.rows.length!==1||actual.rows[0].database!==target.database||actual.rows[0].principal!=='tivdoc_worker_runtime'
  ||actual.rows[0].schema_version!==CANONICAL_POSTGRES_SCHEMA_VERSION)throw Error('REAL_SERVICE_CONTROLLER_DATABASE');
 const rows=await context.client.query(statement('real_service_controller_candidates',
  'select private.real_service_candidates($1,$2,$3,$4::jsonb,$5::integer) value',[capability,plan,build,JSON.stringify({target_id:target.target_id,
   database_name:target.database,environment:target.environment,deployment_sha256:target.deployment_sha256,
   machine_issuer_sha256:target.machine_issuer_sha256,provider_budget_policy_sha256:target.provider_budget_policy_sha256}),limit]));
 if(rows.row_count!==1||rows.rows.length!==1)throw Error('REAL_SERVICE_CONTROLLER_ACK');
 const batch=realServiceCandidateBatchSchema.parse(rows.rows[0].value);
 if(batch.candidates.length>limit||new Set(batch.candidates.map(c=>c.case_id)).size!==batch.candidates.length
  ||Date.parse(batch.evaluated_at)>=Date.parse(batch.expires_at)||Date.now()>=Date.parse(batch.expires_at)
  ||batch.candidates.some(c=>c.plan_sha256!==plan||Date.parse(c.expires_at)>Date.parse(batch.expires_at)||Date.parse(c.expires_at)<=Date.parse(batch.evaluated_at)))throw Error('REAL_SERVICE_CONTROLLER_SCOPE');
 return deepFreeze(batch);
}

/** Both modes use the supplied existing queue-claim transaction. Stored207
 * artifact bytes independently authorize mode and escrow; a runtime mode string
 * never authorizes spend. Actual provider requests additionally require208. */
async function admitRealServiceClaim(context:PostgresTransactionContext,input:RealServiceClaimRequest,mode:'saved_receipts_only'|'budgeted_provider'){
 if(!enabled())throw Error('REAL_SERVICE_WORKER_DISABLED');
 if(input.extraction_mode!==mode)throw Error(mode==='saved_receipts_only'?'REAL_SERVICE_PROVIDER_TRANSPORT_UNAVAILABLE':'REAL_SERVICE_BUDGET_MODE');
 if(mode==='budgeted_provider'&&process.env.TIVDOC_REAL_AI_PROVIDER_ENABLED!=='1')throw Error('REAL_SERVICE_PROVIDER_DISABLED');
 const candidate=realServiceCandidateSchema.parse(input.candidate),policy=hash.parse(input.providerBudgetPolicySha256);
 if(input.job.case_id!==candidate.case_id||input.job.revision!==candidate.source_revision||input.job.input_sha256!==candidate.source_sha256
  ||input.job.authority_dependency_sha256!==candidate.authority_dependency_sha256||input.job.processing_profile!=='qualified_ai_v1'||input.job.mode!=='draft')throw Error('REAL_SERVICE_RUN_SCOPE');
 const job=z.string().min(3).max(160).parse(input.jobId),worker=z.string().min(3).max(160).parse(input.workerId),fence=z.number().int().positive().parse(input.fencingToken);
 const rows=await context.client.query(statement('real_service_claim_admit',
  'select private.real_service_claim_admit($1::jsonb,$2,$3::bigint,$4,$5,$6,$7) value',
  [JSON.stringify(candidate),job,fence,worker,policy,input.extraction_mode,getCompiledAiReleaseBuild().manifest.sha256]));
 if(rows.row_count!==1||rows.rows.length!==1)throw Error('REAL_SERVICE_RUN_CLAIM_ADMISSION');
 const admission=realServiceClaimAdmissionSchema.parse(rows.rows[0].value);
 if(admission.case_id!==candidate.case_id||admission.job_id!==job||admission.fencing_token!==fence||admission.source_sha256!==candidate.source_sha256
  ||admission.authority_dependency_sha256!==candidate.authority_dependency_sha256||admission.plan_sha256!==candidate.plan_sha256
  ||admission.provider_budget_policy_sha256!==policy||admission.extraction_mode!==input.extraction_mode
  ||Date.parse(admission.expires_at)>Date.parse(candidate.expires_at)||Date.now()>=Date.parse(admission.expires_at))throw Error('REAL_SERVICE_RUN_CLAIM_ADMISSION');
 return deepFreeze(admission);
}
/** Existing zero-spend path deliberately continues rejecting provider mode. */
export const admitRealServiceSavedReceiptsClaim:RealServiceClaimAdmissionPort=(context,input)=>admitRealServiceClaim(context,input,'saved_receipts_only');
/** Runtime must pair this with createRealServiceBudgetedExtraction on the
 * verified per-case host. No SDK is created and no request is sent by admission. */
export const admitRealServiceBudgetedProviderClaim:RealServiceClaimAdmissionPort=(context,input)=>admitRealServiceClaim(context,input,'budgeted_provider');

/** Dedicated worker LOGIN, exact configured coordinates and CA-verified TLS.
 * Neither the controller nor its connection factory installs a machine SID. */
export async function connectRealServiceController(input:RealServiceControllerConfiguration&{connectionUrl:string;certificateAuthority:string}){
 if(!enabled())throw Error('REAL_SERVICE_WORKER_DISABLED');
 const config=deepFreeze({target:realServiceControllerTargetSchema.parse(input.target),planSha256:hash.parse(input.planSha256),
  capability:z.string().regex(/^[A-Za-z0-9._-]{32,256}$/u).parse(input.capability)});let url:URL;
 try{url=new URL(input.connectionUrl);}catch{throw Error('REAL_SERVICE_CONTROLLER_CONNECTION');}
 const target=config.target;
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==target.host||Number(url.port||5432)!==target.port
  ||decodeURIComponent(url.pathname.slice(1))!==target.database||decodeURIComponent(url.username)!==target.login||!url.password||url.hash
  ||[...url.searchParams.keys()].some(k=>k!=='sslmode')||!input.certificateAuthority.includes('-----BEGIN CERTIFICATE-----'))throw Error('REAL_SERVICE_CONTROLLER_CONNECTION');
 if(url.searchParams.has('sslmode')&&!['require','verify-full'].includes(url.searchParams.get('sslmode')!))throw Error('REAL_SERVICE_CONTROLLER_TLS');
 url.search='';
 const pool=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:15000,statement_timeout:30000,
  ssl:{rejectUnauthorized:true,ca:input.certificateAuthority},application_name:'tivdoc-real-service-controller-v1'});
 let active=0,closed=false,idleConnectionFailures=0;pool.on('error',()=>{idleConnectionFailures++;});
 const driver:PostgresConnectionFactory={async acquire(){if(closed)throw Error('REAL_SERVICE_CONTROLLER_CLOSED');const client=await pool.connect();active++;
  return new NodePostgresManagedClient(client,{query(){},release(){active--;}});}};
 const manager=new CanonicalPostgresTransactionManager(driver);
 return Object.freeze({enrollPaidSources:()=>manager.transaction(context=>enrollCurrentPaidRealServiceSources(context,{target,planSha256:config.planSha256,limit:2})),
  candidates:(request:{target:typeof target;planSha256:string;buildManifestSha256:string;limit:number})=>{
  if(canonicalSha256(request.target)!==canonicalSha256(target)||request.planSha256!==config.planSha256
   ||request.buildManifestSha256!==getCompiledAiReleaseBuild().manifest.sha256)throw Error('REAL_SERVICE_CONTROLLER_SCOPE');
  return manager.transaction(context=>readRealServiceCandidates(context,{...config,limit:request.limit}));
 },health:()=>({activeTransactions:active,closed,idleConnectionFailures}),async close(){if(active)throw Error('REAL_SERVICE_CONTROLLER_TRANSACTIONS_ACTIVE');closed=true;await pool.end();}});
}
