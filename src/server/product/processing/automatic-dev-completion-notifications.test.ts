import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {CaseAccessDb} from '../case-access/db';
import {decryptNotification} from '../case-access/notification-outbox';
import {payloadDigest,type NotificationMessage,type NotificationProvider} from '../case-access/notifications';
import {completionNotificationRoundSchema,enqueueCompletionNotifications,renderCompletionNotification,type CompletionNotificationRound} from './automatic-dev-completion-notifications';
import {runAutomaticNotificationPass} from './automatic-dev-notifications';
vi.mock('server-only',()=>({}));
afterEach(()=>vi.unstubAllEnvs());
const secret=Buffer.alloc(32,7).toString('base64'),origin='https://tivdoc-synthetic.vercel.app',contact='round-unit@example.invalid';
function round(count=14):CompletionNotificationRound{return {round_id:'a'.repeat(64),job_id:'saved-draft:'+randomUUID(),analysis_run_id:randomUUID(),case_id:randomUUID(),public_id:'TV-ROUND001',identity_id:randomUUID(),contact,request_set_sha256:'b'.repeat(64),questions:Array.from({length:count},(_,index)=>({request_id:randomUUID(),question:`השלמת בדיקה ${index+1}: מה רשום במקור?`}))};}
function fixture(rounds:unknown[]){
 vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST',contact);vi.stubEnv('VERCEL_ENV','test');
 const calls:{fn:string;args:Readonly<Record<string,unknown>>}[]=[],sent:NotificationMessage[]=[];
 let claimed=false;let enqueued:Readonly<Record<string,unknown>>|undefined;
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){
  calls.push({fn,args});let rows:unknown[]=[];
  if(fn==='case_notification_completion_pending')rows=rounds;
  if(fn==='case_notification_completion_enqueue'){enqueued=args;rows=[{value:args.target_delivery}];}
  if(fn==='case_notification_managed_claim'&&enqueued&&!claimed){claimed=true;rows=[{delivery_id:enqueued.target_delivery,encrypted_payload:enqueued.target_payload,fencing_token:4}];}
  if(fn==='case_notification_managed_dispatch')rows=[{state:'ready'}];
  return rows as T[];
 }};
 const provider:NotificationProvider={id:'injected_completion_unit',async send(message){sent.push(message);return {ok:true,provider_message_id:randomUUID()};}};
 return {db,calls,sent,provider,input:{db,capability:'synthetic',secret,origin},pass:()=>runAutomaticNotificationPass({db,capability:'synthetic',secret,origin,provider})};
}
it('turns fourteen authenticated READY questions into one encrypted intention and one provider request',async()=>{
 const ready=round(),s=fixture([ready]);expect(await s.pass()).toMatchObject({queued:1,deliveryConfirmed:false,attempts:[{state:'provider_accepted'}]});
 expect(s.sent).toHaveLength(1);expect(s.calls.filter(c=>c.fn==='case_notification_completion_enqueue')).toHaveLength(1);
 expect(s.calls.some(c=>c.fn==='case_notification_managed_enqueue')).toBe(false);
 for(const question of ready.questions)expect(s.sent[0].body).toContain(`/thread?requestId=${question.request_id}`);
 expect(s.sent[0].body).toContain('14 השלמות');expect(s.sent[0].subject).toContain('DEV');
 const enqueue=s.calls.find(c=>c.fn==='case_notification_completion_enqueue')!.args;
 expect(enqueue).toMatchObject({target_round:ready.round_id,expected_case:ready.case_id,expected_identity:ready.identity_id,expected_request_set_sha256:ready.request_set_sha256,expected_request_ids:ready.questions.map(q=>q.request_id).sort()});
 expect(JSON.stringify(enqueue.target_payload)).not.toContain(contact);
 const names=s.calls.map(c=>c.fn);expect(names.indexOf('case_notification_managed_dispatch')).toBeGreaterThan(names.indexOf('case_notification_managed_claim'));
 expect(names.indexOf('case_notification_outbox_finish')).toBeGreaterThan(names.indexOf('case_notification_managed_dispatch'));
});
it('keeps the delivery key stable when the same round is enumerated in a different order after restart',async()=>{
 const ready=round(),reordered={...ready,questions:[...ready.questions].reverse()};
 const first=renderCompletionNotification(ready,origin),restart=renderCompletionNotification(reordered,origin);
 expect(restart).toEqual(first);expect(payloadDigest(restart)).toBe(payloadDigest(first));
 const s=fixture([ready]);await enqueueCompletionNotifications(s.input);await enqueueCompletionNotifications({...s.input,db:fixture([reordered]).db});
 expect(s.calls.filter(c=>c.fn==='case_notification_completion_enqueue')).toHaveLength(1);
});
it('links only the server-returned open questions and keeps a later READY round distinct',()=>{
 const first=round(),later={...first,round_id:'c'.repeat(64),analysis_run_id:randomUUID(),questions:[...first.questions.slice(1),{request_id:randomUUID(),question:'שאלה חדשה מסבב הניתוח הבא'}],request_set_sha256:'d'.repeat(64)};
 const initial=renderCompletionNotification(first,origin),next=renderCompletionNotification(later,origin);
 expect(next.body).not.toContain(first.questions[0].request_id);expect(next.body).toContain(later.questions.at(-1)!.request_id);expect(payloadDigest(next)).not.toBe(payloadDigest(initial));
});
it('renders all supported forty request links within the existing payload limit',()=>{
 const ready=round(40);for(const q of ready.questions)q.question='ש'.repeat(400);
 const message=renderCompletionNotification(ready,origin);expect(message.body.length).toBeLessThanOrEqual(16000);
 for(const q of ready.questions)expect(message.body).toContain(q.request_id);
});
it.each(['duplicate','empty','oversized','missing_round','foreign_host'])('refuses invalid complete round %s without a partial enqueue',async mutation=>{
 const ready=round(),s=fixture([]);const value:Record<string,unknown>={...ready};
 if(mutation==='duplicate')value.questions=[ready.questions[0],ready.questions[0]];
 if(mutation==='empty')value.questions=[];
 if(mutation==='oversized')value.questions=round(41).questions;
 if(mutation==='missing_round')delete value.round_id;
 if(mutation==='foreign_host')expect(()=>renderCompletionNotification(ready,'https://foreign.invalid')).toThrow('MANAGED_NOTIFICATION_ORIGIN');
 else{expect(()=>completionNotificationRoundSchema.parse(value)).toThrow();const malformed=fixture([value]);await expect(enqueueCompletionNotifications(malformed.input)).rejects.toThrow();expect(malformed.calls.filter(c=>c.fn==='case_notification_completion_enqueue')).toHaveLength(0);}
 expect(s.sent).toHaveLength(0);
});
it('does not enqueue to a foreign recipient or on an invented/individual event selection',async()=>{
 const ready=round(),foreign=fixture([{...ready,contact:'foreign@example.invalid'}]);expect(await enqueueCompletionNotifications(foreign.input)).toBe(0);
 const s=fixture([ready]);expect(await enqueueCompletionNotifications({...s.input,enqueueEventKeys:['request:'+ready.questions[0].request_id,'completion:'+'f'.repeat(64)]})).toBe(0);
 expect(await enqueueCompletionNotifications({...s.input,enqueueEventKeys:['completion:'+ready.round_id]})).toBe(1);
 const enqueue=s.calls.find(c=>c.fn==='case_notification_completion_enqueue')!.args;
 expect(decryptNotification(enqueue.target_payload,String(enqueue.target_delivery),secret).to).toBe(contact);
});
it('accepts an enqueue refusal when the current set changed and sends nothing',async()=>{
 const ready=round(),s=fixture([ready]);const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string,args:Readonly<Record<string,unknown>>){if(fn==='case_notification_completion_enqueue')return [{value:null}] as T[];return s.db.rpc<T>(fn,args);}};
 expect(await runAutomaticNotificationPass({...s.input,db,provider:s.provider})).toMatchObject({queued:0,attempts:[]});expect(s.sent).toHaveLength(0);
});
