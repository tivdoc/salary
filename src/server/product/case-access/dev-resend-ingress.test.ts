import {describe,it,expect,vi} from 'vitest';
import {Webhook} from 'svix';
import {handleDevResendIngress} from './dev-resend-ingress.ts';
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
 });
 it.each(['foreign_redirect','missing_cookie','unexpected_status'])('refuses an unsafe protection exchange: %s',async mutation=>{
  const response=new Response(null,{status:mutation==='unexpected_status'?200:307,headers:{location:mutation==='foreign_redirect'?'https://other.example/api/health':`${origin}/api/health`,...(mutation==='missing_cookie'?{}:{'set-cookie':'_vercel_jwt=synthetic-cookie'})}});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response);
  expect((await handleDevResendIngress(request(),env,fetcher)).status).toBe(502);expect(fetcher).toHaveBeenCalledTimes(1);
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
