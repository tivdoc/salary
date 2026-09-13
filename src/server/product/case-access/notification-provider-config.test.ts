import {afterEach,describe,it,expect,vi} from 'vitest';
import {resolveNotificationProvider,sendNotification,installNotificationProviderForTests} from './notifications';
const message={template:'access_code' as const,channel:'email' as const,to:'owned-test@example.invalid',subject:'Synthetic access',body:'Synthetic only'};
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();installNotificationProviderForTests(null);});
describe('automatic DEV configured delivery',()=>{
 it.each(['preview',undefined])('refuses strangers even in NODE_ENV=production with deployment environment %s',async environment=>{
  vi.stubEnv('NODE_ENV','production');vi.stubEnv('VERCEL','1');vi.stubEnv('VERCEL_ENV',environment);vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST',message.to);
  const send=vi.fn(async()=>({ok:true as const}));
  const result=await sendNotification({...message,to:'foreign@example.invalid'},{id:'synthetic',send});
  expect(result).toMatchObject({state:'refused',error_code:'recipient_not_allowlisted'});expect(send).not.toHaveBeenCalled();
 });
 it('uses the explicitly configured Resend adapter and distinguishes acceptance from delivery',async()=>{
  vi.stubEnv('VERCEL_ENV','preview');vi.stubEnv('NODE_ENV','production');vi.stubEnv('VERCEL','1');vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST',message.to);
  vi.stubEnv('TIVDOC_NOTIFICATION_PROVIDER','resend');vi.stubEnv('RESEND_API_KEY','test-only-not-a-secret');vi.stubEnv('TIVDOC_NOTIFICATION_FROM','owned-sender@example.invalid');
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json({id:'11111111-1111-4111-8111-111111111111'}));vi.stubGlobal('fetch',fetch);
  expect(resolveNotificationProvider().id).toBe('resend');
  const result=await sendNotification(message);expect(result).toMatchObject({state:'sent',provider:'resend',provider_message_id:expect.any(String)});
  expect(result).not.toHaveProperty('delivered_at');expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
 });
 it.each(['missing_key','missing_from','invalid_sender','unknown_provider'])('fails configured %s without a network request',async scenario=>{
  vi.stubEnv('TIVDOC_NOTIFICATION_PROVIDER',scenario==='unknown_provider'?'unknown':'resend');
  vi.stubEnv('RESEND_API_KEY',scenario==='missing_key'?'':'test-only');
  vi.stubEnv('TIVDOC_NOTIFICATION_FROM',scenario==='missing_from'?'':scenario==='invalid_sender'?'a\r\nb':'sender@example.invalid');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  expect(await resolveNotificationProvider().send(message)).toMatchObject({ok:false});expect(fetch).not.toHaveBeenCalled();
 });
});
