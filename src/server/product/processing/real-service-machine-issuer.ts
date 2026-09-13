import 'server-only';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {z} from 'zod';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {CanonicalPostgresTransactionManager,type PostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/transaction-manager';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u);
export const realServiceMachineSelectorSchema=z.object({case_id:z.uuid(),identity_id:z.uuid(),plan_sha256:hash,enrollment_id:z.uuid()}).strict();
export type RealServiceMachineSelector=z.infer<typeof realServiceMachineSelectorSchema>;
export const realServiceMachineOperationSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('read')}).strict(),
 z.object({action:z.literal('issue'),request_id:z.uuid()}).strict(),
 z.object({action:z.literal('rotate'),request_id:z.uuid(),session_id:opaque,expected_rotation:z.number().int().nonnegative()}).strict(),
 z.object({action:z.literal('revoke'),request_id:z.uuid(),session_id:opaque,expected_rotation:z.number().int().nonnegative()}).strict(),
]);
export type RealServiceMachineOperation=z.infer<typeof realServiceMachineOperationSchema>;
const bindingSchema=z.object({plan_sha256:hash,issuer_sha256:hash,target_id:z.string().min(1).max(200),database_name:z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/u),
 environment:z.enum(['development','preview','production','test']),deployment_sha256:hash}).strict();
export type RealServiceMachineIssuerBinding=z.infer<typeof bindingSchema>;
export const realServiceMachineIssuerTargetSchema=bindingSchema.extend({schema_version:z.literal('real-service-machine-issuer-target-v1'),
 host:z.string().regex(/^[a-z0-9.-]+$/u),port:z.number().int().min(1).max(65535),login:z.string().regex(/^tivdoc_identity_runtime(?:\.[a-z0-9]+)?$/u)}).strict();
export type RealServiceMachineIssuerTarget=z.infer<typeof realServiceMachineIssuerTargetSchema>;
export const REAL_SERVICE_MACHINE_REFUSALS=['not_enrolled','not_issued','already_issued','revoked','expired','scope_changed','superseded'] as const;
const identitySchema=z.object({session_id:opaque,token_id:opaque,tenant_id:opaque,actor_id:z.uuid(),reviewer_organization_id:z.null(),rotation_counter:z.number().int().nonnegative()}).strict();
const issuedSchema=bindingSchema.extend({case_id:z.uuid(),identity_id:z.uuid(),enrollment_id:z.uuid(),request_id:z.uuid(),provenance_sha256:hash,
 replayed:z.boolean(),evaluated_at:time,valid_after:time,expires_at:time,identity:identitySchema}).strict();
export const realServiceMachineResponseSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unavailable'),reason:z.enum(REAL_SERVICE_MACHINE_REFUSALS)}).strict(),
 issuedSchema.extend({state:z.literal('active')}).strict(),issuedSchema.extend({state:z.literal('revoked')}).strict(),
]);

/** The caller supplies identifiers and CAS only. Credentials and expected
 * deployment pins are private server configuration, never a public route body.
 * SQL authenticates the actual identity LOGIN plus separately registered issuer
 * capability, derives the tenant, and calls the existing durable session RPCs.
 * Returned machine identities are credentials: never log or publish this value. */
export async function manageRealServiceMachine(context:PostgresTransactionContext,candidate:RealServiceMachineSelector,
 requested:RealServiceMachineOperation,expectedCandidate:RealServiceMachineIssuerBinding){
 const selector=realServiceMachineSelectorSchema.parse(candidate),operation=realServiceMachineOperationSchema.parse(requested),expected=bindingSchema.parse(expectedCandidate);
 if(operation.action!=='revoke'&&(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED!=='1'))throw Error('REAL_MACHINE_ISSUER_DISABLED');
 const capability=process.env.TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY;
 if(!capability||!/^[A-Za-z0-9._-]{32,256}$/u.test(capability))throw Error('REAL_MACHINE_ISSUER_UNCONFIGURED');
 if(selector.plan_sha256!==expected.plan_sha256)throw Error('REAL_MACHINE_PLAN_SCOPE');
 const principal=await context.client.query(statement('real_machine_issuer_principal','select current_database() database,session_user::text principal',[]));
 if(principal.row_count!==1||principal.rows.length!==1||principal.rows[0].database!==expected.database_name||principal.rows[0].principal!=='tivdoc_identity_runtime')throw Error('REAL_MACHINE_IDENTITY_PRINCIPAL');
 const requestId=operation.action==='read'?randomUUID():operation.request_id;
 const result=await context.client.query(statement('real_service_machine_manage',
  'select private.real_service_machine_manage($1,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9::bigint) value',
  [capability,selector.case_id,selector.identity_id,selector.plan_sha256,selector.enrollment_id,requestId,operation.action,
   'session_id' in operation?operation.session_id:null,'expected_rotation' in operation?operation.expected_rotation:null]));
 if(result.row_count!==1||result.rows.length!==1)throw Error('REAL_MACHINE_ACK');
 const row=realServiceMachineResponseSchema.parse(result.rows[0].value);
 if(row.state==='unavailable')return row;
 for(const pin of ['plan_sha256','issuer_sha256','target_id','database_name','environment','deployment_sha256'] as const)
  if(row[pin]!==expected[pin])throw Error('REAL_MACHINE_ISSUER_BINDING_CHANGED');
 if(row.case_id!==selector.case_id||row.identity_id!==selector.identity_id||row.enrollment_id!==selector.enrollment_id
  ||row.identity.tenant_id!==`saved-case:${selector.case_id}`)throw Error('REAL_MACHINE_CASE_BINDING_CHANGED');
 if(operation.action!=='read'&&row.request_id!==requestId)throw Error('REAL_MACHINE_REQUEST_CHANGED');
 if((operation.action==='revoke')!==(row.state==='revoked'))throw Error('REAL_MACHINE_STATE_CHANGED');
 if(operation.action==='issue'&&row.identity.rotation_counter!==0
  ||operation.action==='rotate'&&(row.identity.session_id!==operation.session_id||row.identity.rotation_counter!==operation.expected_rotation+1)
  ||operation.action==='revoke'&&(row.identity.session_id!==operation.session_id||row.identity.rotation_counter!==operation.expected_rotation))throw Error('REAL_MACHINE_ROTATION_CHANGED');
 const evaluated=Date.parse(row.evaluated_at),expires=Date.parse(row.expires_at);
 if(row.state==='active'&&(Date.parse(row.valid_after)>evaluated||expires<=evaluated||expires-evaluated>3600000))throw Error('REAL_MACHINE_SESSION_EXPIRED');
 return row;
}

/** Exact private deployment coordinates and CA-verified TLS. This connector
 * does not provision credentials or install a caller-chosen tenant. Each manage
 * operation gets one transaction; only SQL may derive tenant for registration. */
export async function connectRealServiceMachineIssuer(input:{target:RealServiceMachineIssuerTarget;connectionUrl:string;certificateAuthority:string}){
 const target=Object.freeze(realServiceMachineIssuerTargetSchema.parse(input.target));let url:URL;
 try{url=new URL(input.connectionUrl);}catch{throw Error('REAL_MACHINE_CONNECTION');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==target.host||Number(url.port||5432)!==target.port
  ||decodeURIComponent(url.pathname.slice(1))!==target.database_name||decodeURIComponent(url.username)!==target.login||!url.password||url.hash
  ||[...url.searchParams.keys()].some(k=>k!=='sslmode')||!input.certificateAuthority.includes('-----BEGIN CERTIFICATE-----'))throw Error('REAL_MACHINE_CONNECTION');
 if(url.searchParams.has('sslmode')&&!['require','verify-full'].includes(url.searchParams.get('sslmode')!))throw Error('REAL_MACHINE_TLS');
 url.search='';
 const pool=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:15000,statement_timeout:30000,
  ssl:{rejectUnauthorized:true,ca:input.certificateAuthority},application_name:'tivdoc-real-machine-issuer-v1'});
 let active=0,closed=false,idleConnectionFailures=0;
 pool.on('error',()=>{idleConnectionFailures++;});
 const driver:PostgresConnectionFactory={async acquire(){if(closed)throw Error('REAL_MACHINE_CONNECTION_CLOSED');const client=await pool.connect();active++;
  return new NodePostgresManagedClient(client,{query(){},release(){active--;}});
 }};
 const manager=new CanonicalPostgresTransactionManager(driver);
 const expected=bindingSchema.parse({plan_sha256:target.plan_sha256,issuer_sha256:target.issuer_sha256,target_id:target.target_id,database_name:target.database_name,
  environment:target.environment,deployment_sha256:target.deployment_sha256});
 return Object.freeze({
  manage:(selector:RealServiceMachineSelector,operation:RealServiceMachineOperation)=>manager.transaction(context=>manageRealServiceMachine(context,selector,operation,expected)),
  health:()=>({activeTransactions:active,idleConnectionFailures,closed}),
  async close(){if(active)throw Error('REAL_MACHINE_TRANSACTIONS_ACTIVE');closed=true;await pool.end();},
 });
}
