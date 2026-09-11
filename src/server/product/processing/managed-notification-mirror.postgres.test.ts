import {expect,it,vi} from 'vitest';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {offerSnapshot} from '../orders/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
vi.mock('server-only',()=>({}));

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
// No provider, OCR, report builder, customer session or send API is imported.
// Synthetic receipt events exercise only SQL state transitions, all rolled back.
it.skipIf(process.env.TIVDOC_MANAGED_NOTIFICATION_MIRROR_DB_PROOF!=='1')('mirrors scoped synthetic receipts in rollback and replays an existing managed event without sending',async()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL||process.env.VERCEL_ENV)throw Error('MIRROR_PROOF_SCOPE');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile('../release-work/replay.env');
 const connect=(key:string,role:string)=>{const u=new URL(env.get(key)!);expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username).toBe(role+'.cpzrbidxftzqcfeqqusu');u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:10000});};
 const owner=connect('TIVDOC_DEV_DATABASE_URL','tivdoc_dev_migrator'),worker=connect('TIVDOC_WORKER_POSTGRES_URL','tivdoc_worker_runtime');
 const runId=randomUUID(),caseId=randomUUID(),email=`mirror-rollback-${runId}@example.invalid`,recipient=sha('email|'+email),sid='mirror-rollback:'+runId,jti=randomUUID(),digest=sha(randomBytes(32).toString('hex'));
 const checks:string[]=[],deliveries:string[]=[],providers:string[]=[],events:string[]=[];let failure:string|null=null,rollbackVerified=false;
 const refused=async(db:pg.Client,operation:()=>Promise<unknown>,message:string)=>{await db.query('savepoint negative_probe');try{await expect(operation()).rejects.toThrow(message);}finally{await db.query('rollback to savepoint negative_probe');await db.query('release savepoint negative_probe');}};
 try{
  await owner.connect();await worker.connect();
  expect((await owner.query('select current_database() db,session_user role')).rows[0]).toEqual({db:'tivdoc_release_replay_20260907',role:'tivdoc_dev_migrator'});
  expect((await worker.query('select current_database() db,session_user role')).rows[0]).toEqual({db:'tivdoc_release_replay_20260907',role:'tivdoc_worker_runtime'});
  const acl=(await owner.query("select has_function_privilege(role,'private.managed_notification_product_mirror(text,uuid,text)','execute') allowed from unnest(array['anon','authenticated','service_role','tivdoc_web_runtime','tivdoc_worker_runtime','tivdoc_operations_runtime']) role")).rows;
  expect(acl).toHaveLength(6);expect(acl.every(r=>r.allowed===false)).toBe(true);
  const definition=(await owner.query("select pg_get_functiondef('public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text)'::regprocedure) body")).rows[0].body as string;
  expect(definition).toContain('private.managed_notification_product_mirror(digest,expected_case,prior)');expect(definition).toContain('private.managed_notification_product_mirror(digest,row.case_id,target_delivery)');
  checks.push('applied_enqueue_has_fresh_and_replay_mirror_hooks_private_helper_not_runtime_callable');
  await owner.query('begin');
  await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic rollback mirror',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01')",[caseId,email]);
  const identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[recipient,email])).rows[0].id as string;
  await owner.query('select public.case_access_identity_link($1,$2)',[identity,caseId]);
  const offer=offerSnapshot('initial'),orderId=randomUUID();
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.rollback.notification.worker',$3,now()-interval '1 minute',now()+interval '20 minutes',$4,now())",['saved-case:'+caseId,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,notification_recipients) values($1,now()+interval '20 minutes',$2)",[digest,[recipient]]);
  await owner.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4)',[caseId,identity,sid,digest]);
  for(const template of ['document_request','report_ready']){
   const delivery=sha(runId+template),provider=randomUUID(),event=`mirror-rollback:${runId}:${template}`,at=new Date(),lease=randomUUID();deliveries.push(delivery);providers.push(provider);events.push(event);
   await owner.query('select public.case_notification_outbox_enqueue($1,$2,$3,$4,$5,$6,now()+interval \'10 minutes\')',[delivery,caseId,identity,recipient,template,{synthetic_rollback_only:true}]);
   // Historical event fixture only: no question, analysis, finding or report is
   // fabricated. It deliberately fails current-event admission and cannot send.
   const sourceEvent=(template==='document_request'?'request:':'report:')+randomUUID();
   await owner.query('insert into private.managed_dev_notification_events(event_key,case_id,delivery_id) values($1,$2,$3)',[sourceEvent,caseId,delivery]);
   expect((await owner.query('select private.managed_dev_notification_event_current($1,$2) value',[caseId,sourceEvent])).rows[0].value).toBe(false);
   const mirror=async(cap=digest,c=caseId)=>(await owner.query('select private.managed_notification_product_mirror($1,$2,$3) id',[cap,c,delivery])).rows[0].id as string;
   const first=await mirror();expect(await mirror()).toBe(first);
   expect((await owner.query('select state,provider_message_id,delivered_at from public.case_notifications where id=$1',[first])).rows[0]).toEqual({state:'queued',provider_message_id:null,delivered_at:null});
   await refused(owner,()=>mirror('f'.repeat(64)),'MANAGED_NOTIFICATION_MIRROR_SCOPE');await refused(owner,()=>mirror(digest,randomUUID()),'MANAGED_NOTIFICATION_MIRROR_SCOPE');
   await owner.query('savepoint removed_identity');await owner.query('delete from public.case_identity_cases where case_id=$1 and identity_id=$2',[caseId,identity]);await refused(owner,()=>mirror(),'MANAGED_NOTIFICATION_MIRROR_SCOPE');await owner.query('rollback to savepoint removed_identity');
   const webhook=()=>owner.query('select public.case_notification_webhook_record($1,$2,\'email.delivered\',$3)',[event,provider,at]);
   if(template==='document_request')await webhook(); // A callback can precede acceptance persistence.
   await owner.query("update private.case_notification_outbox set state='leased',attempts=1,fencing_token=1,lease_owner=$2,lease_expires_at=now()+interval '1 minute' where delivery_id=$1",[delivery,lease]);
   await owner.query('select public.case_notification_outbox_finish($1,$2,1,$3,null)',[delivery,lease,provider]);
   if(template==='report_ready'){
    expect((await owner.query('select state,delivered_at from public.case_notifications where id=$1',[first])).rows[0]).toEqual({state:'sent',delivered_at:null});await webhook();
   }
   await webhook();expect(await mirror()).toBe(first);
   expect((await owner.query('select state,provider_message_id,delivered_at from public.case_notifications where id=$1',[first])).rows[0]).toEqual({state:'delivered',provider_message_id:provider,delivered_at:at});
   expect((await owner.query('select count(*)::int n from private.case_notification_webhooks where event_id=$1',[event])).rows[0].n).toBe(1);
   expect((await owner.query('select count(*)::int n from public.case_notifications where payload_sha256=$1',[delivery])).rows[0].n).toBe(1);
   await refused(owner,()=>owner.query("select public.case_notification_webhook_record($1,$2,'email.failed',$3)",[event,provider,at]),'WEBHOOK_REPLAY_MISMATCH');
  }
  checks.push('both_templates_new_mirror_and_replay_one_row_exact_case_capability_and_identity_required','synthetic_early_and_late_webhook_replay_delivers_once_no_provider_called','provider_acceptance_alone_remains_sent_no_delivery_claim');
  await owner.query('rollback');
  expect((await owner.query('select count(*)::int n from public.cases where id=$1',[caseId])).rows[0].n).toBe(0);
  expect((await owner.query('select count(*)::int n from private.case_notification_webhooks where event_id=any($1)',[events])).rows[0].n).toBe(0);
  expect((await owner.query('select count(*)::int n from public.case_notifications where payload_sha256=any($1)',[deliveries])).rows[0].n).toBe(0);rollbackVerified=true;

  // Reuse only the authorized capability and already-persisted event. These
  // calls take no claim and cannot call a provider; every update is rolled back.
  const control=JSON.parse(readFileSync('../release-work/sol-scheduled-control-20260911.private.json','utf8')) as {caseId:string;capability:string;capabilitySha:string};
  expect(control.caseId).toBe('33f41e2f-56b5-420c-8ee2-310201813d35');expect(sha(control.capability)).toBe(control.capabilitySha);
  const existing=(await owner.query("select n.event_key,n.delivery_id,o.identity_id,o.recipient_sha256 from private.managed_dev_notification_events n join private.case_notification_outbox o using(delivery_id) join private.managed_dev_worker_cases m on m.case_id=n.case_id join public.cases c on c.id=m.case_id and c.is_qa where n.case_id=$1 and m.capability_sha256=$2 and m.enabled order by n.event_key limit 1",[control.caseId,control.capabilitySha])).rows[0];expect(existing).toBeDefined();
  const snapshot=async()=>JSON.stringify((await owner.query('select to_jsonb(o) outbox,(select jsonb_agg(to_jsonb(p) order by p.id) from public.case_notifications p where p.payload_sha256=o.delivery_id) mirrors from private.case_notification_outbox o where o.delivery_id=$1',[existing.delivery_id])).rows[0]);
  const before=await snapshot();await worker.query('begin');
  const replay=async(c=control.caseId,i=existing.identity_id,r=existing.recipient_sha256)=>(await worker.query('select public.case_notification_managed_enqueue($1,$2,$3,$4,now()+interval \'10 minutes\',$5,$6,$7) value',[control.capability,existing.event_key,existing.delivery_id,{synthetic_unused_replay:true},c,i,r])).rows[0].value;
  expect(await replay()).toBe(existing.delivery_id);expect(await replay()).toBe(existing.delivery_id);
  expect(await replay(randomUUID())).toBeNull();expect(await replay(control.caseId,randomUUID())).toBeNull();expect(await replay(control.caseId,existing.identity_id,'0'.repeat(64))).toBeNull();
  await refused(worker,()=>worker.query('select private.managed_notification_product_mirror($1,$2,$3)',[control.capabilitySha,control.caseId,existing.delivery_id]),'permission denied');
  await worker.query('rollback');expect(await snapshot()).toBe(before);checks.push('actual_worker_existing_enqueue_replay_and_foreign_snapshots_refused_no_state_or_outbox_change');
 }catch(error){failure=error instanceof Error?error.message:'unknown_failure';throw error;}finally{
  await Promise.allSettled([owner.query('rollback'),worker.query('rollback')]);await Promise.allSettled([owner.end(),worker.end()]);
  const directory='output/release-completion/sol-scheduled-20260911';mkdirSync(directory,{recursive:true});
  writeFileSync(`${directory}/mirror-rollback-${runId}.json`,JSON.stringify({at:new Date().toISOString(),state:failure?'FAIL':'PASS',error:failure,gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks,rollbackVerified,
   schemaMigration:'20260911015947_managed_notification_product_mirror.sql',schemaSha256:sha(readFileSync('supabase/migrations/20260911015947_managed_notification_product_mirror.sql','utf8')),providerCalls:0,syntheticWebhookEventsOnly:true,ownerDeliveryClaimed:false,freshManagedEnqueueNewlyProven:false,productionChanged:false},null,2)+'\n',{flag:'wx'});
 }
},90000);
