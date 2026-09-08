import {it,expect,vi,afterEach} from 'vitest';
import {Invoice4uClient} from './invoice4u';
vi.mock('server-only',()=>({}));
afterEach(()=>vi.unstubAllEnvs());
it.each(['qa','production'])('uses only the documented %s host for authenticated provider lookup',async environment=>{
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({GetClearingLogByIdResult:{Id:123}})));
 const api=new Invoice4uClient('synthetic-test-key',fetcher,15,environment);
 await api.getClearingLogById('123');expect(fetcher.mock.calls[0][0]).toBe(`https://${environment==='qa'?'apiqa':'api'}.invoice4u.co.il/Services/ApiService.svc/GetClearingLogById`);
 expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({clearingLogId:'123',token:'synthetic-test-key'});
});
it.each(['','QA','https://untrusted.invalid','staging'])('refuses unknown environment %s without sending credentials',environment=>{
 const fetcher=vi.fn<typeof fetch>();expect(()=>new Invoice4uClient('synthetic-test-key',fetcher,15,environment)).toThrow('invalid_provider_environment');expect(fetcher).not.toHaveBeenCalled();
});
it('supports an explicit server QA setting while preserving the previous production default',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>new Response('null'));
 vi.stubEnv('INVOICE4U_ENVIRONMENT','qa');await new Invoice4uClient('synthetic-test-key',fetcher,6).getClearingLogById('123');expect(String(fetcher.mock.calls[0][0])).toContain('apiqa.invoice4u.co.il');
 vi.stubEnv('INVOICE4U_ENVIRONMENT',undefined);await new Invoice4uClient('synthetic-test-key',fetcher,6).getClearingLogById('123');expect(String(fetcher.mock.calls[1][0])).toContain('api.invoice4u.co.il');
});
