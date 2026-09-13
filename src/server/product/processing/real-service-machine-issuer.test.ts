import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {manageRealServiceMachine,connectRealServiceMachineIssuer,REAL_SERVICE_MACHINE_REFUSALS,type RealServiceMachineOperation} from './real-service-machine-issuer';
vi.mock('server-only',()=>({}));
const pool=vi.hoisted(()=>({created:0,closed:0,released:0,queries:[] as string[],response:undefined as unknown,fail:'',options:{} as Record<string,unknown>,onError:()=>{}}));
vi.mock('pg',()=>({default:{Pool:class{
 constructor(options:Record<string,unknown>){pool.created++;pool.options=options;}
 on(_event:string,handler:()=>void){pool.onError=handler;}
 async connect(){return {async query(q:{name:string}){pool.queries.push(q.name);if(pool.fail===q.name)throw Error('synthetic-connection-loss');
  const rows=q.name==='real_machine_issuer_principal'?[{database:'synthetic_database',principal:'tivdoc_identity_runtime'}]:q.name==='real_service_machine_manage'?[{value:pool.response}]:[];
  return {rows,rowCount:rows.length};},release(){pool.released++;}};}
 async end(){pool.closed++;}
}}}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(c:string)=>c.repeat(64);
function fixture(){
 const selector={case_id:id(1),identity_id:id(2),plan_sha256:sha('a'),enrollment_id:id(3)};
 const expected={plan_sha256:selector.plan_sha256,issuer_sha256:sha('b'),target_id:'synthetic-target',database_name:'synthetic_database',environment:'test' as const,deployment_sha256:sha('c')};
 const row={...selector,...expected,state:'active',request_id:id(4),provenance_sha256:sha('d'),replayed:false,
  evaluated_at:'2026-09-13T05:00:00Z',valid_after:'2026-09-13T05:00:00Z',expires_at:'2026-09-13T05:30:00Z',
  identity:{session_id:'synthetic-session-1',token_id:'synthetic-token-1',tenant_id:`saved-case:${selector.case_id}`,actor_id:id(5),reviewer_organization_id:null,rotation_counter:0}};
 const target={...expected,schema_version:'real-service-machine-issuer-target-v1' as const,host:'db.example.test',port:5432,login:'tivdoc_identity_runtime'};
 const connection={target,connectionUrl:'postgresql://tivdoc_identity_runtime:synthetic-secret@db.example.test:5432/synthetic_database?sslmode=verify-full',certificateAuthority:'-----BEGIN CERTIFICATE-----synthetic'};
 return {selector,expected,row,connection};
}
function context(value:unknown,principal='tivdoc_identity_runtime',database='synthetic_database'):PostgresTransactionContext{
 return {transaction_id:'synthetic-no-db',client:{query:vi.fn(async q=>({row_count:1,rows:q.name==='real_machine_issuer_principal'?[{principal,database}]:[{value}]}))}};
}
beforeEach(()=>{
 vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY','synthetic-issuer-capability-0000000000');
 pool.created=0;pool.closed=0;pool.released=0;pool.queries=[];pool.fail='';pool.response=undefined;
});
afterEach(()=>vi.unstubAllEnvs());
it('issues through the identity principal with selectors only and binds the resulting tenant',async()=>{
 const f=fixture(),db=context(f.row);
 expect(await manageRealServiceMachine(db,f.selector,{action:'issue',request_id:id(4)},f.expected)).toEqual(f.row);
 const q=vi.mocked(db.client.query).mock.calls[1][0];
 expect(q.name).toBe('real_service_machine_manage');expect(q.values.slice(1)).toEqual([id(1),id(2),sha('a'),id(3),id(4),'issue',null,null]);
 expect(q.values.some(v=>typeof v==='object'&&v!==null)).toBe(false);
});
it('accepts an exact issuance replay and reads a current session without a new issuance request',async()=>{
 const f=fixture();f.row.replayed=true;
 expect((await manageRealServiceMachine(context(f.row),f.selector,{action:'issue',request_id:id(4)},f.expected)).state).toBe('active');
 expect((await manageRealServiceMachine(context(f.row),f.selector,{action:'read'},f.expected)).state).toBe('active');
});
it('checks rotation SID, counter and immutable request id',async()=>{
 const f=fixture(),op:RealServiceMachineOperation={action:'rotate',request_id:id(6),session_id:f.row.identity.session_id,expected_rotation:0};
 const rotated={...f.row,request_id:id(6),identity:{...f.row.identity,token_id:'synthetic-token-2',rotation_counter:1}};
 expect((await manageRealServiceMachine(context(rotated),f.selector,op,f.expected)).state).toBe('active');
 for(const changed of [{...rotated,request_id:id(7)},{...rotated,identity:{...rotated.identity,rotation_counter:0}},{...rotated,identity:{...rotated.identity,session_id:'foreign-session'}}])
  await expect(manageRealServiceMachine(context(changed),f.selector,op,f.expected)).rejects.toThrow();
});
it('allows authenticated revocation after the service kill switch and validates its receipt',async()=>{
 const f=fixture();f.row.state='revoked';vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED','0');
 const op:RealServiceMachineOperation={action:'revoke',request_id:id(4),session_id:f.row.identity.session_id,expected_rotation:0};
 expect((await manageRealServiceMachine(context(f.row),f.selector,op,f.expected)).state).toBe('revoked');
 await expect(manageRealServiceMachine(context({...f.row,state:'active'}),f.selector,op,f.expected)).rejects.toThrow('REAL_MACHINE_STATE_CHANGED');
});
it.each(REAL_SERVICE_MACHINE_REFUSALS)('preserves %s without fabricating an identity',async reason=>{
 const f=fixture(),db=context({state:'unavailable',reason});
 expect(await manageRealServiceMachine(db,f.selector,{action:'issue',request_id:id(4)},f.expected)).toEqual({state:'unavailable',reason});
 expect(db.client.query).toHaveBeenCalledTimes(2);
});
it.each(['tivdoc_worker_runtime','tivdoc_web_runtime','service_role'])('refuses %s before calling the issuer RPC',async principal=>{
 const f=fixture(),db=context(f.row,principal);
 await expect(manageRealServiceMachine(db,f.selector,{action:'issue',request_id:id(4)},f.expected)).rejects.toThrow('REAL_MACHINE_IDENTITY_PRINCIPAL');expect(db.client.query).toHaveBeenCalledTimes(1);
});
it.each(['issuer_sha256','target_id','database_name','deployment_sha256','enrollment_id','identity_id','tenant_id'] as const)('rejects changed %s even in an otherwise shaped receipt',async field=>{
 const f=fixture();if(field==='tenant_id')f.row.identity.tenant_id=`saved-case:${id(9)}`;
 else if(field==='enrollment_id'||field==='identity_id')f.row[field]=id(9);
 else f.row[field]=field.endsWith('sha256')?sha('9'):'foreign';
 await expect(manageRealServiceMachine(context(f.row),f.selector,{action:'issue',request_id:id(4)},f.expected)).rejects.toThrow();
});
it.each(['expired','future','unbounded'] as const)('rejects %s active session windows',async kind=>{
 const f=fixture();if(kind==='expired')f.row.expires_at=f.row.evaluated_at;if(kind==='future')f.row.valid_after='2026-09-13T05:01:00Z';if(kind==='unbounded')f.row.expires_at='2026-09-13T07:00:00Z';
 await expect(manageRealServiceMachine(context(f.row),f.selector,{action:'issue',request_id:id(4)},f.expected)).rejects.toThrow('REAL_MACHINE_SESSION_EXPIRED');
});
it('refuses supplied tenant, actor or session credentials in an issuance operation',async()=>{
 const f=fixture(),db=context(f.row);
 for(const extra of [{tenant_id:'foreign'},{actor_id:id(9)},{session_id:'fabricated-session'}])await expect(manageRealServiceMachine(db,f.selector,
  {...extra,action:'issue',request_id:id(4)} as RealServiceMachineOperation,f.expected)).rejects.toThrow();
 expect(db.client.query).not.toHaveBeenCalled();
});
it('fails closed before access with missing capability or disabled issuance',async()=>{
 const f=fixture(),db=context(f.row);vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY','');
 await expect(manageRealServiceMachine(db,f.selector,{action:'read'},f.expected)).rejects.toThrow('REAL_MACHINE_ISSUER_UNCONFIGURED');
 vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED','0');await expect(manageRealServiceMachine(db,f.selector,{action:'read'},f.expected)).rejects.toThrow('REAL_MACHINE_ISSUER_DISABLED');expect(db.client.query).not.toHaveBeenCalled();
});
it('pins target/TLS before opening any pool',async()=>{
 const f=fixture();
 for(const connectionUrl of [f.connection.connectionUrl.replace('db.example.test','foreign.test'),f.connection.connectionUrl.replace('tivdoc_identity_runtime','tivdoc_worker_runtime'),
  f.connection.connectionUrl.replace('verify-full','no-verify'),f.connection.connectionUrl+'&options=unsafe'])await expect(connectRealServiceMachineIssuer({...f.connection,connectionUrl})).rejects.toThrow();
 expect(pool.created).toBe(0);
});
it('uses one transaction, releases the actual driver client, and never reports uncertain commit as issued',async()=>{
 const f=fixture();pool.response=f.row;const issuer=await connectRealServiceMachineIssuer(f.connection);
 expect((await issuer.manage(f.selector,{action:'issue',request_id:id(4)})).state).toBe('active');
 expect(pool.queries).toEqual(['transaction_begin','real_machine_issuer_principal','real_service_machine_manage','transaction_commit']);expect(pool.released).toBe(1);
 expect(pool.options.ssl).toEqual({rejectUnauthorized:true,ca:f.connection.certificateAuthority});
 pool.onError();expect(issuer.health().idleConnectionFailures).toBe(1);
 pool.fail='transaction_commit';await expect(issuer.manage(f.selector,{action:'issue',request_id:id(4)})).rejects.toThrow('POSTGRES_STATEMENT_FAILED');
 expect(pool.queries.at(-1)).toBe('transaction_rollback');expect(pool.released).toBe(2);
 await issuer.close();expect(pool.closed).toBe(1);expect(issuer.health().closed).toBe(true);
});
