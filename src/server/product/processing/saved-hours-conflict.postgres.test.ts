import {expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {hasHoursConflictObservations} from '@/engine/extraction/hours-conflict';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {createDocumentHoursConflictTarget} from '../reports/document-hours-conflict';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_SOL_CONFLICT_DB!=='1')('compares SQL target to saved live provider evidence and verifies the narrow DEV ACL',async()=>{
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const u=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username).toBe('tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu');u.search='';
 const db=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},statement_timeout:20000});
 const receipt:{at:string;sourceHashes:string[];checks:string[];providerCalls:number}={at:new Date().toISOString(),sourceHashes:[],checks:[],providerCalls:0};
 try{
  await db.connect();
  const rows=(await db.query(`select distinct on(c.result_sha256) c.case_id,c.version_id,c.result_sha256,c.result,o.id order_id
   from private.case_extraction_checkpoints c join public.cases k on k.id=c.case_id and k.is_qa
   join private.product_orders o on o.case_id=c.case_id and o.state='paid' and 'minimum_wage'=any(o.topics)
   where c.policy_version=$1 and c.result#>>'{run,provider_receipts,0,origin}'='openai_live'
    and c.result->>'expected_month'='2026-06' order by c.result_sha256,c.revision desc limit 40`,[SAVED_EXTRACTION_POLICY])).rows;
  let conflicts=0;
  for(const row of rows){
   const cp=row.result,extraction=normalizedPayslipExtractionSchema.parse(cp.run.result.final_extraction);
   if(!hasHoursConflictObservations(extraction))continue;
   const expected=createDocumentHoursConflictTarget({checkpoint:cp,orderId:row.order_id,policyVersion:SAVED_EXTRACTION_POLICY});
   const source={document_id:cp.product_document_id,version_id:cp.version_id,source_sha256:cp.input_sha256,checkpoint_sha256:cp.result_sha256,checkpoint:cp};
   const actual=(await db.query('select private.june2026_hours_conflict_target($1::jsonb,$2::uuid,$3::uuid) target',[source,row.case_id,row.order_id])).rows[0].target;
   expect(actual).toEqual(expected);const {target_sha256,...body}=actual;expect(canonicalSha256(body)).toBe(target_sha256);
   const legacy=structuredClone(source);delete legacy.checkpoint.run.provider_receipts;
   await expect(db.query('select private.june2026_hours_conflict_target($1::jsonb,$2::uuid,$3::uuid)',[legacy,row.case_id,row.order_id])).rejects.toMatchObject({message:'HOURS_CONFLICT_RECEIPT_REQUIRED'});
   receipt.sourceHashes.push(cp.input_sha256);conflicts++;
  }
  expect(conflicts).toBeGreaterThan(0);receipt.checks.push('actual retained live conflict: SQL target equals TypeScript target');
  const acl=(await db.query(`select role,has_table_privilege(role,'private.june2026_hours_conflict_targets','INSERT') direct_write,
   has_function_privilege(role,'private.june2026_hours_conflict_current(uuid,jsonb)','EXECUTE') raw_current,
   has_function_privilege(role,'private.june2026_hours_conflict_effective_assert(uuid,uuid,integer,text,uuid,jsonb,jsonb)','EXECUTE') bypass_save
   from unnest(array['anon','authenticated','service_role','tivdoc_web_runtime','tivdoc_worker_runtime']) role`)).rows;
  expect(acl.every(r=>!r.direct_write&&!r.raw_current&&!r.bypass_save)).toBe(true);receipt.checks.push('all runtime roles denied raw target writes/internal helpers');
  const control=JSON.parse(readFileSync('../release-work/sol-scheduled-control-20260911.private.json','utf8'));
  const current=(await db.query('select private.june2026_hours_conflict_current($1::uuid,null::jsonb) current',[control.caseId])).rows[0].current;
  expect(current).toBe(false);receipt.checks.push('missing target is explicitly not current');
 }finally{await db.end();writeFileSync('output/release-completion/sol-scheduled-20260911/conflict-db-'+Date.now()+'.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
},60000);
