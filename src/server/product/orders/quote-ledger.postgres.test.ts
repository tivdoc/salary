import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {offerSnapshot} from './contracts';
import {legacyFullOfferFixture} from './fixtures/legacy-offer';
import {issueSavedPriceQuote,reserveSavedQuoteCredit,type SavedPricingBasisReader} from './quote-ledger';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_QUOTE_DB_PROOF!=='1')('persists scoped quote history and serializes initial credit on two actual worker connections',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('QUOTE_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const ids=[randomUUID(),randomUUID()],identities:string[]=[],initialId=randomUUID(),tenant=`saved-case:${ids[0]}`,sid=`quote-proof:${randomUUID()}`,jti=randomUUID();
 const checks:string[]=[],migration='20260908145315_order_quote_ledger.sql';let cleaned=false,seeded=false,failure:string|null=null,cleanupError:unknown;
 writeFileSync(`../release-work/quote-ledger-owned-${ids[0]}.json`,JSON.stringify({ids,tenant,sid,jti,scope:'Synthetic quote ledger proof only; isolated DEV'}));
 const transact=async<T>(db:pg.Client,run:(context:PostgresTransactionContext)=>Promise<T>)=>{
  await db.query('begin');try{
   await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'quote-ledger-proof']);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows,row_count:r.rowCount??0};}}};
   const result=await run(context);await db.query('commit');return result;
  }catch(e){await db.query('rollback');throw e;}
 };
 const request=(to='2026-08')=>({id:randomUUID(),caseId:ids[0],identityId:identities[0],from:'2026-08',to,topics:['pension' as const]});
 // Explicit synthetic, injected basis: this is NOT canonical monetary proof.
 const reader:SavedPricingBasisReader=async(_context,source)=>({case_id:source.caseId,identity_id:source.identityId,input_sha256:source.inputSha256,analysis_version:'synthetic-quote-proof-only',checked_months:['2026-08'],checked_topics:['pension'],components:[{finding_id:initialId,economic_key:'synthetic-deposit-gap',month:'2026-08',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:[initialId],rule_versions:['synthetic-only'],alternative_group:null}]});
 const createFull=async(issued:Awaited<ReturnType<typeof issueSavedPriceQuote>>)=>{
  if(issued.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');const id=randomUUID();
  const legacy=legacyFullOfferFixture(),base={...legacy,amount_minor:issued.quote.balance_minor,price_quote_id:issued.id,price_quote_sha256:issued.quote.sha256};
  const {sha256:ignored,...payload}=base;void ignored;const offer={...payload,sha256:canonicalSha256(payload)};
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version) values($1,$2,'full',$3,$4,$5,'ILS',$6,$7,$8,$9)",[id,ids[0],issued.quote.purchased_period.from+'-01',issued.quote.purchased_period.to+'-01',issued.quote.balance_minor,offer,offer.sha256,issued.quote.purchased_topics,issued.termsVersion]);
  return id;
 };
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_QUOTE_LEDGER==='1'){await owner.query('begin');try{await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}}
  await owner.query('begin');
  for(const id of ids){
   const email=`quote-proof-${id}@example.invalid`;
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic quote ledger',$2,'0500000000',true,'under_review','verified',now(),'2026-08-01')",[id,email]);
   const identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);
   await owner.query('select public.case_access_identity_link($1,$2)',[identity,id]);
  }
  const offer=offerSnapshot('initial');
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-08-01','2026-08-01',999,'ILS',$3,$4,array['pension'],$5,'paid',now())",[initialId,ids[0],offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[initialId]);
  await owner.query("insert into public.payments(case_id,order_id,provider,amount,currency,status,verified_at,idempotency_key) values($1,$2,'invoice4u',9.99,'ILS','verified',now(),$3)",[ids[0],initialId,`synthetic-quote:${initialId}`]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{}','Synthetic quote source')",[ids[0]]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  const firstRequest=request();let reads=0;const counted:SavedPricingBasisReader=async(c,s)=>{reads++;return reader(c,s);};
  const issued=await transact(worker,c=>issueSavedPriceQuote(c,firstRequest,counted));
  expect(issued.state).toBe('quoted');if(issued.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');expect(issued.quote.balance_minor).toBe(8901);
  const again=await transact(peer,c=>issueSavedPriceQuote(c,firstRequest,counted));expect(again).toEqual({...issued,replayed:true});expect(reads).toBe(1);
  checks.push('actual worker and fresh peer replay exactly one stored policy/price/credit snapshot without rereading the injected basis');
  await expect(transact(worker,c=>issueSavedPriceQuote(c,{...firstRequest,to:'2026-09'},reader))).rejects.toThrow('PRICE_QUOTE_REQUEST_CONFLICT');
  await expect(transact(worker,c=>issueSavedPriceQuote(c,{...request(),identityId:identities[1]},reader))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(transact(worker,c=>issueSavedPriceQuote(c,{...request(),caseId:ids[1],identityId:identities[1]},reader))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(web.query('select * from private.order_price_quotes')).rejects.toMatchObject({code:'42501'});
  await expect(web.query('select private.order_quote_reserve($1,$2)',[issued.id,initialId])).rejects.toMatchObject({code:'42501'});
  checks.push('conflicting idempotency payload, foreign identity/case and actual web-role ledger access are refused');
  const absent=await transact(worker,c=>issueSavedPriceQuote(c,request(),async()=>null));expect(absent).toEqual({state:'amount_unknown',reason:'trusted_monetary_basis_unavailable'});
  expect((await owner.query('select count(*)::int n from private.order_price_quotes where case_id=$1',[ids[0]])).rows[0].n).toBe(1);
  checks.push('missing trusted basis produces no quote or amount and persists no phantom price');
  const expiredId=randomUUID(),expiredQuote=structuredClone(issued.quote);
  expiredQuote.created_at=new Date(Date.parse(expiredQuote.created_at)-8*86400000).toISOString();
  expiredQuote.expires_at=new Date(Date.parse(expiredQuote.expires_at)-8*86400000).toISOString();expiredQuote.purchased_period.to='2026-11';
  const {sha256:oldHash,...expiredPayload}=expiredQuote;void oldHash;expiredQuote.sha256=canonicalSha256(expiredPayload);
  await owner.query('insert into private.order_price_quotes(id,case_id,identity_id,request_sha256,snapshot,quote_sha256,terms_version) values($1,$2,$3,$4,$5,$6,$7)',[expiredId,ids[0],identities[0],canonicalSha256({expiredId}),expiredQuote,expiredQuote.sha256,issued.termsVersion]);
  const expiredOrder=await createFull({...issued,id:expiredId,quote:expiredQuote});
  await expect(transact(worker,c=>reserveSavedQuoteCredit(c,{quoteId:expiredId,orderId:expiredOrder}))).rejects.toThrow('PRICE_QUOTE_EXPIRED');
  await expect(transact(worker,async()=>worker.query('update private.order_price_quotes set terms_version=$1 where id=$2',['forbidden',issued.id]))).rejects.toMatchObject({code:'42501'});
  for(const role of ['anon','authenticated','service_role','tivdoc_web_runtime','tivdoc_operations_runtime']){
   const acl=(await owner.query("select has_function_privilege($1,'private.order_quote_context(uuid,uuid)','EXECUTE') context,has_function_privilege($1,'private.order_quote_reserve(uuid,uuid)','EXECUTE') reserve,has_table_privilege($1,'private.order_price_quotes','SELECT') read",[role])).rows[0];
   expect(acl).toEqual({context:false,reserve:false,read:false});
  }
  checks.push('expired unpaid quotes cannot reserve credit; runtime cannot rewrite snapshots and actual non-worker ACLs expose no quote data or mutation functions');
  const other=await transact(peer,c=>issueSavedPriceQuote(c,request('2026-09'),reader));const orders=[await createFull(issued),await createFull(other)];
  // An injected failure after the reservation must roll back credit and event.
  await expect(transact(worker,async c=>{await reserveSavedQuoteCredit(c,{quoteId:issued.id,orderId:orders[0]});throw new Error('INJECTED_AFTER_RESERVATION');})).rejects.toThrow('INJECTED_AFTER_RESERVATION');
  expect((await owner.query('select count(*)::int n from private.order_quote_reservations where case_id=$1',[ids[0]])).rows[0].n).toBe(0);
  checks.push('failure before transaction completion rolls back the credit reservation and its order event');
  if(other.state!=='quoted')throw new Error('QUOTE_NOT_ISSUED');
  const rivals=await Promise.allSettled([transact(worker,c=>reserveSavedQuoteCredit(c,{quoteId:issued.id,orderId:orders[0]})),transact(peer,c=>reserveSavedQuoteCredit(c,{quoteId:other.id,orderId:orders[1]}))]);
  expect(rivals.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(rivals.filter(r=>r.status==='rejected')).toHaveLength(1);
  for(const r of rivals)if(r.status==='rejected')expect(r.reason.message).toBe('PRICE_QUOTE_CREDIT_UNAVAILABLE');
  const winner=rivals.findIndex(r=>r.status==='fulfilled'),winningQuote=winner===0?issued:other;
  const retried=await transact(worker,c=>reserveSavedQuoteCredit(c,{quoteId:winningQuote.id,orderId:orders[winner]}));expect(retried.credit_minor).toBe(999);
  expect((await owner.query("select count(*)::int n from private.order_events where order_id=any($1::uuid[]) and kind='quote_reserved'",[orders])).rows[0].n).toBe(1);
  checks.push('two real concurrent worker connections reserve the initial credit exactly once; retry preserves one reservation and one event');
  const subsequent=await transact(peer,c=>issueSavedPriceQuote(c,request('2026-10'),reader));expect(subsequent).toMatchObject({state:'quoted',quote:{credit_minor:0,balance_minor:9900}});
  checks.push('a later quote reads the existing reservation and cannot promise the initial credit a second time');
  await expect(transact(worker,c=>reserveSavedQuoteCredit(c,{quoteId:issued.id,orderId:initialId}))).rejects.toThrow('PRICE_QUOTE_ORDER_MISMATCH');
  await owner.query("update public.questionnaire_responses set payload='{\"salaryType\":\"hourly\"}'::jsonb where case_id=$1",[ids[0]]);
  await expect(transact(worker,c=>issueSavedPriceQuote(c,firstRequest,reader))).rejects.toThrow('PRICE_QUOTE_SOURCE_CHANGED');
  await expect(transact(worker,c=>reserveSavedQuoteCredit(c,{quoteId:winningQuote.id,orderId:orders[winner]}))).rejects.toThrow('PRICE_QUOTE_SOURCE_CHANGED');
  expect((await owner.query('select snapshot from private.order_price_quotes where id=$1',[issued.id])).rows[0].snapshot).toEqual(issued.quote);
  checks.push('mismatched order and changed input refuse unpaid use while historical quote bytes remain unchanged');
  await owner.query("update private.product_orders set state='paid',verified_at=now() where id=$1",[orders[winner]]);
  const paidReplay=await transact(peer,c=>reserveSavedQuoteCredit(c,{quoteId:winningQuote.id,orderId:orders[winner]}));expect(paidReplay).toEqual(retried);
  checks.push('an exact synthetic paid-order replay preserves its original credit reservation after input changes, without a second event or repricing');
 }catch(e){failure=e instanceof Error?e.message:'proof_failed';throw e;}finally{
  await owner.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');try{
   await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);
   // The task owns these synthetic orders and their synthetic payment only.
   await owner.query('delete from public.payments where case_id=any($1::uuid[])',[ids]);
   await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic quote ledger'",[ids]);
   await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
   expect((await owner.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);
   await owner.query('commit');cleaned=true;
  }catch(e){await owner.query('rollback');cleanupError=e;}}
  await Promise.allSettled([owner.end(),worker.end(),peer.end(),web.end()]);
  writeFileSync('docs/release-evidence/P09-quote-ledger-db.json',JSON.stringify({verdict:cleaned&&checks.length===9&&!failure?'PASS':'FAIL',checks,failure,cleanupFailure:cleanupError instanceof Error?cleanupError.message:null,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,scope:'Actual worker/peer/web roles; injected synthetic monetary basis and synthetic verified payment row. No canonical monetary proof, provider payment, customer checkout or production change.',productionChanged:false},null,2)+'\n');
  if(cleanupError)throw cleanupError;
 }
},120000);
