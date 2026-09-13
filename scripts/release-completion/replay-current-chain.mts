import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {replayMigrationChain,type ChainCompensation} from '../supabase-dev-guard/chain-replay.mts';
import {assertSupabaseDevTarget,TIVDOC_DEV_LABEL} from '../supabase-dev-guard/guard.mts';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca.ts';

// Fresh schema proof, never reset the populated Preview database. The shared
// DEV cluster's provisioned login roles are observed before/after, not disabled.
assert.equal(process.env.TIVDOC_FRESH_CHAIN_PROOF,'1');
const env=readDevEnvFile(),ref=env.get('TIVDOC_DEV_PROJECT_REF');
assertSupabaseDevTarget({SUPABASE_PROJECT_REF:ref,SUPABASE_PROJECT_LABEL:TIVDOC_DEV_LABEL});
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.match(sha,/^[a-f0-9]{40}$/);
const database=`tivdoc_release_chain_20260908_${sha.slice(0,7)}`;
const u=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);
assert.equal(u.hostname,'aws-0-eu-central-1.pooler.supabase.com');
assert.equal(u.pathname,'/tivdoc_release_replay_20260907');
assert.equal(decodeURIComponent(u.username),'tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu');u.search='';
const admin=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});
const rolesSql="select rolname,rolsuper,rolcanlogin,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls from pg_roles where rolname like 'tivdoc_%' or rolname in ('anon','authenticated','service_role') order by rolname";
const membersSql="select r.rolname role,g.rolname member,m.admin_option from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles g on g.oid=m.member where r.rolname like 'tivdoc_%' or g.rolname like 'tivdoc_%' order by r.rolname,g.rolname";
// Same explicit managed-platform compensations as run-chain-replay.mts.
// Each omission is recorded by the existing byte-pinned replay engine.
const compensations:ChainCompensation[]=[{file:'202609010005_governance_runtime_security.sql',omit_patterns:[
 '^alter role tivdoc_[a-z_]+ nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;$',
 '^revoke tivdoc_governance_owner from anon, authenticated, service_role,','^revoke service_role from tivdoc_governance_owner,',
],pre_statements:['grant usage, create on schema private to tivdoc_governance_owner'],reason:'Managed platform refuses superuser attributes/reserved-role modification; preserve and verify existing shared DEV runtime provisioning',sqlstate:'42501'}];
await admin.connect();
const before={roles:(await admin.query(rolesSql)).rows,members:(await admin.query(membersSql)).rows};
try{
 assert.equal((await admin.query('select count(*)::int n from pg_database where datname=$1',[database])).rows[0].n,0,'Fresh database must not already exist');
 await admin.query(`create database ${database}`);
 writeFileSync('../release-work/fresh-chain-owned.json',JSON.stringify({database,sha,scope:'Empty owned DEV schema replay; no customer data; no drop/reset'}));
 u.pathname='/'+database;
 const setup=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});
 await setup.connect();try{
  await setup.query("create schema storage; comment on schema storage is 'Synthetic platform scaffold, not real Storage'; create table storage.buckets(id text primary key,name text not null,owner uuid,created_at timestamptz default now(),updated_at timestamptz default now(),public boolean default false,avif_autodetection boolean default false,file_size_limit bigint,allowed_mime_types text[])");
 }finally{await setup.end();}
 const ca=resolve('../release-work/fresh-chain-ca.pem');writeFileSync(ca,SUPABASE_ROOT_2021_CA);
 u.searchParams.set('sslmode','verify-full');u.searchParams.set('sslrootcert',ca);
 const receipt=await replayMigrationChain({migrations_root:'supabase/migrations',environment:{SUPABASE_PROJECT_REF:ref,SUPABASE_PROJECT_LABEL:TIVDOC_DEV_LABEL,TIVDOC_DEV_DATABASE_URL:u.toString()},compensations,schema_create_grant_role:'tivdoc_governance_owner'});
 const after={roles:(await admin.query(rolesSql)).rows,members:(await admin.query(membersSql)).rows};
 const unchanged=JSON.stringify(before)===JSON.stringify(after);
 writeFileSync('docs/release-evidence/P00-current-chain-replay.json',JSON.stringify({...receipt,sha,sharedRoleProvisioningUnchanged:unchanged,scaffold:'Synthetic storage.buckets only; not live Storage API',scope:'Fresh separate DEV database, existing shared runtime LOGIN provisioning preserved; listed managed-platform compensations are not an uncompensated superuser replay',productionChanged:false},null,2)+'\n');
 console.log({status:receipt.status,applied:receipt.files_applied,compensated:receipt.files_compensated,total:receipt.files_discovered,failedFile:receipt.failed_file,failure:receipt.failure_reason,database,sharedRoleProvisioningUnchanged:unchanged});
 assert(unchanged,'Shared role provisioning changed');assert.equal(receipt.status,'PASS');
}finally{await admin.end();}
