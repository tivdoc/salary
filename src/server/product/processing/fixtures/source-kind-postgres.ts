import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {PDFDocument} from 'pdf-lib';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildLegacyPaidScope} from '../../orders/legacy-paid-receipt';

export const SOURCE_KIND_FIXTURE_NAME='Synthetic source kind SQL proof';
/** Owner fixture bootstrap only. All UUIDs and source/payment metadata are
 * synthetic. Append-only receipts and their QA cases deliberately remain as
 * labeled test history; this is not an import or validation of a real payment. */
export async function seedSourceKindFixture(owner:pg.Client,kind:'attendance'|'contract',syntheticPrintedText='SYNTHETIC ONLY - June 2026 payslip',physicalPages=1){
 const caseId=randomUUID(),documentId=randomUUID(),versionId=randomUUID(),paymentId=randomUUID();
 const sid=`source-kind-proof:${randomUUID()}`,jti=randomUUID(),tenant=`saved-case:${caseId}`;
 const capturedAt=new Date().toISOString(),publicId=`SYNTHETIC-KIND-${caseId}`;
 const sourceCase={id:caseId,public_id:publicId,payment_status:'verified',is_qa:false};
 const payment={id:paymentId,case_id:caseId,provider:'invoice4u',amount:'9.99',currency:'ILS',status:'verified',verified_at:capturedAt,
  idempotency_key:`${caseId}:initial-check`,provider_order_id:`tivdoc-salary:${publicId}`,provider_payment_id:`synthetic-${paymentId}`,
  provider_reference:`synthetic-${paymentId}`,provider_clearing_log_id:`synthetic-${paymentId}`,provider_confirmation_number:`synthetic-${paymentId}`};
 const source={sourceProject:'hedgdltsonvypefbigag',capturedAt,synthetic_fixture:true,cases:[{...sourceCase,payments:[payment]}]};
 const sourceHash=canonicalSha256(source);
 const built=buildLegacyPaidScope({case:sourceCase,payment,source:{project_ref:source.sourceProject,captured_at:capturedAt,snapshot_sha256:sourceHash},periods:[]});
 if(built.state!=='admitted')throw Error('SYNTHETIC_LEGACY_FIXTURE');
 if(!syntheticPrintedText.startsWith('SYNTHETIC ONLY - ')||syntheticPrintedText.length>180)throw Error('SYNTHETIC_SOURCE_TEXT_REQUIRED');
 if(!Number.isInteger(physicalPages)||physicalPages<1||physicalPages>7)throw Error('SYNTHETIC_SOURCE_PAGE_BOUND');
 const scope=built.scope,pdf=await PDFDocument.create();
 for(let page=1;page<=physicalPages;page++)pdf.addPage().drawText(physicalPages===1||page===3?syntheticPrintedText:`SYNTHETIC ONLY - source page ${page}`,{size:9});
 const bytes=await pdf.save(),hash=createHash('sha256').update(bytes).digest('hex');
 const configurationId=randomUUID(),enrollmentId=randomUUID();
 const issuedAt=new Date(Date.now()-60000).toISOString(),expiresAt=new Date(Date.now()+15*60000).toISOString();
 // SQL profile-selection fixture only. It supplies no legal receipts, rules,
 // report/publication authority or executable configuration. No executor runs.
 const configurationBody={schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:configurationId,revision:1,
  synthetic_sql_routing_fixture:true,policy:{namespace:'isolated_test',issued_at:issuedAt,expires_at:expiresAt},registry:{issued_at:issuedAt,expires_at:expiresAt}};
 const configuration={...configurationBody,sha256:canonicalSha256(configurationBody)};
 await owner.query('begin');
 try{
  await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at) values($1,$2,'source-kind-proof@example.invalid','0500000000',true,'under_review','verified',now())",[caseId,SOURCE_KIND_FIXTURE_NAME]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,$4,$5,$6,'SYNTHETIC-SOURCE-KIND.pdf','application/pdf',$7,$8,null)",[documentId,caseId,versionId,kind,kind,`cases/${caseId}/versions/${versionId}.pdf`,bytes.length,hash]);
  await owner.query('insert into private.legacy_paid_source_snapshots(snapshot_sha256,project_ref,captured_at,source_snapshot,imported_by) values($1,$2,$3,$4,$5)',[sourceHash,source.sourceProject,capturedAt,source,SOURCE_KIND_FIXTURE_NAME]);
  await owner.query('insert into private.legacy_paid_scope_admissions(payment_id,receipt_sha256,case_id,source_case_id,source_snapshot_sha256,scope,source_case_sha256,source_payment_sha256,destination_isolated_qa,registered_by) values($1,$2,$3,$3,$4,$5,$6,$7,true,$8)',[paymentId,scope.receipt_sha256,caseId,sourceHash,scope,scope.case_record_sha256,scope.payment_record_sha256,SOURCE_KIND_FIXTURE_NAME]);
  await owner.query("insert into private.legacy_paid_scope_events(payment_id,receipt_sha256,case_id,action,reason,actor) values($1,$2,$3,'active',$4,$4)",[paymentId,scope.receipt_sha256,caseId,SOURCE_KIND_FIXTURE_NAME]);
  await owner.query('select private.capture_case_input($1,$2)',[caseId,'synthetic_source_kind_fixture']);
  await owner.query('insert into private.ai_release_configurations(configuration_id,revision,payload_sha256,payload) values($1,1,$2,$3)',[configurationId,configuration.sha256,configuration]);
  await owner.query("insert into private.ai_release_enrollment_events(event_id,case_id,sequence,configuration_sha256,kind,idempotency_key,issued_at,expires_at,reason) values($1,$2,1,$3,'granted',$4,$5,$6,$7)",[enrollmentId,caseId,configuration.sha256,`synthetic-kind:${caseId}`,issuedAt,expiresAt,SOURCE_KIND_FIXTURE_NAME]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  const identityId=(await owner.query("select public.case_access_identity_upsert('email',$1,'source-kind-proof@example.invalid') id",[canonicalSha256({caseId})])).rows[0].id as string;
  await owner.query('select public.case_access_identity_link($1,$2)',[identityId,caseId]);
  await owner.query('commit');
  return {caseId,documentId,versionId,paymentId,tenant,sid,jti,identityId,kind,hash,size:bytes.length,scope,enrollmentId,configurationHash:configuration.sha256,issuedAt,expiresAt};
 }catch(error){await owner.query('rollback');throw error;}
}

export async function revokeSourceKindFixture(owner:pg.Client,f:Awaited<ReturnType<typeof seedSourceKindFixture>>){
 await owner.query('begin');
 try{
  const owned=await owner.query('select id from public.cases where id=$1 and first_name=$2 and is_qa for update',[f.caseId,SOURCE_KIND_FIXTURE_NAME]);
  if(owned.rowCount!==1)throw Error('SOURCE_KIND_CLEANUP_SCOPE');
  // Same scoped migrator cleanup as saved-extraction-worker.postgres.test.ts;
  // the restrictive session UPDATE policy checks the resulting row's tenant.
  await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[f.tenant]);
  const revoked=await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2 returning sid',[f.tenant,f.sid]);
  if(revoked.rowCount!==1)throw Error('SOURCE_KIND_SESSION_REVOKE_SCOPE');
  await owner.query("insert into private.ai_release_enrollment_events(event_id,case_id,sequence,predecessor_id,configuration_sha256,kind,idempotency_key,issued_at,expires_at,reason) values($1,$2,2,$3,$4,'revoked',$5,$6,$7,$8)",[randomUUID(),f.caseId,f.enrollmentId,f.configurationHash,`synthetic-kind-revoke:${f.caseId}`,f.issuedAt,f.expiresAt,'Synthetic source kind proof complete; no execution authority retained']);
  await owner.query('commit');
 }catch(error){await owner.query('rollback');throw error;}
}
