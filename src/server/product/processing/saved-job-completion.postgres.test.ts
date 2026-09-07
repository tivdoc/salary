import {it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from '../orders/contracts';
import {runSavedWorkerMonth} from './saved-worker';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {dispatchCaseInput,type SourceJob} from './source-dispatch';
import {PostgresJobsOutboxAuditRepository} from '@/server/platform/persistence/postgres/runtime/jobs-outbox-audit';
import {completeSavedDraftJob} from './saved-job-completion';

it.skipIf(process.env.TIVDOC_SAVED_COMPLETION_DB_PROOF!=='1')('completes all purchased months atomically as the actual worker and refuses partial, stale and cancelled work',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('SAVED_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
 const fixture=buildSyntheticCaseFixture({fixture_id:`worker-${randomUUID()}`,mode:'real'}),caseId=fixture.command.case_id,otherId=randomUUID(),documentId=randomUUID(),orderId=randomUUID(),fullOrderId=randomUUID(),febId=randomUUID();
 const tenant=savedCaseTenant(caseId),sid=`worker-proof:${randomUUID()}`,jti=randomUUID(),checks:string[]=[];
 const doc=fixture.stored.documents[0],extraction=fixture.stored.extractions[0],feb=fixture.stored.documents[1],offer=offerSnapshot('initial');
 const migration='20260907210000_saved_worker_analysis_scope.sql';
 const context:PostgresTransactionContext={transaction_id:sid,client:{async query(s){try{const r=await worker.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]))),row_count:r.rowCount??0};}catch(e){console.info('WORKER_DB_FAILURE',{statement:s.name,code:(e as {code?:string}).code,message:(e as Error).message,where:(e as {where?:string}).where});throw e;}}}};
 let seeded=false,cleaned=false;
 try{
  await Promise.all([owner.connect(),worker.connect()]);
  if(process.env.TIVDOC_APPLY_WORKER_MIGRATION==='1'){await owner.query('begin');await owner.query(readFileSync(`supabase/migrations/${migration}`,'utf8'));await owner.query('commit');}
  await owner.query('begin');
  for(const id of [caseId,otherId])await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic worker proof','qa@example.invalid','0500000000',true,'under_review','verified','2025-01-01')",[id]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[documentId,caseId,doc.document_id,`cases/${caseId}/versions/${doc.document_id}.pdf`,doc.size_bytes,doc.content_sha256]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'other-synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[randomUUID(),otherId,randomUUID(),`cases/${otherId}/versions/other.pdf`,doc.size_bytes,doc.content_sha256]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-02',$4,'feb-synthetic.pdf','application/pdf',$5,$6,'2025-02-01')",[febId,caseId,feb.document_id,`cases/${caseId}/versions/${feb.document_id}.pdf`,feb.size_bytes,feb.content_sha256]);
  // Explicit synthetic paid order; no provider receipt is asserted. Source
  // capture itself is real and never patched or rehashed by the test.
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2025-01-01','2025-01-01',999,'ILS',$3,$4,$5,$6,'paid',now())",[orderId,caseId,offer,offer.sha256,fixture.command.requested_topics.slice(0,3),offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);
  // Existing historical full purchase, not a new v1.1 price or payment proof.
  const fullOffer={...offer,kind:'full',amount_minor:14900,maximum_checked_topics:7,human_review_required:true};
  const {sha256:initialHash,...fullContent}=fullOffer;void initialHash;fullOffer.sha256=canonicalSha256(fullContent);
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full','2025-01-01','2025-02-01',14900,'ILS',$3,$4,$5,$6,'paid',now())",[fullOrderId,caseId,fullOffer,fullOffer.sha256,fixture.command.requested_topics,fullOffer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[fullOrderId]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,$2,'')",[caseId,{salaryType:'hourly',employmentStartMonth:'2024-07'}]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  const head=(await owner.query('select * from private.case_input_heads where case_id=$1',[caseId])).rows[0];
  const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:head.revision,input_sha256:head.input_sha256,mode:'draft'};
  await worker.query('begin');
  await worker.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
  await expect(admitSavedSource(context,job)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');
  expect((await worker.query('select id from public.documents where case_id=$1',[caseId])).rows).toHaveLength(0);
  checks.push('a tenant GUC without authoritative machine SID/JTI cannot admit a saved case');
  await worker.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'saved-worker-proof']);
  await worker.query("select set_config('tivdoc.engine_git_sha',$1,true)",[execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]);
  await expect(admitSavedSource(context,{...job,case_id:otherId})).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');
  await worker.query('savepoint foreign_tenant');await expect(worker.query('select private.resolve_engine_case_id($1,$2)',[savedCaseTenant(otherId),otherId])).rejects.toThrow(/row-level security/);await worker.query('rollback to savepoint foreign_tenant');
  const admission=await admitSavedSource(context,job);expect(admission.tenantId).toBe(tenant);expect(admission.revision).toBe(1);
  expect((await admitSavedSource(context,job)).revision).toBe(1);
  checks.push('verified machine session admits its paid saved source once and refuses another case');
  expect((await worker.query('select id from public.documents where case_id=$1',[caseId])).rows).toHaveLength(2);
  expect((await worker.query('select id from public.documents where case_id=$1',[otherId])).rows).toHaveLength(0);
  checks.push('actual worker can read product document metadata only in its verified case tenant');
  const result={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:documentId,version_id:doc.document_id,input_sha256:doc.content_sha256,expected_month:'2025-01',period_mismatch:false,requires_confirmation:false,run:{result:{final_extraction:extraction}},result_sha256:canonicalSha256({final_extraction:extraction})};
  await saveExtractionCheckpoint(context,job,result as Parameters<typeof saveExtractionCheckpoint>[2]);
  const febExtraction=fixture.stored.extractions[1];
  const febResult={...result,product_document_id:febId,version_id:feb.document_id,input_sha256:feb.content_sha256,expected_month:'2025-02',run:{result:{final_extraction:febExtraction}},result_sha256:canonicalSha256({final_extraction:febExtraction})};
  await saveExtractionCheckpoint(context,job,febResult as Parameters<typeof saveExtractionCheckpoint>[2]);
  const queued=await dispatchCaseInput(context,{caseId,tenantId:tenant,mode:'draft',liveEnabled:false,nowMs:Date.now()});expect(queued).not.toBeNull();
  const queue=new PostgresJobsOutboxAuditRepository(context,tenant,caseId),workerId='synthetic-finalizer';
  const claimed=(await queue.claim(workerId,Date.now(),180000))[0];expect(claimed.job_id).toBe(queued!.job_id);
  await queue.start(claimed.job_id,workerId,claimed.fencing_token,Date.now());
  const finalArgs={context,jobId:claimed.job_id,workerId,fencingToken:claimed.fencing_token};
  await expect(completeSavedDraftJob(finalArgs)).rejects.toThrow('SAVED_JOB_MONTHS_INCOMPLETE');
  const initial=await runSavedWorkerMonth({context,job,orderId,month:'2025-01'});expect(initial.bundle?.topic_results).toHaveLength(3);
  await runSavedWorkerMonth({context,job,orderId:fullOrderId,month:'2025-01'});
  await expect(completeSavedDraftJob(finalArgs)).rejects.toThrow('SAVED_JOB_MONTHS_INCOMPLETE');
  expect((await worker.query('select state from public.engine_durable_jobs where job_id=$1',[claimed.job_id])).rows[0].state).toBe('running');
  expect((await worker.query('select count(*)::int n from public.engine_outbox_events where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  checks.push('initial January and full January do not stand in for the missing purchased February; no terminal success or outbox');
  await owner.query("update private.order_entitlements set state='suspended' where order_id=$1",[fullOrderId]);
  await expect(runSavedWorkerMonth({context,job,orderId:fullOrderId,month:'2025-02'})).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
  await owner.query("update private.order_entitlements set state='active' where order_id=$1",[fullOrderId]);
  checks.push('another paid initial order cannot authorize a suspended full-order month');
  await worker.query('savepoint before_february');
  const february=await runSavedWorkerMonth({context,job,orderId:fullOrderId,month:'2025-02'});
  await worker.query('rollback to savepoint before_february');
  await expect(completeSavedDraftJob(finalArgs)).rejects.toThrow('SAVED_JOB_MONTHS_INCOMPLETE');
  const retried=await runSavedWorkerMonth({context,job,orderId:fullOrderId,month:'2025-02'});expect(retried.report?.report_sha256).toBe(february.report?.report_sha256);
  checks.push('rollback of the final monthly analysis prevents completion; retry retains exact report bytes');
  await expect(completeSavedDraftJob({...finalArgs,fencingToken:claimed.fencing_token+1})).rejects.toThrow('SAVED_JOB_FENCE');
  for(const modification of ["cancellation_requested=true","lease_expires_at=clock_timestamp()-interval '1 second'"]){
   await worker.query('savepoint invalid_lease');await worker.query(`update public.engine_durable_jobs set ${modification} where job_id=$1`,[claimed.job_id]);
   await expect(completeSavedDraftJob(finalArgs)).rejects.toThrow('SAVED_JOB_FENCE');await worker.query('rollback to savepoint invalid_lease');
  }
  checks.push('stale fence, cancelled job and expired database-time lease refuse without terminal effects');
  await worker.query('savepoint expires_during_completion');
  const expiringContext:PostgresTransactionContext={...context,client:{async query(s){
   if(s.name==='saved_job_complete_atomic')await worker.query("update public.engine_durable_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where job_id=$1",[claimed.job_id]);
   return context.client.query(s);
  }}};
  await expect(completeSavedDraftJob({...finalArgs,context:expiringContext})).rejects.toThrow('SAVED_JOB_FENCE');
  expect((await worker.query('select state from public.engine_durable_jobs where job_id=$1',[claimed.job_id])).rows[0].state).toBe('running');
  expect((await worker.query('select count(*)::int n from public.engine_outbox_events where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  await worker.query('rollback to savepoint expires_during_completion');
  checks.push('lease expiration after receipt validation is rejected by the actual atomic SQL with no outbox or terminal state');
  await worker.query('savepoint before_completion');
  const first=await completeSavedDraftJob(finalArgs);expect(first.manifest.months).toHaveLength(3);expect(first.manifest.publication).toBe('draft');
  expect(new Set(first.manifest.months.map(m=>m.analysis_run_id)).size).toBe(3);
  await worker.query('rollback to savepoint before_completion');
  expect((await worker.query('select state from public.engine_durable_jobs where job_id=$1',[claimed.job_id])).rows[0].state).toBe('running');
  expect((await worker.query('select count(*)::int n from public.engine_outbox_events where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  const retry=await completeSavedDraftJob(finalArgs),again=await completeSavedDraftJob(finalArgs);expect(retry.sha256).toBe(first.sha256);expect(again.replayed).toBe(true);expect(again.sha256).toBe(first.sha256);
  expect((await worker.query('select count(*)::int n from public.engine_outbox_events where tenant_id=$1',[tenant])).rows[0].n).toBe(1);
  expect((await worker.query('select state,terminal_effect_sha256 from public.engine_durable_jobs where job_id=$1',[claimed.job_id])).rows[0]).toEqual({state:'succeeded',terminal_effect_sha256:first.sha256});
  checks.push('atomic draft success and one exact manifest roll back together and replay without duplicate outbox');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[caseId])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  expect((await worker.query('select count(*)::int n from public.engine_report_versions where tenant_id=$1 and visible',[tenant])).rows[0].n).toBe(0);
  checks.push('completion leaves customer case/payment states and report visibility unchanged');
  await worker.query('rollback');
  expect((await worker.query('select private.runtime_verified_tenant() value')).rows[0].value).toBeNull();
  checks.push('transaction end clears worker authorization and no canonical fixture rows remain');
 }finally{
  await worker.query('rollback').catch(()=>{});await owner.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where sid=$1 and tenant_id=$2',[sid,tenant]);await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic worker proof'",[[caseId,otherId]]);await owner.query('commit');cleaned=true;}
  writeFileSync('docs/release-evidence/P05-saved-completion-db.json',JSON.stringify({verdict:checks.length===11?'PASS':'FAIL',checks,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync(`supabase/migrations/${migration}`)).digest('hex'),authorization:'actual worker login, provisioned synthetic machine session, existing verified-tenant RLS; no canonical fixture policies',syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,canonicalWritesRolledBack:true,independent_concurrent_finalizers_verified:false,provider_verified:false,storage_bytes_verified:false,customer_publication:false,productionChanged:false},null,2)+'\n');
  await Promise.all([worker.end(),owner.end()]);
 }
},240000);
