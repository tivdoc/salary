import {expect,it,vi} from 'vitest';
import {handleLocalDevResendIngress} from './dev-resend-ingress';
const env={NODE_ENV:'development',TIVDOC_DEV_LOCAL_INGRESS_ENABLED:'true',TIVDOC_DEV_LOCAL_INGRESS_EXPIRES:new Date(Date.now()+3600000).toISOString()};
it.each([{VERCEL:'1'},{VERCEL_ENV:'preview'},{VERCEL_ENV:'production'},{NODE_ENV:'production'},
 {TIVDOC_DEV_LOCAL_INGRESS_ENABLED:'false'},{TIVDOC_DEV_LOCAL_INGRESS_EXPIRES:'bad'},
 {TIVDOC_DEV_LOCAL_INGRESS_EXPIRES:'2000-01-01T00:00:00Z'},
 {TIVDOC_DEV_LOCAL_INGRESS_EXPIRES:new Date(Date.now()+5*3600000).toISOString()}])('refuses remote, expired or unbounded local relay configuration',async changed=>{
 const transport=vi.fn();expect((await handleLocalDevResendIngress(new Request('https://relay.invalid/api/resend'),{...env,...changed},transport)).status).toBe(503);
 expect(transport).not.toHaveBeenCalled();
});
it('keeps the narrow path/method and independent forwarding configuration guards',async()=>{
 const transport=vi.fn();
 expect((await handleLocalDevResendIngress(new Request('https://relay.invalid/customer'),env,transport)).status).toBe(404);
 expect((await handleLocalDevResendIngress(new Request('https://relay.invalid/api/resend'),env,transport)).status).toBe(405);
 expect((await handleLocalDevResendIngress(new Request('https://relay.invalid/api/resend',{method:'POST',body:'{}'}),env,transport)).status).toBe(503);
 expect(transport).not.toHaveBeenCalled();
});
