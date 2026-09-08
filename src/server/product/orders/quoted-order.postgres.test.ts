import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {offerSnapshot} from './contracts';
import {legacyFullOfferFixture} from './fixtures/legacy-offer';
import {issueSavedPriceQuote,type SavedPricingBasisReader} from './quote-ledger';
import {acceptSavedPriceQuote,quotedFullOffer} from './quoted-order';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_QUOTED_ORDER_DB_PROOF!=='1')('atomically creates quoted orders and reserves credit under failure and concurrent worker requests',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('QUOTE_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const ids=[randomUUID(),randomUUID()],identities:string[]=[],initialId=randomUUID(),tenant=`saved-case:${ids[0]}`,sid=`quote-proof:${randomUUID()}`,jti=randomUUID();
 const availabilityMarker=`synthetic-quoted-order:${ids[0]}`;
 const checks:string[]=[],migration='20260908151940_quoted_order_acceptance.sql';let cleaned=false,seeded=false,failure:string|null=null,cleanupError:unknown;
 writeFileSync(`../release-work/quoted-order-owned-${ids[0]}.json`,JSON.stringify({ids,tenant,sid,jti,scope:'Synthetic quoted order proof only; isolated DEV'}));
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
 const createFull=async(issued:Awaited<ReturnType<typeof issueSavedPriceQuote>>)=>{
  if(issued.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');const id=randomUUID();
  const legacy=legacyFullOfferFixture(),base={...legacy,amount_minor:issued.quote.balance_minor,price_quote_id:issued.id,price_quote_sha256:issued.quote.sha256};
  const {sha256:ignored,...payload}=base;void ignored;const offer={...payload,sha256:canonicalSha256(payload)};
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version) values($1,$2,'full',$3,$4,$5,'ILS',$6,$7,$8,$9)",[id,ids[0],issued.quote.purchased_period.from+'-01',issued.quote.purchased_period.to+'-01',issued.quote.balance_minor,offer,offer.sha256,issued.quote.purchased_topics,issued.termsVersion]);
  return id;
 };
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_QUOTED_ORDER==='1'){await owner.query('begin');try{await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}}
  await owner.query('begin');
  for(const id of ids){
   const email=`quote-proof-${id}@example.invalid`;
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic quoted order',$2,'0500000000',true,'under_review','verified',now(),'2020-01-01')",[id,email]);
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
  const counts=async()=> (await owner.query("select (select count(*)::int from private.product_orders where case_id=$1 and kind='full') orders,(select count(*)::int from private.order_quote_reservations where case_id=$1) reservations",[ids[0]])).rows[0];
  expect((await owner.query("select count(*)::int n from private.order_availability where kind='full' and topic='pension' and ready and period_from<='2020-01-01' and period_to>='2020-01-01'")).rows[0].n).toBe(0);
  await expect(accept(worker,issued.id)).rejects.toThrow('ORDER_COVERAGE_UNAVAILABLE');expect(await counts()).toEqual({orders:0,reservations:0});
  checks.push('unavailable purchased coverage creates neither an order nor a credit reservation');
  await owner.query("insert into private.order_availability(kind,topic,period_from,period_to,ready,evidence_reference) values('full','pension','2020-01-01','2020-03-01',true,$1)",[availabilityMarker]);
  await expect(transact(worker,async c=>{await acceptSavedPriceQuote(c,{quoteId:issued.id,caseId:ids[0],identityId:identities[0]});throw new Error('INJECTED_BEFORE_COMMIT');})).rejects.toThrow('INJECTED_BEFORE_COMMIT');
  expect(await counts()).toEqual({orders:0,reservations:0});
  checks.push('failure after SQL acceptance but before commit rolls back the newly created order, reservation and cascading events');
  const badOffer={...quotedFullOffer(issued.quote,issued.termsVersion),price_quote_id:issued.id,sha256:'a'.repeat(64),amount_minor:1};
  await expect(transact(worker,async()=>worker.query('select private.order_quote_accept($1,$2)',[issued.id,badOffer]))).rejects.toThrow('ORDER_OFFER_INVALID');
  await expect(transact(worker,c=>acceptSavedPriceQuote(c,{quoteId:issued.id,caseId:ids[0],identityId:identities[1]}))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(transact(worker,c=>acceptSavedPriceQuote(c,{quoteId:issued.id,caseId:ids[1],identityId:identities[1]}))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  for(const role of ['anon','authenticated','service_role','tivdoc_web_runtime','tivdoc_operations_runtime'])expect((await owner.query("select has_function_privilege($1,'private.order_quote_accept(uuid,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false);
  await expect(web.query('select private.order_quote_accept($1,$2)',[issued.id,badOffer])).rejects.toMatchObject({code:'42501'});
  expect(await counts()).toEqual({orders:0,reservations:0});checks.push('altered price, foreign case/identity, actual web access and all non-worker function ACLs are refused');
  const expiredId=randomUUID(),expired=structuredClone(issued.quote);
  expired.created_at=new Date(Date.parse(expired.created_at)-8*86400000).toISOString();expired.expires_at=new Date(Date.parse(expired.expires_at)-8*86400000).toISOString();
  const {sha256:ignoredExpiry,...expiredPayload}=expired;void ignoredExpiry;expired.sha256=canonicalSha256(expiredPayload);
  await owner.query('insert into private.order_price_quotes(id,case_id,identity_id,request_sha256,snapshot,quote_sha256,terms_version) values($1,$2,$3,$4,$5,$6,$7)',[expiredId,ids[0],identities[0],canonicalSha256({expiredId}),expired,expired.sha256,issued.termsVersion]);
  await expect(accept(worker,expiredId)).rejects.toThrow('PRICE_QUOTE_EXPIRED');expect(await counts()).toEqual({orders:0,reservations:0});
  checks.push('database-clock expiry prevents initial acceptance without creating an order or reserving credit');
  const other=await transact(peer,c=>issueSavedPriceQuote(c,request('2020-02'),reader));if(other.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');
  const rivals=await Promise.allSettled([accept(worker,issued.id),accept(peer,other.id)]);
  expect(rivals.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(rivals.filter(r=>r.status==='rejected')).toHaveLength(1);
  for(const r of rivals)if(r.status==='rejected')expect(r.reason.message).toBe('PRICE_QUOTE_CREDIT_UNAVAILABLE');
  expect(await counts()).toEqual({orders:1,reservations:1});
  const winningQuote=rivals[0].status==='fulfilled'?issued:other;
  checks.push('different quotes racing for one initial credit create exactly one full order; the losing insert rolls back');
  const replays=await Promise.all([accept(worker,winningQuote.id),accept(peer,winningQuote.id)]);
  expect(replays[0]).toEqual(replays[1]);expect(replays[0].replayed).toBe(true);const winner=replays[0].order;
  expect((await owner.query("select kind,count(*)::int n from private.order_events where order_id=$1 group by kind order by kind",[winner.id])).rows).toEqual([{kind:'created',n:1},{kind:'quote_reserved',n:1}]);
  checks.push('concurrent exact retries after response loss return one saved order and do not duplicate either event');
  const samePeriod=await transact(worker,c=>issueSavedPriceQuote(c,{...request(),from:winningQuote.quote.purchased_period.from,to:winningQuote.quote.purchased_period.to},reader));if(samePeriod.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');
  await expect(accept(peer,samePeriod.id)).rejects.toThrow('PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION');
  checks.push('a different quote for an existing purchased scope cannot silently reprice, cancel or replace that order');
  const zeroCredit=await transact(worker,c=>issueSavedPriceQuote(c,request('2020-03'),reader));if(zeroCredit.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');expect(zeroCredit.quote.credit_minor).toBe(0);
  const sameQuoteRace=await Promise.all([accept(worker,zeroCredit.id),accept(peer,zeroCredit.id)]);
  expect(sameQuoteRace.map(x=>x.replayed).sort()).toEqual([false,true]);expect(sameQuoteRace[0].order.id).toBe(sameQuoteRace[1].order.id);expect(await counts()).toEqual({orders:2,reservations:2});
  checks.push('two first acceptances of the same unreserved quote create one order and one zero-credit reservation');
  const oldOrder=await createFull({...issued,quote:{...issued.quote,purchased_period:{from:'2020-04',to:'2020-04'}}});
  await owner.query("update private.product_orders set state='paid',verified_at=now() where id=any($1::uuid[])",[[winner.id,oldOrder]]);
  const clocks=(await owner.query('select order_id,track,budget_ms::int from private.order_sla where order_id=any($1::uuid[])',[[winner.id,oldOrder]])).rows;
  expect(clocks.find(c=>c.order_id===winner.id)).toMatchObject({track:'business',budget_ms:86400000});expect(clocks.find(c=>c.order_id===oldOrder)).toMatchObject({track:'human',budget_ms:86400000});
  expect(winner.offer).toMatchObject({version:'tivdoc-order-offer-v2',human_review_required:false,service_kind:'ai_assisted'});
  checks.push('synthetic paid v2 order starts a business clock without human attestation; historical v1 retains its human clock');
  await owner.query("update public.questionnaire_responses set payload='{\"salaryType\":\"hourly\"}'::jsonb where case_id=$1",[ids[0]]);
  await expect(accept(worker,zeroCredit.id)).rejects.toThrow('PRICE_QUOTE_SOURCE_CHANGED');expect((await accept(peer,winningQuote.id)).order.id).toBe(winner.id);
  checks.push('changed source rejects unpaid retry while exact paid replay preserves purchased history');
  expect((await owner.query('select count(*)::int n from private.order_entitlements where order_id=any($1::uuid[])',[[winner.id,sameQuoteRace[0].order.id]])).rows[0].n).toBe(0);
  checks.push('quote acceptance alone grants no entitlement and invokes no payment provider');
 }catch(e){failure=e instanceof Error?e.message:'proof_failed';throw e;}finally{
  await owner.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');try{
   await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);
   // The task owns these synthetic orders and their synthetic payment only.
   await owner.query('delete from private.order_availability where evidence_reference=$1',[availabilityMarker]);
   await owner.query('delete from public.payments where case_id=any($1::uuid[])',[ids]);
   await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic quoted order'",[ids]);
   await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
   expect((await owner.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);
   await owner.query('commit');cleaned=true;
  }catch(e){await owner.query('rollback');cleanupError=e;}}
  await Promise.allSettled([owner.end(),worker.end(),peer.end(),web.end()]);
  writeFileSync('docs/release-evidence/P09-quoted-order-db.json',JSON.stringify({verdict:cleaned&&checks.length===11&&!failure?'PASS':'FAIL',checks,failure,cleanupFailure:cleanupError instanceof Error?cleanupError.message:null,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,scope:'Actual worker/peer/web roles; injected synthetic monetary basis and synthetic verified payment row. No canonical monetary proof, provider payment, customer checkout or production change.',productionChanged:false},null,2)+'\n');
  if(cleanupError)throw cleanupError;
 }
},120000);
