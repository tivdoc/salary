import {it,expect,vi} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument} from 'pdf-lib';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {offerSnapshot} from '../orders/contracts';
import {issueSavedPriceQuote,type SavedPricingBasisReader} from '../orders/quote-ledger';
import {acceptSavedPriceQuote} from '../orders/quoted-order';
import {S04_HIGH_CERTAINTY} from './case-report-projection.fixtures';
import {reportDocumentSchema} from './report-document';
import {publishSavedAiReport} from './publish-ai-report';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_AI_PUBLICATION_DB_PROOF!=='1')('binds AI publication to its actual worker, paid AI order and unchanged saved evidence',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('AI_REPORT_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const ids=[randomUUID(),randomUUID()],identities:string[]=[],initialId=randomUUID(),tenant=`saved-case:${ids[0]}`,sid=`ai-publication:${randomUUID()}`,jti=randomUUID();
 const marker=`synthetic-ai-publication:${ids[0]}`,projectionId=randomUUID(),docId=randomUUID(),versionId=randomUUID(),evidenceId=randomUUID();
 const browserProof=process.env.TIVDOC_AI_PUBLICATION_PREVIEW_PROOF==='1';
 const customerSessions:string[]=[],publicIds:string[]=[];let bucket:ReturnType<ReturnType<typeof createClient>['storage']['from']>|undefined,storageUploaded=false,storageRemoved=false,sourceHash='b'.repeat(64),sourceSize=100;
 const sourcePath=`cases/${ids[0]}/versions/${versionId}.pdf`;
 const migration='20260908162320_ai_report_publication.sql',checks:string[]=[];let seeded=false,cleaned=false,failure:string|null=null,cleanupError:unknown;
 writeFileSync(`../release-work/ai-publication-owned-${ids[0]}.json`,JSON.stringify({ids,identities,tenant,sid,jti,marker,projectionId,scope:'Exclusively owned synthetic DEV publication proof'}));
 const transact=async<T>(db:pg.Client,run:(c:PostgresTransactionContext)=>Promise<T>)=>{
  await db.query('begin');try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'ai-publication-proof']);
   const c:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows,row_count:r.rowCount??0};}}};
   const result=await run(c);await db.query('commit');return result;
  }catch(e){await db.query('rollback');throw e;}
 };
 const reader:SavedPricingBasisReader=async(_c,s)=>({case_id:s.caseId,identity_id:s.identityId,input_sha256:s.inputSha256,analysis_version:'synthetic-only',checked_months:['2020-01'],checked_topics:['minimum_wage'],components:[{finding_id:initialId,economic_key:'synthetic-wage-gap',month:'2020-01',topic:'minimum_wage',kind:'wage_gap',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:[evidenceId],rule_versions:['synthetic-only'],alternative_group:null}]});
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_AI_PUBLICATION==='1'){await owner.query('begin');try{await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}}
  await owner.query('begin');
  for(const id of ids){const email=`ai-publication-${id}@example.invalid`;
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic AI publication',$2,'0500000000',true,'under_review','verified',now(),'2020-01-01')",[id,email]);
   const identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);await owner.query('select public.case_access_identity_link($1,$2)',[identity,id]);
  }
  if(browserProof)for(let i=0;i<ids.length;i++){
   const session=randomBytes(16).toString('base64url');customerSessions.push(session);
   publicIds.push((await owner.query('select public_id from public.cases where id=$1',[ids[i]])).rows[0].public_id);
   await owner.query('select public.case_access_session_create($1,$2,14400)',[identities[i],createHash('sha256').update('case-access-session|'+session).digest('hex')]);
  }
  const initial=offerSnapshot('initial');
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2020-01-01','2020-01-01',999,'ILS',$3,$4,array['minimum_wage'],$5,'paid',now())",[initialId,ids[0],initial,initial.sha256,initial.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[initialId]);
  await owner.query("insert into public.payments(case_id,order_id,provider,amount,currency,status,verified_at,idempotency_key) values($1,$2,'invoice4u',9.99,'ILS','verified',now(),$3)",[ids[0],initialId,marker]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{}','Synthetic AI publication source')",[ids[0]]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query("insert into private.order_availability(kind,topic,period_from,period_to,ready,evidence_reference) values('full','minimum_wage','2020-01-01','2020-01-01',true,$1)",[marker]);
  await owner.query('commit');seeded=true;
  if(browserProof){
   const keys=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_STORAGE_CREDENTIALS_FILE??'','utf8'));expect(keys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
   bucket=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('salary-documents');
   const pdf=await PDFDocument.create();pdf.addPage().drawText('SYNTHETIC - AI report evidence fixture');const bytes=await pdf.save();sourceSize=bytes.length;sourceHash=createHash('sha256').update(bytes).digest('hex');
   const uploaded=await bucket.upload(sourcePath,bytes,{contentType:'application/pdf',upsert:false});if(uploaded.error)throw Error('OWNED_SOURCE_UPLOAD_FAILED');storageUploaded=true;
   const stored=await bucket.download(sourcePath);if(stored.error||!stored.data)throw Error('OWNED_SOURCE_READ_FAILED');expect(createHash('sha256').update(Buffer.from(await stored.data.arrayBuffer())).digest('hex')).toBe(sourceHash);
  }

  const quote=await transact(worker,c=>issueSavedPriceQuote(c,{id:randomUUID(),caseId:ids[0],identityId:identities[0],from:'2020-01',to:'2020-01',topics:['minimum_wage']},reader));if(quote.state!=='quoted')throw Error('QUOTE_NOT_ISSUED');
  const accepted=await transact(worker,c=>acceptSavedPriceQuote(c,{quoteId:quote.id,caseId:ids[0],identityId:identities[0]}));
  await owner.query("update private.product_orders set state='paid',verified_at=now() where id=$1",[accepted.order.id]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[accepted.order.id]);
  await owner.query('begin');await owner.query('create policy ai_doc_fixture on public.documents for all to tivdoc_dev_migrator using(true) with check(true)');
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$6,$5)",[docId,ids[0],versionId,sourcePath,sourceHash,sourceSize]);
  await owner.query('drop policy ai_doc_fixture on public.documents');await owner.query('commit');
  const source=(await owner.query('select * from private.case_input_heads where case_id=$1',[ids[0]])).rows[0];
  const publicId=(await owner.query('select public_id from public.cases where id=$1',[ids[0]])).rows[0].public_id;
  const projection={...structuredClone(S04_HIGH_CERTAINTY),case_public_id:publicId,report_kind:'full' as const,check_period_month:'2020-01',months_covered:['2020-01']};
  const document={schema_version:'tivdoc-report-document-v3',service_kind:'ai_assisted',publication_policy:'tivdoc-ai-publication-v1',order_offer_sha256:(accepted.order.offer as {sha256:string}).sha256,id:projectionId,case_id:ids[0],order_id:accepted.order.id,revision:1,input_sha256:source.input_sha256,projection_sha256:canonicalSha256(projection),purchased_period:{from:'2020-01',to:'2020-01'},projection,evidence:[{id:evidenceId,document_id:docId,version_id:versionId,sha256:sourceHash,page:1,field:'gross',fact_version:'synthetic-1'}],findings:[{id:randomUUID(),topic:'minimum_wage',evidence_ids:[evidenceId],rule_versions:['synthetic-rule'],parameter_versions:['synthetic-parameter']}],publication:{state:'draft',approved_input_sha256:null,approval_actor_kind:'automation',published_at:null},correction_policy:'append_new_revision_preserve_published'};
  reportDocumentSchema.parse(document);
  await owner.query('begin');await owner.query('create policy ai_projection_fixture on public.case_report_projections for all to tivdoc_dev_migrator using(true) with check(true)');
  await owner.query("insert into public.case_report_projections(id,case_id,schema_version,report_kind,check_period_month,projection,projection_sha256,legal_basis,generated_at,input_revision,report_document) values($1,$2,$3,'full','2020-01-01',$4,$5,$6,now(),$7,$8)",[projectionId,ids[0],projection.schema_version,projection,canonicalSha256(projection),projection.legal_basis,source.revision,document]);
  await owner.query('drop policy ai_projection_fixture on public.case_report_projections');await owner.query('commit');
  const publish=(db:pg.Client)=>transact(db,c=>publishSavedAiReport(c,{caseId:ids[0],identityId:identities[0],projectionId}));
  const mutate=async(value:unknown)=>{await owner.query('begin');try{await owner.query('create policy ai_projection_fixture on public.case_report_projections for all to tivdoc_dev_migrator using(true) with check(true)');await owner.query("update public.case_report_projections set report_document=$1,projection=$1::jsonb->'projection',projection_sha256=$1::jsonb->>'projection_sha256' where id=$2",[value,projectionId]);await owner.query('drop policy ai_projection_fixture on public.case_report_projections');await owner.query('commit');}catch(e){await owner.query('rollback');throw e;}};
  await expect(transact(worker,c=>publishSavedAiReport(c,{caseId:ids[1],identityId:identities[1],projectionId}))).rejects.toThrow('REPORT_AI_FORBIDDEN');
  await expect(transact(worker,c=>publishSavedAiReport(c,{caseId:ids[0],identityId:identities[1],projectionId}))).rejects.toThrow('PRICE_QUOTE_FORBIDDEN');
  await expect(web.query('select private.report_ai_publish($1,$2,$3,$4)',[ids[0],identities[0],projectionId,document])).rejects.toMatchObject({code:'42501'});
  checks.push('actual foreign case/identity and web-role publication are refused');
  for(const [bad,reason] of [[{...document,order_offer_sha256:'c'.repeat(64)},'REPORT_AI_ORDER_REQUIRED'],[{...document,order_id:initialId},'REPORT_AI_ORDER_REQUIRED'],[{...document,evidence:document.evidence.map(e=>({...e,sha256:'c'.repeat(64)}))},'REPORT_AI_SOURCE_HASH_MISMATCH']] as const){await mutate(bad);await expect(publish(worker)).rejects.toThrow(reason);}
  await mutate(document);checks.push('wrong offer hash, historical initial order and forged source byte hash cannot publish');
  for(const [kind,reason] of [['basis','REPORT_AI_RESULT_NOT_PERMITTED'],['ceiling','REPORT_HUMAN_APPROVAL_REQUIRED'],['human','REPORT_AI_AUTHORITY_REQUIRED']] as const){
   const bad=structuredClone(document);
   if(kind==='human')bad.publication.approval_actor_kind='human';
   else {const topic=bad.projection.topics.find(t=>t.gate==='checked');if(!topic||topic.gate!=='checked')throw Error('FIXTURE');
    if(kind==='basis')topic.basis_complete=false;else topic.amount={currency:'ILS',minor_units:500001};bad.projection_sha256=canonicalSha256(bad.projection);}
   await mutate(bad);
   await expect(transact(worker,async()=>worker.query('select private.report_ai_publish($1,$2,$3,$4)',[ids[0],identities[0],projectionId,bad]))).rejects.toThrow(reason);
  }
  await mutate({...document,schema_version:'tivdoc-report-document-v2'});
  await expect(transact(worker,async()=>worker.query("select * from public.case_report_qa_enqueue($1,$2,'full','automatic',array[]::text[],'published','system:publication_gate')",[ids[0],projectionId]))).rejects.toThrow('REPORT_HUMAN_APPROVAL_REQUIRED');
  await mutate(document);checks.push('actual SQL retains basis and ceiling gates, refuses a forged human actor and keeps legacy full reports behind human review');

  await expect(transact(worker,async()=>worker.query('select private.report_ai_publish($1,$2,$3,$4)',[ids[0],identities[0],projectionId,{...document,revision:2}]))).rejects.toThrow('REPORT_AI_DOCUMENT_CHANGED');
  checks.push('changed saved candidate is refused at the serialized completion boundary');
  await expect(transact(worker,async c=>{await publishSavedAiReport(c,{caseId:ids[0],identityId:identities[0],projectionId});throw Error('INJECTED_BEFORE_COMMIT');})).rejects.toThrow('INJECTED_BEFORE_COMMIT');
  expect((await worker.query('select count(*)::int n from public.case_report_qa where projection_id=$1',[projectionId])).rows[0].n).toBe(0);
  expect((await owner.query('select completed_at from private.order_sla where order_id=$1',[accepted.order.id])).rows[0].completed_at).toBeNull();
  checks.push('pre-commit failure rolls back publication, audit, delivery intentions and order clock completion');
  const raced=await Promise.all([publish(worker),publish(peer)]);expect(raced.map(r=>r.replayed).sort()).toEqual([false,true]);expect(raced[0].qa_id).toBe(raced[1].qa_id);expect(raced[0].published_at).toBe(raced[1].published_at);
  expect((await worker.query('select count(*)::int n from public.case_report_qa_log where qa_id=$1',[raced[0].qa_id])).rows[0].n).toBe(1);
  checks.push('concurrent publication and lost-response retry preserve one QA decision and one audit receipt');
  const snapshot=(await web.query('select public.case_report_customer_snapshot($1,$2) value',[ids[0],identities[0]])).rows[0].value;
  expect(snapshot.reports).toHaveLength(1);const visible=reportDocumentSchema.parse(snapshot.reports[0].document);expect(visible.publication.approval_actor_kind).toBe('automation');expect(visible.publication.state).toBe('published');expect(visible.schema_version).toBe('tivdoc-report-document-v3');
  await expect(web.query('select public.case_report_customer_snapshot($1,$2)',[ids[0],identities[1]])).rejects.toThrow('REPORT_FORBIDDEN');
  checks.push('actual customer-role snapshot returns v3 with automation actor; foreign identity cannot read it');
  await expect(mutate({...document,revision:2})).rejects.toThrow('REPORT_APPEND_REVISION_REQUIRED');
  await owner.query("update public.questionnaire_responses set payload='{\"salaryType\":\"hourly\"}' where case_id=$1",[ids[0]]);
  expect((await publish(worker)).qa_id).toBe(raced[0].qa_id);
  checks.push('published evidence is immutable and exact receipt replay survives later input changes');
  expect((await owner.query("select has_table_privilege('tivdoc_worker_runtime','public.case_report_projections','INSERT') allowed")).rows[0].allowed).toBe(false);
  checks.push('no projection write permission or real legal-source activation is introduced');
  if(browserProof){
   const {verifyAiReportPreview}=await import('../../../../scripts/release-completion/preview-ai-report.mts');
   await verifyAiReportPreview({publicId:publicIds[0],foreignPublicId:publicIds[1],session:customerSessions[0],foreignSession:customerSessions[1],reportId:projectionId,versionId,findingId:document.findings[0].id,sourceSha256:sourceHash});
   expect((await owner.query('select count(*)::int n from private.case_support_threads where case_id=$1 and report_id=$2 and finding_id=$3',[ids[0],projectionId,document.findings[0].id])).rows[0].n).toBe(1);
  }

 }catch(e){failure=e instanceof Error?e.message:'proof_failed';throw e;}finally{
  await owner.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');try{
   await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);
   for(const table of ['case_report_projections','case_report_qa','case_report_qa_log'])await owner.query(`create policy ai_cleanup on public.${table} for all to tivdoc_dev_migrator using(case_id=any(array['${ids[0]}'::uuid,'${ids[1]}'::uuid])) with check(false)`);
   await owner.query('alter table public.case_report_qa_log disable trigger case_report_qa_log_no_update');
   await owner.query('delete from private.order_availability where evidence_reference=$1',[marker]);await owner.query('delete from public.payments where case_id=any($1::uuid[])',[ids]);
   await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic AI publication'",[ids]);await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
   await owner.query('alter table public.case_report_qa_log enable trigger case_report_qa_log_no_update');for(const table of ['case_report_projections','case_report_qa','case_report_qa_log'])await owner.query(`drop policy ai_cleanup on public.${table}`);
   expect((await owner.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);await owner.query('commit');cleaned=true;
  }catch(e){await owner.query('rollback');cleanupError=e;}}
  if(cleaned&&storageUploaded&&bucket){const removed=await bucket.remove([sourcePath]);if(removed.error)cleanupError=new Error('OWNED_SOURCE_CLEANUP_FAILED');else storageRemoved=true;}
  await Promise.allSettled([owner.end(),worker.end(),peer.end(),web.end()]);
  writeFileSync('docs/release-evidence/P08-ai-publication-db.json',JSON.stringify({verdict:cleaned&&checks.length===9&&!failure&&!cleanupError?'PASS':'FAIL',checks,failure,cleanupFailure:cleanupError instanceof Error?cleanupError.message:null,migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,browserProof,storageUploaded,storageRemoved,sourceSha256:browserProof?sourceHash:null,scope:browserProof?'Actual worker/peer/web SQL publication, synthetic paid report and seeded customer sessions; hosted browser/API/PDF and owned Storage bytes. No canonical monetary computation, legal activation, real payment/provider, runtime projection INSERT grant or production.':'Actual worker/peer/web roles and SQL publication/customer snapshot. Owner-seeded synthetic projection, payslip metadata and payment. No Storage bytes, actual monetary computation, source attestation, provider or browser publication proof. No runtime projection INSERT permission or production change.',productionChanged:false},null,2)+'\n');
  if(cleanupError)throw cleanupError;
 }
},browserProofTimeout());
function browserProofTimeout(){return process.env.TIVDOC_AI_PUBLICATION_PREVIEW_PROOF==='1'?240000:120000;}
