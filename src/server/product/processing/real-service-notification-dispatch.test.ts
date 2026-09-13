import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const revalidate=vi.hoisted(()=>vi.fn());
vi.mock('../reports/real-ai-service-notification',()=>({revalidateRealAiReportNotification:revalidate}));
import {encryptNotification} from '../case-access/notification-outbox';
import {payloadDigest,renderReportReady,type NotificationMessage,type NotificationProvider} from '../case-access/notifications';
import type {PostgresQueryResult,PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {runRealAiServiceNotificationPass} from './real-service-notification-dispatch';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const caseId=id(1),identity=id(2),report=id(3),worker=id(4),providerId=id(5),secret=Buffer.alloc(32,17).toString('base64');
const origin='https://real-service.protocol-fixture.org';
const message:NotificationMessage={template:'report_ready',channel:'email',to:'synthetic@protocol-fixture.org',
 ...renderReportReady({publicId:'TV-ABCD1234',linkUrl:`${origin}/case/TV-ABCD1234/reports?report=${report}`})};
const digest=payloadDigest(message);
const claim=()=>({delivery_id:digest,encrypted_payload:encryptNotification(message,digest,secret),fencing_token:1,case_id:caseId,identity_id:identity,report_id:report});
beforeEach(()=>{
 vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED','1');
 vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST',message.to);vi.stubEnv('VERCEL_ENV','test');revalidate.mockReset();
 revalidate.mockResolvedValue({delivery_id:digest,grant_sha256:'a'.repeat(64),expires_at:'2026-09-13T23:00:00Z'});
});
afterEach(()=>vi.unstubAllEnvs());
function setup(){
 const trace:string[]=[],statements:PostgresStatement[]=[],claims=[claim()];let active=false;
 const state={principal:'tivdoc_worker_runtime',tenant:`saved-case:${caseId}`,dispatches:['ready','ready'],finishError:false,onClaim:()=>{},onDispatch:()=>{}};
 const query=async(s:PostgresStatement):Promise<PostgresQueryResult>=>{
  statements.push(s);trace.push(s.name);
  if(s.name==='real_notification_worker_scope')return {row_count:1,rows:[{principal:state.principal,tenant_id:state.tenant}]};
  if(s.name==='real_notification_claim'){const row=claims.shift();state.onClaim();return {row_count:row?1:0,rows:row?[row]:[]};}
  if(s.name==='real_notification_dispatch'){state.onDispatch();return {row_count:1,rows:[{value:state.dispatches.shift()??'ready'}]};}
  if(s.name==='real_notification_finish'){if(state.finishError)throw Error('synthetic SQL error must remain private');return {row_count:1,rows:[{value:null}]};}
  throw Error('UNEXPECTED_STATEMENT');
 };
 const transactions:SavedWorkerTransactions=async operation=>{
  expect(active).toBe(false);active=true;trace.push('begin');
  try{const value=await operation({client:{query},transaction_id:'synthetic'} satisfies PostgresTransactionContext);trace.push('commit');return value;}
  catch(error){trace.push('rollback');throw error;}finally{active=false;}
 };
 const send=vi.fn(async()=>{expect(active).toBe(false);trace.push('provider');return {ok:true as const,provider_message_id:providerId};});
 const provider:NotificationProvider={id:'synthetic-provider',send};
 const input={transactions,caseId,workerId:worker,origin,secret,provider,maxMessages:1};
 return {input,state,trace,statements,claims,send,isActive:()=>active};
}
describe('bounded REAL sender reuses the existing encrypted outbox protocol',()=>{
 it('commits claim, locks before decryption, revalidates, dispatches, sends outside transactions and fences the receipt',async()=>{
  const s=setup();revalidate.mockImplementation(async()=>{expect(s.isActive()).toBe(true);s.trace.push('revalidate');});
  const result=await runRealAiServiceNotificationPass(s.input);
  expect(result).toMatchObject({state:'finished',deliveryConfirmed:false,attempts:[{state:'provider_accepted',provider_message_id:providerId,recorded:true}]});
  expect(s.trace).toEqual(['begin','real_notification_worker_scope','real_notification_claim','commit',
   'begin','real_notification_worker_scope','real_notification_dispatch','revalidate','real_notification_dispatch','commit',
   'provider','begin','real_notification_worker_scope','real_notification_finish','commit']);
  expect(s.send).toHaveBeenCalledWith(message);
  expect(revalidate).toHaveBeenCalledWith(expect.anything(),{case_id:caseId,identity_id:identity,report_id:report},origin,{delivery_id:digest,message});
  expect(s.statements.at(-1)?.values).toEqual([caseId,digest,worker,1,providerId,null]);
  expect(s.statements.every(q=>!q.text.includes('public.case_notification_outbox_claim'))).toBe(true);
 });
 it.each(['TIVDOC_REAL_AI_SERVICE_ENABLED','TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED'])('does no work without %s',async key=>{
  const s=setup();vi.stubEnv(key,'0');expect((await runRealAiServiceNotificationPass(s.input)).state).toBe('disabled');expect(s.trace).toEqual([]);
 });
 it.each([{origin:'http://example.org'},{origin:'https://example.org/private'},{secret:'bad'},{maxMessages:11}])('rejects private configuration %j before claim',async invalid=>{
  const s=setup();await expect(runRealAiServiceNotificationPass({...s.input,...invalid})).rejects.toThrow();expect(s.trace).toEqual([]);
 });
 it.each(['principal','tenant'] as const)('requires authenticated %s on every transaction',async kind=>{
  const s=setup();s.state[kind]=kind==='principal'?'tivdoc_web_runtime':`saved-case:${id(20)}`;
  await expect(runRealAiServiceNotificationPass(s.input)).rejects.toThrow('REAL_SERVICE_NOTIFICATION_WORKER_FORBIDDEN');expect(s.send).not.toHaveBeenCalled();
 });
 it('rejects a foreign claim before fetching authority or decrypting',async()=>{
  const s=setup();s.claims[0].case_id=id(20);await expect(runRealAiServiceNotificationPass(s.input)).rejects.toThrow('REAL_SERVICE_NOTIFICATION_CLAIM_SCOPE');
  expect(revalidate).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();
 });
 it('commits cancellation without decrypting malformed ciphertext or calling a provider',async()=>{
  const s=setup();s.state.dispatches=['cancelled'];s.claims[0].encrypted_payload.ciphertext='corrupt';
  expect((await runRealAiServiceNotificationPass(s.input)).attempts).toMatchObject([{state:'cancelled',recorded:true}]);
  expect(revalidate).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();expect(s.statements.some(q=>q.name==='real_notification_finish')).toBe(false);
 });
 it('retains the claimed lease when ciphertext authentication fails, without a provider receipt',async()=>{
  const s=setup();s.claims[0].encrypted_payload.tag=Buffer.alloc(16).toString('base64');
  await expect(runRealAiServiceNotificationPass(s.input)).rejects.toThrow();expect(s.send).not.toHaveBeenCalled();expect(s.trace.at(-1)).toBe('rollback');
 });
 it('does not send after REAL report or message revalidation fails',async()=>{
  const s=setup();revalidate.mockRejectedValue(Error('REAL_SERVICE_NOTIFICATION_PAYLOAD_CHANGED'));
  await expect(runRealAiServiceNotificationPass(s.input)).rejects.toThrow('REAL_SERVICE_NOTIFICATION_PAYLOAD_CHANGED');expect(s.send).not.toHaveBeenCalled();
 });
 it('checks the lease and expiry again after replay/rerender',async()=>{
  const s=setup();s.state.dispatches=['ready','cancelled'];
  expect((await runRealAiServiceNotificationPass(s.input)).attempts[0].state).toBe('cancelled');expect(revalidate).toHaveBeenCalledOnce();expect(s.send).not.toHaveBeenCalled();
 });
 it('records an uncertain transport as the same-key retry intention without inventing a provider receipt',async()=>{
  const s=setup(),provider:NotificationProvider={id:'synthetic-provider',async send(){throw Error('private transport details');}};
  const result=await runRealAiServiceNotificationPass({...s.input,provider});
  expect(result.attempts).toMatchObject([{delivery_id:digest,state:'provider_unconfirmed',provider_message_id:null,error_code:'provider_transport_uncertain',recorded:true}]);
  expect(s.statements.at(-1)?.values).toEqual([caseId,digest,worker,1,null,'provider_transport_uncertain']);
 });
 it('does not claim provider acceptance when the provider omits its ID',async()=>{
  const s=setup(),provider:NotificationProvider={id:'synthetic-provider',async send(){return {ok:true};}};
  const result=await runRealAiServiceNotificationPass({...s.input,provider});expect(result.attempts[0]).toMatchObject({state:'provider_unconfirmed',provider_message_id:null,error_code:'provider_receipt_missing'});
 });
 it('stops after an uncertain finish and preserves the accepted digest for lease recovery',async()=>{
  const s=setup();s.state.finishError=true;s.claims.push({...claim(),fencing_token:2});
  const result=await runRealAiServiceNotificationPass({...s.input,maxMessages:2});
  expect(result).toMatchObject({state:'held',reason:'finish_unconfirmed',attempts:[{delivery_id:digest,state:'provider_accepted',recorded:false}]});
  expect(s.send).toHaveBeenCalledOnce();expect(s.claims).toHaveLength(1);
 });
 it('aborts after claim without releasing the durable lease as a fake send',async()=>{
  const s=setup(),control=new AbortController();s.state.onClaim=()=>control.abort();
  expect((await runRealAiServiceNotificationPass({...s.input,signal:control.signal})).state).toBe('interrupted');expect(s.send).not.toHaveBeenCalled();expect(revalidate).not.toHaveBeenCalled();
 });
 it('honors a kill switch changed during preparation',async()=>{
  const s=setup();s.state.onDispatch=()=>vi.stubEnv('TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED','0');
  expect((await runRealAiServiceNotificationPass(s.input)).state).toBe('disabled');expect(s.send).not.toHaveBeenCalled();
 });
 it('still persists an observed provider result if shutdown arrives during send',async()=>{
  const s=setup(),control=new AbortController(),provider:NotificationProvider={id:'synthetic-provider',async send(){control.abort();return {ok:true,provider_message_id:providerId};}};
  const result=await runRealAiServiceNotificationPass({...s.input,provider,signal:control.signal,maxMessages:2});
  expect(result.state).toBe('interrupted');expect(result.attempts[0]).toMatchObject({provider_message_id:providerId,recorded:true});
 });
});
