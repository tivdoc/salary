import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {chromium,type BrowserContext} from 'playwright';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca.ts';

const origin='https://salary-l3do4s4eq-tivdoccom-5042s-projects.vercel.app';
const deployedSha='115a2dde81e9a2a537590588e400cb2994965926';
const directory='output/release-completion/preview-requests';
const env=readDevEnvFile();
function client(key:string){const u=new URL(env.get(key)!);assert.equal(u.pathname,'/tivdoc_release_replay_20260907');assert.equal(u.hostname,'aws-0-eu-central-1.pooler.supabase.com');assert.ok(u.username.endsWith('.cpzrbidxftzqcfeqqusu'));u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].domain,new URL(origin).hostname);assert.equal(access.cookies[0].name,'_vercel_jwt');
const db=client('TIVDOC_DEV_DATABASE_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
const ids=[randomUUID(),randomUUID()],identities:string[]=[],cases:{caseId:string;publicId:string;session:string}[]=[];
const checks:{name:string;passed:boolean}[]=[],errors:string[]=[];
let cleaned=false,context:BrowserContext|undefined;
mkdirSync(directory,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const save=()=>writeFileSync(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,checks,errors,syntheticCasesRemoved:cleaned?2:0,scope:'Seeded QA sessions; hosted request draft/answer/correction UI, HTTP and isolated DEV DB. No OTP, provider, real payment or canonical correction application proof.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
async function check(name:string,run:()=>Promise<void>){try{await run();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false});throw e;}finally{save();}}
try{
 await Promise.all([db.connect(),web.connect()]);
 await db.query('begin');
 for(const id of ids){
  const session=randomBytes(16).toString('base64url'),email=`request-preview-${id}@example.invalid`;
  const c=(await db.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic request browser',$2,'0500000000',true,'under_review','verified',now(),'2026-08-01') returning public_id",[id,email])).rows[0];
  const identity=(await db.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+email).digest('hex'),email])).rows[0].id;identities.push(identity);
  await db.query('select public.case_access_identity_link($1,$2)',[identity,id]);
  await db.query('select public.case_access_session_create($1,$2,14400)',[identity,createHash('sha256').update('case-access-session|'+session).digest('hex')]);
  cases.push({caseId:id,publicId:c.public_id,session});
 }
 await db.query('commit');
 context=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});
 await context.addCookies([{name:'tivdoc_case_session',value:cases[0].session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 const route=`/api/cases/${cases[0].publicId}/requests`,url=origin+`/case/${cases[0].publicId}/thread`;
 const requestId=randomUUID();
 await web.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at) values($1,$2,'regular_day_hours_unknown','כמה שעות נמשך יום העבודה הרגיל שלך?','number',true,now()+interval '10 days')",[requestId,ids[0]]);
 const revisions=async()=>(await web.query('select * from public.case_request_revision_list($1)',[ids[0]])).rows.find(r=>r.request_id===requestId);
 const inputHead=async()=>(await db.query('select revision from private.case_input_heads where case_id=$1',[ids[0]])).rows[0]?.revision??0;
 const loseResponse=()=>page.route('**'+route,async r=>{const response=await r.fetch();assert.equal(response.status(),200);await r.abort('failed');},{times:1});
 const card=()=>page.locator(`#request-${requestId}`);
 const latest=()=>page.locator('.thread-answered__answer');
 await check('saved request opens with its exact question and no draft',async()=>{
  assert.equal((await page.goto(url))?.status(),200);await card().getByRole('heading',{name:'כמה שעות נמשך יום העבודה הרגיל שלך?'}).waitFor();
  await card().getByText('תקופת השאלה: אוגוסט 2026',{exact:true}).waitFor();
  assert.equal(await card().getByRole('spinbutton',{name:'תשובה',exact:true}).inputValue(),'');
 });
 await check('draft response loss retries once and reload shows the persisted value',async()=>{
  const before=await inputHead();await card().getByRole('spinbutton',{name:'תשובה',exact:true}).fill('8');await loseResponse();
  await card().getByRole('button',{name:'שמירת טיוטה',exact:true}).click();await card().locator('.form-error').waitFor();
  assert.equal((await revisions()).draft_revision,1);assert.equal((await revisions()).draft_text,'8');
  await card().getByRole('button',{name:'שמירת טיוטה',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.thread-answer .button--primary')?.textContent==='שליחת תשובה');
  await page.reload();assert.equal(await card().getByRole('spinbutton',{name:'תשובה',exact:true}).inputValue(),'8');
  assert.equal((await revisions()).draft_revision,1);assert.equal(await inputHead(),before);
 });
 await check('saved initial answer with lost HTTP response remains retryable and clears only its draft',async()=>{
  await loseResponse();await card().getByRole('button',{name:'שליחת תשובה',exact:true}).click();await card().locator('.form-error').waitFor();
  assert.equal((await revisions()).answer_revision,1);assert.equal((await revisions()).draft_revision,2);assert.equal((await revisions()).draft_text,null);
  const version=await inputHead();await card().getByRole('button',{name:'שליחת תשובה',exact:true}).click();
  await page.locator('.thread-answered__answer').getByText('8',{exact:true}).waitFor();await page.reload();
  assert.equal((await latest().innerText()).trim(),'8');assert.equal(await inputHead(),version);
 });
 await check('correction response loss retries the same immutable version and survives reload',async()=>{
  await page.getByText('תיקון התשובה',{exact:true}).click();
  const form=page.locator('.thread-answered .thread-answer');await form.getByRole('spinbutton',{name:'תשובה',exact:true}).fill('9');await loseResponse();
  await form.getByRole('button',{name:'שליחת תיקון',exact:true}).click();await form.locator('.form-error').waitFor();
  const version=await inputHead();assert.equal((await revisions()).answer_revision,2);
  await form.getByRole('button',{name:'שליחת תיקון',exact:true}).click();await latest().getByText('9',{exact:true}).waitFor();await page.reload();
  assert.equal((await latest().innerText()).trim(),'9');assert.equal(await inputHead(),version);
  assert.equal((await web.query('select answer_text from public.case_requests where id=$1',[requestId])).rows[0].answer_text,'8');
 });
 await check('stale HTTP draft, foreign case and foreign origin cannot overwrite the saved answer',async()=>{
  const data={requestId,action:'draft',answer:'11',expectedRevision:0};
  assert.equal((await context!.request.post(origin+route,{headers:{origin},data})).status(),409);
  assert.equal((await context!.request.post(origin+`/api/cases/${cases[1].publicId}/requests`,{headers:{origin},data})).status(),404);
  assert.equal((await context!.request.post(origin+route,{headers:{origin:'https://example.invalid'},data})).status(),403);
  assert.equal((await revisions()).latest_answer,'9');assert.equal((await revisions()).draft_text,null);
 });
 await check('two independent HTTP clients retry one correction without duplicate versions',async()=>{
  const peer=await browser.newContext({storageState:await context!.storageState()});
  try{
   const data={requestId,action:'correction',answer:'10',expectedRevision:2};
   const replies=await Promise.all([context!.request.post(origin+route,{headers:{origin},data}),peer.request.post(origin+route,{headers:{origin},data})]);
   assert.deepEqual(replies.map(r=>r.status()),[200,200]);assert.equal((await revisions()).answer_revision,3);
  }finally{await peer.close();}
 });
 for(const width of [360,390,768,1440])await check(`saved corrected request readable at ${width}px`,async()=>{
  await page.setViewportSize({width,height:900});await page.reload();assert.equal((await latest().innerText()).trim(),'10');
  await page.getByText('תקופת התשובה: אוגוסט 2026',{exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)<=1);
  await page.screenshot({path:`${directory}/request-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);
 });
 await check('an open request expires in the displayed thread without manual reload or hydration errors',async()=>{
  const expiring=randomUUID();
  await web.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at) values($1,$2,'regular_day_hours_unknown','שאלה סינתטית עם מועד קרוב','number',true,now()+interval '8 seconds')",[expiring,ids[0]]);
  await page.reload();await page.locator(`#request-${expiring}`).getByRole('spinbutton').waitFor();
  await page.getByRole('heading',{name:'שאלות שנסגרו ללא תשובה',exact:true}).waitFor();
  assert.equal(await page.locator(`#request-${expiring}`).count(),0);
  assert.ok((await page.locator('.thread-view').innerText()).includes('שאלה סינתטית עם מועד קרוב — הסתיים המועד להשלמה.'));
  assert.equal((await web.query('select answered_at from public.case_requests where id=$1',[expiring])).rows[0].answered_at,null);
  assert.deepEqual(errors,[]);
 });
 await check('request retries preserve case/payment and all three original/corrected versions',async()=>{
  const rows=(await db.query('select status,payment_status from public.cases where id=any($1::uuid[])',[ids])).rows;
  assert.ok(rows.every(c=>c.status==='under_review'&&c.payment_status==='verified'));
  assert.deepEqual((await db.query('select answer_text from private.case_request_answer_versions where request_id=$1 order by revision',[requestId])).rows.map(r=>r.answer_text),['8','9','10']);
 });
}catch(e){console.error(e instanceof Error?e.message:'proof failed');const failedPage=context?.pages()[0];if(failedPage){await failedPage.screenshot({path:`${directory}/failure.png`,fullPage:true}).catch(()=>{});console.log((await failedPage.locator('.thread-view').innerText()).slice(0,2000));}process.exitCode=1;}
finally{
 await context?.close();await browser.close();await db.query('rollback').catch(()=>{});
 try{
  await db.query('begin');await db.query('delete from public.cases where id=any($1::uuid[]) and is_qa and first_name=$2',[ids,'Synthetic request browser']);
  if(identities.length)await db.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
  assert.equal((await db.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n,0);await db.query('commit');cleaned=true;
 }catch(e){await db.query('rollback').catch(()=>{});console.error('Exact fixture cleanup failed: '+(e instanceof Error?e.message:'unknown'));process.exitCode=1;}
 save();await Promise.all([db.end(),web.end()]);
}
