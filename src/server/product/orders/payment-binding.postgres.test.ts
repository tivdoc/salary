import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from './contracts';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_PAYMENT_BINDING_DB_PROOF!=='1')('binds verification to the saved payment and requires one actual payment row',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('PAYMENT_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 const u=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';
 const db=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});
 const caseId=randomUUID(),orderId=randomUUID(),paymentId=`synthetic-payment:${orderId}`,logId=`synthetic-log:${orderId}`;
 const migration='20260908182405_payment_reference_binding.sql',checks:string[]=[];let failure:string|null=null,rolledBack=false,committedFixture=false;
 const runtimeClients:pg.Client[]=[];
 writeFileSync(`../release-work/payment-binding-owned-${caseId}.json`,JSON.stringify({caseId,orderId,availabilityMarker:'synthetic-binding:'+caseId,scope:'One synthetic QA case in isolated DEV; no Storage object created.'}));
 await db.connect();
 const attempt=async(payment:string,expectedError?:string)=>{
  await db.query('savepoint payment_attempt');
  let value:unknown;
  try{
   const r=await db.query("select public.case_order_payment_verify($1,$2,$3,'synthetic-confirmation',999,'ILS') value",[orderId,logId,payment]);
   value=r.rows[0].value;
  }catch(e){await db.query('rollback to savepoint payment_attempt');if(expectedError){expect((e as Error).message).toContain(expectedError);return;}throw e;}
  if(expectedError)throw new Error('EXPECTED_REFUSAL_NOT_OBSERVED');return value;
 };
 try{
  await db.query('begin');
  if(process.env.TIVDOC_PAYMENT_BINDING_CANDIDATE==='1')await db.query(readFileSync('supabase/migrations/'+migration,'utf8'));
  await db.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic payment binding','payment-binding@example.invalid','0500000000',true,'documents_uploaded','not_started',now(),'2020-01-01')",[caseId]);
  await db.query("insert into public.documents(case_id,document_type,slot,storage_path,original_filename,mime_type,size) values($1,'payslip','payslip-01',$2,'synthetic.pdf','application/pdf',100)",[caseId,`cases/${caseId}/synthetic.pdf`]);
  const offer=offerSnapshot('initial');
  await db.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version) values($1,$2,'initial','2020-01-01','2020-01-01',999,'ILS',$3,$4,array['pension'],$5)",[orderId,caseId,offer,offer.sha256,offer.terms_version]);
  await db.query("insert into private.order_availability(kind,topic,period_from,period_to,ready,evidence_reference) values('initial','pension','2020-01-01','2020-01-01',true,$1)",['synthetic-binding:'+caseId]);
  await db.query("insert into private.order_checkouts(order_id,attempt_id,state,return_hash,return_expires_at,provider_order_id,provider_log_id,provider_payment_id) values($1,$2,'ready',$3,now()+interval '1 hour',$4,$5,$6)",[orderId,randomUUID(),createHash('sha256').update(orderId).digest('hex'),'synthetic-order:'+orderId,logId,paymentId]);
  await db.query("insert into public.payments(case_id,order_id,provider,amount,currency,status,idempotency_key,provider_payment_id) values($1,$2,'invoice4u',9.99,'ILS','pending',$3,$4)",[caseId,orderId,'synthetic-binding:'+orderId,paymentId]);
  await attempt('different-payment','ORDER_PAYMENT_MISMATCH');checks.push('contradictory checkout payment reference refused');
  expect((await db.query('select state from private.product_orders where id=$1',[orderId])).rows[0].state).toBe('awaiting_payment');
  expect((await db.query('select count(*)::int n from private.order_entitlements where order_id=$1',[orderId])).rows[0].n).toBe(0);checks.push('refusal leaves order unpaid and entitlement absent');
  await db.query('savepoint missing_payment');await db.query('delete from public.payments where order_id=$1',[orderId]);
  await attempt(paymentId,'ORDER_PAYMENT_RECORD_MISSING');await db.query('rollback to savepoint missing_payment');checks.push('missing payment row cannot create a paid order');
  const pending=(await db.query('select public.case_order_payment_pending(100) value')).rows[0].value;
  expect(pending.find((row:{id:string})=>row.id===orderId)?.provider_payment_id).toBe(paymentId);checks.push('pending verification carries the saved payment reference');
  await db.query('savepoint unknown_payment');
  await db.query('update private.order_checkouts set provider_payment_id=null where order_id=$1',[orderId]);await db.query('update public.payments set provider_payment_id=null where order_id=$1',[orderId]);
  expect(await attempt(paymentId)).toBe(true);await db.query('rollback to savepoint unknown_payment');checks.push('initially unknown payment can be discovered through its exact saved log');
  await db.query('savepoint conflicting_record');await db.query("update public.payments set provider_payment_id='different-record' where order_id=$1",[orderId]);
  await attempt(paymentId,'ORDER_PAYMENT_MISMATCH');await db.query('rollback to savepoint conflicting_record');checks.push('contradictory saved payment row refused');
  await db.query('savepoint before_verification');
  expect(await attempt(paymentId)).toBe(true);expect(await attempt(paymentId)).toBe(false);checks.push('exact verified observation is idempotent');
  expect((await db.query('select count(*)::int n from private.order_entitlements where order_id=$1',[orderId])).rows[0].n).toBe(1);
  expect((await db.query("select count(*)::int n from private.order_events where order_id=$1 and kind='payment_verified'",[orderId])).rows[0].n).toBe(1);checks.push('one payment event and entitlement across replay');
  await attempt('different-payment','ORDER_PAYMENT_MISMATCH');checks.push('paid replay cannot replace the original payment');
  if(process.env.TIVDOC_PAYMENT_BINDING_CANDIDATE!=='1'){
   await db.query('rollback to savepoint before_verification');await db.query('commit');committedFixture=true;
   for(const key of ['TIVDOC_WORKER_POSTGRES_URL','TIVDOC_WORKER_POSTGRES_URL','TIVDOC_WEB_POSTGRES_URL']){
    const runtimeUrl=new URL(env.get(key)!);expect(runtimeUrl.pathname).toBe(u.pathname);expect(runtimeUrl.hostname).toBe(u.hostname);expect(runtimeUrl.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);runtimeUrl.search='';
    const runtime=new pg.Client({connectionString:runtimeUrl.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});runtimeClients.push(runtime);await runtime.connect();
   }
   const [worker,peer,web]=runtimeClients;
   const verify=(client:pg.Client,payment:string)=>client.query("select public.case_order_payment_verify($1,$2,$3,'synthetic-confirmation',999,'ILS') value",[orderId,logId,payment]);
   await expect(verify(web,paymentId)).rejects.toThrow('permission denied');checks.push('actual customer web credential cannot verify payment');
   await expect(verify(worker,'different-payment')).rejects.toThrow('ORDER_PAYMENT_MISMATCH');checks.push('actual worker credential rejects contradictory reference');
   const race=await Promise.all([verify(worker,paymentId),verify(peer,paymentId)]);expect(race.map(r=>r.rows[0].value).sort()).toEqual([false,true]);checks.push('two actual worker connections grant one verification under concurrency');
   expect((await verify(peer,paymentId)).rows[0].value).toBe(false);checks.push('actual worker response-loss retry replays the saved result');
   expect((await db.query("select count(*)::int n from private.order_events where order_id=$1 and kind='payment_verified'",[orderId])).rows[0].n).toBe(1);
   expect((await db.query('select count(*)::int n from private.order_entitlements where order_id=$1',[orderId])).rows[0].n).toBe(1);checks.push('concurrent worker observations leave one event and entitlement');
  }
 }catch(e){failure=e instanceof Error?e.message:'proof_failed';throw e;}finally{
  await db.query('rollback');rolledBack=true;
  await Promise.allSettled(runtimeClients.map(client=>client.end()));
  if(committedFixture){await db.query('begin');await db.query('delete from public.payments where order_id=$1 and case_id=$2',[orderId,caseId]);await db.query("delete from public.cases where id=$1 and is_qa and first_name='Synthetic payment binding'",[caseId]);await db.query('delete from private.order_availability where evidence_reference=$1',['synthetic-binding:'+caseId]);await db.query('commit');}
  expect((await db.query('select count(*)::int n from public.cases where id=$1',[caseId])).rows[0].n).toBe(0);await db.end();
  writeFileSync('docs/release-evidence/P09-payment-binding-db.json',JSON.stringify({verdict:!failure&&checks.length===(committedFixture?14:9)&&rolledBack?'PASS':'FAIL',checks,failure,rolledBack,committedFixtureCleaned:committedFixture,database:'tivdoc_release_replay_20260907',candidateMigration:process.env.TIVDOC_PAYMENT_BINDING_CANDIDATE==='1'?migration:null,scope:'First nine assertions use an isolated owner transaction. Applied-migration runs additionally use actual worker/peer/web credentials against one briefly committed owned QA case, then remove it and its metadata. No shared role membership changed. No real Storage bytes or provider payment; the configured dedicated payment-verifier deployment credential remains separate.',productionChanged:false},null,2)+'\n');
 }
},120000);
