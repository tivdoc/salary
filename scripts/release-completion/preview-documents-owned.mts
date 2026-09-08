import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca.ts';

const origin='https://salary-ezhfzrike-tivdoccom-5042s-projects.vercel.app';
const deployedSha='45cf30f178a86e45793e90e3789f225fe7024e9d';
const directory='output/release-completion/preview-documents';
const env=readDevEnvFile();
function client(key:string){const u=new URL(env.get(key)!);assert.equal(u.pathname,'/tivdoc_release_replay_20260907');assert.equal(u.hostname,'aws-0-eu-central-1.pooler.supabase.com');assert.ok(u.username.endsWith('.cpzrbidxftzqcfeqqusu'));u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].domain,new URL(origin).hostname);assert.equal(access.cookies[0].name,'_vercel_jwt');
const secrets=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_STORAGE_CREDENTIALS_FILE??'','utf8'));
assert.equal(secrets.NEXT_PUBLIC_SUPABASE_URL,'https://cpzrbidxftzqcfeqqusu.supabase.co');
const bucket=createClient(secrets.NEXT_PUBLIC_SUPABASE_URL,secrets.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('salary-documents');
const db=client('TIVDOC_DEV_DATABASE_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
const ids=[randomUUID(),randomUUID()],identities:string[]=[];
const cases:{caseId:string;publicId:string;identity:string;session:string;requests:Record<string,string>}[]=[];
const objects:{path:string;size:number;sha256:string;retained:boolean}[]=[];
let seeded=false,removedCases=0,removedIdentities=0,removedObjects=0,emptyPrefixes=false,browserPassed=false;
const errors:string[]=[];
mkdirSync(directory,{recursive:true});
const save=()=>writeFileSync(`${directory}/owned-receipt.json`,JSON.stringify({origin,deployedSha,ownedCaseIds:ids,ownedIdentityIds:identities,browserPassed,objects,removedCases,removedIdentities,removedObjects,emptyPrefixes,errors,scope:'Fresh owned QA identities and cases; actual hosted upload, isolated PostgreSQL and private Storage bytes. No OTP, real payment or model call.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
async function listOwned(){const paths:string[]=[];for(const id of ids){const prefix=`cases/${id}/versions`;const result=await bucket.list(prefix,{limit:1000});assert.equal(result.error,null);assert.ok(result.data!.length<1000);for(const item of result.data!){assert.ok(item.id,'unexpected nested prefix');assert.ok(!item.name.includes('/'));paths.push(`${prefix}/${item.name}`);}}return paths;}
try{
 await Promise.all([db.connect(),web.connect()]);await db.query('begin');
 for(const id of ids){
  const session=randomBytes(16).toString('base64url'),email=`upload-preview-${id}@example.invalid`;
  const c=(await db.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic owned upload browser',$2,'0500000000',true,'under_review','verified',now(),'2026-08-01') returning public_id",[id,email])).rows[0];
  const identity=(await db.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);
  await db.query('select public.case_access_identity_link($1,$2)',[identity,id]);
  await db.query('select public.case_access_session_create($1,$2,14400)',[identity,createHash('sha256').update('case-access-session|'+session).digest('hex')]);
  cases.push({caseId:id,publicId:c.public_id,identity,session,requests:{}});
 }
 await db.query('commit');seeded=true;save();
 for(const code of ['contract_missing','attendance_missing']){const id=randomUUID();cases[1].requests[code]=id;await web.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at) values($1,$2,$3,$4,'document',true,now()+interval '10 days')",[id,ids[1],code,code==='contract_missing'?'השלמת חוזה סינתטי':'השלמת דוח נוכחות סינתטי']);}
 const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,[...process.execArgv,'scripts/release-completion/preview-documents.mts'],{stdio:'inherit',env:{...process.env,TIVDOC_PREVIEW_CASE_FIXTURES:JSON.stringify({origin,database:'tivdoc_release_replay_20260907',cases}),TIVDOC_PREVIEW_BROWSER_STATE:JSON.stringify(access),TIVDOC_PREVIEW_LOCAL_CHROME:'true'}});child.on('error',reject);child.on('exit',resolve);});
 browserPassed=code===0;
 const receipt=JSON.parse(readFileSync(`${directory}/receipt.json`,'utf8'));
 assert.equal(receipt.origin,origin);assert.equal(receipt.deployedSha,deployedSha);
 const rows=(await db.query('select storage_path,original_filename,size,false retained from public.documents where case_id=any($1::uuid[]) union all select storage_path,original_filename,size,true retained from public.document_versions where case_id=any($1::uuid[])',[ids])).rows;
 for(const row of rows){
  assert.ok(ids.some(id=>row.storage_path.startsWith(`cases/${id}/versions/`)));
  const expected=receipt.expectedFiles.find((f:{name:string})=>f.name===row.original_filename);assert.ok(expected);
  const result=await bucket.download(row.storage_path);assert.equal(result.error,null);const bytes=Buffer.from(await result.data!.arrayBuffer());
  const sha256=createHash('sha256').update(bytes).digest('hex');assert.equal(sha256,expected.sha256);assert.equal(bytes.length,Number(row.size));
  objects.push({path:row.storage_path,size:bytes.length,sha256,retained:row.retained});
 }
 if(browserPassed){assert.equal(rows.length,8);assert.equal(rows.filter(r=>r.retained).length,1);assert.equal((await listOwned()).length,8);}
 assert.equal(code,0,'hosted browser upload proof');
}catch(e){errors.push(e instanceof Error?e.message:'upload proof failed');process.exitCode=1;}
finally{
 await db.query('rollback').catch(()=>{});save();
 try{if(seeded){
  const paths=await listOwned();
  const reservations=(await db.query('select files from public.document_upload_batches where case_id=any($1::uuid[])',[ids])).rows.flatMap(r=>r.files.map((f:{path:string})=>f.path));
  for(const path of paths)assert.ok(reservations.includes(path),'cleanup path must have an owned reservation');
  await db.query('begin');
  const owned=(await db.query('select id,email from public.cases where id=any($1::uuid[]) and is_qa and first_name=$2 for update',[ids,'Synthetic owned upload browser'])).rows;
  assert.equal(owned.length,2);for(const c of owned)assert.equal(c.email,`upload-preview-${c.id}@example.invalid`);
  removedCases=(await db.query('delete from public.cases where id=any($1::uuid[])',[ids])).rowCount!;
  removedIdentities=(await db.query('delete from public.case_identities where id=any($1::uuid[])',[identities])).rowCount!;
  await db.query('commit');
  assert.equal((await db.query('select count(*)::int n from public.documents where case_id=any($1::uuid[])',[ids])).rows[0].n,0);
  if(paths.length){const removal=await bucket.remove(paths);assert.equal(removal.error,null);removedObjects=paths.length;}
  assert.deepEqual(await listOwned(),[]);emptyPrefixes=true;
 }}catch(e){await db.query('rollback').catch(()=>{});errors.push('Exact fixture cleanup failed: '+(e instanceof Error?e.message:'unknown'));process.exitCode=1;}
 save();await Promise.all([db.end(),web.end()]);
 console.log(JSON.stringify({browserPassed,verifiedObjects:objects.length,removedCases,removedIdentities,removedObjects,emptyPrefixes,errors}));
}
