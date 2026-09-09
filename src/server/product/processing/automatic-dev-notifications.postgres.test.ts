import {expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {Webhook} from 'svix';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {productOffer} from '@/lib/product-offer';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb} from '../case-access/db';
import {normalizeContact,sha256Hex,hashRequesterIp} from '../case-access/crypto';
import {requestAccessCode,verifyAccessCode,resolveIdentitySession,listIdentityCases} from '../case-access/service';
import {enqueueNotification} from '../case-access/notification-outbox';
import {payloadDigest,type NotificationMessage,type NotificationProvider} from '../case-access/notifications';
import {verifyResendWebhook} from '../case-access/resend-webhook';
import {offerSnapshot} from '../orders/contracts';
import {runAutomaticNotificationPass} from './automatic-dev-notifications';
vi.mock('server-only',()=>({}));

// Actual SQL and service calls, injected message transport only. No findings,
// document field targets, report payloads, delivery events or OTPs are seeded.
it.skipIf(process.env.TIVDOC_AUTOMATIC_NOTIFICATION_DB_PROOF!=='1')('proves isolated DEV OTP and scoped notification delivery with synthetic authenticated webhook receipts',async()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL||process.env.VERCEL_ENV)throw Error('NOTIFICATION_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const url=new URL(env.get(key)!);expect(url.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(url.pathname).toBe('/tivdoc_release_replay_20260907');expect(url.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);url.search='';return new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:15000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),web=client('TIVDOC_WEB_POSTGRES_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
 const adapt=(c:pg.Client)=>postgresCaseAccessDb({query:(sql,values)=>c.query(sql,values?[...values]:[])}),webDb=adapt(web),workerDb=adapt(worker);
 const runId=randomUUID(),secret=randomBytes(32).toString('base64'),tokenSecret=randomBytes(40).toString('base64url');
 const cases=[0,1].map(()=>{const id=randomUUID(),email=`automatic-notification-${id}@example.invalid`;return {id,email,hash:normalizeContact(email)!.hash,identity:'',publicId:'',sid:`notification-proof:${randomUUID()}`,jti:randomUUID(),capability:randomBytes(32).toString('base64url'),orderId:randomUUID()};}),primary=cases[0],foreign=cases[1];
 const sent:{message:NotificationMessage;providerId:string}[]=[],checks:string[]=[],requestHashes:string[]=[],providerIds:string[]=[];
 const provider:NotificationProvider={id:'injected_notification_db_test',async send(message){const providerId=randomUUID();sent.push({message,providerId});providerIds.push(providerId);return {ok:true,provider_message_id:providerId};}};
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gitDirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const privatePath=`../release-work/automatic-notification-proof-${runId}.json`;mkdirSync('../release-work',{recursive:true});
 let seeded=false,cleaned=false,foreignIdentityDeleted=false,failure:string|null=null,cleanupFailure:string|null=null;
 const saveOwned=()=>writeFileSync(privatePath,JSON.stringify({runId,cases:cases.map(c=>({id:c.id,identity:c.identity,sid:c.sid,capabilitySha:sha256Hex(c.capability)})),requestHashes,providerIds},null,2));
 const checked=(value:string)=>{checks.push(value);saveOwned();};
 const pass=(capability=primary.capability)=>runAutomaticNotificationPass({db:workerDb,capability,secret,origin:'https://tivdoc-synthetic.vercel.app',provider});
 const request=async(c=primary)=>{const req=new Request('http://localhost/api/cases/access/request',{method:'POST',headers:{'x-forwarded-for':`192.0.2.${requestHashes.length+1}`}});requestHashes.push(hashRequesterIp(req,tokenSecret));saveOwned();return requestAccessCode({contact:c.email,request:req},webDb);};
 const latestCode=async(c=primary)=>(await owner.query('select id,attempts,max_attempts,consumed_at,expires_at from public.case_access_codes where identity_id=$1 order by created_at desc,id desc limit 1',[c.identity])).rows[0];
 const codeFrom=(index:number)=>{const code=/\b([0-9]{6})\b/u.exec(sent[index].message.body)?.[1];if(!code)throw Error('NOTIFICATION_PROOF_CODE_MISSING');return code;};
 vi.stubEnv('CASE_TOKEN_SECRET',tokenSecret);vi.stubEnv('TIVDOC_NOTIFICATION_OUTBOX_ENABLED','true');vi.stubEnv('TIVDOC_NOTIFICATION_ENCRYPTION_KEY',secret);vi.stubEnv('DELIVERY_RECIPIENT_ALLOWLIST',cases.map(c=>c.email).join(','));
 try{
  await Promise.all([owner.connect(),web.connect(),worker.connect()]);expect((await owner.query('select session_user,current_database() database')).rows[0]).toEqual({session_user:'tivdoc_dev_migrator',database:'tivdoc_release_replay_20260907'});
  expect((await owner.query("select to_regprocedure('public.case_notification_managed_claim(text,uuid)') is not null ready")).rows[0].ready).toBe(true);
  await owner.query('begin');
  for(const c of cases){
   c.publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic automatic notification',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[c.id,c.email])).rows[0].public_id;
   c.identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[c.hash,c.email])).rows[0].id;await owner.query('select public.case_access_identity_link($1,$2)',[c.identity,c.id]);
   const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[c.orderId,c.id,offer.amount_minor,offer,offer.sha256,offer.terms_version]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[c.orderId]);
   await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.notification.worker',$3,now()-interval '1 minute',now()+interval '2 hours',$4,now())",[`saved-case:${c.id}`,c.sid,c.jti,canonicalSha256({sid:c.sid,jti:c.jti})]);
   await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,notification_recipients) values($1,clock_timestamp()+interval '2 hours',$2::text[])",[sha256Hex(c.capability),[c.hash]]);
   await owner.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4)',[c.id,c.identity,c.sid,sha256Hex(c.capability)]);
  }
  await owner.query('commit');seeded=true;saveOwned();
  const requested=await request();expect(requested.accepted).toBe(true);expect(sent).toHaveLength(0);
  const queued=(await owner.query('select delivery_id,state,encrypted_payload from private.case_notification_outbox where identity_id=$1',[primary.identity])).rows;expect(queued).toHaveLength(1);expect(queued[0].state).toBe('queued');expect(JSON.stringify(queued[0].encrypted_payload)).not.toContain(primary.email);
  await expect(pass(randomBytes(32).toString('base64url'))).rejects.toThrow('MANAGED_DEV_CAPABILITY_FORBIDDEN');expect((await pass(foreign.capability)).attempts).toEqual([]);expect(sent).toHaveLength(0);
  await expect(webDb.rpc('case_notification_managed_claim',{target_capability:primary.capability,target_worker:randomUUID()})).rejects.toMatchObject({code:'42501'});
  checked('actual access service queues one encrypted OTP; invalid capability, a valid foreign recipient capability and the web role cannot claim it');
  const accepted=await pass();expect(accepted).toMatchObject({deliveryConfirmed:false,attempts:[{state:'provider_accepted',provider:'injected_notification_db_test'}]});expect(sent).toHaveLength(1);expect(sent[0].message.to).toBe(primary.email);
  const firstCode=codeFrom(0),deliveryId=payloadDigest(sent[0].message);expect(deliveryId).toBe(queued[0].delivery_id);
  const receipt=(await owner.query('select state,encrypted_payload,delivered_at from private.case_notification_outbox where delivery_id=$1',[deliveryId])).rows[0];expect(receipt).toEqual({state:'sent',encrypted_payload:null,delivered_at:null});
  expect((await pass()).attempts).toEqual([]);expect(sent).toHaveLength(1);checked('injected provider acceptance produces sent state without delivery; a repeated managed pass sends no duplicate and clears encrypted OTP bytes');
  expect((await verifyAccessCode({contact:foreign.email,code:firstCode},webDb)).outcome).toBe('invalid');
  const login=await verifyAccessCode({contact:primary.email,code:firstCode},webDb);expect(login.outcome).toBe('ok');if(login.outcome!=='ok')throw Error('NOTIFICATION_PROOF_LOGIN');
  expect(login.next).toBe(`/case/${primary.publicId}`);expect((await resolveIdentitySession(login.session,webDb))?.identity_id).toBe(primary.identity);
  expect((await listIdentityCases(primary.identity,webDb)).map(c=>c.case_id)).toEqual([primary.id]);
  expect((await verifyAccessCode({contact:primary.email,code:firstCode},webDb)).outcome).toBe('invalid');
  await expect(web.query('select public.case_report_dev_financial($1,$2)',[primary.id,foreign.identity])).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');
  checked('actual issued code opens an identity session and only its owned case; foreign identity, report access and reuse of the consumed OTP are refused');
  const webhookSecret='whsec_'+randomBytes(32).toString('base64'),at=new Date(),eventId=`notification-proof:${runId}`,raw=JSON.stringify({type:'email.delivered',created_at:at.toISOString(),data:{email_id:sent[0].providerId}});
  const headers=new Headers({'svix-id':eventId,'svix-timestamp':String(Math.floor(at.getTime()/1000)),'svix-signature':new Webhook(webhookSecret).sign(eventId,at,raw)});
  expect(()=>verifyResendWebhook(raw+' ',headers,webhookSecret)).toThrow();const old=new Date(at.getTime()-600000),stale=new Headers(headers);stale.set('svix-timestamp',String(Math.floor(old.getTime()/1000)));stale.set('svix-signature',new Webhook(webhookSecret).sign(eventId,old,raw));expect(()=>verifyResendWebhook(raw,stale,webhookSecret)).toThrow();
  const event=verifyResendWebhook(raw,headers,webhookSecret),webhookArgs={target_event:event.event_id,target_provider:event.provider_message_id,target_kind:event.kind,target_at:event.occurred_at};
  await expect(webDb.rpc('case_notification_webhook_record',webhookArgs)).rejects.toMatchObject({code:'42501'});
  await workerDb.rpc('case_notification_webhook_record',webhookArgs);await workerDb.rpc('case_notification_webhook_record',webhookArgs);
  expect((await owner.query('select state,delivered_at from private.case_notification_outbox where delivery_id=$1',[deliveryId])).rows[0]).toMatchObject({state:'delivered',delivered_at:expect.any(Date)});
  expect((await owner.query('select count(*)::int n from private.case_notification_webhooks where event_id=$1',[eventId])).rows[0].n).toBe(1);
  await expect(workerDb.rpc('case_notification_webhook_record',{...webhookArgs,target_kind:'email.bounced'})).rejects.toThrow('WEBHOOK_REPLAY_MISMATCH');
  checked('production signature verifier rejects tampered/expired signatures; verified synthetic webhook and exact replay persist one delivered event, with foreign web-role and mismatched replay refused');
  await request();await pass();expect(sent).toHaveLength(2);const expiring=await latestCode();
  expect(expiring.expires_at.getTime()).toBeGreaterThan(Date.now());
  expect((await owner.query("update public.case_access_codes set expires_at=clock_timestamp()-interval '1 second' where id=$1 and identity_id=$2",[expiring.id,primary.identity])).rowCount).toBe(1);
  expect((await verifyAccessCode({contact:primary.email,code:codeFrom(1)},webDb)).outcome).toBe('expired');
  checked('real database expiry rejects the generated OTP; only this owned fixture expiry is moved into the past, with no fake service clock or TTL bypass');
  await request();await pass();expect(sent).toHaveLength(3);const locking=await latestCode(),actual=codeFrom(2),wrong=actual==='000000'?'111111':'000000';expect(locking.max_attempts).toBe(productOffer().access.code_max_attempts);
  for(let i=1;i<=locking.max_attempts;i++)expect((await verifyAccessCode({contact:primary.email,code:wrong},webDb)).outcome).toBe(i===locking.max_attempts?'locked':'invalid');
  expect((await verifyAccessCode({contact:primary.email,code:actual},webDb)).outcome).toBe('locked');expect((await latestCode()).attempts).toBe(locking.max_attempts);
  checked('all configured incorrect attempts are counted in DB and the actual valid code remains refused after lockout');
  const boundMessage:NotificationMessage={template:'document_request',channel:'email',to:primary.email,subject:'Synthetic authorization probe',body:'Synthetic authorization probe only; no generated field request or report is claimed.'};
  const bound=await enqueueNotification(webDb,{caseId:primary.id,identityId:primary.identity,message:boundMessage,secret});
  expect((await owner.query('delete from public.case_identity_cases where case_id=$1 and identity_id=$2',[primary.id,primary.identity])).rowCount).toBe(1);
  expect((await pass()).attempts).toEqual([]);expect(sent).toHaveLength(3);
  await owner.query('select public.case_access_identity_link($1,$2)',[primary.identity,primary.id]);
  await owner.query("update private.case_notification_outbox set expires_at=clock_timestamp()-interval '1 second' where delivery_id=$1 and case_id=$2",[bound,primary.id]);
  expect((await pass()).attempts).toEqual([]);expect((await owner.query('select state,encrypted_payload,last_error from private.case_notification_outbox where delivery_id=$1',[bound])).rows[0]).toEqual({state:'dead_letter',encrypted_payload:null,last_error:'delivery_expired'});
  checked('removing the owned identity/case link prevents queued case-bound delivery; after link restoration an expired intention is scrubbed without a provider call');
  await request(foreign);expect((await owner.query('select count(*)::int n from private.case_notification_outbox where identity_id=$1',[foreign.identity])).rows[0].n).toBe(1);
  await owner.query('delete from private.managed_dev_worker_cases where case_id=$1 and identity_id=$2',[foreign.id,foreign.identity]);await owner.query('delete from public.case_identities where id=$1',[foreign.identity]);foreignIdentityDeleted=true;
  expect((await pass(foreign.capability)).attempts).toEqual([]);expect(sent).toHaveLength(3);expect((await owner.query('select count(*)::int n from private.case_notification_outbox where identity_id=$1',[foreign.identity])).rows[0].n).toBe(0);
  checked('deleting only the owned synthetic identity removes its queued OTP and a later scoped pass sends nothing');
 }catch(error){failure=error instanceof Error?error.message:'NOTIFICATION_PROOF_FAILED';throw error;}finally{
  await Promise.all([owner,web,worker].map(c=>c.query('rollback').catch(()=>{})));
  try{if(seeded){await owner.query('begin');for(const c of cases){await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[`saved-case:${c.id}`]);await owner.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=clock_timestamp() where case_id=$1',[c.id]);await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[sha256Hex(c.capability)]);await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where sid=$1 and tenant_id=$2',[c.sid,`saved-case:${c.id}`]);}
   await owner.query('delete from private.case_notification_webhooks where provider_message_id=any($1::uuid[])',[providerIds]);await owner.query('delete from public.case_access_requests where requester_ip_hash=any($1::text[])',[requestHashes]);
   expect((await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic automatic notification'",[cases.map(c=>c.id)])).rowCount).toBe(2);
   expect((await owner.query('delete from public.case_identities where id=any($1::uuid[])',[cases.map(c=>c.identity)])).rowCount).toBe(foreignIdentityDeleted?1:2);await owner.query('commit');cleaned=true;
  }}catch(error){cleanupFailure=error instanceof Error?error.message:'NOTIFICATION_PROOF_CLEANUP_FAILED';await owner.query('rollback').catch(()=>{});throw error;}finally{
   writeFileSync('docs/release-evidence/DEV-automatic-notifications-db.json',JSON.stringify({verdict:!failure&&!cleanupFailure&&cleaned&&checks.length===8?'PASS':'FAIL',gitSha,gitWorktreeDirty:gitDirty,runId,checks,failure,cleanupFailure,
    database:'tivdoc_release_replay_20260907',schemaRequired:'20260909154033',otpIssuedAndVerified:checks.length>=3,providerKind:'injected_notification_db_test',providerAccepted:sent.length,realEmailDelivery:false,actualOwnerInbox:false,authenticatedWebhookProof:checks.length>=4,webhookHttpRoute:false,
    generatedFieldOrReportNotificationDbProof:false,syntheticCasesRemoved:cleaned?2:0,identitiesRemoved:cleaned?2:0,capabilitiesRevoked:cleaned,budgetAuditRetained:true,productionChanged:false},null,2)+'\n');
   vi.unstubAllEnvs();await Promise.all([owner.end(),web.end(),worker.end()]);
  }
 }
},120000);
