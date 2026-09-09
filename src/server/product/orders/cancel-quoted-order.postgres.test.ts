import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {offerSnapshot} from './contracts';
import {issueSavedPriceQuote,type SavedPricingBasisReader} from './quote-ledger';
import {acceptSavedPriceQuote,quotedFullOffer} from './quoted-order';
import {cancelUnstartedQuotedOrder} from './cancel-quoted-order';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_QUOTE_CANCEL_DB_PROOF!=='1')('cancels only unstarted quoted orders and preserves credit across retries and checkout races',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('QUOTE_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const customerProof=process.env.TIVDOC_CUSTOMER_CANCEL_DB_PROOF==='1',customerPeer=customerProof?client('TIVDOC_WEB_POSTGRES_URL'):null,customerChecks:string[]=[];
 const customerMigration='20260908220956_customer_unstarted_order_cancellation.sql';
 const browserProof=process.env.TIVDOC_CUSTOMER_CANCEL_PREVIEW_PROOF==='1',sessions:string[]=[],publicIds:string[]=[];
 let browserChecks:unknown=null;
 if(browserProof&&!customerProof)throw Error('CUSTOMER_CANCEL_PROOF_SCOPE_REQUIRED');
 const ids=[randomUUID(),randomUUID()],identities:string[]=[],initialId=randomUUID(),tenant=`saved-case:${ids[0]}`,sid=`quote-proof:${randomUUID()}`,jti=randomUUID();
 const availabilityMarker=`synthetic-quoted-order:${ids[0]}`;
 const checks:string[]=[],migration='20260908153942_quote_unstarted_cancellation.sql';let cleaned=false,seeded=false,failure:string|null=null,cleanupError:unknown;
 writeFileSync(`../release-work/quote-cancellation-owned-${ids[0]}.json`,JSON.stringify({ids,tenant,sid,jti,scope:'Synthetic quote cancellation proof only; isolated DEV'}));
 const transact=async<T>(db:pg.Client,run:(context:PostgresTransactionContext)=>Promise<T>)=>{
  await db.query('begin');try{
   await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'quote-ledger-proof']);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows,row_count:r.rowCount??0};}}};
   const result=await run(context);await db.query('commit');return result;
  }catch(e){await db.query('rollback');throw e;}
 };
 const request=(to='2020-01')=>({id:randomUUID(),caseId:ids[0],identityId:identities[0],from:'2020-01',to,topics:['pension' as const]});
 // Explicit synthetic, injected basis: this is NOT canonical monetary proof.
 const reader:SavedPricingBasisReader=async(_context,source)=>({case_id:source.caseId,identity_id:source.identityId,input_sha256:source.inputSha256,analysis_version:'synthetic-quote-proof-only',checked_months:['2020-01'],checked_topics:['pension'],components:[{finding_id:initialId,economic_key:'synthetic-deposit-gap',month:'2020-01',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:[initialId],rule_versions:['synthetic-only'],alternative_group:null}]});

 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect(),customerPeer?.connect()]);
  if(process.env.TIVDOC_APPLY_CUSTOMER_CANCEL==='1'){
   expect((await owner.query("select to_regprocedure('public.case_order_cancel_unstarted(uuid,uuid,uuid)') value")).rows[0].value).toBeNull();
   const sql=readFileSync('supabase/migrations/'+customerMigration,'utf8');
   await owner.query('begin');try{await owner.query(sql);}finally{await owner.query('rollback');}
   await owner.query('begin');try{await owner.query(sql);await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}
   writeFileSync('docs/release-evidence/P09-customer-cancellation-migration.json',JSON.stringify({state:'APPLIED_ISOLATED_DEV',migration:customerMigration,sha256:createHash('sha256').update(sql).digest('hex'),candidateDdlRolledBackBeforeApply:true,productionChanged:false},null,2)+'\n');
  }
  if(process.env.TIVDOC_APPLY_QUOTE_CANCEL==='1'){await owner.query('begin');try{await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}}
  if(process.env.TIVDOC_APPLY_QUOTE_CHECKOUT_RETRY==='1')await owner.query(readFileSync('supabase/migrations/20260908154530_quoted_checkout_retry_freshness.sql','utf8'));
  await owner.query('begin');
  for(const id of ids){
   const email=`quote-proof-${id}@example.invalid`;
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic quote cancellation',$2,'0500000000',true,'under_review','verified',now(),'2020-01-01')",[id,email]);
   const identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);
   await owner.query('select public.case_access_identity_link($1,$2)',[identity,id]);
   if(browserProof){const session=randomBytes(16).toString('base64url');sessions.push(session);publicIds.push((await owner.query('select public_id from public.cases where id=$1',[id])).rows[0].public_id);await owner.query('select public.case_access_session_create($1,$2,14400)',[identity,createHash('sha256').update('case-access-session|'+session).digest('hex')]);}
  }
  const initialOffer=offerSnapshot('initial');
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2020-01-01','2020-01-01',999,'ILS',$3,$4,array['pension'],$5,'paid',now())",[initialId,ids[0],initialOffer,initialOffer.sha256,initialOffer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[initialId]);
  await owner.query("insert into public.payments(case_id,order_id,provider,amount,currency,status,verified_at,idempotency_key) values($1,$2,'invoice4u',9.99,'ILS','verified',now(),$3)",[ids[0],initialId,`synthetic-quote:${initialId}`]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{}','Synthetic quote source')",[ids[0]]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  // Owner-only transaction-local fixture policy, removed before commit. No
  // physical Storage upload is claimed by this checkout-admission proof.
  await owner.query("create policy quote_cancel_owner_fixture on public.documents for all to tivdoc_dev_migrator using(true) with check(true)");
  const docId=randomUUID(),versionId=randomUUID();
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic-checkout-metadata.pdf','application/pdf',1,$5,'2020-01-01')",[docId,ids[0],versionId,'synthetic-quote-cancel/'+ids[0]+'/'+versionId+'.pdf','a'.repeat(64)]);
  await owner.query('drop policy quote_cancel_owner_fixture on public.documents');
  await owner.query('commit');seeded=true;
  const accept=(db:pg.Client,id:string)=>transact(db,c=>acceptSavedPriceQuote(c,{quoteId:id,caseId:ids[0],identityId:identities[0]}));
  const cancel=(db:pg.Client,orderId:string)=>transact(db,c=>cancelUnstartedQuotedOrder(c,{caseId:ids[0],identityId:identities[0],orderId,reason:'customer_changed_scope'}));
  const checkout=(orderId:string,terms:string,db=web)=>db.query('select public.case_order_checkout_begin($1,$2,$3,$4,$5,$6) value',[ids[0],identities[0],orderId,randomUUID(),canonicalSha256(randomUUID()),terms]);
  const customerCancel=async(db:pg.Client,orderId:string,identity=identities[0],caseId=ids[0])=>(await db.query('select public.case_order_cancel_unstarted($1,$2,$3) value',[caseId,identity,orderId])).rows[0].value as {order_id:string;state:string;replayed:boolean};
  const customerView=async(orderId:string)=>(await web.query('select public.case_order_snapshot($1,$2) value',[ids[0],identities[0]])).rows[0].value.find((o:{id:string})=>o.id===orderId);
  const issue=async(to='2020-01')=>{const q=await transact(worker,c=>issueSavedPriceQuote(c,request(to),reader));if(q.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');return q;};
  await owner.query("insert into private.order_availability(kind,topic,period_from,period_to,ready,evidence_reference) values('full','pension','2020-01-01','2020-04-01',true,$1)",[availabilityMarker]);
  const issued=await issue(),original=(await accept(worker,issued.id)).order;
  if(customerProof){
   await expect(customerCancel(web,original.id,identities[1])).rejects.toThrow('ORDER_FORBIDDEN');
   await expect(customerCancel(web,original.id,identities[1],ids[1])).rejects.toThrow('ORDER_FORBIDDEN');
   await expect(customerCancel(web,initialId)).rejects.toThrow('ORDER_FORBIDDEN');
   await expect(web.query("select private.order_quote_cancel_locked($1,$2,$3,'customer_changed_scope','forged')",[ids[0],identities[0],original.id])).rejects.toMatchObject({code:'42501'});
   for(const role of ['anon','authenticated','tivdoc_worker_runtime','tivdoc_operations_runtime'])expect((await owner.query("select has_function_privilege($1,'public.case_order_cancel_unstarted(uuid,uuid,uuid)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
   customerChecks.push('customer RPC rejects foreign identity/case, initial orders and unprivileged roles; web cannot invoke the common ledger helper or forge its audit actor');
   expect((await customerView(original.id)).can_cancel_unstarted).toBe(true);expect((await customerView(initialId)).can_cancel_unstarted).toBe(false);
   customerChecks.push('authorized saved order snapshot offers cancellation only for the exact unstarted v2 order');
   await web.query('begin');try{expect((await customerCancel(web,original.id)).state).toBe('cancelled');}finally{await web.query('rollback');}
   expect((await customerView(original.id)).can_cancel_unstarted).toBe(true);
   expect((await owner.query('select released_at from private.order_quote_reservations where order_id=$1',[original.id])).rows[0].released_at).toBe(null);
   customerChecks.push('rollback of a customer cancellation restores both the order and reserved initial credit');
  }
  await expect(transact(worker,c=>cancelUnstartedQuotedOrder(c,{caseId:ids[0],identityId:identities[1],orderId:original.id,reason:'source_changed'}))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(transact(worker,c=>cancelUnstartedQuotedOrder(c,{caseId:ids[1],identityId:identities[1],orderId:original.id,reason:'source_changed'}))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(web.query("select private.order_quote_cancel_unstarted($1,$2,$3,'source_changed')",[ids[0],identities[0],original.id])).rejects.toMatchObject({code:'42501'});
  for(const role of ['anon','authenticated','service_role','tivdoc_web_runtime','tivdoc_operations_runtime'])expect((await owner.query("select has_function_privilege($1,'private.order_quote_cancel_unstarted(uuid,uuid,uuid,text)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
  checks.push('the private worker cancellation RPC rejects foreign identity/case and all non-worker roles');
  await expect(transact(worker,async c=>{await cancelUnstartedQuotedOrder(c,{caseId:ids[0],identityId:identities[0],orderId:original.id,reason:'source_changed'});throw new Error('INJECTED_CANCEL_BEFORE_COMMIT');})).rejects.toThrow('INJECTED_CANCEL_BEFORE_COMMIT');
  expect((await owner.query('select state from private.product_orders where id=$1',[original.id])).rows[0].state).toBe('awaiting_payment');expect((await owner.query('select released_at from private.order_quote_reservations where order_id=$1',[original.id])).rows[0].released_at).toBe(null);
  checks.push('failure before commit restores both the awaiting order and its credit reservation');
  const cancelled=await Promise.all(customerProof?[customerCancel(web,original.id),customerCancel(customerPeer!,original.id)]:[cancel(worker,original.id),cancel(peer,original.id)]);expect(cancelled.map(r=>r.replayed).sort()).toEqual([false,true]);
  if(customerProof){
   expect((await customerCancel(web,original.id)).replayed).toBe(true);expect((await customerView(original.id)).can_cancel_unstarted).toBe(false);
   expect((await owner.query("select actor from private.order_events where order_id=$1 and kind='cancelled_before_checkout'",[original.id])).rows).toEqual([{actor:`customer:${identities[0]}`}]);
   customerChecks.push('two actual web connections and retry create one attributed cancellation; saved history removes the action and releases the 999-minor initial credit once');
  }
  expect((await owner.query("select count(*)::int n from private.order_events where order_id=$1 and kind='cancelled_before_checkout'",[original.id])).rows[0].n).toBe(1);
  expect((await owner.query('select snapshot from private.order_price_quotes where id=$1',[issued.id])).rows[0].snapshot).toEqual(issued.quote);
  const reservation=(await owner.query('select credit_minor,credit_order_id,released_at from private.order_quote_reservations where order_id=$1',[original.id])).rows[0];expect(reservation).toMatchObject({credit_minor:999,credit_order_id:initialId});expect(reservation.released_at).not.toBe(null);
  checks.push('concurrent cancellation is idempotent, appends one event and retains the original quote/credit history');
  await expect(accept(worker,issued.id)).rejects.toThrow('PRICE_QUOTE_ORDER_MISMATCH');const replacementQuote=await issue();expect(replacementQuote.quote.credit_minor).toBe(999);const replacement=(await accept(worker,replacementQuote.id)).order;expect(replacement.id).not.toBe(original.id);expect(replacement.amount_minor).toBe(8901);
  expect((await owner.query("select state,count(*)::int n from private.product_orders where case_id=$1 and kind='full' group by state order by state",[ids[0]])).rows).toEqual([{state:'awaiting_payment',n:1},{state:'cancelled',n:1}]);
  checks.push('a fresh quote reuses the initial credit for the same scope while the cancelled order remains immutable history');
  expect((await checkout(replacement.id,replacementQuote.termsVersion)).rows[0].value.claimed).toBe(true);
  for(const state of ['creating','uncertain','ready']){await owner.query('update private.order_checkouts set state=$2 where order_id=$1',[replacement.id,state]);await expect(cancel(worker,replacement.id)).rejects.toThrow('ORDER_CANCEL_REQUIRES_RECONCILIATION');}
  expect((await owner.query('select released_at from private.order_quote_reservations where order_id=$1',[replacement.id])).rows[0].released_at).toBe(null);
  checks.push('a real web checkout claim, including creating/uncertain/ready fixture outcomes, prevents credit release');
  if(customerProof){
   for(const state of ['creating','uncertain','ready']){await owner.query('update private.order_checkouts set state=$2 where order_id=$1',[replacement.id,state]);expect((await customerView(replacement.id)).can_cancel_unstarted).toBe(false);await expect(customerCancel(web,replacement.id)).rejects.toThrow('ORDER_CANCEL_REQUIRES_RECONCILIATION');}
   customerChecks.push('customer cancellation refuses creating, uncertain and ready provider-attempt states and keeps the credit reserved');
  }
  const raceQuote=await issue('2020-02'),raceOrder=(await accept(worker,raceQuote.id)).order;
  const race=await Promise.allSettled([customerProof?customerCancel(web,raceOrder.id):cancel(peer,raceOrder.id),checkout(raceOrder.id,raceQuote.termsVersion,customerPeer??web)]);
  const state=(await owner.query('select o.state,r.released_at,(select count(*)::int from private.order_checkouts where order_id=o.id) attempts from private.product_orders o join private.order_quote_reservations r on r.order_id=o.id where o.id=$1',[raceOrder.id])).rows[0];
  if(state.state==='cancelled'){expect(state.attempts).toBe(0);expect(state.released_at).not.toBe(null);expect(race[0].status).toBe('fulfilled');if(race[1].status==='fulfilled')expect(race[1].value.rows[0].value.claimed).toBe(false);else throw race[1].reason;}
  else{expect(state.attempts).toBe(1);expect(state.released_at).toBe(null);expect(race[0].status).toBe('rejected');if(race[0].status==='rejected')expect(race[0].reason.message).toBe('ORDER_CANCEL_REQUIRES_RECONCILIATION');}
  checks.push('actual web checkout racing authorized cancellation cannot both create a provider attempt and release credit');
  if(customerProof)customerChecks.push('actual customer cancellation racing a separate web checkout connection cannot release credit and create a provider attempt together');
  const staleQuote=await issue('2020-03'),stale=(await accept(worker,staleQuote.id)).order;
  await owner.query("update public.questionnaire_responses set payload='{\"salaryType\":\"hourly\"}'::jsonb where case_id=$1",[ids[0]]);
  await expect(checkout(replacement.id,replacementQuote.termsVersion)).rejects.toThrow('ORDER_QUOTE_SOURCE_CHANGED');
  checks.push('changed input also blocks reopening an already-created checkout without releasing its reserved credit');
  await expect(checkout(stale.id,staleQuote.termsVersion)).rejects.toThrow('ORDER_QUOTE_SOURCE_CHANGED');expect((await owner.query('select count(*)::int n from private.order_checkouts where order_id=$1',[stale.id])).rows[0].n).toBe(0);
  expect((await cancel(worker,stale.id)).state).toBe('cancelled');checks.push('source change between acceptance and checkout blocks provider claim; an unstarted stale order can still be cancelled');
  if(customerProof){expect((await customerCancel(web,stale.id)).replayed).toBe(true);customerChecks.push('customer retry sees the stored cancellation after a source change without rewriting its history');}
  const expiredQuote=await issue('2020-04'),expired=structuredClone(expiredQuote.quote);expired.created_at=new Date(Date.parse(expired.created_at)-8*86400000).toISOString();expired.expires_at=new Date(Date.parse(expired.expires_at)-8*86400000).toISOString();
  const {sha256:oldHash,...payload}=expired;void oldHash;expired.sha256=canonicalSha256(payload);
  // Owner-only fixture models an order that was accepted before its quote expired.
  await owner.query('update private.order_price_quotes set snapshot=$2,quote_sha256=$3 where id=$1',[expiredQuote.id,expired,expired.sha256]);
  const offerPayload={...quotedFullOffer(expired,expiredQuote.termsVersion),price_quote_id:expiredQuote.id},offer={...offerPayload,sha256:canonicalSha256(offerPayload)},expiredOrder=randomUUID();
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version) values($1,$2,'full','2020-01-01','2020-04-01',$3,'ILS',$4,$5,array['pension'],$6)",[expiredOrder,ids[0],expired.balance_minor,offer,offer.sha256,expiredQuote.termsVersion]);
  await owner.query('insert into private.order_quote_reservations(quote_id,case_id,order_id,credit_minor) values($1,$2,$3,0)',[expiredQuote.id,ids[0],expiredOrder]);
  await expect(checkout(expiredOrder,expiredQuote.termsVersion)).rejects.toThrow('ORDER_QUOTE_EXPIRED');expect((await owner.query('select count(*)::int n from private.order_checkouts where order_id=$1',[expiredOrder])).rows[0].n).toBe(0);
  checks.push('an owner-seeded historically accepted expired quote fails checkout against the real database clock');
  await owner.query("update private.product_orders set state='paid',verified_at=now() where id=$1",[replacement.id]);await expect(cancel(worker,replacement.id)).rejects.toThrow('ORDER_CANCEL_REQUIRES_RECONCILIATION');
  checks.push('synthetic paid order cannot be treated as an unstarted cancellation or release its credit');
  if(customerProof){await expect(customerCancel(web,replacement.id)).rejects.toThrow('ORDER_CANCEL_REQUIRES_RECONCILIATION');expect((await customerView(replacement.id)).can_cancel_unstarted).toBe(false);customerChecks.push('paid orders cannot be cancelled or release initial credit through the customer action');}
  if(browserProof){
   await customerCancel(web,expiredOrder);
   const browserQuote=await issue('2020-04'),browserOrder=(await accept(worker,browserQuote.id)).order;
   const otherStates=async()=>(await owner.query('select id,state from private.product_orders where case_id=$1 and id<>$2 order by id',[ids[0],browserOrder.id])).rows;
   const before=await otherStates();
   const {verifyOrderCancellationPreview}=await import('../../../../scripts/release-completion/preview-order-cancellation.mts');
   browserChecks=await verifyOrderCancellationPreview({expectedGitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),publicId:publicIds[0],foreignPublicId:publicIds[1],session:sessions[0],foreignSession:sessions[1],orderId:browserOrder.id,initialOrderId:initialId});
   expect((await owner.query('select state from private.product_orders where id=$1',[browserOrder.id])).rows[0].state).toBe('cancelled');
   expect((await owner.query("select actor from private.order_events where order_id=$1 and kind='cancelled_before_checkout'",[browserOrder.id])).rows).toEqual([{actor:`customer:${identities[0]}`}]);
   expect((await owner.query('select count(*)::int n from private.order_checkouts where order_id=$1',[browserOrder.id])).rows[0].n).toBe(0);
   expect(await otherStates()).toEqual(before);
  }
  const final=(await owner.query('select count(*)::int n from private.order_quote_reservations where credit_order_id=$1 and released_at is null',[initialId])).rows[0].n;expect(final).toBe(1);
  checks.push('exactly one active initial-credit reservation remains after cancellation, replacement and checkout races');
 }catch(e){failure=e instanceof Error?e.message:'proof_failed';throw e;}finally{
  await Promise.all([owner,worker,peer,web,...(customerPeer?[customerPeer]:[])].map(db=>db.query('rollback').catch(()=>{})));
  if(seeded){await owner.query('begin');try{
   await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);
   // The task owns these synthetic orders and their synthetic payment only.
   await owner.query('delete from private.order_availability where evidence_reference=$1',[availabilityMarker]);
   await owner.query('delete from public.payments where case_id=any($1::uuid[])',[ids]);
   await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic quote cancellation'",[ids]);
   await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
   expect((await owner.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);
   await owner.query('commit');cleaned=true;
  }catch(e){await owner.query('rollback');cleanupError=e;}}
  await Promise.allSettled([owner.end(),worker.end(),peer.end(),web.end(),customerPeer?.end()]);
  if(customerProof)writeFileSync('docs/release-evidence/P09-customer-cancellation-db.json',JSON.stringify({verdict:cleaned&&customerChecks.length===8&&!failure&&!cleanupError&&(!browserProof||browserChecks)?'PASS':'FAIL',gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:customerChecks,browserChecks,failure,cleanupFailure:cleanupError instanceof Error?cleanupError.message:null,migration:customerMigration,migrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/'+customerMigration)).digest('hex'),syntheticCasesRemoved:cleaned?2:0,syntheticIdentitiesRemoved:cleaned?identities.length:0,machineSessionRevoked:cleaned,browserProof,scope:browserProof?'Actual isolated DEV worker/two web connections and hosted authenticated UI/HTTP cancellation, lost response/retry/reload. Injected synthetic quote basis, payment and readiness; no actual provider settlement, live monetary correctness or production.':'Actual isolated DEV worker and two web connections; synthetic injected quote basis, payment and readiness. Customer SQL cancellation/rollback/concurrency/history and checkout-claim race, not customer HTTP or provider settlement.',productionChanged:false},null,2)+'\n');
  writeFileSync('docs/release-evidence/P09-quote-cancellation-db.json',JSON.stringify({verdict:cleaned&&checks.length===11&&!failure?'PASS':'FAIL',checks,failure,cleanupFailure:cleanupError instanceof Error?cleanupError.message:null,database:'tivdoc_release_replay_20260907',migration,checkoutRetryMigration:'20260908154530_quoted_checkout_retry_freshness.sql',checkoutRetryMigrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20260908154530_quoted_checkout_retry_freshness.sql')).digest('hex'),migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,scope:'Actual worker/peer/web roles; injected synthetic monetary basis and synthetic verified payment row. Synthetic payslip metadata only; no Storage/provider transport. Actual web checkout-claim function is exercised, not customer HTTP/browser or provider settlement. No canonical monetary proof or production change.',productionChanged:false},null,2)+'\n');
  if(cleanupError)throw cleanupError;
 }
},process.env.TIVDOC_CUSTOMER_CANCEL_PREVIEW_PROOF==='1'?360000:120000);
