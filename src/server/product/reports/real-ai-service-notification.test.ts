import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {normalizeContact} from '../case-access/crypto';
import {decryptNotification} from '../case-access/notification-outbox';
import {authorizeRealAiReportNotification,enqueueRealAiReportNotification,revalidateRealAiReportNotification,
 REAL_AI_SERVICE_NOTIFICATION_TEMPLATE,realAiServiceNotificationContextSchema} from './real-ai-service-notification';
import {realAiServiceFixture,syntheticServiceId} from './real-ai-service.fixture';

vi.mock('server-only',()=>({}));
let base:ReturnType<typeof realAiServiceFixture>;
const origin='https://synthetic.example.org';
beforeAll(()=>{base=realAiServiceFixture();});
beforeEach(()=>{vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST','synthetic@protocol-fixture.org');vi.stubEnv('VERCEL_ENV','test');});
afterEach(()=>{vi.unstubAllEnvs();});
function notification(){
 const body={schema_version:'tivdoc-real-ai-service-notification-grant-v1',grant_id:syntheticServiceId(8),state:'active',namespace:'real',
  ...base.selector,service_decision_sha256:base.row.service_decision.sha256,recipient_sha256:normalizeContact('synthetic@protocol-fixture.org')!.hash,
  origin,template:REAL_AI_SERVICE_NOTIFICATION_TEMPLATE,issued_at:'2026-09-12T10:00:00Z',expires_at:'2026-09-12T11:00:00Z'};
 const grant={...body,sha256:canonicalSha256(body)},row=realAiServiceNotificationContextSchema.parse({state:'authorized',grant,grant_sha256:grant.sha256,
  context_sha256:'a'.repeat(64),evaluated_at:'2026-09-12T10:30:00Z',contact:'synthetic@protocol-fixture.org',public_id:'TV-TEST1234',revocations:[]});
 if(row.state!=='authorized')throw Error('SYNTHETIC_NOTIFICATION_REQUIRED');return row;
}
function worker(note:unknown,delivery=base.row):PostgresTransactionContext{
 return {transaction_id:'synthetic-no-db',client:{query:vi.fn(async statement=>{
  if(statement.name==='real_ai_service_notification_enqueue')return {row_count:1,rows:[{value:{delivery_id:statement.values[5],grant_sha256:notification().grant.sha256,
   delivery_binding_sha256:base.row.publication!.delivery_binding_sha256,replayed:false}}]};
  return {row_count:1,rows:[{value:statement.name==='real_ai_service_delivery_context'?delivery:note}]};
 })}};
}
it('requires a separate recipient grant and renders only the fixed availability notice',async()=>{
 const context=worker(notification()),a=await authorizeRealAiReportNotification(context,base.selector,origin);
 expect(a.message).toMatchObject({template:'report_ready',channel:'email',to:'synthetic@protocol-fixture.org'});
 expect(a.message.body).toContain(`${origin}/case/TV-TEST1234/reports?report=${base.selector.report_id}`);
 expect(a.message.body).not.toContain('300.00');expect(a.expires_at).toBe('2026-09-12T11:00:00.000Z');
 await expect(authorizeRealAiReportNotification(worker({state:'unavailable',reason:'not_authorized'}),base.selector,origin)).rejects.toThrow('REAL_SERVICE_NOTIFICATION_NOT_AUTHORIZED');
});
it.each(['contact','origin','expiry','opted_out','revocation','unpublished'] as const)('rejects notification after %s changes',async kind=>{
 const note=notification(),delivery=structuredClone(base.row);
 if(kind==='contact')note.contact='another@protocol-fixture.org';
 if(kind==='expiry')note.evaluated_at=note.grant.expires_at;
 if(kind==='revocation')note.revocations.push({target_sha256:note.grant.sha256,effective_at:note.evaluated_at});
 if(kind==='unpublished')delivery.publication=null;
 const candidate=kind==='opted_out'?{state:'unavailable',reason:'opted_out'}:note;
 const code={contact:'REAL_SERVICE_NOTIFICATION_RECIPIENT',origin:'REAL_SERVICE_NOTIFICATION_ORIGIN_CHANGED',expiry:'REAL_SERVICE_NOTIFICATION_EXPIRED',
  opted_out:'REAL_SERVICE_NOTIFICATION_OPTED_OUT',revocation:'REAL_SERVICE_NOTIFICATION_REVOKED',unpublished:'REAL_SERVICE_NOTIFICATION_UNPUBLISHED'}[kind];
 await expect(authorizeRealAiReportNotification(worker(candidate,delivery),base.selector,kind==='origin'?'https://foreign.example.org':origin)).rejects.toThrow(code);
});
it('passes encrypted content into the existing outbox bridge with both CAS tokens',async()=>{
 const context=worker(notification()),secret=Buffer.alloc(32,7).toString('base64'),receipt=await enqueueRealAiReportNotification(context,base.selector,origin,secret);
 const call=vi.mocked(context.client.query).mock.calls.find(c=>c[0].name==='real_ai_service_notification_enqueue')![0];
 expect(call.values[3]).toBe(base.row.context_sha256);expect(call.values[4]).toBe(notification().context_sha256);
 const stored=JSON.parse(String(call.values[7]));expect(JSON.stringify(stored)).not.toContain('synthetic@');
 expect(decryptNotification(stored,receipt.delivery_id,secret).template).toBe('report_ready');
});
it('revalidates the exact claimed message before send and rejects changed content or newly revoked authority',async()=>{
 const note=notification(),a=await authorizeRealAiReportNotification(worker(note),base.selector,origin),claimed={delivery_id:a.payload_sha256,message:a.message};
 expect((await revalidateRealAiReportNotification(worker(note),base.selector,origin,claimed)).delivery_id).toBe(a.payload_sha256);
 await expect(revalidateRealAiReportNotification(worker(note),base.selector,origin,{...claimed,message:{...claimed.message,body:'changed'}})).rejects.toThrow('REAL_SERVICE_NOTIFICATION_PAYLOAD_CHANGED');
 await expect(revalidateRealAiReportNotification(worker({state:'unavailable',reason:'revoked'}),base.selector,origin,claimed)).rejects.toThrow('REAL_SERVICE_NOTIFICATION_REVOKED');
});
