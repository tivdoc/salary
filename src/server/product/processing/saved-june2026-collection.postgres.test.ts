import {expect,it,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createJune2026CollectionTarget,june2026CollectionQuestion,JUNE2026_DECLARATION_OPTIONS,JUNE2026_COMPONENT_OPTIONS} from '@/engine/minimum-wage-june2026/collection';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb} from '../case-access/db';
import {listCaseRequests,answerCaseRequest,editCaseRequest} from '../reports/case-requests';
import {offerSnapshot} from '../orders/contracts';
import {legacyFullOfferFixture} from '../orders/fixtures/legacy-offer';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {savedJuneCollectionFixture} from './saved-june2026-collection.fixture';
import {admitSavedSource} from './saved-admission';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {openSavedJune2026Collection,readSavedJune2026Collection} from './saved-june2026-collection';
import {runSavedWorkerMonth} from './saved-worker';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {SourceJob} from './source-dispatch';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_JUNE_COLLECTION_DB_PROOF!=='1')('binds actual DEV request writes and canonical review history to current purchased June sources',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('JUNE_COLLECTION_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:20000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL'),web2=client('TIVDOC_WEB_POSTGRES_URL');
 const f=savedJuneCollectionFixture(),caseId=f.doc.case_id,otherId=randomUUID(),orderId=randomUUID(),sid='june-collection:'+randomUUID(),jti=randomUUID(),tenant='saved-case:'+caseId;
 let identity='',foreignIdentity='',seeded=false,revoked=false;const checks:string[]=[],runIds:string[]=[];
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
 const directory='output/release-completion/june2026-collection';mkdirSync(directory,{recursive:true});
 const context:PostgresTransactionContext={transaction_id:sid,client:{async query(s){const r=await worker.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
 const head=async():Promise<SourceJob>=>{const h=(await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[caseId])).rows[0];return {schema_version:'saved-case-work-v1',case_id:caseId,revision:h.revision,input_sha256:h.input_sha256,mode:'draft'};};
 const tx=async<T>(action:()=>Promise<T>)=>{await worker.query('begin');try{await worker.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'june-collection-proof']);await worker.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);const result=await action();await worker.query('commit');return result;}catch(error){await worker.query('rollback');throw error;}};
 const refuse=async(db:pg.Client,sql:string,values:unknown[],error:string|RegExp)=>{await db.query('savepoint rejected_input');await expect(db.query(sql,values)).rejects.toThrow(error);await db.query('rollback to savepoint rejected_input');};
 const openSql='select private.june2026_collection_request_open($1,$2,$3,$4::jsonb,$5) id';
 const sourceTarget=()=>createJune2026CollectionTarget({checkpoint:f.checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject:{kind:'applicability',field:'age_18_entire_month'}});
 const save=async(job:SourceJob)=>{await admitSavedSource(context,job);await saveExtractionCheckpoint(context,job,f.checkpoint as Parameters<typeof saveExtractionCheckpoint>[2]);};
 const store=postgresCaseAccessDb(web);
 try{
  await Promise.all([owner.connect(),worker.connect(),web.connect(),web2.connect()]);
  expect((await owner.query("select to_regprocedure('private.june2026_collection_request_open(uuid,integer,text,jsonb,text)') ready")).rows[0].ready).not.toBeNull();
  await owner.query('begin');
  for(const id of [caseId,otherId]){
   const email='june-collection-'+id+'@example.invalid';
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic June collection proof',$2,'0500000000',true,'under_review','verified','2026-06-01')",[id,email]);
   const actor=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[canonicalSha256({email}),email])).rows[0].id;
   await owner.query('select public.case_access_identity_link($1,$2)',[actor,id]);if(id===caseId)identity=actor;else foreignIdentity=actor;
  }
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic-metadata-only.pdf','application/pdf',$5,$6,'2026-06-01')",[f.checkpoint.product_document_id,caseId,f.checkpoint.version_id,`cases/${caseId}/versions/${f.checkpoint.version_id}.pdf`,f.doc.size_bytes,f.doc.content_sha256]);
  const createOrder=async(id:string,month:string,topics:string[])=>{const kind=topics[0]==='travel'?'initial':'full',offer=kind==='initial'?offerSnapshot('initial'):legacyFullOfferFixture();await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,$9,$3::date,$3::date,$4,'ILS',$5,$6,$7::text[],$8,'paid',now())",[id,caseId,month,offer.amount_minor,offer,offer.sha256,topics,offer.terms_version,kind]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[id]);};
  await createOrder(randomUUID(),'2026-06-01',['travel']);await createOrder(randomUUID(),'2026-07-01',['minimum_wage']);
  await owner.query("select private.capture_case_input($1,'synthetic_june_collection_scope')",[caseId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.june.collection.worker',$3,now()-interval '1 minute',now()+interval '1 hour',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  const unpurchased=await head(),target=sourceTarget(),question=june2026CollectionQuestion(target);
  await tx(async()=>{await save(unpurchased);expect(await openSavedJune2026Collection(context,unpurchased,f.checkpoint)).toEqual([]);
   await refuse(worker,openSql,[caseId,unpurchased.revision,unpurchased.input_sha256,target,question.question],'JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED');});
  await owner.query('begin');await createOrder(orderId,'2026-06-01',['minimum_wage']);await owner.query("select private.capture_case_input($1,'synthetic_june_minimum_wage_added')",[caseId]);await owner.query('commit');
  const initial=await head();
  checks.push('actual SQL refuses June questions when only June travel and July minimum wage were purchased; adding the June minimum-wage entitlement permits necessary questions');
  await worker.query('begin');await refuse(worker,openSql,[caseId,initial.revision,initial.input_sha256,target,question.question],'JUNE_COLLECTION_FORBIDDEN');await worker.query('rollback');
  const ids=await tx(async()=>{
   await save(initial);const first=await openSavedJune2026Collection(context,initial,f.checkpoint);expect(first).toHaveLength(8);expect(await openSavedJune2026Collection(context,initial,f.checkpoint)).toEqual(first);
   await refuse(worker,openSql,[caseId,initial.revision,initial.input_sha256,target,'האם אין הסדר מיטיב?'],'JUNE_COLLECTION_TARGET_INVALID');
   await refuse(worker,openSql,[caseId,initial.revision,initial.input_sha256,{...target,target_sha256:'a'.repeat(64)},question.question],'JUNE_COLLECTION_TARGET_INVALID');
   await refuse(worker,openSql,[otherId,initial.revision,initial.input_sha256,target,question.question],'JUNE_COLLECTION_FORBIDDEN');
   const evidence=await readSavedJune2026Collection(context,initial);expect(evidence.resolutions).toHaveLength(8);expect(evidence.resolutions.every(r=>r.state==='missing')).toBe(true);
   const run=await runSavedWorkerMonth({context,job:initial,orderId,month:'2026-06'});runIds.push(run.analysis_run_id);expect(run.bundle?.topic_results).toHaveLength(1);expect(run.bundle?.topic_results[0].amount).toBeNull();
   const review=run.stages.find(s=>s.stage==='review_pending')!.payload;writeFileSync(directory+'/initial-review.json',JSON.stringify(review,null,2));
   expect(JSON.stringify(review)).toContain('saved-june2026-collection-evidence-v1');
   const replay=await runSavedWorkerMonth({context,job:initial,orderId,month:'2026-06'});expect(replay.analysis_run_id).toBe(run.analysis_run_id);expect(replay.report?.report_sha256).toBe(run.report?.report_sha256);
   return first;
  });
  expect((await head()).revision).toBe(initial.revision);checks.push('actual scoped worker opens8 source-bound questions once including a1e-7-confidence component; exact TS/SQL wording and hash; no input revision from opening; canonical review persists and retries once');
  const rows=await listCaseRequests(caseId,store,identity);expect(rows).toHaveLength(8);expect(rows.every(r=>r.source_current&&r.statement_month==='2026-06')).toBe(true);
  const component=rows.find(r=>r.options?.length===JUNE2026_COMPONENT_OPTIONS.length)!;expect(component.options).toEqual(JUNE2026_COMPONENT_OPTIONS);
  const age=rows.find(r=>r.question===question.question)!;expect(age.options).toEqual(JUNE2026_DECLARATION_OPTIONS);
  const sourceArgs=[caseId,identity,component.id];
  const source=(await web.query('select public.case_request_document_source($1,$2,$3) value',sourceArgs)).rows[0].value;
  expect(source).toMatchObject({version:f.checkpoint.version_id,sha256:f.checkpoint.input_sha256,path:`cases/${caseId}/versions/${f.checkpoint.version_id}.pdf`,page:1});
  await expect(web.query('select public.case_request_document_source($1,$2,$3)',[caseId,foreignIdentity,component.id])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await expect(listCaseRequests(caseId,store,foreignIdentity)).rejects.toThrow('JUNE_COLLECTION_FORBIDDEN');
  await web.query('begin');await refuse(web,'select * from public.case_request_answer($1,$2,$3)',[age.id,caseId,JUNE2026_DECLARATION_OPTIONS[0]],'JUNE_COLLECTION_FORBIDDEN');await web.query('rollback');
  await expect(answerCaseRequest({caseId,requestId:age.id,identityId:foreignIdentity,answer:JUNE2026_DECLARATION_OPTIONS[0]},store)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  const answered=await Promise.all([web,web2].map(db=>answerCaseRequest({caseId,requestId:age.id,identityId:identity,answer:JUNE2026_DECLARATION_OPTIONS[0]},postgresCaseAccessDb(db))));expect(answered.every(r=>r?.id===age.id)).toBe(true);
  const after=await head();expect(after.revision).toBeGreaterThan(initial.revision);
  expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[age.id])).rows[0].n).toBe(1);
  expect((await listCaseRequests(caseId,store,identity)).every(r=>r.source_current)).toBe(true);checks.push('foreign identity and unidentified originals rejected; simultaneous exact original retry produces one answer revision and does not stale sibling questions');
  await editCaseRequest({caseId,requestId:age.id,identityId:identity,answer:JUNE2026_DECLARATION_OPTIONS[1],expectedRevision:1,kind:'correction'},store);
  expect(await editCaseRequest({caseId,requestId:age.id,identityId:identity,answer:JUNE2026_DECLARATION_OPTIONS[1],expectedRevision:1,kind:'correction'},store)).toBe(2);
  const corrected=await head();expect(corrected.revision).toBeGreaterThan(after.revision);
  await tx(async()=>{await save(corrected);expect(await openSavedJune2026Collection(context,corrected,f.checkpoint)).toEqual(ids);
   const evidence=await readSavedJune2026Collection(context,corrected);expect(evidence.customer_declarations).toBe(1);expect(evidence.legal_confirmation).toBe(false);expect(evidence.resolutions.find(r=>r.state==='declared')).toMatchObject({declaration:{answer_revision:2,identity_id:identity,interpretation:{value:false},candidate_evidence_admitted:false}});
   const run=await runSavedWorkerMonth({context,job:corrected,orderId,month:'2026-06'});runIds.push(run.analysis_run_id);expect(run.analysis_run_id).not.toBe(runIds[0]);expect(run.bundle?.topic_results[0].amount).toBeNull();
   writeFileSync(directory+'/corrected-review.json',JSON.stringify(run.stages.find(s=>s.stage==='review_pending')!.payload,null,2));
   for(const [extension,bytes]of Object.entries({json:run.report!.json,html:run.report!.html,pdf:run.report!.pdf,manifest:run.report!.manifest}))writeFileSync(directory+'/blocked-canonical-draft.'+extension,bytes);
   expect((await worker.query('select count(*)::int n from public.analysis_runs where tenant_id=$1',[tenant])).rows[0].n).toBe(2);
  });checks.push('correction and exact retry preserve original answer; next actual canonical run retains identified declaration with unreviewed status; both runs retained; no financial finding or publication seeded');
  // Rollback-only source/entitlement perturbations exercise the actual SQL
  // boundary without replacing storage bytes or weakening any RLS policy.
  await owner.query('begin');await owner.query("update private.order_entitlements set state='revoked' where order_id=$1",[orderId]);
  expect((await owner.query('select private.june2026_collection_current($1,$2) current',[caseId,target])).rows[0].current).toBe(false);await owner.query('rollback');
  await owner.query('begin');await owner.query("update public.documents set period_month='2026-07-01' where id=$1",[f.checkpoint.product_document_id]);expect((await owner.query('select private.june2026_collection_current($1,$2) current',[caseId,target])).rows[0].current).toBe(false);await owner.query('rollback');
  // Metadata replacement is not a second upload proof; exact previous byte
  // preservation is covered by the existing upload package.
  const replacement=randomUUID();await owner.query('begin');await owner.query('update public.documents set version_id=$1,storage_path=$2,content_sha256=$3 where id=$4',[replacement,`cases/${caseId}/versions/${replacement}.pdf`,'c'.repeat(64),f.checkpoint.product_document_id]);await owner.query('commit');
  expect((await listCaseRequests(caseId,store,identity)).every(r=>r.source_current===false)).toBe(true);
  expect((await web.query('select public.case_request_document_source($1,$2,$3) value',sourceArgs)).rows[0].value).toBeNull();
  const pending=rows.find(r=>r.id!==age.id)!;
  await expect(answerCaseRequest({caseId,requestId:pending.id,identityId:identity,answer:pending.options?.[0]??'synthetic factual text'},store)).rejects.toThrow('JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED');
  await expect(editCaseRequest({caseId,requestId:age.id,identityId:identity,answer:JUNE2026_DECLARATION_OPTIONS[0],expectedRevision:2,kind:'correction'},store)).rejects.toThrow('JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED');
  await expect(editCaseRequest({caseId,requestId:pending.id,identityId:identity,answer:'draft',expectedRevision:0,kind:'draft'},store)).rejects.toThrow('JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED');
  checks.push('revoked entitlement and month metadata invalidate scope; exact source metadata rejects foreign identity and replacement; old originals/corrections/drafts and browser-facing current-state RPC become stale while preserving history');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[caseId])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
 }catch(error){console.info('JUNE_COLLECTION_DB_FAILURE',{message:(error as Error).message,code:(error as {code?:string}).code});throw error;}finally{
  for(const db of [worker,web,web2,owner])await db.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where sid=$1 and tenant_id=$2',[sid,tenant]);await owner.query('commit');revoked=true;}
  const receipt={verdict:checks.length===5?'PASS':'FAIL',gitSha,dirty,database:'tivdoc_release_replay_20260907',schema:'130 / 20260909185038',caseId,otherId,runIds,checks,
   source:'synthetic database metadata/checkpoint; no uploaded bytes or provider call',authorization:'actual worker/web PostgreSQL roles, provisioned synthetic machine identity and existing RLS; no fixture policies',
   migrationFiles:['20260909181537_june2026_minimum_wage_collection.sql','20260909183727_june2026_collection_age_prompt.sql','20260909185038_june2026_collection_source_link.sql'].map(name=>({name,sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+name)).digest('hex')})),
   retainedSyntheticCases:seeded?2:0,machineSessionRevoked:revoked,customerSessionInjected:false,liveProvider:false,emailSent:false,financialReportProduced:false,productionDatabaseChanged:false};
  writeFileSync(directory+'/database-proof.json',JSON.stringify(receipt,null,2));
  await Promise.all([owner.end(),worker.end(),web.end(),web2.end()]);
 }
},120000);
