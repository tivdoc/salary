import {expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {documentUploadSchema} from '@/lib/document-upload';
import type {UploadBatch} from '../documents/upload';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {installCaseAccessDbForTests,postgresCaseAccessDb} from '../case-access/db';
import {readJune2026RegularArtifact} from '../reports/june2026-regular-artifact';
vi.mock('server-only',()=>({}));

/** Real retained live-provider reports, no provider calls or seeded findings.
 * Mutations below are rollback probes; published historical bytes stay intact. */
it.skipIf(process.env.TIVDOC_JUNE_REGULAR_CURRENT_PROOF!=='1')('fences ordinary live report presentation after changed input or authority',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('DEV_ONLY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},statement_timeout:15000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),web=client('TIVDOC_WEB_POSTGRES_URL'),identity='dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a';
 const source=JSON.parse(readFileSync('../release-work/june-regular-live-absent-hours.private.json','utf8'));
 const report=JSON.parse(readFileSync(source.directory+'/report.json','utf8')),projection=report.document.id;
 const checks:string[]=[];let failed:unknown=null;
 const current=async()=> (await owner.query('select private.june2026_regular_publication_current($1) value',[projection])).rows[0].value;
 const artifact=async()=> (await web.query('select public.june2026_regular_report_artifact($1,$2,$3) value',[source.caseId,identity,projection])).rows[0].value;
 const snapshot=async()=> (await web.query('select public.case_report_customer_snapshot($1,$2) value',[source.caseId,identity])).rows[0].value;
 try{
  await Promise.all([owner.connect(),web.connect()]);
  expect(await current()).toBe(true);const baseline=await artifact();expect(baseline).toMatchObject({current:true,authority_current:true});
  installCaseAccessDbForTests(postgresCaseAccessDb(web));
  const reconstructed=await readJune2026RegularArtifact(source.caseId,identity,projection);
  expect(reconstructed?.current).toBe(true);expect(reconstructed?.report.report_id).toBe(projection);
  expect(Buffer.from(reconstructed!.report.html).equals(readFileSync(source.directory+'/report.html'))).toBe(true);
  expect(Buffer.from(reconstructed!.report.pdf).equals(readFileSync(source.directory+'/report.pdf'))).toBe(true);
  checks.push('ordinary_access_adapter_and_artifact_reader_return_exact_live_html_pdf');
  expect((await snapshot()).reports.find((r:{id:string})=>r.id===projection).state).toBe('published');
  await expect(web.query('select private.june2026_regular_publication_current($1)',[projection])).rejects.toThrow('permission denied');
  await expect(web.query('select private.june2026_regular_publication_owned_current($1,$2,$3)',[projection,source.caseId,randomUUID()])).rejects.toThrow('REGULAR_REPORT_FORBIDDEN');
  checks.push('actual_web_current_artifact_and_snapshot','private_authority_boolean_not_exposed','foreign_owned_wrapper_denied');
  const assessment=(await owner.query('select a.* from private.june2026_regular_assessments a join private.june2026_regular_results r on r.assessment_id=a.id where r.projection_id=$1',[projection])).rows[0];
  await owner.query('begin');try{
   await owner.query('update private.june2026_regular_assessments set revoked_at=now() where id=$1',[assessment.id]);expect(await current()).toBe(false);
   expect((await owner.query('select private.managed_dev_notification_event_current($1,$2) value',[source.caseId,'report:'+projection])).rows[0].value).toBe(false);
   expect((await owner.query('select report_id from public.case_report_notification_pending()')).rows.some(r=>r.report_id===projection)).toBe(false);
   const delivery=canonicalSha256({probe:randomUUID()});
   await owner.query("insert into private.case_notification_outbox(delivery_id,case_id,identity_id,recipient_sha256,template,encrypted_payload,expires_at) values($1,$2,$3,$4,'report_ready',$5,now()+interval '1 hour')",[delivery,source.caseId,identity,'a'.repeat(64),{synthetic_rollback_only:true}]);
   await owner.query('update private.case_report_delivery set delivery_id=$2 where report_id=$1',[projection,delivery]);
   await owner.query('select delivery_id from public.case_notification_outbox_claim($1)',[randomUUID()]);
   expect((await owner.query('select state,last_error,encrypted_payload from private.case_notification_outbox where delivery_id=$1',[delivery])).rows[0]).toEqual({state:'dead_letter',last_error:'report_authority_unavailable',encrypted_payload:null});
   checks.push('already_queued_regular_notification_invalidated_before_generic_claim_no_email_sent');
   checks.push('revoked_assessment_blocks_predicate_and_notification_pending');
  }finally{await owner.query('rollback');}
  // This probes a tampered/expired record as well as its pinned hash. The pure
  // verifier tests separately prove valid signatures that expire with time.
  await owner.query('begin');try{
   const expired=structuredClone(assessment.payload);expired.payload.expires_at='2026-01-01T00:00:00.000Z';
   await owner.query('update private.june2026_regular_assessments set payload=$2,payload_sha256=$3 where id=$1',[assessment.id,expired,canonicalSha256(expired)]);
   expect(await current()).toBe(false);checks.push('expired_or_tampered_assessment_record_blocks');
  }finally{await owner.query('rollback');}
  await owner.query('begin');try{
   const registry=(await owner.query('select * from private.june2026_authority_registries where registry_key=$1 order by revision desc limit 1',[assessment.registry_key])).rows[0];
   const payload=structuredClone(registry.payload);payload.trust_journal.events.push({kind:'revoke',at:new Date().toISOString(),key_id:assessment.payload.envelope.key_id,effective_at:new Date().toISOString(),reason_code:'synthetic_rollback_probe',actor:'isolated.june.admin'});
   await owner.query('insert into private.june2026_authority_registries(registry_key,revision,namespace,payload,payload_sha256) values($1,$2,$3,$4,$5)',[registry.registry_key,registry.revision+1,registry.namespace,payload,canonicalSha256(payload)]);
   expect(await current()).toBe(false);checks.push('appended_registry_revision_invalidates_old_publication');
  }finally{await owner.query('rollback');}
  const target=(await owner.query('select request_id from private.june2026_hours_targets where case_id=$1 and version_id=$2',[source.caseId,source.file.versionId])).rows[0];
  await web.query('begin');try{
   await web.query("select public.case_request_edit($1,$2,$3,$4,1,'correction')",[source.caseId,target.request_id,identity,'101']);
   const changed=await artifact();expect(changed).toMatchObject({current:false,authority_current:false});
   expect((await readJune2026RegularArtifact(source.caseId,identity,projection))?.current).toBe(false);
   expect((await snapshot()).reports.find((r:{id:string})=>r.id===projection).state).toBe('authority_unavailable');
   expect(canonicalSha256(changed.completion)).toBe(canonicalSha256(baseline.completion));checks.push('identified_answer_change_fences_web_artifact_and_UI_without_rewriting_history');
  }finally{await web.query('rollback');}
  // New publication reader risk only: reuse existing upload transaction and
  // replace with identical synthetic bytes. No extraction or new findings.
  const keys=JSON.parse(readFileSync('../release-work/preview-secrets.json','utf8'));expect(keys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
  const bucket=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('salary-documents');
  const input=readFileSync(source.directory+'/input.pdf'),hash=createHash('sha256').update(input).digest('hex');let uploadedPath:string|null=null;
  await web.query('begin');try{
   const manifest=documentUploadSchema.parse({caseId:source.caseId,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:'synthetic-replacement.pdf',type:'application/pdf',size:input.length,sha256:hash,periodMonth:'2026-06',replace:{documentId:source.file.documentId,versionId:source.file.versionId}}]});
   const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[source.caseId,manifest.batchId,manifest])).rows[0].value as UploadBatch;
   const file=batch.files[0];expect(file.path.startsWith(`cases/${source.caseId}/`)).toBe(true);expect(file.path).not.toBe(source.file.path);
   const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});expect(signed.error).toBeNull();
   const upload=await bucket.uploadToSignedUrl(file.path,signed.data!.token,input,{contentType:'application/pdf'});expect(upload.error).toBeNull();uploadedPath=file.path;
   await web.query('select public.case_documents_commit($1,$2,$3)',[source.caseId,manifest.batchId,{[file.versionId]:hash}]);
   expect(await artifact()).toMatchObject({current:false,authority_current:false});
   const previous=await bucket.download(source.file.path);expect(previous.error).toBeNull();expect(createHash('sha256').update(Buffer.from(await previous.data!.arrayBuffer())).digest('hex')).toBe(hash);
   expect(canonicalSha256((await artifact()).completion)).toBe(canonicalSha256(baseline.completion));
   checks.push('actual_uploaded_replacement_fences_ordinary_report_preserves_old_storage_and_bytes');
  }finally{
   await web.query('rollback');
   if(uploadedPath){expect((await owner.query('select count(*)::int n from public.documents where storage_path=$1',[uploadedPath])).rows[0].n).toBe(0);expect((await bucket.remove([uploadedPath])).error).toBeNull();}
  }
  expect(await current()).toBe(true);expect(canonicalSha256((await artifact()).completion)).toBe(canonicalSha256(baseline.completion));checks.push('all_rollback_probes_restored_original_current_state_and_bytes');
 }catch(error){failed=error;throw error;}finally{
  installCaseAccessDbForTests(null);await Promise.allSettled([owner.query('rollback'),web.query('rollback')]);await Promise.allSettled([owner.end(),web.end()]);
  writeFileSync(`output/release-completion/june-regular/current-authority-${Date.now()}.json`,JSON.stringify({at:new Date().toISOString(),state:failed?'FAIL':'PASS',error:failed instanceof Error?failed.message:null,
   gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeClean:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()==='',schemaMigration:'20260910172700_june2026_regular_current_authority.sql',
   migrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20260910172700_june2026_regular_current_authority.sql')).digest('hex'),caseId:source.caseId,projectionId:projection,checks,providerCalls:0,mutations:'rolled_back',productionChanged:false},null,2)+'\n',{flag:'wx'});
 }
},60000);
