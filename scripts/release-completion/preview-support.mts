import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {chromium,type BrowserContext} from 'playwright';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca.ts';

const origin='https://salary-l8hk2xi7m-tivdoccom-5042s-projects.vercel.app';
const deployedSha='ceb1e0efd354bffc568750e05187800b542375ba';
const directory='output/release-completion/preview-support';
const env=readDevEnvFile();
function client(key:string){const u=new URL(env.get(key)!);assert.equal(u.pathname,'/tivdoc_release_replay_20260907');assert.equal(u.hostname,'aws-0-eu-central-1.pooler.supabase.com');assert.ok(u.username.endsWith('.cpzrbidxftzqcfeqqusu'));u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].domain,new URL(origin).hostname);assert.equal(access.cookies[0].name,'_vercel_jwt');
const db=client('TIVDOC_DEV_DATABASE_URL'),ops=client('TIVDOC_OPERATIONS_POSTGRES_URL');
const ids=[randomUUID(),randomUUID()],identities:string[]=[],cases:{caseId:string;publicId:string;session:string}[]=[];
const checks:{name:string;passed:boolean}[]=[],errors:string[]=[];
let cleaned=false,context:BrowserContext|undefined;
mkdirSync(directory,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const save=()=>writeFileSync(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,checks,errors,syntheticCasesRemoved:cleaned?2:0,scope:'Seeded QA session; hosted customer browser/API and DEV database. Owner response injected through actual operations DB role; no owner HTTP/UI, OTP, provider, real payment or professional approval proof.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
async function check(name:string,run:()=>Promise<void>){try{await run();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false});throw e;}finally{save();}}
try{
 await Promise.all([db.connect(),ops.connect()]);
 await db.query('begin');
 for(const id of ids){
  const session=randomBytes(16).toString('base64url'),email=`support-preview-${id}@example.invalid`;
  const c=(await db.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic support browser',$2,'0500000000',true,'under_review','verified',now(),'2026-08-01') returning public_id",[id,email])).rows[0];
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
 await check('customer opens case support with saved server state',async()=>{
  assert.equal((await page.goto(url))?.status(),200);await page.getByRole('heading',{name:'פנייה לתמיכה',exact:true}).waitFor();
  assert.ok((await page.locator('#support').innerText()).includes('עדיין אין פניות תמיכה בתיק.'));
 });
 const question='Synthetic browser support question';
 await check('lost completion response retries the same saved question without duplication',async()=>{
  await page.getByLabel('פרטי הפנייה לתמיכה',{exact:true}).fill(question);
  await page.route('**'+route,async r=>{await r.fetch();await r.abort('failed');},{times:1});
  await page.getByRole('button',{name:'שליחת הודעה',exact:true}).click();
  await page.getByText('לא התקבל אישור שמירה. הטקסט נשאר כאן ואפשר לנסות שוב.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('פרטי הפנייה לתמיכה',{exact:true}).inputValue(),question);
  assert.equal((await db.query('select count(*)::int n from private.case_support_threads where case_id=$1',[ids[0]])).rows[0].n,1);
  await page.getByRole('button',{name:'שליחת הודעה',exact:true}).click();
  await page.locator('#support article').waitFor();await page.reload();
  assert.equal(await page.locator('#support article').count(),1);assert.equal(await page.locator('#support article li').count(),1);
  assert.ok((await page.locator('#support article').innerText()).includes(question));
 });
 const thread=(await db.query('select id,revision from private.case_support_threads where case_id=$1',[ids[0]])).rows[0];
 await check('an operations DB reply is visible after customer reload and customer can reopen it',async()=>{
  await ops.query('select public.case_request_support_owner_reply($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),thread.id,thread.revision,'owner:synthetic-browser','Synthetic owner DB response','waiting_customer','normal']);
  await page.reload();await page.getByText('Synthetic owner DB response',{exact:true}).waitFor();
  await page.getByLabel('הוספת תשובה לפנייה',{exact:true}).fill('Synthetic customer follow-up');
  await page.locator('#support article').getByRole('button',{name:'שליחת הודעה',exact:true}).click();
  await page.locator('#support article li').getByText('Synthetic customer follow-up',{exact:true}).waitFor();await page.reload();
  assert.equal(await page.locator('#support article li').count(),3);
  assert.equal((await db.query('select state from private.case_support_threads where id=$1',[thread.id])).rows[0].state,'open');
 });
 await check('concurrent HTTP retries persist once and cross-case or foreign-origin requests are refused',async()=>{
  const data={id:randomUUID(),action:'support_reply',threadId:thread.id,message:'Synthetic concurrent reply'};
  const replies=await Promise.all([1,2].map(()=>context!.request.post(origin+route,{headers:{origin},data})));assert.deepEqual(replies.map(r=>r.status()),[202,202]);
  assert.equal((await db.query('select count(*)::int n from private.case_support_messages where id=$1',[data.id])).rows[0].n,1);
  const foreign=await context!.request.post(origin+`/api/cases/${cases[1].publicId}/requests`,{headers:{origin},data:{id:randomUUID(),action:'support_open',message:'Foreign case attempt'}});assert.equal(foreign.status(),404);
  assert.equal((await context!.request.post(origin+route,{headers:{origin:'https://example.invalid'},data})).status(),403);
 });
 for(const width of [360,390,768,1440])await check(`persisted support is readable in RTL at ${width}px`,async()=>{
  await page.setViewportSize({width,height:900});await page.reload();assert.equal(await page.locator('#support article li').count(),4);
  assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)<=1);
  await page.screenshot({path:`${directory}/support-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);
 });
 await check('two deliberate identical new messages receive distinct IDs after confirmed saves',async()=>{
  for(const expected of [2,3]){
   await page.getByLabel('פרטי הפנייה לתמיכה',{exact:true}).fill('Same deliberate new question');
   const response=page.waitForResponse(r=>new URL(r.url()).pathname===route&&r.request().method()==='POST');
   await page.locator('#support').getByRole('button',{name:'שליחת הודעה',exact:true}).first().click();assert.equal((await response).status(),202);
   await page.waitForFunction(n=>document.querySelectorAll('#support article').length===n,expected);
  }
  assert.equal((await db.query('select count(*)::int n from private.case_support_threads where case_id=$1',[ids[0]])).rows[0].n,3);
 });
 await check('support leaves case and payment status unchanged',async()=>{const rows=(await db.query('select status,payment_status from public.cases where id=any($1::uuid[])',[ids])).rows;assert.equal(rows.length,2);assert.ok(rows.every(c=>c.status==='under_review'&&c.payment_status==='verified'));});
}catch(e){console.error(e instanceof Error?e.message:'proof failed');const failedPage=context?.pages()[0];if(failedPage){await failedPage.screenshot({path:`${directory}/failure.png`,fullPage:true}).catch(()=>{});console.log((await failedPage.locator('#support').innerText()).slice(0,2500));console.log(await failedPage.locator('#support textarea').evaluateAll(es=>es.map(e=>({label:e.parentElement?.textContent,value:(e as HTMLTextAreaElement).value}))));}process.exitCode=1;}
finally{
 await context?.close();await browser.close();await db.query('rollback').catch(()=>{});
 try{
  await db.query('begin');await db.query('delete from public.cases where id=any($1::uuid[]) and is_qa and first_name=$2',[ids,'Synthetic support browser']);
  if(identities.length)await db.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
  assert.equal((await db.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n,0);await db.query('commit');cleaned=true;
 }catch(e){await db.query('rollback').catch(()=>{});console.error('Exact fixture cleanup failed: '+(e instanceof Error?e.message:'unknown'));process.exitCode=1;}
 save();await Promise.all([db.end(),ops.end()]);
}
