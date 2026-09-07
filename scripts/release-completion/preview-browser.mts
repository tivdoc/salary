import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,type BrowserContext} from 'playwright';

// Deliberately pinned to the isolated, closed-sales deployment, never production.
const origin='https://salary-18a6lvjd7-tivdoccom-5042s-projects.vercel.app';
const deployedSha='30f24e79ca4ffc3df92403b0d625f8eea4d17ebf';
const directory='output/release-completion/preview-browser';
const raw=process.env.TIVDOC_PREVIEW_BROWSER_STATE;
if(!raw)throw new Error('PREVIEW_TEMPORARY_ACCESS_MISSING');
const storageState=JSON.parse(raw);
assert.equal(storageState.origins.length,0);
assert.equal(storageState.cookies.length,1);
assert.equal(storageState.cookies[0].domain,new URL(origin).hostname);
assert.equal(storageState.cookies[0].name,'_vercel_jwt');
delete process.env.TIVDOC_PREVIEW_BROWSER_STATE;
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true});
const checks:{name:string;passed:boolean;detail?:string}[]=[];
const pages:{path:string;width:number;status:number|null;horizontalOverflow:number;errors:string[]}[]=[];
async function check(name:string,run:()=>Promise<void>){
 try{await run();checks.push({name,passed:true});console.log('PASS '+name);}
 catch(error){const detail=error instanceof Error?error.message:'check failed';checks.push({name,passed:false,detail});console.log('FAIL '+name+': '+detail);}
}
let context:BrowserContext|undefined;
try{
 context=await browser.newContext({storageState,locale:'he-IL',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
 const page=await context.newPage();
 const errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await check('DEV liveness distinguishes readiness and external services are disabled',async()=>{
  const response=await context!.request.get(origin+'/api/health');assert.equal(response.status(),200);
  const body=await response.json();assert.equal(body.scope,'process_liveness');assert.equal(body.readiness,'not_assessed');
  for(const key of ['payment','analytics','analyticsServer','metaPixel','metaCapi','paymentRecovery'])assert.equal(body.configured[key],false,key);
  assert.ok(response.headers()['content-security-policy'].includes('cpzrbidxftzqcfeqqusu.supabase.co'));
  assert.ok(!response.headers()['content-security-policy'].includes('hedgdltsonvypefbigag'));
 });
 for(const width of [360,390,768,1440]){
  await page.setViewportSize({width,height:900});
  for(const path of ['/','/check','/login','/privacy','/terms']){
   await check(`public ${path} at ${width}px`,async()=>{
    const start=errors.length;const response=await page.goto(origin+path,{waitUntil:'networkidle',timeout:45000});
    assert.equal(response?.status(),200);assert.equal(new URL(page.url()).origin,origin);
    await page.evaluate(()=>document.fonts.ready);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    const pageErrors=errors.slice(start);pages.push({path,width,status:response?.status()??null,horizontalOverflow:overflow,errors:pageErrors});
    await page.screenshot({path:`${directory}/${path==='/'?'home':path.slice(1)}-${width}.png`,fullPage:true});
    assert.ok(overflow<=1,`horizontal overflow ${overflow}px`);assert.deepEqual(pageErrors,[]);
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
    assert.ok(await page.locator('main').count()>0);
    if(path==='/')assert.ok((await page.locator('body').innerText()).includes('פתיחת הזמנות חדשות אינה זמינה כרגע'));
   });
  }
 }
 await check('keyboard can reach a visible homepage control',async()=>{
  await page.goto(origin);await page.keyboard.press('Tab');
  const focused=await page.evaluate(()=>{const e=document.activeElement as HTMLElement|null;return e?{tag:e.tagName,rect:e.getBoundingClientRect().toJSON()}:null;});
  assert.ok(focused&&['A','BUTTON','INPUT'].includes(focused.tag));assert.ok(focused.rect.width>0);
 });
 await check('anonymous private routes redirect before streaming any case data',async()=>{
  for(const path of ['/account','/cases','/case/TV-SYNTHETIC000','/case/TV-SYNTHETIC000/documents','/case/TV-SYNTHETIC000/thread','/case/TV-SYNTHETIC000/reports','/case/TV-SYNTHETIC000/orders']){
   const response=await context!.request.get(origin+path,{maxRedirects:0});assert.equal(response.status(),307,path);
   assert.ok(response.headers().location?.includes('/login'),path);
  }
 });
 await check('anonymous document API refuses access',async()=>{
  const response=await context!.request.get(origin+'/api/cases/TV-SYNTHETIC000/upload-session');
  assert.ok([401,403,404].includes(response.status()),String(response.status()));
 });
}finally{
 await context?.close();await browser.close();
 await writeFile(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,checks,pages,scope:'Public read-only pages and anonymous authorization; no case identity/payment/provider or completed DB journey',productionChanged:false,temporaryAccessIncluded:false},null,2)+'\n');
}
if(checks.some(check=>!check.passed))process.exitCode=1;
