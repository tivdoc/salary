import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {seedSourceKindFixture,revokeSourceKindFixture} from './fixtures/source-kind-postgres';
import {obligationPaymentFixture,seedObligationPayroll,type ObligationDbCase} from './fixtures/obligation-payment-postgres';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {savedLegacySourceIntake,legacySourceIntakeRequests} from './saved-legacy-source-intake';
import {documentRowCellTarget,documentRowCellQuestion} from '../reports/document-row-cell-confirmation';
import {documentObligationPaymentLinkQuestion} from '../reports/document-obligation-payment-link';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {SavedCaseSnapshot,SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {readSavedObligationPaymentLinks,openSavedObligationPaymentLinkRequests,attachSavedObligationPaymentLinks} from './saved-obligation-payment-links';
vi.mock('server-only',()=>({}));

/** Actual login roles and named production statements; no provider, Storage,
 * migration, Findings, reports, scheduler or payment provider effects. */
it.skipIf(process.env.TIVDOC_OBLIGATION_PAYMENT_DB_PROOF!=='1')('opens and replays an ordinary obligation choice through actual worker/web roles',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('OBLIGATION_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);
  if(u.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||u.pathname!=='/tivdoc_release_replay_20260907'||!u.username.endsWith('.cpzrbidxftzqcfeqqusu'))throw Error('OBLIGATION_EXACT_DEV_REQUIRED');
  u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const runId=randomUUID(),head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),checks:string[]=[],statements=new Set<string>();
 let f:ObligationDbCase|undefined,primary:unknown,passed=false,revoked=false,lastStatement:string|null=null;
 const cleanupErrors:{stage:string;error:unknown}[]=[];
 const errorView=(error:unknown)=>({name:error instanceof Error?error.name:'Unknown',message:String(error instanceof Error?error.message:error).slice(0,1000),code:error&&typeof error==='object'&&'code'in error?String(error.code):null});
 async function tx<T>(db:pg.Client,operation:(context:PostgresTransactionContext)=>Promise<T>,commit=false){
  await db.query('begin');
  try{
   await db.query("set local lock_timeout='5s'");
   if(db===worker){if(!f)throw Error('FIXTURE_REQUIRED');await db.query('select * from private.runtime_context_install($1,$2,$3)',[f.sid,f.jti,`obligation-proof:${runId}`]);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[head]);}
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(q){lastStatement=q.name;statements.add(q.name);const r=await db.query({name:q.name,text:q.text,values:[...q.values]});return {row_count:r.rowCount??0,rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v])))};}}};
   const out=await operation(context);await db.query(commit?'commit':'rollback');return out;
  }catch(error){await db.query('rollback').catch(error=>cleanupErrors.push({stage:'rollback',error}));throw error;}
 }
 const current=async():Promise<SourceJob>=>{
  const row=(await owner.query("select h.revision,h.input_sha256,d.processing_profile,d.authority_dependency_sha256 from private.case_input_heads h join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[f!.caseId])).rows[0];
  return sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f!.caseId,mode:'draft',...row});
 };
 try{
  await Promise.all([owner.connect(),worker.connect(),web.connect()]);
  for(const [db,principal] of [[owner,'tivdoc_dev_migrator'],[worker,'tivdoc_worker_runtime'],[web,'tivdoc_web_runtime']] as const)
   expect((await db.query('select current_database() database,session_user principal')).rows[0]).toEqual({database:'tivdoc_release_replay_20260907',principal});
  f=await seedSourceKindFixture(owner,'contract');const fixture=f,data=await obligationPaymentFixture(f);await seedObligationPayroll(owner,f,data);
  const checkpoint=data.checkpoint as Parameters<typeof saveExtractionCheckpoint>[2],payrollFixtures=[data];
  await tx(worker,async()=>{for(const d of [{id:fixture.documentId,version:fixture.versionId,hash:fixture.hash,size:fixture.size},{id:data.documentId,version:data.versionId,hash:data.hash,size:data.size}])
   await worker.query('select private.document_physical_pages_record($1,$2,$3,$4,$5,$6,1)',[fixture.caseId,d.id,d.version,d.hash,d.size,'application/pdf']);},true);
  const intakeJob=await current();
  const intakeRequest=await tx(worker,async()=>{
   const context=(await worker.query('select private.legacy_source_intake_context($1,$2,$3) context',[fixture.caseId,intakeJob.revision,intakeJob.input_sha256])).rows[0].context;
   const request=legacySourceIntakeRequests(savedLegacySourceIntake(context)).find(r=>r.kind==='document_field'&&r.target.version_id===data.versionId);
   if(!request)throw Error('SYNTHETIC_PAYROLL_INTAKE_REQUIRED');
   return (await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[fixture.caseId,intakeJob.revision,intakeJob.input_sha256,request.target,request.question.question])).rows[0].id as string;
  },true);
  const identify=async(requestId:string,answer:string,identityId=fixture.identityId)=>tx(web,async()=>web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[requestId,fixture.caseId,identityId,answer]),true);
  await identify(intakeRequest,JSON.stringify({v:1,action:'correct',value:{document_kind:'payslip',period:data.period,page:1,source_label:'SYNTHETIC ONLY - June 2026'}}));
  const beforeRow=await current();await tx(worker,c=>saveExtractionCheckpoint(c,beforeRow,checkpoint),true);
  const rowTarget=documentRowCellTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,componentId:data.componentId,cell:'amount'});
  const rowRequest=await tx(worker,async()=> (await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[fixture.caseId,beforeRow.revision,beforeRow.input_sha256,rowTarget,documentRowCellQuestion(rowTarget).question])).rows[0].id as string,true);
  await identify(rowRequest,'כן, בדקתי במסמך והערך נכון');
  async function replay(){
   const job=await current();
   return tx(worker,async context=>{
    for(const payroll of payrollFixtures)await saveExtractionCheckpoint(context,job,payroll.checkpoint as Parameters<typeof saveExtractionCheckpoint>[2]);
    const snapshot=await new SavedCaseSnapshot(context,job,'2026-06').read(),review=data.review(snapshot);
    const saved=await readSavedObligationPaymentLinks(context,job,'2026-06',review);
    return {job,review,saved,input:attachSavedObligationPaymentLinks(review,saved)};
   },true);
  }
  const initial=await replay();expect(initial.saved.dependencies).toHaveLength(1);
  const target=initial.saved.dependencies[0].target!;expect(target).not.toBeNull();expect(target.candidates).toHaveLength(1);
  expect(target.reading_dependencies.some(d=>d.request_id===rowRequest)).toBe(true);
  const opened=await tx(worker,c=>openSavedObligationPaymentLinkRequests(c,initial.job,'2026-06',initial.review),true);
  expect(opened).toHaveLength(1);const requestId=opened[0].requestId,pair=target.candidates[0];
  const retry=await tx(worker,c=>openSavedObligationPaymentLinkRequests(c,initial.job,'2026-06',initial.review),true);expect(retry).toEqual(opened);
  const source=async(identity:string,linked:'payroll'|'clause',candidate:string|null=pair.target_sha256,request=requestId)=>tx(web,async()=> (await web.query('select public.case_request_obligation_source($1,$2,$3,$4,$5) source',[fixture.caseId,identity,request,candidate,linked])).rows[0].source);
  expect(await source(fixture.identityId,'payroll')).toMatchObject({version:data.versionId,sha256:data.hash,page:1});
  expect(await source(fixture.identityId,'clause',null)).toMatchObject({version:fixture.versionId,sha256:fixture.hash,page:1});
  expect(await source(randomUUID(),'payroll')).toBeNull();expect(await source(fixture.identityId,'payroll','f'.repeat(64))).toBeNull();
  const correct=JSON.stringify({action:'correct',candidate_target_sha256:pair.target_sha256,value:{relationship:'same_obligation',basis:{page:1,locator:'Synthetic payment reference',text:'Synthetic explicit payroll reference to this clause'}}});
  await expect(identify(requestId,correct,randomUUID())).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await identify(requestId,correct);
  const positive=await replay();expect(positive.saved.readings).toHaveLength(1);expect(positive.input.obligation_payment_link_readings).toHaveLength(1);
  expect(await tx(worker,c=>openSavedObligationPaymentLinkRequests(c,positive.job,'2026-06',positive.review))).toEqual([]);
  checks.push('actual worker bridge opens one idempotent source choice; both sources resolve only for linked identity; identified web correct replays through a new saved snapshot');
  const edit=async(request:string,answer:string,revision:number)=>tx(web,async()=> (await web.query("select public.case_request_edit($1,$2,$3,$4,$5,'correction') revision",[fixture.caseId,request,fixture.identityId,answer,revision])).rows[0].revision,true);
  expect(await edit(requestId,JSON.stringify({action:'unknown'}),1)).toBe(2);
  const unknown=await replay();expect(unknown.saved.readings).toEqual([]);expect(unknown.saved.history).toMatchObject([{current:true,action:'unknown'}]);
  expect(await tx(worker,c=>openSavedObligationPaymentLinkRequests(c,unknown.job,'2026-06',unknown.review))).toEqual([]);
  expect(await edit(requestId,correct,2)).toBe(3);const corrected=await replay();expect(corrected.saved.readings[0].answer_revision).toBe(3);
  // Keep the same case and fixed synthetic clause, but add independent source B
  // so its source-answer set can stay current after selected source A changes.
  const second=await obligationPaymentFixture(fixture);await seedObligationPayroll(owner,fixture,second,'payslip-02');payrollFixtures.push(second);
  await tx(worker,async()=>{await worker.query('select private.document_physical_pages_record($1,$2,$3,$4,$5,$6,1)',[fixture.caseId,second.documentId,second.versionId,second.hash,second.size,'application/pdf']);},true);
  const secondJob=await current(),secondRowTarget=documentRowCellTarget({checkpoint:second.checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,componentId:second.componentId,cell:'amount'});
  const secondRowRequest=await tx(worker,async()=> (await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[fixture.caseId,secondJob.revision,secondJob.input_sha256,secondRowTarget,documentRowCellQuestion(secondRowTarget).question])).rows[0].id as string,true);
  await identify(secondRowRequest,'כן, בדקתי במסמך והערך נכון');
  const expanded=await replay(),expandedTarget=expanded.saved.dependencies[0].target!;
  expect(expandedTarget.candidates).toHaveLength(2);expect(expandedTarget.target_sha256).not.toBe(target.target_sha256);
  expect(expanded.saved.readings).toHaveLength(1);expect(expanded.saved.readings[0].request_id).toBe(requestId);
  expect(await tx(worker,c=>openSavedObligationPaymentLinkRequests(c,expanded.job,'2026-06',expanded.review))).toEqual([]);
  // Deliberately exercise the protected SQL lifecycle with a valid recomputed
  // new inventory, modeling a concurrent/renewed opener. Ordinary replay above
  // correctly avoids reopening an already resolved clause.
  const secondRequest=await tx(worker,async()=> (await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[fixture.caseId,expanded.job.revision,expanded.job.input_sha256,expandedTarget,documentObligationPaymentLinkQuestion(expandedTarget).question])).rows[0].id as string,true);
  expect(secondRequest).not.toBe(requestId);
  const states=await tx(worker,async()=> (await worker.query('select private.obligation_payment_request_states($1) states',[fixture.caseId])).rows[0].states as {request_id:string;current:boolean}[]);
  expect(states.find(s=>s.request_id===requestId)?.current).toBe(false);expect(states.find(s=>s.request_id===secondRequest)?.current).toBe(true);
  expect(await source(fixture.identityId,'payroll')).toBeNull();await expect(edit(requestId,correct,3)).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
  const selectedA=expandedTarget.candidates.find(p=>p.version_id===data.versionId)!,survivingB=expandedTarget.candidates.find(p=>p.version_id===second.versionId)!;
  expect(selectedA.target_sha256).toBe(pair.target_sha256);
  const secondCorrect=JSON.stringify({action:'correct',candidate_target_sha256:selectedA.target_sha256,value:{relationship:'same_obligation',basis:{page:1,locator:'Synthetic payment reference',text:'Synthetic explicit payroll reference to this clause'}}});
  await identify(secondRequest,secondCorrect);
  const active=await replay();expect(active.saved.readings).toHaveLength(1);expect(active.saved.readings[0].request_id).toBe(secondRequest);
  expect(active.saved.history.find(h=>h.request_id===requestId)?.current).toBe(false);
  expect(await source(fixture.identityId,'payroll',survivingB.target_sha256,secondRequest)).toMatchObject({version:second.versionId,sha256:second.hash});
  checks.push('second independent payslip expands candidate inventory; ordinary opener suppresses repeat; protected renewed opener supersedes Q1, whose original positive remains history while only Q2 emits one reading');
  const immutable=async()=> (await owner.query(`select jsonb_build_object(
   'documents',(select jsonb_agg(to_jsonb(d) order by d.id) from public.documents d where d.case_id=$1),
   'versions',(select jsonb_agg(to_jsonb(d) order by d.version_id) from public.document_versions d where d.case_id=$1),
   'original_answers',(select jsonb_agg(to_jsonb(a) order by a.request_id) from private.case_request_answer_versions a join public.case_requests r on r.id=a.request_id where r.case_id=$1 and a.revision=1),
   'journals',(select jsonb_agg(to_jsonb(v) order by v.revision) from private.case_input_versions v where v.case_id=$1 and v.revision<=$2),
   'receipt',(select jsonb_agg(to_jsonb(p)) from private.legacy_paid_scope_admissions p where p.case_id=$1)) original`,[fixture.caseId,active.job.revision])).rows[0].original;
  const original=canonicalSha256(await immutable());
  expect(await edit(rowRequest,JSON.stringify({schema_version:'document-field-answer-v2',action:'unknown'}),1)).toBe(2);
  await expect(tx(worker,c=>new SavedCaseSnapshot(c,active.job,'2026-06').read())).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  expect(await source(fixture.identityId,'payroll')).toBeNull();expect(await source(fixture.identityId,'clause',null)).toBeNull();
  await expect(edit(secondRequest,secondCorrect,1)).rejects.toThrow(/REQUEST_ANSWER_INVALID|REQUEST_FIELD_SOURCE_CHANGED/);
  expect((await owner.query('select private.obligation_payment_pair_current($1,$2,$3) current',[fixture.caseId,expandedTarget,survivingB])).rows[0].current).toBe(true);
  const webStates=await tx(web,async()=> (await web.query('select * from public.case_request_field_states($1,$2)',[fixture.caseId,fixture.identityId])).rows);
  expect(webStates.find(s=>s.request_id===secondRequest)?.source_current).toBe(false);
  expect(await source(fixture.identityId,'payroll',survivingB.target_sha256,secondRequest)).toBeNull();
  const changed=await replay();expect(changed.saved.readings).toEqual([]);expect(changed.saved.history.every(h=>!h.current)).toBe(true);
  expect(canonicalSha256(await immutable())).toBe(original);
  expect((await owner.query("select count(*)::integer n from public.case_requests where case_id=$1 and field_crop='obligation.payment_link'",[fixture.caseId])).rows[0].n).toBe(2);
  checks.push('actual web unknown/correction preserve originals; selected A source change makes Q2 web state and all source URLs stale even while B pair remains current; stale snapshot refused, originals and paid receipt unchanged, exactly two historical questions');
  passed=true;
 }catch(error){primary=error;}
 finally{
  await Promise.allSettled([owner.query('rollback'),worker.query('rollback'),web.query('rollback')]);
  if(f)try{await revokeSourceKindFixture(owner,f);revoked=true;}catch(error){cleanupErrors.push({stage:'revoke',error});}
  await Promise.allSettled([owner.end(),worker.end(),web.end()]);
  try{
   const directory='../release-work/obligation-payment-postgres';mkdirSync(directory,{recursive:true});
   writeFileSync(`${directory}/${runId}.private.json`,JSON.stringify({schema_version:'obligation-payment-postgres-proof-v1',result:passed&&revoked&&!cleanupErrors.length?'passed':'failed',tested_head:head,
    database:'tivdoc_release_replay_20260907',primary_failure:primary===undefined?null:{...errorView(primary),last_statement:lastStatement},cleanup_failures:cleanupErrors.map(e=>({...e,error:errorView(e.error)})),checks,
    statement_names:[...statements].sort(),provider_calls:0,storage_calls:0,analysis_runs:0,case_id:f?.caseId??null,revoked,
    fixture_scope:'Random synthetic legacy QA case, source metadata, local payroll PDF/checkpoint; contract reviewed evidence is deterministic injected engine fixture, not DB/provider-authenticated contract extraction. Payroll amount and link answers are authenticated actual web writes and actual worker saved-snapshot/bridge replay.',
    retained_scope:'Only this synthetic case/source metadata/immutable legacy receipt, physical receipts, source and link answer versions, checkpoints, input journals and revoked fixture session/enrollment history. No Findings or reports, real case edits, prior receipt rewrites, external provider or Storage calls.'},null,2)+'\n',{flag:'wx',mode:0o600});
  }catch(error){cleanupErrors.push({stage:'receipt',error});}
 }
 if(primary!==undefined)throw primary;if(cleanupErrors.length)throw new AggregateError(cleanupErrors.map(e=>e.error),'OBLIGATION_DB_CLEANUP_FAILED');
},240000);
