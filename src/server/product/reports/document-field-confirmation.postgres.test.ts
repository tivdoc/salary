import {it,expect,vi} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument} from 'pdf-lib';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {legacyFullOfferFixture} from '../orders/fixtures/legacy-offer';
import {SavedCaseSnapshot,SAVED_EXTRACTION_POLICY} from '../processing/saved-snapshot';
import {runSavedWorkerMonth} from '../processing/saved-worker';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {documentFieldTarget,documentFieldQuestion,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from './document-field-confirmation';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_FIELD_CONFIRMATION_DB_PROOF!=='1')('binds saved customer readings to actual worker/identity, immutable extraction and purchased month',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('FIELD_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:20000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const fixture=buildSyntheticCaseFixture({fixture_id:`field-db-${randomUUID()}`,mode:'real'}),caseId=fixture.command.case_id,otherId=randomUUID(),docId=randomUUID(),orderId=randomUUID(),identities:string[]=[];
 const doc=fixture.stored.documents[0],extraction=structuredClone(fixture.stored.extractions[0]);
 const period=extraction.fields.find(f=>f.field==='salary_period')!;period.normalized_value={year:2025,month:2,start_date:'2025-02-01',end_date:'2025-02-28'};
 const candidate=extraction.fields.find(f=>f.field==='base_monthly_salary')!;candidate.confidence=0.6;
 const browserProof=process.env.TIVDOC_FIELD_CONFIRMATION_PREVIEW_PROOF==='1',sessions:string[]=[],publicIds:string[]=[],storagePaths:string[]=[],sourcePath=`cases/${caseId}/versions/${doc.document_id}.pdf`;
 let sourceHash=doc.content_sha256,sourceSize=100,sourceBytes:Uint8Array|undefined,bucket:ReturnType<ReturnType<typeof createClient>['storage']['from']>|undefined,storageUploaded=false,storageRemoved=false;
 if(browserProof){const pdf=await PDFDocument.create();for(let p=0;p<candidate.source.page;p++)pdf.addPage();pdf.getPages().at(-1)!.drawText('SYNTHETIC SOURCE - February 2025 - Base salary: '+JSON.stringify(candidate.normalized_value),{x:25,y:750,size:10});sourceBytes=await pdf.save();sourceSize=sourceBytes.length;sourceHash=createHash('sha256').update(sourceBytes).digest('hex');}
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:docId,version_id:doc.document_id,input_sha256:sourceHash,expected_month:'2025-02',period_mismatch:false,requires_confirmation:true,
  result_sha256:canonicalSha256({final_extraction:extraction}),run:{result:{final_extraction:extraction}}};
 const target=documentFieldTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,candidateId:candidate.candidate_id}),question=documentFieldQuestion(target);
 const tenant=`saved-case:${caseId}`,sid=`field-proof:${randomUUID()}`,jti=randomUUID(),checks:string[]=[];
 const migration='20260908192147_document_field_confirmations.sql';let seeded=false,cleaned=false,failure:string|null=null,cleanupFailure:string|null=null;
 let sourceTraceProof:unknown=null;
 writeFileSync(`../release-work/field-confirmation-owned-${caseId}.json`,JSON.stringify({caseIds:[caseId,otherId],identities,tenant,sid,docId,orderId,sourcePath,browserProof,scope:'Owned isolated DEV metadata and optional exact synthetic Storage object'}));
 const preview=async(phase:'open'|'stale-open'|'answer'|'correct'|'stale-answer',id:string)=>{if(!browserProof)return;const {verifyFieldConfirmationPreview}=await import('../../../../scripts/release-completion/preview-field-confirmation.mts');await verifyFieldConfirmationPreview({phase,publicId:publicIds[0],foreignPublicId:publicIds[1],session:sessions[0],foreignSession:sessions[1],requestId:id,question:question.question,sourceSha256:sourceHash});};
 const transact=async<T>(db:pg.Client,run:(context:PostgresTransactionContext)=>Promise<T>)=>{await db.query('begin');try{
  await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'field-confirmation-proof']);
  await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]);
  const result=await run({transaction_id:randomUUID(),client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]))),row_count:r.rowCount??0};}}});await db.query('commit');return result;
 }catch(e){await db.query('rollback');throw e;}};
 const head=async()=>(await owner.query('select * from private.case_input_heads where case_id=$1',[caseId])).rows[0];
 const open=async(db:pg.Client,payload=target,scopeCase=caseId)=>{const h=await head();return transact(db,async()=>
  (await db.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[scopeCase,h.revision,h.input_sha256,payload,question.question])).rows[0].id as string);};
 const identified=(db:pg.Client,id:string,identity=identities[0],answer:string=DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0])=>db.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[id,caseId,identity,answer]);
 const saved=async()=>{const h=await head();await owner.query(`insert into private.case_extraction_checkpoints(case_id,revision,version_id,input_sha256,policy_version,result_sha256,result)
  values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,[caseId,h.revision,doc.document_id,sourceHash,SAVED_EXTRACTION_POLICY,checkpoint.result_sha256,checkpoint]);
  return transact(worker,c=>new SavedCaseSnapshot(c,{schema_version:'saved-case-work-v1',case_id:caseId,revision:h.revision,input_sha256:h.input_sha256,mode:'draft'},'2025-02').read());};
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_FIELD_CONFIRMATIONS==='1'){
   expect((await owner.query("select to_regclass('private.document_field_targets') value")).rows[0].value).toBeNull();
   const sql=readFileSync('supabase/migrations/'+migration,'utf8');await owner.query('begin');try{await owner.query(sql);await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}
   writeFileSync('docs/release-evidence/P06-field-confirmation-migration.json',JSON.stringify({state:'APPLIED_ISOLATED_DEV',migration,sha256:createHash('sha256').update(sql).digest('hex'),productionChanged:false},null,2)+'\n');
  }
  await owner.query('begin');
  for(const id of [caseId,otherId]){const email=`field-${id}@example.invalid`;
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic field confirmation',$2,'0500000000',true,'under_review','verified','2025-01-01')",[id,email]);
   const identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);await owner.query('select public.case_access_identity_link($1,$2)',[identity,id]);
   if(browserProof){const session=randomBytes(16).toString('base64url');sessions.push(session);publicIds.push((await owner.query('select public_id from public.cases where id=$1',[id])).rows[0].public_id);await owner.query('select public.case_access_session_create($1,$2,14400)',[identity,createHash('sha256').update('case-access-session|'+session).digest('hex')]);}
  }
  await owner.query('create policy field_fixture on public.documents for all to tivdoc_dev_migrator using(true) with check(true)');
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$6,$5,'2025-02-01')",[docId,caseId,doc.document_id,sourcePath,sourceHash,sourceSize]);
  await owner.query('drop policy field_fixture on public.documents');
  const offer=legacyFullOfferFixture();await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full','2025-01-01','2025-02-01',14900,'ILS',$3,$4,array['minimum_wage'],$5,'paid',now())",[orderId,caseId,offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.field.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;await saved();
  if(browserProof){const keys=JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8'));expect(keys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');bucket=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('salary-documents');
   const uploaded=await bucket.upload(sourcePath,sourceBytes!,{contentType:'application/pdf',upsert:false});if(uploaded.error)throw Error('OWNED_FIELD_SOURCE_UPLOAD_FAILED');storageUploaded=true;storagePaths.push(sourcePath);}
  await expect(open(web)).rejects.toMatchObject({code:'42501'});await expect(open(worker,target,otherId)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  checks.push('actual web role cannot open a confirmation and a verified worker cannot open one in another case');
  const changed=structuredClone(target);changed.candidate.raw_value='forged';await expect(open(worker,changed)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
  checks.push('SQL independently refuses a target that differs from its persisted extraction candidate');
  const h=await head();await expect(transact(worker,async()=>{await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5)',[caseId,h.revision,h.input_sha256,target,question.question]);throw Error('PRECOMMIT_FAULT');})).rejects.toThrow('PRECOMMIT_FAULT');
  expect((await owner.query('select count(*)::int n from private.document_field_targets where case_id=$1',[caseId])).rows[0].n).toBe(0);
  checks.push('failure before commit rolls back both the question and its deferred immutable target');
  const [id,duplicate]=await Promise.all([open(worker),open(peer)]);expect(duplicate).toBe(id);expect(await open(worker)).toBe(id);
  const request=(await owner.query('select * from public.case_requests where id=$1',[id])).rows[0];expect(request.statement_month).toBe('2025-02');expect(request.blocking).toBe(false);
  checks.push('concurrent open and retry return one request bound to purchased February while the initial case month stays January');
  const visibility=async(identity=identities[0])=>(await web.query('select * from public.case_request_field_states($1,$2)',[caseId,identity])).rows;
  expect(await visibility()).toEqual([{request_id:id,source_current:true}]);
  await expect(visibility(identities[1])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await expect(worker.query('select * from public.case_request_field_states($1,$2)',[caseId,identities[0]])).rejects.toMatchObject({code:'42501'});
  checks.push('current-source presentation is identity-bound and rejects foreign customer and worker access');
  await preview('open',id);
  const setMonth=async(month:string)=>{await owner.query('begin');await owner.query('create policy field_month_fixture on public.documents for update to tivdoc_dev_migrator using(true) with check(true)');
   await owner.query('update public.documents set period_month=$1 where id=$2',[month,docId]);await owner.query('drop policy field_month_fixture on public.documents');await owner.query('commit');};
  await setMonth('2025-03-01');await expect(open(worker)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
  expect(await visibility()).toEqual([{request_id:id,source_current:false}]);
  expect((await web.query('select answered_at,expires_at from public.case_requests where id=$1',[id])).rows[0]).toMatchObject({answered_at:null,expires_at:request.expires_at});
  checks.push('an unanswered stale source is identified without rewriting its question expiry or answer state');
  await preview('stale-open',id);
  await setMonth('2025-02-01');
  checks.push('changing current document-month metadata invalidates the old reading even when immutable bytes and older checkpoint still match');
  await expect(web.query('select * from public.case_request_answer($1,$2,$3)',[id,caseId,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await expect(identified(web,id,identities[1])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  checks.push('unattributed original answers and a foreign authenticated identity are refused');
  await preview('answer',id);
  const [one,two]=await Promise.all([identified(web,id),identified(owner,id)]);expect(one.rows[0].id).toBe(id);expect(two.rows[0].id).toBe(id);expect((await identified(web,id)).rows[0].id).toBe(id);
  const answerRows=(await owner.query('select * from private.case_request_answer_versions where request_id=$1',[id])).rows;expect(answerRows).toHaveLength(1);expect(answerRows[0].identity_id).toBe(identities[0]);
  const snapshot=await saved(),reading=snapshot.extractions[0].customer_readings?.[0];expect(reading).toMatchObject({request_id:id,answer_revision:1,identity_id:identities[0],document_id:doc.document_id,actor_kind:'customer'});
  checks.push('concurrent answer and lost-response replay preserve one attributed version that the actual saved snapshot reads from the immutable journal');
  const confirmedHead=await head();await transact(worker,async context=>{
   await worker.query('savepoint before_confirmed_analysis');
   const analysis=await runSavedWorkerMonth({context,job:{schema_version:'saved-case-work-v1',case_id:caseId,revision:confirmedHead.revision,input_sha256:confirmedHead.input_sha256,mode:'draft'},orderId,month:'2025-02'});
   const stage=analysis.stages.find(s=>s.stage==='canonical_facts')!.payload as {facts:unknown};
   const fact=employmentSnapshotSchema.parse(stage.facts).facts.find(f=>f.path==='compensation.base_monthly_salary');
   expect(fact).toMatchObject({status:'confirmed',confidence:1});expect(fact?.provenance[0]).toMatchObject({verified:true,customer_confirmation:{request_id:id,identity_id:identities[0]}});
   expect(analysis.dependencies?.code_version).toBe('case-analysis@0.6.5');expect(analysis.bundle?.topic_results.every(t=>t.amount===null)).toBe(true);
   expect((await worker.query('select count(*)::int n from public.engine_analysis_stage_versions where tenant_id=$1',[tenant])).rows[0].n).toBe(7);
   if(process.env.TIVDOC_SOURCE_TRACE_DB_PROOF==='1'){
    const {proveSourceTracePostgres}=await import('@/server/platform/persistence/postgres/analysis/source-trace.postgres-proof');
    sourceTraceProof=await proveSourceTracePostgres({db:worker,context,tenant,facts:employmentSnapshotSchema.parse(stage.facts),bundle:analysis.bundle!});
   }
   await worker.query('rollback to savepoint before_confirmed_analysis');
   if(sourceTraceProof)expect((await worker.query('select count(*)::int n from public.engine_calculation_trace_versions where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  });
  checks.push('actual worker canonical PostgreSQL stages retain the identified reading under 0.6.5 while legal gates keep all monetary results absent; analysis fixture is rolled back');
  const source=(await web.query('select public.case_request_document_source($1,$2,$3) value',[caseId,identities[0],id])).rows[0].value;expect(source.version).toBe(doc.document_id);expect(source.sha256).toBe(sourceHash);
  await expect(web.query('select public.case_request_document_source($1,$2,$3)',[caseId,identities[1],id])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  checks.push('source metadata is tied to this exact document version and refuses the other customer');
  if(browserProof)await preview('correct',id);else await web.query('select public.case_request_edit($1,$2,$3,$4,1,\'correction\')',[caseId,id,identities[0],DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1]]);
  expect((await saved()).extractions[0].customer_readings).toBeUndefined();expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[id])).rows[0].n).toBe(2);
  checks.push('a negative correction removes confirmation in the next canonical input while preserving both original and corrected answers');
  await expect(web.query("update public.case_requests set question='changed question' where id=$1",[id])).rejects.toThrow('CASE_REQUEST_ALREADY_ANSWERED');
  await expect(worker.query('update private.document_field_targets set target=target where request_id=$1',[id])).rejects.toMatchObject({code:'42501'});
  checks.push('web cannot rewrite the bound question and worker cannot mutate target history');
  const replacement=randomUUID(),replacementPath=`cases/${caseId}/versions/${replacement}.pdf`;
  if(browserProof){const uploaded=await bucket!.upload(replacementPath,sourceBytes!,{contentType:'application/pdf',upsert:false});if(uploaded.error)throw Error('OWNED_FIELD_REPLACEMENT_UPLOAD_FAILED');storagePaths.push(replacementPath);}
  await owner.query('begin');await owner.query('create policy field_replacement on public.documents for update to tivdoc_dev_migrator using(true) with check(true)');
  await owner.query('update public.documents set version_id=$1,storage_path=$2 where id=$3',[replacement,replacementPath,docId]);await owner.query('drop policy field_replacement on public.documents');await owner.query('commit');
  await expect(open(worker)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');expect((await web.query('select public.case_request_document_source($1,$2,$3) value',[caseId,identities[0],id])).rows[0].value).toBeNull();
  expect(await visibility()).toEqual([{request_id:id,source_current:false}]);
  expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[id])).rows[0].n).toBe(2);
  checks.push('answered replaced-source visibility is historical while both immutable answer versions remain intact');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[caseId])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  checks.push('replacement invalidates source and old target reuse without changing paid status or deleting answer history');
  await preview('stale-answer',id);
  if(browserProof)for(const path of storagePaths){const stored=await bucket!.download(path);if(stored.error||!stored.data)throw Error('OWNED_FIELD_SOURCE_NOT_RETAINED');expect(createHash('sha256').update(Buffer.from(await stored.data.arrayBuffer())).digest('hex')).toBe(sourceHash);}
 }catch(e){failure=e instanceof Error?e.message:'FIELD_PROOF_FAILED';throw e;}finally{
  await Promise.all([owner.query('rollback').catch(()=>{}),worker.query('rollback').catch(()=>{}),peer.query('rollback').catch(()=>{}),web.query('rollback').catch(()=>{})]);
  try{if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);
   expect((await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic field confirmation'",[[caseId,otherId]])).rowCount).toBe(2);
   await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);await owner.query('commit');cleaned=true;}
   if(cleaned&&storageUploaded&&bucket){const removed=await bucket.remove(storagePaths);if(removed.error)throw Error('OWNED_FIELD_SOURCE_CLEANUP_FAILED');const remaining=await bucket.list(`cases/${caseId}/versions`);if(remaining.error||remaining.data?.length)throw Error('OWNED_FIELD_SOURCE_REMAINS');storageRemoved=true;}
  }catch(e){cleanupFailure=e instanceof Error?e.message:'FIELD_CLEANUP_FAILED';await owner.query('rollback');throw e;}finally{
   if(process.env.TIVDOC_SOURCE_COMPARISON_DB_PROOF==='1'){
    const proof=sourceTraceProof&&typeof sourceTraceProof==='object'&&'comparisonProof' in sourceTraceProof?sourceTraceProof.comparisonProof:null;
    writeFileSync('docs/release-evidence/P08-source-monetary-comparison-db.json',JSON.stringify({verdict:proof&&cleaned&&!failure&&!cleanupFailure?'PASS':'FAIL',gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),proof,failure,cleanupFailure,syntheticCasesRemoved:cleaned?2:0,syntheticIdentitiesRemoved:cleaned?identities.length:0,machineSessionRevoked:cleaned,traceAndAnalysisRolledBack:Boolean(proof),browserProof:false,productionChanged:false},null,2)+'\n');
   }
   if(process.env.TIVDOC_SOURCE_TRACE_DB_PROOF==='1')writeFileSync('docs/release-evidence/P08-source-calculation-trace-db.json',JSON.stringify({verdict:sourceTraceProof&&cleaned&&!failure&&!cleanupFailure?'PASS':'FAIL',gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),proof:sourceTraceProof,failure,cleanupFailure,syntheticCasesRemoved:cleaned?2:0,syntheticIdentitiesRemoved:cleaned?identities.length:0,machineSessionRevoked:cleaned,traceAndAnalysisRolledBack:Boolean(sourceTraceProof),browserProof:false,productionChanged:false},null,2)+'\n');
   writeFileSync('docs/release-evidence/P06-field-confirmation-db.json',JSON.stringify({verdict:cleaned&&!failure&&!cleanupFailure&&(!browserProof||storageRemoved)&&checks.length===15?'PASS':'FAIL',checks,failure,cleanupFailure,migration,sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),periodGuardMigration:'20260908202806_document_field_period_guard.sql',periodGuardSha256:createHash('sha256').update(readFileSync('supabase/migrations/20260908202806_document_field_period_guard.sql')).digest('hex'),visibilityMigration:'20260908205236_document_field_visibility.sql',visibilitySha256:createHash('sha256').update(readFileSync('supabase/migrations/20260908205236_document_field_visibility.sql')).digest('hex'),syntheticCasesRemoved:cleaned?2:0,syntheticIdentitiesRemoved:cleaned?identities.length:0,machineSessionRevoked:cleaned,browserProof,storageUploaded,storageRemoved,storageObjectsRemoved:storageRemoved?storagePaths.length:0,sourceSha256:browserProof?sourceHash:null,scope:browserProof?'Actual isolated DEV worker/peer/web SQL, actual Storage PDF, seeded customer sessions and hosted reading/correction/history; saved snapshot and canonical PostgreSQL stages. Synthetic extraction and paid order, no live OCR/OTP, legal activation, monetary calculation or production.':'Actual isolated DEV worker/peer/web SQL, saved snapshot and canonical PostgreSQL stages with synthetic document metadata and paid order. No Storage bytes, browser, legal activation or production.',productionChanged:false},null,2)+'\n');
   await Promise.all([owner.end(),worker.end(),peer.end(),web.end()]);
  }
 }
},process.env.TIVDOC_FIELD_CONFIRMATION_PREVIEW_PROOF==='1'?360000:180000);
