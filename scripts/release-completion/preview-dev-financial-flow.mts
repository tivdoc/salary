import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {PDFDocument} from 'pdf-lib';
import {currentPreviewTarget} from './preview-target.mts';
import type {DevFinancialRun} from '../../src/server/product/processing/dev-financial-contract.ts';
import type {ReservedFile} from '../../src/server/product/documents/upload.ts';

type Input={stage:'missing'|'completed';cases:{publicId:string;session:string}[];first:ReservedFile;second:ReservedFile;
 initial:DevFinancialRun;missing:DevFinancialRun;answered?:DevFinancialRun;directory:string;gitSha:string;automatic?:boolean};
/** Called by the actual DB/Storage flow before its exact QA cleanup. It neither
 * seeds analysis nor supplies a financial result; it reads the hosted customer
 * projection and enters one identified missing-input answer through its UI. */
export async function verifyDevFinancialPreview(input:Input){
 const {origin,deployedSha,deploymentId}=currentPreviewTarget();assert.equal(input.gitSha,deployedSha);
 const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
 assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);
 assert.equal(access.cookies[0].name,'_vercel_jwt');assert.equal(access.cookies[0].domain,new URL(origin).hostname);
 const directory='output/release-completion/preview-dev-financial-flow';mkdirSync(directory,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});
 const cookie=(session:string)=>({name:'tivdoc_case_session',value:session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax' as const});
 const own=input.cases[0],foreign=input.cases[1];await context.addCookies([cookie(own.session)]);
 const page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(15000);
 const checks:{name:string;passed:boolean;detail?:string}[]=[],errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 const save=()=>writeFileSync(`${directory}/${input.stage}-receipt.json`,JSON.stringify({origin,deployedSha,deploymentId,stage:input.stage,checks,errors,
  scope:'Actual generated DEV financial runs; hosted HTML/PDF/source/history and identified answer UI. Synthetic paid scope/session; injected OCR; no real payment, login OTP or production.',
  liveOcrProof:false,seededReport:false,productionChanged:false},null,2)+'\n');
 const check=async(name:string,operation:()=>Promise<void>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('BROWSER_CHECK_DEADLINE: '+name)),45000);})]);checks.push({name,passed:true});console.log('PASS '+name);}
 catch(error){checks.push({name,passed:false,detail:error instanceof Error?error.message:'failed'});throw error;}finally{if(timer)clearTimeout(timer);save();}};
 const reportUrl=origin+`/case/${own.publicId}/reports`;
 const api=(run:DevFinancialRun)=>origin+`/api/cases/${own.publicId}/reports?engineering=1&report=${run.run_id}`;
 try{
  await check('isolated Preview health preserves disabled external services',async()=>{
   const response=await context.request.get(origin+'/api/health');assert.equal(response.status(),200);
   const body=await response.json();for(const key of ['payment','analytics','analyticsServer','metaPixel','metaCapi','paymentRecovery'])assert.equal(body.configured[key],false);
  });
  if(input.stage==='missing'){
   await check('current missing result and previous historical financial run reload from saved DB',async()=>{
    assert.equal((await page.goto(reportUrl,{waitUntil:'domcontentloaded'}))?.status(),200);
    assert.equal(await page.locator('[data-financial-run]').count(),2);
    const current=page.locator('[data-current="true"]');assert.equal(await current.getAttribute('data-financial-run'),input.missing.run_id);
    await current.getByText('חסר קלט מאומת',{exact:true}).waitFor();
    assert.equal(await page.locator(`[data-financial-run="${input.initial.run_id}"]`).getAttribute('data-current'),'false');
   });
   await check('identified customer answers the analysis-generated exact June hours request through the hosted UI',async()=>{
    assert.ok(input.missing.request_id);assert.equal((await page.goto(origin+`/case/${own.publicId}/thread`,{waitUntil:'domcontentloaded'}))?.status(),200);
    const card=page.locator(`#request-${input.missing.request_id}`);
    await card.getByText('תקופת השאלה: יוני 2026',{exact:true}).waitFor();
    await card.getByRole('spinbutton',{name:'תשובה',exact:true}).fill('100');
    const submitted=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/cases/${own.publicId}/requests`,{timeout:15000});
    await card.getByRole('button',{name:'שליחת תשובה',exact:true}).click({noWaitAfter:true,timeout:10000});
    const response=await submitted;assert.equal(response.status(),200);console.log('PASS hosted answer HTTP status');
    await page.locator('.thread-answered__answer').getByText('100',{exact:true}).waitFor();
    await page.reload({waitUntil:'domcontentloaded'});await page.locator('.thread-answered__answer').getByText('100',{exact:true}).waitFor();
    // Read the acknowledgement through an actual same-answer HTTP retry. The
    // browser refresh can leave Playwright's original response body pending.
    const retry=await context.request.post(origin+`/api/cases/${own.publicId}/requests`,{
     headers:{Origin:origin},data:{requestId:input.missing.request_id,answer:'100',action:'answer',expectedRevision:0},timeout:15000});
    assert.equal(retry.status(),200);assert.equal((await retry.json()).ok,true);
    await page.screenshot({timeout:10000,path:`${directory}/answered-request.png`,fullPage:false});
   });
   await check('answer invalidates the previous financial results before the next worker run',async()=>{
    assert.equal((await page.goto(reportUrl,{waitUntil:'domcontentloaded'}))?.status(),200);if(input.automatic){assert.equal(await page.locator(`[data-financial-run="${input.initial.run_id}"][data-current="true"], [data-financial-run="${input.missing.run_id}"][data-current="true"]`).count(),0);}else assert.equal(await page.locator('[data-current="true"]').count(),0);
   });
  }else{
   const run=input.answered;assert.ok(run);
   await check('one current financial run and both historical runs appear after reload with computed operands and amounts',async()=>{
    assert.equal((await page.goto(reportUrl,{waitUntil:'domcontentloaded'}))?.status(),200);await page.reload({waitUntil:'domcontentloaded'});
    assert.equal(await page.locator('[data-financial-run]').count(),3);const current=page.locator('[data-current="true"]');
    assert.equal(await current.getAttribute('data-financial-run'),run.run_id);
    const text=await current.innerText();for(const value of ['3540.00','3300.00','240.00','35.40','100',run.source.version_id])assert.ok(text.includes(value));
    assert.ok(text.includes('תשובת לקוח מזוהה'));
   });
   await check('hosted PDF is the exact stored calculated artifact and carries the same run and amounts as HTML',async()=>{
    const response=await context.request.get(api(run));assert.equal(response.status(),200);
    assert.ok(response.headers()['content-type'].includes('application/pdf'));const bytes=await response.body();
    assert.deepEqual(bytes,readFileSync(`${input.directory}/answered-calculated.pdf`));assert.equal((await PDFDocument.load(bytes)).getSubject(),run.run_id);
    const text=[...bytes.toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>/gu)].map(m=>String.fromCharCode(...m[1].match(/.{4}/gu)!.map(h=>parseInt(h,16)))).join(' ');
    for(const value of [run.run_id,'3540.00','3300.00','240.00'])assert.ok(text.includes(value));
    writeFileSync(`${directory}/computed-report.pdf`,bytes);
   });
   await check('both replaced and current source links return exact immutable uploaded bytes',async()=>{
    for(const value of [input.initial,run]){
     const response=await context.request.get(api(value)+`&version=${value.source.version_id}`);assert.equal(response.status(),200);
     assert.equal(createHash('sha256').update(await response.body()).digest('hex'),value.source.source_sha256);
    }
   });
   await check('foreign actual customer cannot read HTML, PDF or either source',async()=>{
    const other=await browser.newContext({storageState:access});try{
     await other.addCookies([cookie(foreign.session)]);assert.equal((await other.request.get(reportUrl)).status(),404);
     for(const value of [input.initial,run])for(const suffix of ['',`&version=${value.source.version_id}`])assert.equal((await other.request.get(api(value)+suffix)).status(),404);
     assert.equal((await context.request.get(api(run)+`&version=${input.first.versionId}`)).status(),404);
    }finally{await other.close();}
   });
   for(const width of [390,1440])await check(`financial report remains readable on reload at ${width}px`,async()=>{
    await page.setViewportSize({width,height:900});await page.reload({waitUntil:'domcontentloaded'});
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);
    assert.equal(await page.locator('[data-current="true"]').getAttribute('data-financial-run'),run.run_id);assert.deepEqual(errors,[]);
    await page.screenshot({timeout:10000,path:`${directory}/report-${width}.png`,fullPage:false});
   });
  }
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({timeout:10000,path:`${directory}/${input.stage}-failure.png`,fullPage:false}).catch(()=>{});throw error;}
 finally{save();await context.close();await browser.close();}
 return checks;
}
