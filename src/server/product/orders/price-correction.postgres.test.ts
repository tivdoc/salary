import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {createOpaqueToken,hashSession} from '../case-access/crypto';
import {offerSnapshot} from './contracts';
import {issueSavedPriceQuote,type SavedPricingBasisReader} from './quote-ledger';
import {acceptSavedPriceQuote} from './quoted-order';
import {requestSavedPriceCorrection} from './price-correction';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_PRICE_CORRECTION_DB_PROOF!=='1')('persists cumulative correction requests only for verified paid quotes without duplicate payouts',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('QUOTE_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const ids=[randomUUID(),randomUUID()],identities:string[]=[],initialId=randomUUID(),tenant=`saved-case:${ids[0]}`,sid=`quote-proof:${randomUUID()}`,jti=randomUUID();
 const availabilityMarker=`synthetic-quoted-order:${ids[0]}`;
 const checks:string[]=[],migration='20260908172254_order_price_correction_intents.sql';let cleaned=false,seeded=false,failure:string|null=null,cleanupError:unknown;
 const browserProof=process.env.TIVDOC_PRICE_CORRECTION_PREVIEW_PROOF==='1';
 writeFileSync(`../release-work/price-correction-owned-${ids[0]}.json`,JSON.stringify({ids,tenant,sid,jti,scope:'Synthetic price correction proof only; isolated DEV'}));
 const transact=async<T>(db:pg.Client,run:(context:PostgresTransactionContext)=>Promise<T>)=>{
  await db.query('begin');try{
   await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'quote-ledger-proof']);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows,row_count:r.rowCount??0};}}};
   const result=await run(context);await db.query('commit');return result;
  }catch(e){await db.query('rollback');throw e;}
 };
 const request=(to='2020-01')=>({id:randomUUID(),caseId:ids[0],identityId:identities[0],from:'2020-01',to,topics:['pension' as const]});
 // Explicit synthetic, injected basis: this is NOT canonical monetary proof.
 const reader:SavedPricingBasisReader=async(_context,source)=>({case_id:source.caseId,identity_id:source.identityId,input_sha256:source.inputSha256,analysis_version:'synthetic-quote-proof-only',checked_months:['2020-01'],checked_topics:['pension'],components:[{finding_id:initialId,economic_key:'synthetic-deposit-gap',month:'2020-01',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:2000000,range:null,evidence_ids:[initialId],rule_versions:['synthetic-only'],alternative_group:null}]});


 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_PRICE_CORRECTION==='1'){await owner.query('begin');try{await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}}
  if(process.env.TIVDOC_APPLY_CUSTOMER_CORRECTION==='1')await owner.query(readFileSync('supabase/migrations/20260908174231_customer_price_correction_status.sql','utf8'));
  await owner.query('begin');
  for(const id of ids){
   const email=`quote-proof-${id}@example.invalid`;
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic price correction',$2,'0500000000',true,'under_review','verified',now(),'2020-01-01')",[id,email]);
   const identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);
   await owner.query('select public.case_access_identity_link($1,$2)',[identity,id]);
  }
  const offer=offerSnapshot('initial');
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2020-01-01','2020-01-01',999,'ILS',$3,$4,array['pension'],$5,'paid',now())",[initialId,ids[0],offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[initialId]);
  await owner.query("insert into public.payments(case_id,order_id,provider,amount,currency,status,verified_at,idempotency_key) values($1,$2,'invoice4u',9.99,'ILS','verified',now(),$3)",[ids[0],initialId,`synthetic-quote:${initialId}`]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{}','Synthetic quote source')",[ids[0]]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  const accept=(db:pg.Client,id:string)=>transact(db,c=>acceptSavedPriceQuote(c,{quoteId:id,caseId:ids[0],identityId:identities[0]}));
  const issued=await transact(worker,c=>issueSavedPriceQuote(c,request(),reader));
  if(issued.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');
  await owner.query("insert into private.order_availability(kind,topic,period_from,period_to,ready,evidence_reference) values('full','pension','2020-01-01','2020-01-01',true,$1)",[availabilityMarker]);
  const full=(await accept(worker,issued.id)).order,correctionId=randomUUID();
  const correction={id:correctionId,caseId:ids[0],identityId:identities[0],orderId:full.id};
  let amount=500000;
  const corrected:SavedPricingBasisReader=async(c,source)=>{const b=(await reader(c,source))!;b.components[0].amount=amount;return b;};
  const ask=(db:pg.Client,id=correctionId,read=corrected)=>transact(db,c=>requestSavedPriceCorrection(c,{...correction,id},read));
  const count=async()=> (await owner.query('select count(*)::int n from private.order_price_correction_requests where order_id=$1',[full.id])).rows[0].n;
  await expect(ask(worker)).rejects.toThrow('PRICE_CORRECTION_PAID_ORDER_REQUIRED');
  await owner.query("update private.product_orders set state='paid',verified_at=now() where id=$1",[full.id]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[full.id]);
  await expect(ask(worker)).rejects.toThrow('PRICE_CORRECTION_PAID_ORDER_REQUIRED');
  await owner.query("insert into public.payments(case_id,order_id,provider,amount,currency,status,verified_at,idempotency_key) values($1,$2,'invoice4u',339.01,'ILS','verified',now(),$3)",[ids[0],full.id,`synthetic-correction:${full.id}`]);
  checks.push('unpaid order and entitlement without an exact verified payment cannot request money');
  await expect(transact(worker,c=>requestSavedPriceCorrection(c,{...correction,identityId:identities[1]},corrected))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(transact(worker,c=>requestSavedPriceCorrection(c,{...correction,caseId:ids[1],identityId:identities[1]},corrected))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(web.query('select private.order_price_correction_context($1,$2,$3,$4)',[ids[0],identities[0],full.id,correctionId])).rejects.toMatchObject({code:'42501'});
  for(const role of ['anon','authenticated','service_role','tivdoc_web_runtime','tivdoc_operations_runtime'])expect((await owner.query("select has_function_privilege($1,'private.order_price_correction_request(uuid,uuid,uuid,uuid,text,jsonb,text,bigint,integer)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
  checks.push('foreign case/identity, actual web and non-worker function privileges are refused');
  for(const defect of ['missing','low','scope','higher']){
   const read:SavedPricingBasisReader=async(c,s)=>{if(defect==='missing')return null;const b=(await corrected(c,s))!;if(defect==='low')b.components[0].certainty='low';if(defect==='scope')b.checked_months=['2020-02'];if(defect==='higher')b.components[0].amount=3000000;return b;};
   expect((await ask(worker,randomUUID(),read)).state).toBe(defect==='higher'?'no_adjustment':'amount_unknown');
  }
  expect(await count()).toBe(0);checks.push('unknown, low, changed checked scope and higher amounts create no refund intent');
  await expect(transact(worker,async c=>{await requestSavedPriceCorrection(c,correction,corrected);throw new Error('INJECTED_BEFORE_COMMIT');})).rejects.toThrow('INJECTED_BEFORE_COMMIT');
  expect(await count()).toBe(0);expect((await owner.query("select count(*)::int n from private.order_events where order_id=$1 and kind='price_correction_refund_requested'",[full.id])).rows[0].n).toBe(0);
  checks.push('pre-commit failure rolls back both the intent and its audit event');
  const replays=await Promise.all([ask(worker),ask(peer)]);expect(replays.map(r=>'replayed' in r?r.replayed:null).sort()).toEqual([false,true]);
  expect(replays[0]).toMatchObject({id:correctionId,order_id:full.id,state:'requested',cumulative_refund_minor:15000});expect(await count()).toBe(1);
  expect(await ask(worker,randomUUID())).toMatchObject({id:correctionId,replayed:true,cumulative_refund_minor:15000});expect(await count()).toBe(1);
  checks.push('concurrent first calls, lost-response retry and a new ID for the same reduction preserve one request');
  const contextInput=(await owner.query('select input_sha256 from private.case_input_heads where case_id=$1',[ids[0]])).rows[0].input_sha256;
  const b=(await corrected({} as PostgresTransactionContext,{caseId:ids[0],identityId:identities[0],inputSha256:contextInput}))!;
  const direct=(basis:typeof b,basisMinor=500000,refund=15000,id=randomUUID())=>transact(worker,async()=>worker.query('select private.order_price_correction_request($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ids[0],identities[0],full.id,id,issued.quote.sha256,basis,canonicalSha256(basis),basisMinor,refund]));
  await expect(direct(b,500000,33901)).rejects.toThrow('PRICE_CORRECTION_AMOUNT_MISMATCH');
  await expect(direct({...b,input_sha256:'a'.repeat(64)})).rejects.toThrow('PRICE_CORRECTION_SOURCE_CHANGED');
  await expect(direct({...b,checked_topics:['travel']})).rejects.toThrow('PRICE_CORRECTION_BASIS_INVALID');
  await expect(direct({...b,analysis_version:'changed-request'},500000,15000,correctionId)).rejects.toThrow('PRICE_CORRECTION_REQUEST_CONFLICT');
  checks.push('actual SQL rechecks original-policy arithmetic, source, checked scope and conflicting request payload');
  amount=49999;
  const customerRefundId=randomUUID();
  const [lower]=await Promise.all([ask(peer,randomUUID()),web.query("select public.case_order_refund_request($1,$2,$3,$4,'Synthetic service review request')",[ids[0],identities[0],full.id,customerRefundId])]);
  expect(lower).toMatchObject({state:'requested',cumulative_refund_minor:33901,replayed:false});expect(await count()).toBe(2);
  const queue=await transact(worker,async()=>worker.query('select cumulative_refund_minor,revision_count::int from private.order_price_correction_queue where order_id=$1',[full.id]));expect(queue.rows).toEqual([{cumulative_refund_minor:33901,revision_count:2}]);
  expect((await owner.query('select id,reason from private.order_refund_requests where order_id=$1',[full.id])).rows).toEqual([{id:customerRefundId,reason:'Synthetic service review request'}]);
  checks.push('a further reduction and concurrent customer refund intake retain both histories; queue uses MAX cumulative target, never SUM');
  const current=(await owner.query('select o.state,o.refund_state,o.amount_minor,e.state entitlement from private.product_orders o join private.order_entitlements e on e.order_id=o.id where o.id=$1',[full.id])).rows[0];
  expect(current).toEqual({state:'paid',refund_state:'requested',amount_minor:33901,entitlement:'active'});
  expect((await owner.query('select snapshot from private.order_price_quotes where id=$1',[issued.id])).rows[0].snapshot).toEqual(issued.quote);
  expect((await owner.query('select credit_minor,released_at from private.order_quote_reservations where order_id=$1',[full.id])).rows[0]).toEqual({credit_minor:999,released_at:null});
  checks.push('pending corrections preserve purchased price, initial credit and active full entitlement; no settled state is fabricated');
  await owner.query("update public.questionnaire_responses set payload='{\"salaryType\":\"hourly\"}'::jsonb where case_id=$1",[ids[0]]);
  expect(await ask(worker)).toMatchObject({id:correctionId,cumulative_refund_minor:15000,replayed:true});
  checks.push('the exact saved request receipt replays after later case-input changes without repricing it');
  for(const privilege of ['INSERT','UPDATE','DELETE'])expect((await owner.query("select has_table_privilege('tivdoc_worker_runtime','private.order_price_correction_requests',$1) allowed",[privilege])).rows[0].allowed).toBe(false);
  await expect(transact(worker,async()=>worker.query("update private.order_price_correction_requests set cumulative_refund_minor=1 where id=$1",[correctionId]))).rejects.toMatchObject({code:'42501'});
  await expect(web.query('select * from private.order_price_correction_queue')).rejects.toMatchObject({code:'42501'});
  expect((await owner.query('select count(*)::int n from private.order_price_correction_requests where order_id=$1 and state<>\'requested\'',[full.id])).rows[0].n).toBe(0);
  checks.push('actual runtime cannot mutate ledger history and web cannot read the private queue or assert provider settlement');
  const customer=(await web.query('select public.case_order_snapshot($1,$2) value',[ids[0],identities[0]])).rows[0].value;
  expect(customer.find((o:{id:string})=>o.id===full.id).price_correction).toEqual({state:'requested',cumulative_refund_minor:33901,requested_at:expect.any(String)});
  expect(customer.find((o:{id:string})=>o.id===initialId).price_correction).toBe(null);
  expect(JSON.stringify(customer.map((o:{price_correction:unknown})=>o.price_correction))).not.toMatch(/basis|input_sha|identity_id|quote_sha/);
  checks.push('actual customer snapshot exposes only one cumulative pending status on the corrected order, with no internal basis or initial-order adjustment');
  await expect(web.query('select public.case_order_snapshot($1,$2)',[ids[0],identities[1]])).rejects.toThrow('ORDER_FORBIDDEN');
  expect((await web.query('select public.case_order_snapshot($1,$2) value',[ids[1],identities[1]])).rows[0].value).toEqual([]);
  checks.push('foreign customer snapshot is refused and another owned case receives none of the correction data');
  if(browserProof){
   const sessions:string[]=[],publicIds:string[]=[];
   for(let i=0;i<ids.length;i++){
    const token=createOpaqueToken();sessions.push(token);
    await owner.query('select public.case_access_session_create($1,$2,14400)',[identities[i],hashSession(token)]);
    publicIds.push((await owner.query('select public_id from public.cases where id=$1',[ids[i]])).rows[0].public_id);
   }
   const {verifyOrderRefundPreview}=await import('../../../../scripts/release-completion/preview-order-refunds.mts');
   await verifyOrderRefundPreview({publicId:publicIds[0],foreignPublicId:publicIds[1],session:sessions[0],foreignSession:sessions[1]});
  }
 }catch(e){failure=e instanceof Error?e.message:'proof_failed';throw e;}finally{
  await owner.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');try{
   await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);
   // The task owns these synthetic orders and their synthetic payment only.
   await owner.query('delete from private.order_availability where evidence_reference=$1',[availabilityMarker]);
   await owner.query('delete from public.payments where case_id=any($1::uuid[])',[ids]);
   await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic price correction'",[ids]);
   await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
   expect((await owner.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);
   await owner.query('commit');cleaned=true;
  }catch(e){await owner.query('rollback');cleanupError=e;}}
  await Promise.allSettled([owner.end(),worker.end(),peer.end(),web.end()]);
  writeFileSync('docs/release-evidence/P09-price-correction-db.json',JSON.stringify({verdict:cleaned&&checks.length===12&&!failure?'PASS':'FAIL',checks,failure,cleanupFailure:cleanupError instanceof Error?cleanupError.message:null,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),customerStatusMigration:'20260908174231_customer_price_correction_status.sql',customerStatusMigrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20260908174231_customer_price_correction_status.sql')).digest('hex'),syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,scope:'Actual worker/peer/web correction intake, cumulative queue and customer SQL snapshot. Injected synthetic basis and verified payment rows. No canonical monetary proof or refund dispatch/settlement. Hosted customer browser is proved only when browserProof is true. No production change.',browserProof,productionChanged:false},null,2)+'\n');
  if(cleanupError)throw cleanupError;
 }
},240000);
