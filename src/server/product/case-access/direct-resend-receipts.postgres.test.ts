import {expect,it} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {SUPABASE_ROOT_2021_CA} from './supabase-ca';

it.skipIf(process.env.TIVDOC_DIRECT_RECEIPT_DB_PROOF!=='1')('preserves direct receipt identity and delivery across retries and real concurrent DB clients',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('DIRECT_RECEIPT_DEV_ONLY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:15000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),a=client('TIVDOC_WEB_POSTGRES_URL'),b=client('TIVDOC_WEB_POSTGRES_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
 const providerId=randomUUID(),eventId='synthetic-direct-race:'+randomUUID(),email=`direct-receipt-${randomUUID()}@example.invalid`,hash=createHash('sha256').update('email|'+email).digest('hex');let identity:string|undefined,passed=false;
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='';
 try{
  await Promise.all([owner.connect(),a.connect(),b.connect(),worker.connect()]);
  await owner.query(readFileSync('scripts/release-completion/direct-resend-receipt-probe.sql','utf8'));
  identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[hash,email])).rows[0].id;
  const args=[null,identity,'email','access_code','sent','resend',hash,null,providerId];
  const record=(db:pg.Client)=>db.query('select public.case_notification_record_provider($1,$2,$3,$4,$5,$6,$7,$8,$9) id',args);
  const at=new Date().toISOString();const webhook=()=>worker.query('select public.case_notification_webhook_record($1,$2,$3,$4)',[eventId,providerId,'email.delivered',at]);
  const [first,second]=await Promise.all([record(a),record(b),webhook()]);expect(first.rows[0].id).toBe(second.rows[0].id);
  expect((await owner.query('select state,provider_message_id,delivered_at from public.case_notifications where identity_id=$1',[identity])).rows).toEqual([{state:'delivered',provider_message_id:providerId,delivered_at:new Date(at)}]);
  await webhook();expect((await owner.query('select count(*)::int n from private.case_notification_webhooks where event_id=$1',[eventId])).rows[0].n).toBe(1);
  await expect(record(worker)).rejects.toMatchObject({code:'42501'});
  await expect(a.query('select public.case_notification_webhook_record($1,$2,$3,$4)',[eventId,providerId,'email.delivered',at])).rejects.toMatchObject({code:'42501'});
  passed=true;
 }finally{
  await Promise.all([owner,a,b,worker].map(db=>db.query('rollback').catch(()=>{})));
  if(identity){await owner.query('begin');await owner.query('delete from private.case_notification_webhooks where event_id=$1 and provider_message_id=$2',[eventId,providerId]);expect((await owner.query('delete from public.case_identities where id=$1 and contact_normalized=$2',[identity,email])).rowCount).toBe(1);await owner.query('commit');}
  await Promise.all([owner.end(),a.end(),b.end(),worker.end()]);
  mkdirSync('output/release-completion/direct-resend-receipts',{recursive:true});
  writeFileSync('output/release-completion/direct-resend-receipts/db-proof.json',JSON.stringify({verdict:passed?'PASS':'FAIL',checkedAt:new Date().toISOString(),gitSha:sha,gitWorktreeDirty:dirty,migration:'20260909212737_direct_resend_provider_receipts.sql',schema:131,actualDatabase:true,actualConcurrentClients:true,providerCalls:0,webhookEvents:'synthetic DB contract fixtures; no signature/live-provider claim',fixtureRemoved:!!identity,checks:['NULL and foreign receipt guards','early and late webhook order','direct and outbox collision symmetry','unchanged outbox delivery','nullable fence refused','concurrent retry returns one receipt','web role cannot record webhook; worker cannot forge direct receipt'],productionChanged:false},null,2));
 }
},60000);
