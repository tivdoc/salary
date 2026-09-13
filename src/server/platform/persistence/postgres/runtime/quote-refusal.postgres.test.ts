import {it,expect} from 'vitest';
import pg from 'pg';
import {NodePostgresManagedClient} from './node-pg-driver';
import {CanonicalPostgresError} from './errors';
import {statement} from '../contracts';
import {SUPABASE_ROOT_2021_CA} from '@/server/product/case-access/supabase-ca';

/** Read-only opt-in preflight of actual worker LOGIN, named statements and the
 * production driver. A refused optional quote must leave its parent transaction
 * usable after rollback to savepoint. No schema, case or payment is created. */
it.skipIf(process.env.TIVDOC_QUOTE_REFUSAL_DB_PROOF!=='1')('keeps a DEV worker transaction usable after a mapped commercial refusal',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('QUOTE_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const url=new URL(readDevEnvFile().get('TIVDOC_WORKER_POSTGRES_URL')!);
 if(url.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||url.pathname!=='/tivdoc_release_replay_20260907'
  ||url.username!=='tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu')throw Error('EXACT_ISOLATED_DEV_REQUIRED');
 url.search='';const raw=new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:10000});
 const managed=new NodePostgresManagedClient({async query(q){const r=await raw.query({name:q.name,text:q.text,values:[...q.values]});return {rowCount:r.rowCount,rows:r.rows};},release(){}},{query(){},release(){}});
 await raw.connect();try{
  expect((await raw.query('select session_user role,current_database() database')).rows[0]).toEqual({role:'tivdoc_worker_runtime',database:'tivdoc_release_replay_20260907'});
  await raw.query('begin');
  for(let repeat=0;repeat<2;repeat++){
   await managed.query(statement('quote_refusal_proof_savepoint','savepoint optional_quote',[]));
   let caught:unknown;try{await managed.query(statement('quote_refusal_proof_raise',"do $$begin raise exception 'PRICE_QUOTE_EXPIRED';end$$",[]));}catch(error){caught=error;}
   expect(caught).toBeInstanceOf(CanonicalPostgresError);
   expect(caught).toMatchObject({sqlstate:'P0001',domain_code:'PRICE_QUOTE_EXPIRED',message:'POSTGRES_STATEMENT_FAILED'});
   await managed.query(statement('quote_refusal_proof_rollback','rollback to savepoint optional_quote',[]));
   await managed.query(statement('quote_refusal_proof_release','release savepoint optional_quote',[]));
   expect((await managed.query(statement('quote_refusal_proof_parent','select 1::integer still_usable',[]))).rows[0]).toEqual({still_usable:1});
  }
 }finally{await raw.query('rollback').catch(()=>{});managed.release();await raw.end();}
},30000);
