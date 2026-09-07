import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {TIVDOC_DEV_PROJECT_REF} from '../supabase-dev-guard/guard.mts';
const env=readDevEnvFile();
assert.equal(env.get('TIVDOC_DEV_PROJECT_REF'),TIVDOC_DEV_PROJECT_REF);
const connection=env.get('TIVDOC_DEV_DATABASE_URL');assert.ok(connection);
const inventory=[];
for(const database of ['tivdoc_v09_devruntime01','tivdoc_release_replay_20260907']) {
 const url=new URL(connection);url.pathname=`/${database}`;
 const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000});await db.connect();
 try {
  const roles=(await db.query("select rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname in ('tivdoc_web_runtime','tivdoc_worker_runtime','tivdoc_operations_runtime','tivdoc_identity_runtime','tivdoc_governance_owner') order by rolname")).rows;
  assert.equal(roles.length,5);assert.ok(roles.every(r=>!r.rolsuper&&!r.rolbypassrls&&!r.rolcreatedb&&!r.rolcreaterole));
  const functions=(await db.query("select p.proname,p.prosecdef,pg_get_functiondef(p.oid) definition,has_function_privilege('anon',p.oid,'execute') anon_execute,has_function_privilege('authenticated',p.oid,'execute') authenticated_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('case_documents_snapshot','case_documents_reserve','case_documents_batch','case_documents_commit','case_documents_cancel') order by p.proname")).rows;
  assert.equal(functions.length,5);assert.ok(functions.every(f=>!f.prosecdef&&!f.anon_execute&&!f.authenticated_execute));
  const tables=(await db.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('document_upload_batches','document_versions') order by c.relname")).rows;
  assert.equal(tables.length,2);assert.ok(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
  inventory.push({database,roles,tables,functions:functions.map(({definition,...f})=>({...f,definition_sha256:createHash('sha256').update(definition).digest('hex')}))});
 }finally{await db.end();}
}
assert.deepEqual(inventory[0].functions,inventory[1].functions);
const receipt={schema_version:'release-baseline-v1',tested_at:new Date().toISOString(),target:'isolated DEV only',upload_functions_match:true,privilege_checks:'PASS',login_note:'Four DEV runtime login accounts are explicitly provisioned by dev-credential.mts; governance owner remains NOLOGIN. No role attribute changed for this proof.',inventory};
writeFileSync('docs/release-evidence/P00-installed-comparison.json',JSON.stringify(receipt,null,2)+'\n');
console.log('PASS: replay and installed upload RPC definitions/ACLs match; runtime roles have no superuser, bypass-RLS or role/database creation privilege.');
