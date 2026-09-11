import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {CaseAccessDb} from '../case-access/db';
import {decryptNotification,encryptNotification} from '../case-access/notification-outbox';
import {payloadDigest,type NotificationMessage,type NotificationProvider} from '../case-access/notifications';
import {runAutomaticNotificationPass} from './automatic-dev-notifications';
vi.mock('server-only',()=>({}));
afterEach(()=>vi.unstubAllEnvs());
const secret=Buffer.alloc(32,7).toString('base64'),origin='https://tivdoc-synthetic.vercel.app',contact='notification-unit@example.invalid';
function fixture(events:unknown[]=[]){
 vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST',contact);vi.stubEnv('VERCEL_ENV','test');
 const queries:{fn:string;args:Readonly<Record<string,unknown>>}[]=[],claims:Record<string,unknown>[]=[],sent:NotificationMessage[]=[];
 const provider:NotificationProvider={id:'injected_notification_test',async send(message){sent.push(message);return {ok:true,provider_message_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};}};
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){
  queries.push({fn,args});let result:unknown[]=[];
  if(fn==='case_notification_managed_pending')result=events;
  if(fn==='case_notification_managed_enqueue')result=[{value:args.target_delivery}];
  if(fn==='case_notification_managed_claim')result=claims.splice(0,1);
  return result as T[];
 }};
 return {queries,claims,sent,provider,db,pass:()=>runAutomaticNotificationPass({db,capability:'synthetic-capability',secret,origin,provider})};
}
it.each(['request_required','engineering_report_ready','report_ready'])('renders %s from its saved event and keeps the payload identity across retries',async event_kind=>{
 const requestId=randomUUID(),reportId=randomUUID(),event={event_key:`${event_kind}:${randomUUID()}`,event_kind,case_id:randomUUID(),public_id:'TV-UNIT0001',identity_id:randomUUID(),contact,request_id:event_kind==='request_required'?requestId:null,report_id:event_kind==='request_required'?null:reportId};
 const s=fixture([event]);expect(await s.pass()).toMatchObject({queued:1,deliveryConfirmed:false});await s.pass();
 const enqueued=s.queries.filter(q=>q.fn==='case_notification_managed_enqueue');expect(enqueued).toHaveLength(2);
 expect(enqueued[0].args.target_delivery).toBe(enqueued[1].args.target_delivery);
 const message=decryptNotification(enqueued[0].args.target_payload,String(enqueued[0].args.target_delivery),secret);
 expect(message.to).toBe(contact);expect(message.body).toContain('כניסה לתיק דרך האימייל המאומת');
 if(event_kind==='request_required'){expect(message.template).toBe('document_request');expect(message.body).toContain(`/thread?requestId=${requestId}`);}
 else{expect(message.template).toBe('report_ready');expect(message.body).toContain(`report=${reportId}`);expect(message.subject).toContain('DEV');expect(message.body).toContain('סינתטי');expect(message.body).toContain('אינו חוב מאומת');}
 if(event_kind==='engineering_report_ready'){expect(message.body).toContain('engineering=1');expect(message.body).toContain('אינו חוב מאומת');expect(message.subject).toContain('DEV');}
 if(event_kind==='report_ready'){expect(message.body).toContain('אינו אישור אנושי');expect(message.body).toContain('אינו מעיד שהכלל פעיל בשירות ללקוחות');expect(message.body).not.toContain('engineering=1');}
 expect(JSON.stringify(enqueued[0].args.target_payload)).not.toContain(contact);expect(s.sent).toHaveLength(0);
});
it('records provider acceptance separately from delivery and finishes the exact acquired fence',async()=>{
 const s=fixture(),message:NotificationMessage={template:'access_code',channel:'email',to:contact,subject:'Synthetic code',body:'Synthetic 123456'},id=payloadDigest(message);
 s.claims.push({delivery_id:id,encrypted_payload:encryptNotification(message,id,secret),fencing_token:3});
 const result=await s.pass();expect(result).toMatchObject({queued:0,deliveryConfirmed:false,attempts:[{state:'provider_accepted',provider:'injected_notification_test'}]});
 expect(s.sent).toEqual([message]);expect(s.queries.find(q=>q.fn==='case_notification_outbox_finish')?.args).toMatchObject({target_id:id,target_fence:3,target_provider_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',target_error:null});
});
it('does not enqueue or send a saved event to a recipient outside the local allowlist',async()=>{
 const s=fixture([{event_key:'request:'+randomUUID(),event_kind:'request_required',case_id:randomUUID(),public_id:'TV-UNIT0001',identity_id:randomUUID(),contact:'foreign@example.invalid',request_id:randomUUID(),report_id:null}]);
 expect(await s.pass()).toMatchObject({queued:0,attempts:[],deliveryConfirmed:false});expect(s.queries.some(q=>q.fn==='case_notification_managed_enqueue')).toBe(false);expect(s.sent).toHaveLength(0);
});
it('refuses an invalid origin and encryption key before accessing the outbox',async()=>{
 const s=fixture();await expect(runAutomaticNotificationPass({db:s.db,provider:s.provider,capability:'synthetic',secret,origin:'https://foreign.invalid'})).rejects.toThrow('MANAGED_NOTIFICATION_ORIGIN');
 await expect(runAutomaticNotificationPass({db:s.db,provider:s.provider,capability:'synthetic',secret:'invalid',origin})).rejects.toThrow('NOTIFICATION_KEY_INVALID');expect(s.queries).toHaveLength(0);
});

it('an optional event selection narrows authenticated pending events and cannot enqueue an invented event',async()=>{
 const a=randomUUID(),b=randomUUID();const event=(id:string)=>({event_key:'request:'+id,event_kind:'request_required',case_id:randomUUID(),public_id:'TV-UNIT0001',identity_id:randomUUID(),contact,request_id:id,report_id:null});
 const s=fixture([event(a),event(b)]);
 const pass=(enqueueEventKeys:readonly string[])=>runAutomaticNotificationPass({db:s.db,provider:s.provider,capability:'synthetic',secret,origin,enqueueEventKeys});
 expect(await pass(['request:'+a,'request:'+randomUUID()])).toMatchObject({queued:1});
 expect(s.queries.filter(q=>q.fn==='case_notification_managed_enqueue').map(q=>q.args.target_event)).toEqual(['request:'+a]);
 expect(await pass([])).toMatchObject({queued:0});
 expect(s.queries.filter(q=>q.fn==='case_notification_managed_enqueue')).toHaveLength(1);
});
it('stops without querying or sending when the supervisor has already requested shutdown',async()=>{
 const s=fixture(),controller=new AbortController();controller.abort();
 expect(await runAutomaticNotificationPass({db:s.db,provider:s.provider,capability:'synthetic',secret,origin,signal:controller.signal})).toMatchObject({state:'interrupted',queued:0,attempts:[]});
 expect(s.queries).toHaveLength(0);expect(s.sent).toHaveLength(0);
});
it('leaves a newly claimed lease recoverable if shutdown arrives before provider dispatch',async()=>{
 const s=fixture(),controller=new AbortController();const message:NotificationMessage={template:'access_code',channel:'email',to:contact,subject:'Synthetic code',body:'Synthetic 123456'},id=payloadDigest(message);
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){
  if(fn==='case_notification_managed_claim'){controller.abort();return [{delivery_id:id,encrypted_payload:encryptNotification(message,id,secret),fencing_token:3}] as T[];}
  return s.db.rpc<T>(fn,args);
 }};
 expect(await runAutomaticNotificationPass({db,provider:s.provider,capability:'synthetic',secret,origin,signal:controller.signal})).toMatchObject({state:'interrupted',attempts:[],deliveryConfirmed:false});
 expect(s.sent).toHaveLength(0);expect(s.queries.some(q=>q.fn==='case_notification_outbox_finish')).toBe(false);
});
it('does not claim a second notification after an in-flight provider response is durably saved during shutdown',async()=>{
 const s=fixture(),controller=new AbortController();const message:NotificationMessage={template:'access_code',channel:'email',to:contact,subject:'Synthetic code',body:'Synthetic 123456'},id=payloadDigest(message);
 s.claims.push({delivery_id:id,encrypted_payload:encryptNotification(message,id,secret),fencing_token:3});
 const provider:NotificationProvider={id:'injected_notification_test',async send(){controller.abort();return {ok:true,provider_message_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};}};
 expect(await runAutomaticNotificationPass({db:s.db,provider,capability:'synthetic',secret,origin,signal:controller.signal})).toMatchObject({state:'interrupted',attempts:[{state:'provider_accepted'}],deliveryConfirmed:false});
 expect(s.queries.filter(q=>q.fn==='case_notification_managed_claim')).toHaveLength(1);expect(s.queries.filter(q=>q.fn==='case_notification_outbox_finish')).toHaveLength(1);
});
it.each(['request_without_target','report_with_request','request_with_report'])('refuses malformed saved event %s before any enqueue or delivery',async mutation=>{
 const event={event_key:'request:'+randomUUID(),event_kind:'request_required',case_id:randomUUID(),public_id:'TV-UNIT0001',identity_id:randomUUID(),contact,request_id:null as string|null,report_id:null as string|null};
 if(mutation==='report_with_request'){event.event_kind='report_ready';event.request_id=randomUUID();event.report_id=randomUUID();}
 if(mutation==='request_with_report'){event.request_id=randomUUID();event.report_id=randomUUID();}
 const s=fixture([event]);await expect(s.pass()).rejects.toThrow();expect(s.queries.map(q=>q.fn)).toEqual(['case_notification_managed_pending']);expect(s.sent).toHaveLength(0);
});
