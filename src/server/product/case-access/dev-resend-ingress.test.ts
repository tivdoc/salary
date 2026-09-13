import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {Webhook} from 'svix';
import {devIngressCredentialScopeValid,handleDevResendIngress} from './dev-resend-ingress.ts';
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const origin='https://salary-synthetic-tivdoccom-5042s-projects.vercel.app';
const env={VERCEL_ENV:'preview',TIVDOC_DEV_INGRESS_ENABLED:'true',RESEND_WEBHOOK_SECRET:secret,
 TIVDOC_DEV_PREVIEW_SHARE_SECRET:'synthetic-only-expiring-share-token',TIVDOC_DEV_PREVIEW_ORIGIN:origin,
 TIVDOC_DEV_PREVIEW_SHARE_EXPIRES:new Date(Date.now()+3600000).toISOString()};
function request(){
 const body=JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:'11111111-1111-4111-8111-111111111111'}});
 const at=new Date();const id='msg_synthetic_unit_receipt';
 return new Request('https://ingress.invalid/api/resend',{method:'POST',body,headers:{
  'content-type':'application/json','svix-id':id,'svix-timestamp':String(Math.floor(at.getTime()/1000)),
  'svix-signature':new Webhook(secret).sign(id,at,body),
 }});
}
function exchange(){return new Response(null,{status:307,headers:{location:`${origin}/api/health`,'set-cookie':'_vercel_jwt=synthetic-cookie; Path=/; Secure; HttpOnly'}});}
describe('DEV webhook ingress transport unit contract, not provider delivery proof',()=>{
 beforeEach(()=>{vi.spyOn(console,'warn').mockImplementation(()=>undefined);});
 afterEach(()=>{vi.restoreAllMocks();});
 it.each(['SUPABASE_SERVICE_ROLE_KEY','OPENAI_API_KEY','RESEND_API_KEY','CASE_TOKEN_SECRET',
  'TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL','TIVDOC_MANAGED_DEV_WORKER_CAPABILITY','TIVDOC_FUTURE_APPLICATION_FLAG',
  'PAYMENT_RECONCILIATION_SECRET','DELIVERY_RECIPIENT_ALLOWLIST','GA4_API_SECRET','INVOICE4U_API_KEY',
  'META_CAPI_ACCESS_TOKEN','NEXT_PUBLIC_SUPABASE_URL','DATABASE_URL','PGPASSWORD','OTHER_API_KEY'])('refuses inherited application configuration before even a GET: %s',async key=>{
  const fetcher=vi.fn(),response=await handleDevResendIngress(new Request('https://ingress.invalid/api/resend'),{...env,[key]:'synthetic-only'},fetcher);
  expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'credential_scope_violation'});expect(fetcher).not.toHaveBeenCalled();
 });
 it('accepts explicitly blanked app variables while preserving platform-owned runtime configuration',async()=>{
  const isolated={...env,OPENAI_API_KEY:'',RESEND_API_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL:'',
   VERCEL_OIDC_TOKEN:'synthetic-platform-token',AWS_SESSION_TOKEN:'synthetic-platform-token',NODE_ENV:'production'};
  expect(devIngressCredentialScopeValid(isolated)).toBe(true);
  const fetcher=vi.fn();expect((await handleDevResendIngress(new Request('https://ingress.invalid/api/resend'),isolated,fetcher)).status).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
 });
 it.each(['production','development',''])('never forwards outside Preview: %s',async target=>{
  const fetcher=vi.fn();expect((await handleDevResendIngress(request(),{...env,VERCEL_ENV:target},fetcher)).status).toBe(503);expect(fetcher).not.toHaveBeenCalled();
 });
 it.each([
  {TIVDOC_DEV_INGRESS_ENABLED:'false'}, {RESEND_WEBHOOK_SECRET:''},
  {TIVDOC_DEV_PREVIEW_ORIGIN:'https://salary.vercel.app'},
  {TIVDOC_DEV_PREVIEW_ORIGIN:`${origin}/api`},
  {TIVDOC_DEV_PREVIEW_SHARE_EXPIRES:'invalid'},
  {TIVDOC_DEV_PREVIEW_SHARE_EXPIRES:'2020-01-01T00:00:00.000Z'},
 ])('fails closed before network for unavailable or unsafe configuration: %j',async mutation=>{
  const fetcher=vi.fn();expect((await handleDevResendIngress(request(),{...env,...mutation},fetcher)).status).toBe(503);expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects wrong paths, methods, oversized or unauthenticated bodies before forwarding',async()=>{
  const fetcher=vi.fn();
  expect((await handleDevResendIngress(new Request('https://ingress.invalid/other'),env,fetcher)).status).toBe(404);
  expect((await handleDevResendIngress(new Request('https://ingress.invalid/api/resend'),env,fetcher)).status).toBe(405);
  expect((await handleDevResendIngress(new Request('https://ingress.invalid/api/resend',{method:'POST',body:'x'.repeat(65537)}),env,fetcher)).status).toBe(413);
  expect((await handleDevResendIngress(new Request('https://ingress.invalid/api/resend',{method:'POST',body:'{}'}),env,fetcher)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('preserves the raw signed payload and passes only the single-Preview cookie to the fixed receipt route',async()=>{
  const req=request(),raw=await req.clone().text();
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(exchange()).mockResolvedValueOnce(Response.json({accepted:true}));
  const result=await handleDevResendIngress(req,env,fetcher);
  expect(result.status).toBe(200);expect(await result.json()).toEqual({accepted:true});expect(fetcher).toHaveBeenCalledTimes(2);
  const [access,first]=fetcher.mock.calls[0];expect(new URL(String(access)).origin).toBe(origin);expect(first?.redirect).toBe('manual');
  const [target,second]=fetcher.mock.calls[1];expect(String(target)).toBe(`${origin}/api/notifications/resend`);expect(second?.body).toBe(raw);
  const headers=new Headers(second?.headers);expect(headers.get('cookie')).toBe('_vercel_jwt=synthetic-cookie');expect(headers.get('svix-signature')).toBe(req.headers.get('svix-signature'));
  expect(headers.get('authorization')).toBeNull();expect(headers.get('x-vercel-protection-bypass')).toBeNull();
  expect(console.warn).not.toHaveBeenCalled();
 });
 it('rejects malformed wire bytes that lossy UTF-8 decoding would turn into a different signed payload',async()=>{
  const canonical=JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:'11111111-1111-4111-8111-111111111111',subject:'\uFFFD'}});
  const encoded=Buffer.from(canonical),index=encoded.indexOf(Buffer.from('\uFFFD'));
  const wire=Buffer.concat([encoded.subarray(0,index),Buffer.from([0xff]),encoded.subarray(index+3)]);
  // This equality is the old signature-confusion regression, not a valid raw request.
  expect(wire.toString('utf8')).toBe(canonical);expect(wire.equals(encoded)).toBe(false);
  const at=new Date(),id='msg_synthetic_utf8';
  const req=new Request('https://ingress.invalid/api/resend',{method:'POST',body:wire,headers:{
   'svix-id':id,'svix-timestamp':String(Math.floor(at.getTime()/1000)),
   'svix-signature':new Webhook(secret).sign(id,at,canonical),
  }});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(exchange()).mockResolvedValueOnce(Response.json({accepted:true}));
  expect((await handleDevResendIngress(req,env,fetcher)).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it.each(['foreign_redirect','missing_cookie','unexpected_status'])('refuses an unsafe protection exchange: %s',async mutation=>{
  const response=new Response(null,{status:mutation==='unexpected_status'?200:307,headers:{location:mutation==='foreign_redirect'?'https://other.example/api/health':`${origin}/api/health`,...(mutation==='missing_cookie'?{}:{'set-cookie':'_vercel_jwt=synthetic-cookie'})}});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response);
  expect((await handleDevResendIngress(request(),env,fetcher)).status).toBe(502);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each(['status','origin','path','query','location','cookie','cookie_size']as const)('records only bounded safe flags for refused exchange: %s',async mutation=>{
  const cookie=mutation==='cookie_size'?`_vercel_jwt=${'s'.repeat(16384)}`:'_vercel_jwt=synthetic-private-cookie';
  const location=mutation==='origin'?'https://other.example/api/health':mutation==='path'?`${origin}/private-path`
   :mutation==='query'?`${origin}/api/health?_vercel_share=${env.TIVDOC_DEV_PREVIEW_SHARE_SECRET}`:`${origin}/api/health`;
  const exchange=new Response('synthetic-private-response-body',{status:mutation==='status'?302:307,headers:{
   ...(mutation==='location'?{}:{location}),...(mutation==='cookie'?{}:{'set-cookie':cookie})}});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(exchange),req=request();
  const result=await handleDevResendIngress(req,env,fetcher);
  expect(result.status).toBe(502);expect(await result.json()).toEqual({code:'preview_access_refused'});
  expect(fetcher).toHaveBeenCalledTimes(1);expect(console.warn).toHaveBeenCalledTimes(1);
  const logged=vi.mocked(console.warn).mock.calls[0];expect(logged).toHaveLength(1);
  expect(JSON.parse(logged[0])).toEqual({schema_version:'dev-ingress-exchange-diagnostic-v1',event:'preview_access_refused',
   exchange_status:mutation==='status'?302:307,location_present:mutation!=='location',destination_parseable:mutation!=='location',
   destination_same_origin:!['origin','location'].includes(mutation),destination_health_path:!['path','location'].includes(mutation),
   destination_query_empty:!['query','location'].includes(mutation),scoped_cookie_present:mutation!=='cookie',
   scoped_cookie_within_limit:!['cookie','cookie_size'].includes(mutation)});
  for(const value of [secret,origin,env.TIVDOC_DEV_PREVIEW_SHARE_SECRET,cookie,'synthetic-private-response-body',req.headers.get('svix-signature')!])expect(logged[0]).not.toContain(value);
 });
 it.each([401,503,307])('does not acknowledge a receipt not persisted by the Preview: %i',async status=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(exchange()).mockResolvedValueOnce(new Response(null,{status}));
  expect((await handleDevResendIngress(request(),env,fetcher)).status).toBe(502);
 });
 it('does not acknowledge a successful unrelated HTML response',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(exchange()).mockResolvedValueOnce(new Response('<html>Login</html>'));
  expect((await handleDevResendIngress(request(),env,fetcher)).status).toBe(502);
 });
});
