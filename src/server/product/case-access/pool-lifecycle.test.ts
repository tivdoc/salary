import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import pg from 'pg';
vi.mock('server-only',()=>({}));
const mock=vi.hoisted(()=>({created:[] as {options:Record<string,unknown>;query:ReturnType<typeof vi.fn>;on:ReturnType<typeof vi.fn>}[],attach:vi.fn()}));
vi.mock('@vercel/functions',()=>({attachDatabasePool:mock.attach}));
beforeEach(()=>{vi.resetModules();mock.created.length=0;mock.attach.mockClear();vi.stubEnv('VERCEL_ENV','');vi.stubEnv('TIVDOC_RUNTIME_TARGET','local_only');vi.stubEnv('TIVDOC_PRODUCT_PERSISTENCE_MODE','isolated_postgres');vi.stubEnv('TIVDOC_WEB_POSTGRES_URL','postgres://synthetic@127.0.0.1/tivdoc_synthetic');vi.stubEnv('TIVDOC_OPERATIONS_POSTGRES_URL','postgres://synthetic_ops@127.0.0.1/tivdoc_synthetic');
 vi.spyOn(pg,'Pool').mockImplementation(class {query=vi.fn(async()=>({rows:[]}));on=vi.fn();constructor(public options:Record<string,unknown>){mock.created.push(this);}} as unknown as typeof pg.Pool);
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('product pool lifecycle',()=>{
 it('concurrent cold customer resolution constructs exactly one pool',async()=>{
  const {resolveCaseAccessDb}=await import('./db');
  const stores=await Promise.all(Array.from({length:8},()=>resolveCaseAccessDb()));
  expect(mock.created).toHaveLength(1);await Promise.all(stores.map(s=>s!.rpc('case_access_session_resolve',{})));expect(mock.created[0].query).toHaveBeenCalledTimes(8);
 });
 it('concurrent cold operations resolution constructs exactly one pool',async()=>{
  const {resolveReportOperationsDb}=await import('./db');await Promise.all(Array.from({length:8},()=>resolveReportOperationsDb()));expect(mock.created).toHaveLength(1);
 });
 it('registers both distinct pools with Fluid and releases idle clients promptly',async()=>{
  const {resolveCaseAccessDb,resolveReportOperationsDb}=await import('./db');await Promise.all([resolveCaseAccessDb(),resolveReportOperationsDb()]);
  expect(mock.created).toHaveLength(2);expect(mock.attach).toHaveBeenCalledTimes(2);
  for(const pool of mock.created){expect(pool.options).toMatchObject({max:2,min:0,idleTimeoutMillis:5000});expect(pool.on).toHaveBeenCalledWith('error',expect.any(Function));}
  expect(mock.created[0].options.connectionString).not.toBe(mock.created[1].options.connectionString);
 });
 it('absorbs idle connection errors with a fixed diagnostic rather than raw connection data',async()=>{
  const {resolveCaseAccessDb}=await import('./db');await resolveCaseAccessDb();const handler=mock.created[0].on.mock.calls.find(c=>c[0]==='error')?.[1];expect(handler).toBeTypeOf('function');
  const logger=vi.spyOn(console,'error').mockImplementation(()=>{});try{handler(new Error('private connection details'));expect(logger).toHaveBeenCalledWith('CASE_ACCESS_POOL_IDLE_ERROR');}finally{logger.mockRestore();}
 });
});

it('concurrent cold payment verifiers use one separate Fluid-managed pool',async()=>{
 vi.stubEnv('TIVDOC_PAYMENT_VERIFICATION_POSTGRES_URL','postgres://synthetic_verifier@127.0.0.1/tivdoc_synthetic');
 const {orderVerifierDb}=await import('../orders/service');
 const stores=await Promise.all(Array.from({length:8},()=>orderVerifierDb()));
 expect(mock.created).toHaveLength(1);expect(new Set(stores).size).toBe(1);
 expect(mock.created[0].options).toMatchObject({max:2,min:0,idleTimeoutMillis:5000,application_name:'tivdoc_payment_verifier'});expect(mock.attach).toHaveBeenCalledOnce();expect(mock.created[0].on).toHaveBeenCalledWith('error',expect.any(Function));
});
