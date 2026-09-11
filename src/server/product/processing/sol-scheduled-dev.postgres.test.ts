import {expect,it,vi} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {offerSnapshot} from '../orders/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {createSolSingleBaseSource} from './live-extraction-sol-comparison-fixtures';
import {newSolComparisonLedger} from './live-extraction-sol-comparison-budget';
vi.mock('server-only',()=>({}));
const OWNER='dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const directory='output/release-completion/sol-scheduled-20260911';
const controlFile='../release-work/sol-scheduled-control-20260911.private.json';
type Control={caseId:string;orderId:string;publicId:string;sid:string;jti:string;capability:string;capabilitySha:string;expires:string;gitSha:string;sourceSha256:string};
// Owner provisioning and read-only observation only. This file does NOT import
// an extractor, queue claim, worker runner, calculation or publication function.
// The actual scheduled, separately built worker owns that entire path.
it.skipIf(process.env.TIVDOC_SOL_SCHEDULED_PHASE===undefined)('provisions and observes a separately scheduled live canonical QA case',async()=>{
 const phase=process.env.TIVDOC_SOL_SCHEDULED_PHASE;
 if(process.env.VERCEL||process.env.NODE_ENV!=='test'||!['prepare','snapshot','stop'].includes(phase??''))throw Error('SCHEDULED_PROOF_SCOPE');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const u=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username).toBe('tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu');u.search='';
 const db=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:20000});
 mkdirSync(directory,{recursive:true});
 try{
  await db.connect();
  if(phase==='prepare'){
   expect(existsSync(controlFile)).toBe(false);
   const source=createSolSingleBaseSource('conflicting-hours');
   const caseId=randomUUID(),orderId=randomUUID(),sid='sol.scheduled:'+randomUUID(),jti=randomUUID(),capability=randomBytes(32).toString('base64url'),capabilitySha=sha(capability);
   const expires='2026-09-11T04:10:00Z';expect(Date.now()).toBeLessThan(Date.parse(expires));
   await db.query('begin');
   const publicId=(await db.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic scheduled canonical QA',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[caseId,`sol-scheduled-${caseId}@example.invalid`])).rows[0].public_id;
   await db.query('select public.case_access_identity_link($1,$2)',[OWNER,caseId]);
   const {sha256:ignored,...initial}=offerSnapshot('initial');void ignored;
   const body={...initial,version:'tivdoc-order-offer-v2',kind:'full',service_kind:'ai_assisted',human_review_required:false,synthetic_paid_test_scope:true};
   const offer={...body,sha256:canonicalSha256(body)};
   await db.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
   await db.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);await db.query("select private.capture_case_input($1,'synthetic_paid_full_scope')",[caseId]);
   await db.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.sol.scheduled.worker',$3,now()-interval '1 second',$4,$5,now())",['saved-case:'+caseId,sid,jti,expires,sha(sid+'|'+jti)]);
   await db.query('insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,daily_limit,total_limit,notification_recipients) values($1,$2,20,20,$3::text[])',[capabilitySha,expires,[sha('email|tivdoc.com@gmail.com')]]);
   await db.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4)',[caseId,OWNER,sid,capabilitySha]);
   await db.query('commit');
   const control:Control={caseId,orderId,publicId,sid,jti,capability,capabilitySha,expires,gitSha,sourceSha256:source.sha256};
   writeFileSync(controlFile,JSON.stringify(control,null,2)+'\n',{flag:'wx',mode:0o600});
   writeFileSync(path.join(directory,'input.pdf'),source.bytes,{flag:'wx'});
   writeFileSync(path.join(directory,'independent-oracle.json'),JSON.stringify(source.oracle,null,2)+'\n',{flag:'wx'});
   const ledger=path.resolve(directory,'package-budget-ledger.json');writeFileSync(ledger,JSON.stringify(newSolComparisonLedger(),null,2)+'\n',{flag:'wx'});
   writeFileSync('../release-work/sol-scheduled-package-20260911.private.json',JSON.stringify({version:'sol-scheduled-dev-package-20260911-v1',enabled:true,buildSha:gitSha,expiresAt:expires,ledgerPath:ledger,artifactDirectory:path.resolve(directory,'provider'),allowedCaseIds:[caseId],allowedSources:[{sha256:source.sha256,sizeBytes:source.sizeBytes,mimeType:source.mimeType}]},null,2)+'\n',{flag:'wx',mode:0o600});
   writeFileSync(path.join(directory,'preparation.json'),JSON.stringify({at:new Date().toISOString(),gitSha,caseId,publicId,orderId,sourceSha256:source.sha256,expires,maximumClaims:20,maximumContentRequests:12,maximumReservedUsd:5,ownerRecipient:'tivdoc.com@gmail.com',syntheticPayment:true,documentsUploaded:false,workerInvoked:false,productionChanged:false},null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify({phase,caseId,publicId,orderId,sourceSha256:source.sha256,documentsUploaded:false}));return;
  }
  const c=JSON.parse(readFileSync(controlFile,'utf8')) as Control;
  const owned=(await db.query('select c.is_qa,m.identity_id,m.capability_sha256 from public.cases c join private.managed_dev_worker_cases m on m.case_id=c.id where c.id=$1',[c.caseId])).rows[0];expect(owned).toEqual({is_qa:true,identity_id:OWNER,capability_sha256:c.capabilitySha});
  if(phase==='stop'){
   await db.query('begin');await db.query("select set_config('tivdoc.tenant_id',$1,true)",['saved-case:'+c.caseId]);
   await db.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=now() where case_id=$1 and capability_sha256=$2',[c.caseId,c.capabilitySha]);
   await db.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[c.capabilitySha]);
   await db.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',['saved-case:'+c.caseId,c.sid]);await db.query('commit');
   const f='../release-work/sol-scheduled-package-20260911.private.json',pkg=JSON.parse(readFileSync(f,'utf8'));writeFileSync(f,JSON.stringify({...pkg,enabled:false},null,2)+'\n');
  }
  const queries:Record<string,string>={head:'select revision,input_sha256 from private.case_input_heads where case_id=$1',documents:'select id,version_id,content_sha256 from public.documents where case_id=$1',requests:'select id,code,question,answer,answer_kind,answered_at,expires_at from public.case_requests where case_id=$1 order by created_at',checkpoints:'select revision,version_id,result_sha256,result from private.case_extraction_checkpoints where case_id=$1 order by revision',jobs:"select job_id,state,attempt_count,available_at,lease_expires_at from public.engine_durable_jobs where tenant_id='saved-case:'||$1::text order by created_at",results:'select analysis_run_id,projection_id,input_revision,namespace,created_at from private.june2026_regular_results where case_id=$1 order by created_at'};
  const values:Record<string,unknown>={at:new Date().toISOString(),gitSha,phase,caseId:c.caseId,publicId:c.publicId,workerInvoked:false,providerCallsByObserver:0,productionChanged:false};
  for(const [name,sql]of Object.entries(queries))values[name]=(await db.query(sql,[c.caseId])).rows;
  const output=path.join(directory,`${phase}-${Date.now()}.json`);writeFileSync(output,JSON.stringify(values,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({phase,output,head:values.head,documents:values.documents,jobs:values.jobs,results:values.results,requestCount:(values.requests as unknown[]).length}));
 }catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
},60000);
