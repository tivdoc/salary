import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,type BrowserContext} from 'playwright';

// Deliberately pinned to the isolated, closed-sales deployment, never production.
const origin='https://salary-nvxblwmsh-tivdoccom-5042s-projects.vercel.app';
const deployedSha='e950177b38f13ba8fd672f6b23a6468882338fcd';
const directory='output/release-completion/preview-launch';
const raw=process.env.TIVDOC_PREVIEW_BROWSER_STATE;
if(!raw)throw new Error('PREVIEW_TEMPORARY_ACCESS_MISSING');
const storageState=JSON.parse(raw);
assert.equal(storageState.origins.length,0);
assert.equal(storageState.cookies.length,1);
assert.equal(storageState.cookies[0].domain,new URL(origin).hostname);
assert.equal(storageState.cookies[0].name,'_vercel_jwt');
delete process.env.TIVDOC_PREVIEW_BROWSER_STATE;
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const checks:{name:string;passed:boolean;detail?:string}[]=[];
const pages:{path:string;width:number;status:number|null;horizontalOverflow:number;errors:string[]}[]=[];
async function saveReceipt(){
 await writeFile(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,checks,pages,
  scope:'Public read-only pages and anonymous authorization; no case identity/payment/provider or completed DB journey',
  productionChanged:false,temporaryAccessIncluded:false},null,2)+'\n');
}
async function check(name:string,run:()=>Promise<void>){
 try{await run();checks.push({name,passed:true});console.log('PASS '+name);}
 catch(error){const detail=error instanceof Error?error.message:'check failed';checks.push({name,passed:false,detail});console.log('FAIL '+name+': '+detail);}
 await saveReceipt();
}
let context:BrowserContext|undefined;
try{
 context=await browser.newContext({storageState,locale:'he-IL',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce'});
 const page=await context.newPage();
 context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(20000);
 await saveReceipt();
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
    const start=errors.length;const response=await page.goto(origin+path,{waitUntil:'domcontentloaded',timeout:20000});
    await page.screenshot({path:`${directory}/navigation-${path==='/'?'home':path.slice(1)}-${width}.png`,fullPage:false,timeout:10000});
    assert.equal(response?.status(),200);assert.equal(new URL(page.url()).origin,origin);
    await page.locator('main').waitFor({state:'visible',timeout:15000});
    await page.evaluate(()=>Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,3000))]));
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    const pageErrors=errors.slice(start);pages.push({path,width,status:response?.status()??null,horizontalOverflow:overflow,errors:pageErrors});
    await page.screenshot({path:`${directory}/${path==='/'?'home':path.slice(1)}-${width}.png`,fullPage:true});
    assert.ok(overflow<=1,`horizontal overflow ${overflow}px`);assert.deepEqual(pageErrors,[]);
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
    assert.ok(await page.locator('main').count()>0);
    if(path==='/'||path==='/terms'){
     const rows=page.locator('.price-tiers tbody tr');assert.equal(await rows.count(),4);
     for(const [i,total,balance] of [[1,'99','89.01'],[2,'199','189.01'],[3,'349','339.01']] as const){
      assert.ok((await rows.nth(i).locator('td').nth(0).innerText()).includes(total));
      assert.ok((await rows.nth(i).locator('td').nth(1).innerText()).includes(balance));
     }
    }
    if(path==='/')assert.ok((await page.locator('body').innerText()).includes('פתיחת הזמנות חדשות אינה זמינה כרגע'));
   });
  }
 }
 await check('keyboard can reach a visible homepage control',async()=>{
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.keyboard.press('Tab');
  const focused=await page.evaluate(()=>{const e=document.activeElement as HTMLElement|null;return e?{tag:e.tagName,rect:e.getBoundingClientRect().toJSON()}:null;});
  assert.ok(focused&&['A','BUTTON','INPUT'].includes(focused.tag));assert.ok(focused.rect.width>0);
 });
 await check('mobile menu supports keyboard activation, Escape and restored focus',async()=>{
  await page.setViewportSize({width:390,height:900});await page.goto(origin,{waitUntil:'domcontentloaded'});
  const toggle=page.locator('button[aria-controls="public-navigation"]');await toggle.focus();await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.equal(await toggle.evaluate(e=>e===document.activeElement),true);
 });
 await check('questionnaire keeps a synthetic non-personal draft through offline editing and reload',async()=>{
  await page.goto(origin+'/check',{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'כן',exact:true}).click();await page.getByRole('button',{name:'המשך',exact:true}).click();
  await page.getByRole('heading',{name:'איך השכר מוגדר?'}).waitFor();
  try{await context!.setOffline(true);await page.getByRole('button',{name:'חודשי',exact:true}).click();}
  finally{await context!.setOffline(false);}
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:'איך השכר מוגדר?'}).waitFor();
  await page.getByRole('button',{name:'המשך',exact:true}).click();
  await page.getByRole('heading',{name:'כמה שעות עובדים ביום רגיל?'}).waitFor();
  await page.screenshot({path:`${directory}/questionnaire-restored-draft-390.png`,fullPage:true});
 });
 await check('anonymous private routes redirect before streaming any case data',async()=>{
  for(const path of ['/account','/cases','/case/TV-QAPRE001','/case/TV-QAPRE001/documents','/case/TV-QAPRE001/thread','/case/TV-QAPRE001/reports','/case/TV-QAPRE001/orders']){
   const response=await context!.request.get(origin+path,{maxRedirects:0});assert.equal(response.status(),307,path);
   assert.ok(response.headers().location?.includes('/login'),path);
  }
 });
 await check('anonymous document API refuses access',async()=>{
  const response=await context!.request.post(origin+'/api/cases/TV-QAPRE001/upload-session',{headers:{origin}});
  assert.equal(response.status(),401);assert.equal((await response.json()).code,'session_required');
 });
}finally{
 await context?.close();await browser.close();
 await saveReceipt();
}
if(checks.some(check=>!check.passed))process.exitCode=1;
