import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium,type Route} from 'playwright';
import {PDFDocument} from 'pdf-lib';
import {AI_REPORT_DISCLOSURE} from '../../src/server/product/reports/report-document.ts';

import {currentPreviewTarget} from './preview-target.mts';
const {origin,deployedSha}=currentPreviewTarget();
const directory='output/release-completion/preview-ai-report';
export async function verifyAiReportPreview(input:{publicId:string;foreignPublicId:string;session:string;foreignSession:string;reportId:string;versionId:string;findingId:string;sourceSha256:string}){
 assert.ok(origin.startsWith('https://salary-')&&origin.endsWith('-tivdoccom-5042s-projects.vercel.app'));
 const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
 assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].name,'_vercel_jwt');assert.equal(access.cookies[0].domain,new URL(origin).hostname);
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});
 const cookie=(session:string)=>({name:'tivdoc_case_session',value:session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax' as const});
 await context.addCookies([cookie(input.session)]);const page=await context.newPage();page.setDefaultTimeout(20000);
 const errors:string[]=[],checks:{name:string;passed:boolean;detail?:string}[]=[];page.on('pageerror',e=>errors.push(e.message));mkdirSync(directory,{recursive:true});
 const save=()=>writeFileSync(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,checks,errors,scope:'Owned synthetic paid AI report, seeded customer session, real hosted page/API/PDF/Storage and correction. No OTP, actual monetary calculation, provider payment, legal activation or production.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
 async function check(name:string,run:()=>Promise<void>){try{await run();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false,detail:e instanceof Error?e.message:'failed'});throw e;}finally{save();}}
 const url=origin+`/case/${input.publicId}/reports`,route=`/api/cases/${input.publicId}/reports`,query=`?report=${input.reportId}`;
 try{
  await check('report proof runs with isolated DEV and disabled external services',async()=>{
   const response=await context.request.get(origin+'/api/health');assert.equal(response.status(),200);
   const body=await response.json();for(const key of ['payment','analytics','analyticsServer','metaPixel','metaCapi','paymentRecovery'])assert.equal(body.configured[key],false);
   assert.ok(response.headers()['content-security-policy'].includes('cpzrbidxftzqcfeqqusu.supabase.co'));
  });
  await check('saved AI report opens with explicit disclosure and immutable source links',async()=>{
   assert.equal((await page.goto(url))?.status(),200);await page.locator('.report-service-disclosure').waitFor();
   assert.equal((await page.locator('.report-service-disclosure').innerText()).trim(),AI_REPORT_DISCLOSURE);
   assert.equal(await page.locator('article[aria-label^="דוח שפורסם"]').count(),1);
   assert.ok(await page.locator(`a[href*="version=${input.versionId}"]`).count()>0);
  });
  await check('downloaded PDF is parseable and carries the exact AI disclosure in logical text',async()=>{
   const response=await context.request.get(origin+route+query);assert.equal(response.status(),200);assert.ok(response.headers()['content-type'].includes('application/pdf'));
   const bytes=await response.body();assert.ok((await PDFDocument.load(bytes)).getPageCount()>0);writeFileSync(`${directory}/synthetic-ai-report.pdf`,bytes);
   const text=[...bytes.toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>/gu)].map(m=>String.fromCharCode(...m[1].match(/.{4}/gu)!.map(h=>parseInt(h,16)))).join(' ').replace(/\s+/gu,' ');
   assert.ok(text.includes(AI_REPORT_DISCLOSURE));
  });
  await check('linked evidence downloads the exact newly uploaded synthetic Storage bytes',async()=>{
   const response=await context.request.get(origin+route+query+`&version=${input.versionId}`);assert.equal(response.status(),200);
   assert.equal(createHash('sha256').update(await response.body()).digest('hex'),input.sourceSha256);
  });
  await check('another actual customer session cannot open the report, PDF or evidence',async()=>{
   const foreign=await browser.newContext({storageState:access});try{await foreign.addCookies([cookie(input.foreignSession)]);
    for(const suffix of ['',`&version=${input.versionId}`])assert.equal((await foreign.request.get(origin+route+query+suffix)).status(),404);
    assert.equal((await foreign.request.get(url)).status(),404);
   }finally{await foreign.close();}
  });
  for(const width of [360,390,768,1440])await check(`published report survives reload in RTL at ${width}px`,async()=>{
   await page.setViewportSize({width,height:900});await page.reload();await page.locator('.report-service-disclosure').waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);assert.deepEqual(errors,[]);
   assert.ok(await page.evaluate(()=>{const header=document.querySelector('.check-header')!.getBoundingClientRect();return [...document.querySelector('.check-header__top')!.children].every(n=>{const r=n.getBoundingClientRect();return r.height===0||r.bottom<=header.bottom+1;});}),'case header contains all wrapped controls');
   await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${directory}/report-${width}.png`,fullPage:false});
  });
  await check('unsent finding correction survives reload and stays scoped to that finding',async()=>{
   await page.locator(`#correction-${input.findingId} summary`).click();await page.getByRole('textbox',{name:'מה דורש בדיקה נוספת?'}).fill('Synthetic saved finding correction');
   await page.reload();await page.locator(`#correction-${input.findingId} summary`).click();
   assert.equal(await page.getByRole('textbox',{name:'מה דורש בדיקה נוספת?'}).inputValue(),'Synthetic saved finding correction');
  });
  await check('lost correction response can retry after reload and the original report remains accessible',async()=>{
   let faulted=false;const attempts:string[]=[];
   page.on('request',r=>{if(r.url()===origin+route&&r.method()==='POST'&&r.postDataJSON()?.message)attempts.push(r.postDataJSON().id);});
   const loseResponse=async(r:Route)=>{if(!faulted&&r.request().method()==='POST'&&r.request().postDataJSON()?.message){
    const response=await r.fetch();assert.equal(response.status(),202);assert.equal((await response.json()).state,'pending');
    faulted=true;await r.abort('failed');
   }else await r.continue();};await page.route('**'+route,loseResponse);
   await page.getByRole('button',{name:'שמירת בקשת בירור',exact:true}).click();await page.getByText(/לא הצלחנו לשמור|לא התקבל אישור שמירה/u).waitFor();await page.unroute('**'+route,loseResponse);
   await page.reload();await page.locator(`#correction-${input.findingId} summary`).click();
   assert.equal(await page.getByRole('textbox',{name:'מה דורש בדיקה נוספת?'}).inputValue(),'Synthetic saved finding correction');
   await page.getByRole('button',{name:'שמירת בקשת בירור',exact:true}).click();await page.getByText('הבקשה נשמרה בשרשור התמיכה בתיק. הדוח הקיים נשמר עד לסיום הבדיקה.',{exact:true}).waitFor();
   assert.equal(faulted,true);assert.equal(attempts.length,2);assert.equal(attempts[0],attempts[1]);
   await page.reload();assert.equal(await page.locator('article[aria-label^="דוח שפורסם"]').count(),1);assert.equal((await context.request.get(origin+route+query)).status(),200);
  });
 }catch(e){await page.screenshot({path:`${directory}/failure.png`,fullPage:false}).catch(()=>{});throw e;}
 finally{save();await context.close();await browser.close();}
 return checks;
}
