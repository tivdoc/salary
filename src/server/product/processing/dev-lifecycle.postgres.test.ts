import {it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readDevEnvFile} from '../../../../scripts/supabase-dev-guard/dev-credential.mts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
it.skipIf(process.env.TIVDOC_DEV_LIFECYCLE_DB!=='1')('retains signed assessment history and refuses revision gaps, edits and resurrection in isolated DEV',async()=>{
 const env=readDevEnvFile(),u=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);
 expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username).toBe('tivdoc_dev_migrator.cpzrbidxftzqcfeqqusu');u.search='';
 const db=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},statement_timeout:20000});
 try{await db.connect();await db.query('begin');
 const old=(await db.query("select * from private.june2026_regular_assessments where case_id='33f41e2f-56b5-420c-8ee2-310201813d35' order by assessment_revision desc limit 1")).rows[0];expect(old).toBeTruthy();
 const expectFailure=async(sql:string,values:unknown[],message:string)=>{await db.query('savepoint negative');await expect(db.query(sql,values)).rejects.toThrow(message);await db.query('rollback to savepoint negative');};
 await expectFailure("update private.june2026_regular_assessments set payload=jsonb_set(payload,'{payload,expires_at}','\"2027-01-01T00:00:00Z\"') where id=$1",[old.id],'REGULAR_ASSESSMENT_IMMUTABLE');
 await expectFailure('delete from private.june2026_regular_assessments where id=$1',[old.id],'REGULAR_ASSESSMENT_IMMUTABLE');
 const id=randomUUID(),payload={...old.payload,payload:{...old.payload.payload,assessment_id:id}};
 // Storage-only negative fixture: this copied signature is intentionally not
 // valid for its new ID and is never supplied to an executor or committed.
 const insert='insert into private.june2026_regular_assessments(id,case_id,order_id,input_revision,input_sha256,registry_key,payload,payload_sha256,assessment_revision) values($1,$2,$3,$4,$5,$6,$7,$8,$9)';
 const values=[id,old.case_id,old.order_id,old.input_revision,old.input_sha256,old.registry_key,payload,canonicalSha256(payload)];
 await expectFailure(insert,[...values,old.assessment_revision+2],'REGULAR_ASSESSMENT_REVISION');
 await db.query(insert,[...values,old.assessment_revision+1]);
 expect((await db.query('select payload,payload_sha256 from private.june2026_regular_assessments where id=$1',[old.id])).rows[0]).toEqual({payload:old.payload,payload_sha256:old.payload_sha256});
 await db.query('update private.june2026_regular_assessments set revoked_at=clock_timestamp() where id=$1',[id]);
 await expectFailure('update private.june2026_regular_assessments set revoked_at=null where id=$1',[id],'REGULAR_ASSESSMENT_IMMUTABLE');
 for(const role of ['tivdoc_worker_runtime','tivdoc_web_runtime','service_role'])expect((await db.query("select has_table_privilege($1,'private.june2026_regular_assessments','INSERT') allowed",[role])).rows[0].allowed).toBe(false);
 await db.query('rollback');
 expect((await db.query('select id from private.june2026_regular_assessments where id=$1',[id])).rows).toHaveLength(0);
 }finally{await db.query('rollback').catch(()=>{});await db.end();}
},60000);
