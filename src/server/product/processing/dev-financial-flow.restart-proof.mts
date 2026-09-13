import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {z} from 'zod';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca.ts';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical.ts';
import {sourceJobSchema} from './source-dispatch.ts';
import {runSavedDevFinancialMonth} from './dev-financial-analysis.ts';
import type {PostgresTransactionContext} from '../../platform/persistence/postgres/contracts.ts';

/** Executed only as an independently started, bundled proof process. It has
 * no provider or Storage port: recovery must use the committed analysis. */
async function main(){
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL||process.env.TIVDOC_DEV_FINANCIAL_PROCESS_PROOF!=='1')throw Error('RESTART_PROOF_BOUNDARY');
 const input=z.object({job:sourceJobSchema,orderId:z.uuid(),sid:z.string(),jti:z.uuid(),workerUrl:z.string(),gitSha:z.string().regex(/^[a-f0-9]{40}$/u),runId:z.uuid(),runSha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict().parse(JSON.parse(readFileSync(process.env.TIVDOC_DEV_FINANCIAL_PROCESS_INPUT??'','utf8')));
 if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==input.gitSha)throw Error('RESTART_PROOF_HEAD');
 // The guarded parent supplies the provisioned worker connection privately.
 // Do not bundle the credential CLI and its own top-level main into this process.
 const url=new URL(input.workerUrl);
 if(url.pathname!=='/tivdoc_release_replay_20260907'||url.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||!url.username.endsWith('.cpzrbidxftzqcfeqqusu'))throw Error('RESTART_PROOF_DATABASE');
 url.search='';const db=new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});
 try{await db.connect();await db.query('begin');await db.query('select * from private.runtime_context_install($1,$2,$3)',[input.sid,input.jti,'dev-financial-process-proof']);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[input.gitSha]);
  const context:PostgresTransactionContext={transaction_id:'dev-financial-process-restart',client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
  const result=await runSavedDevFinancialMonth({context,job:input.job,orderId:input.orderId});
  if(!result.receipt.replayed||result.run.run_id!==input.runId||canonicalSha256(result.run)!==input.runSha256)throw Error('RESTART_PROOF_REPLAY_MISMATCH');
  await db.query('commit');process.stdout.write(JSON.stringify({state:'replayed',runId:result.run.run_id,runSha256:canonicalSha256(result.run),htmlSha256:result.artifacts.htmlSha256,pdfSha256:result.artifacts.pdfSha256})+'\n');
 }catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
}
main().catch(()=>{process.stdout.write(JSON.stringify({state:'refused',code:'DEV_FINANCIAL_PROCESS_PROOF_FAILED'})+'\n');process.exitCode=1;});
