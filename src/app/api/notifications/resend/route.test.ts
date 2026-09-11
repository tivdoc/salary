import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Webhook} from 'svix';

const mocks=vi.hoisted(()=>({rpc:vi.fn(),resolve:vi.fn(),preview:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:async()=>{}}));
vi.mock('@/server/product/case-access/db',()=>({resolveCaseAccessDb:mocks.resolve,postgresCaseAccessDb:vi.fn()}));
vi.mock('@/server/product/case-access/preview-webhook-database',()=>({isolatedPreviewWebhookDatabase:mocks.preview}));
vi.mock('@vercel/functions',()=>({attachDatabasePool:vi.fn()}));
import {POST} from './route';

const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const providerId='11111111-1111-4111-8111-111111111111';
function request(options:Readonly<{type?:string;occurredAt?:string;id?:string;mutate?:(body:Buffer)=>Buffer}>={}){
 const raw=JSON.stringify({type:options.type??'email.delivered',created_at:options.occurredAt??'2020-01-01T00:00:00Z',data:{email_id:providerId,subject:'\uFFFD'}});
 const at=new Date(),id=options.id??'msg_synthetic_route';
 return new Request('https://synthetic.invalid/api/notifications/resend',{method:'POST',body:options.mutate?new Uint8Array(options.mutate(Buffer.from(raw))).buffer:raw,headers:{
  'svix-id':id,'svix-timestamp':String(Math.floor(at.getTime()/1000)),
  'svix-signature':new Webhook(secret).sign(id,at,raw),
 }});
}
beforeEach(()=>{
 vi.clearAllMocks();
 vi.stubEnv('VERCEL_ENV','');vi.stubEnv('RESEND_WEBHOOK_SECRET',secret);
 vi.stubEnv('TIVDOC_NOTIFICATION_WEBHOOK_ENABLED','true');vi.stubEnv('TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL','');
 mocks.rpc.mockResolvedValue([]);mocks.resolve.mockResolvedValue({provider:'fake',rpc:mocks.rpc});mocks.preview.mockReturnValue(null);
});
afterEach(()=>vi.unstubAllEnvs());
describe('Resend HTTP receipt boundary with mocked persistence, not real webhook proof',()=>{
 it('passes signed event/provider/time coordinates unchanged, including duplicate and late attempts',async()=>{
  for(let attempt=0;attempt<2;attempt++){
   const response=await POST(request());expect(response.status).toBe(200);expect(await response.json()).toEqual({accepted:true});
  }
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  for(const call of mocks.rpc.mock.calls)expect(call).toEqual(['case_notification_webhook_record',{
   target_event:'msg_synthetic_route',target_provider:providerId,target_kind:'email.delivered',target_at:'2020-01-01T00:00:00Z',
  }]);
 });
 it('acknowledges only after the DB resolves, including a receipt stored before provider acceptance',async()=>{
  let persisted=false; mocks.rpc.mockImplementation(async()=>{persisted=true;return [];});
  const response=await POST(request());expect(persisted).toBe(true);expect(response.status).toBe(200);
 });
 it.each(['WEBHOOK_REPLAY_MISMATCH','connection unavailable'])('does not acknowledge persistence refusal: %s',async message=>{
  mocks.rpc.mockRejectedValueOnce(new Error(message));const response=await POST(request());
  expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'event_persistence_failed'});
 });
 it('refuses malformed UTF-8 before calling the DB even when lossy text would match the signature',async()=>{
  const response=await POST(request({mutate:encoded=>{
   const index=encoded.indexOf(Buffer.from('\uFFFD'));
   return Buffer.concat([encoded.subarray(0,index),Buffer.from([0xff]),encoded.subarray(index+3)]);
  }}));
  expect(response.status).toBe(401);expect(mocks.resolve).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('refuses oversized bodies, signatures and unpersistable event IDs before any store access',async()=>{
  expect((await POST(new Request('https://synthetic.invalid/api/notifications/resend',{method:'POST',body:'x'.repeat(65537)}))).status).toBe(413);
  const unsigned=request();unsigned.headers.delete('svix-signature');expect((await POST(unsigned)).status).toBe(401);
  expect((await POST(request({id:'x'.repeat(201)}))).status).toBe(401);
  expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.resolve).not.toHaveBeenCalled();
 });
 it('does not fall back to the ordinary store when isolated Preview configuration is unavailable',async()=>{
  vi.stubEnv('VERCEL_ENV','preview');const response=await POST(request());
  expect(response.status).toBe(503);expect(mocks.preview).toHaveBeenCalled();expect(mocks.resolve).not.toHaveBeenCalled();
 });
 it('keeps disabled ingress and signed unsupported event kinds away from persistence',async()=>{
  vi.stubEnv('TIVDOC_NOTIFICATION_WEBHOOK_ENABLED','false');expect((await POST(request())).status).toBe(503);
  vi.stubEnv('TIVDOC_NOTIFICATION_WEBHOOK_ENABLED','true');expect((await POST(request({type:'contact.created'}))).status).toBe(200);
  expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.resolve).not.toHaveBeenCalled();
 });
});
