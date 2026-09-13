import 'server-only';
import pg from 'pg';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {CanonicalPostgresTransactionManager,type PostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/transaction-manager';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {manageRealServiceMachine,realServiceMachineSelectorSchema,realServiceMachineResponseSchema,realServiceMachineIssuerTargetSchema,
 type RealServiceMachineSelector,type RealServiceMachineIssuerBinding,type RealServiceMachineIssuerTarget} from './real-service-machine-issuer';

/** Read first. Only authenticated natural expiry/not-issued or an explicit
 * successor can reach 207 maintenance; SQL derives a durable predecessor key
 * and delegates issuance to the unchanged 205 guards. Revocation is terminal. */
export async function maintainRealServiceMachine(context:PostgresTransactionContext,candidate:RealServiceMachineSelector,expected:RealServiceMachineIssuerBinding){
 const selector=realServiceMachineSelectorSchema.parse(candidate),prior=await manageRealServiceMachine(context,selector,{action:'read'},expected);
 if(prior.state!=='unavailable'||!['not_issued','expired','scope_changed'].includes(prior.reason))return prior;
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED!=='1')throw Error('REAL_MACHINE_ISSUER_DISABLED');
 const capability=process.env.TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY;
 if(!capability||!/^[A-Za-z0-9._-]{32,256}$/u.test(capability))throw Error('REAL_MACHINE_ISSUER_UNCONFIGURED');
 const rows=await context.client.query(statement('real_service_machine_maintain',
  'select private.real_service_machine_maintain($1,$2::uuid,$3::uuid,$4,$5::uuid) value',
  [capability,selector.case_id,selector.identity_id,selector.plan_sha256,selector.enrollment_id]));
 if(rows.row_count!==1||rows.rows.length!==1)throw Error('REAL_MACHINE_ACK');
 const response=realServiceMachineResponseSchema.parse(rows.rows[0].value);
 if(response.state==='unavailable')return response;
 if(response.state!=='active')throw Error('REAL_MACHINE_STATE_CHANGED');
 for(const pin of ['plan_sha256','issuer_sha256','target_id','database_name','environment','deployment_sha256'] as const)
  if(response[pin]!==expected[pin])throw Error('REAL_MACHINE_ISSUER_BINDING_CHANGED');
 if(response.case_id!==selector.case_id||response.identity_id!==selector.identity_id||response.enrollment_id!==selector.enrollment_id
  ||response.identity.tenant_id!==`saved-case:${selector.case_id}`)throw Error('REAL_MACHINE_CASE_BINDING_CHANGED');
 const at=Date.parse(response.evaluated_at),expires=Date.parse(response.expires_at);
 if(Date.parse(response.valid_after)>at||expires<=at||expires-at>3600000)throw Error('REAL_MACHINE_SESSION_EXPIRED');
 return response;
}

/** One real identity-role pool for ordinary reads and explicitly authorized
 * maintenance. There is no worker/service-role session writer or token mint. */
export async function connectRealServiceMachineMaintenance(input:{target:RealServiceMachineIssuerTarget;connectionUrl:string;certificateAuthority:string}){
 const target=Object.freeze(realServiceMachineIssuerTargetSchema.parse(input.target));let url:URL;
 try{url=new URL(input.connectionUrl);}catch{throw Error('REAL_MACHINE_CONNECTION');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==target.host||Number(url.port||5432)!==target.port
  ||decodeURIComponent(url.pathname.slice(1))!==target.database_name||decodeURIComponent(url.username)!==target.login||!url.password||url.hash
  ||[...url.searchParams.keys()].some(k=>k!=='sslmode')||!input.certificateAuthority.includes('-----BEGIN CERTIFICATE-----'))throw Error('REAL_MACHINE_CONNECTION');
 if(url.searchParams.has('sslmode')&&!['require','verify-full'].includes(url.searchParams.get('sslmode')!))throw Error('REAL_MACHINE_TLS');
 url.search='';const pool=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:15000,statement_timeout:30000,
  ssl:{rejectUnauthorized:true,ca:input.certificateAuthority},application_name:'tivdoc-real-machine-maintenance-v1'});
 let active=0,closed=false,idleConnectionFailures=0;pool.on('error',()=>{idleConnectionFailures++;});
 const driver:PostgresConnectionFactory={async acquire(){if(closed)throw Error('REAL_MACHINE_CONNECTION_CLOSED');const client=await pool.connect();active++;
  return new NodePostgresManagedClient(client,{query(){},release(){active--;}});}};
 const manager=new CanonicalPostgresTransactionManager(driver),expected={plan_sha256:target.plan_sha256,issuer_sha256:target.issuer_sha256,
  target_id:target.target_id,database_name:target.database_name,environment:target.environment,deployment_sha256:target.deployment_sha256};
 return Object.freeze({read:(selector:RealServiceMachineSelector)=>manager.transaction(context=>manageRealServiceMachine(context,selector,{action:'read'},expected)),
  maintain:(selector:RealServiceMachineSelector)=>manager.transaction(context=>maintainRealServiceMachine(context,selector,expected)),
  health:()=>({activeTransactions:active,closed,idleConnectionFailures}),async close(){if(active)throw Error('REAL_MACHINE_TRANSACTIONS_ACTIVE');closed=true;await pool.end();}});
}
