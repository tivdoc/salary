import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {isOpaqueToken} from '../../src/server/product/case-access/crypto.ts';

// Repin only after the implementation's exact CI and isolated deployment pass.
const origin='https://salary-jew7zf36n-tivdoccom-5042s-projects.vercel.app';
const deployedSha='d6c2b16461ad0a4efde40cb4c3a34f689d61002d';
const directory='output/release-completion/preview-order-refunds';
export async function verifyOrderRefundPreview(input:{publicId:string;foreignPublicId:string;session:string;foreignSession:string}){
 assert.ok(isOpaqueToken(input.session)&&isOpaqueToken(input.foreignSession));
 const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
 assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].name,'_vercel_jwt');assert.equal(access.cookies[0].domain,new URL(origin).hostname);
 assert.ok(origin.startsWith('https://salary-')&&origin.endsWith('-tivdoccom-5042s-projects.vercel.app'));
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});
 const cookie=(session:string)=>({name:'tivdoc_case_session',value:session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax' as const});
 await context.addCookies([cookie(input.session)]);const page=await context.newPage();page.setDefaultTimeout(20000);
 const errors:string[]=[],checks:{name:string;passed:boolean;detail?:string}[]=[];let paymentWrites=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/payments/')&&r.method()==='POST')paymentWrites++;});mkdirSync(directory,{recursive:true});
 const save=()=>writeFileSync(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,checks,errors,paymentWrites,scope:'Owned synthetic paid order and cumulative correction ledger; seeded customer sessions and actual hosted page/DB. No provider charge/refund, canonical financial correctness or production.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
 async function check(name:string,run:()=>Promise<void>){try{await run();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,detail:e instanceof Error?e.message:'failed'});throw e;}finally{save();}}
 const url=origin+`/case/${input.publicId}/orders`;
 try{
  await check('order proof uses isolated DEV with external payment disabled',async()=>{
   const response=await context.request.get(origin+'/api/health');assert.equal(response.status(),200);const body=await response.json();assert.equal(body.configured.payment,false);assert.equal(body.configured.paymentRecovery,false);assert.ok(response.headers()['content-security-policy'].includes('cpzrbidxftzqcfeqqusu.supabase.co'));
  });
  await check('saved cumulative correction is pending on the full order; original price and initial order remain visible',async()=>{
   assert.equal((await page.goto(url))?.status(),200);await page.getByText('בקשת החזר בעקבות תיקון',{exact:true}).waitFor();
   const full=page.locator('article').filter({has:page.getByRole('heading',{name:'דוח מלא',exact:true})}),initial=page.locator('article').filter({has:page.getByRole('heading',{name:'בדיקה ראשונית',exact:true})});
   assert.equal(await full.count(),1);assert.equal(await initial.count(),1);assert.equal(await full.getByText('בקשת החזר בעקבות תיקון',{exact:true}).count(),1);
   assert.ok((await full.innerText()).includes('339.01 ₪'));assert.ok((await full.innerText()).includes('הכסף טרם הוחזר'));assert.ok(!(await full.innerText()).includes('ההחזר אומת'));
   assert.ok((await initial.innerText()).includes('9.99 ₪'));assert.ok((await initial.innerText()).includes('אין בקשת החזר'));assert.equal(await initial.getByText('בקשת החזר בעקבות תיקון',{exact:true}).count(),0);
  });
  await check('reload preserves one cumulative request and does not invoke checkout or a refund provider',async()=>{
   await page.reload();await page.getByText('בקשת החזר בעקבות תיקון',{exact:true}).waitFor();assert.equal(await page.getByText('בקשת החזר בעקבות תיקון',{exact:true}).count(),1);assert.equal(paymentWrites,0);
  });
  await check('another customer cannot open the order or see its adjustment in their own case',async()=>{
   // Independent profiles model distinct customers without directly replacing
   // a live page's cookie while its legitimate refresh request is in flight.
   const foreign=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem'});
   try{await foreign.addCookies([cookie(input.foreignSession)]);const other=await foreign.newPage();assert.equal((await other.goto(url))?.status(),404);
    assert.equal((await other.goto(origin+`/case/${input.foreignPublicId}/orders`))?.status(),200);assert.equal(await other.getByText('בקשת החזר בעקבות תיקון',{exact:true}).count(),0);
   }finally{await foreign.close();}
  });
  for(const width of [360,390,768,1440])await check(`pending refund and protected header fit ${width}px`,async()=>{
   await page.setViewportSize({width,height:900});await page.goto(url);await page.getByText('בקשת החזר בעקבות תיקון',{exact:true}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   assert.ok(await page.locator('.check-header__top').evaluate(el=>{const parent=el.getBoundingClientRect();return [...el.children].every(child=>{const r=child.getBoundingClientRect();return r.top>=parent.top-1&&r.bottom<=parent.bottom+1;});}));
   assert.deepEqual(errors,[]);assert.equal(paymentWrites,0);await page.screenshot({path:`${directory}/orders-${width}.png`,fullPage:false});
  });
 }catch(e){await page.screenshot({path:`${directory}/failure.png`,fullPage:false}).catch(()=>{});throw e;}
 finally{save();await context.close();await browser.close();}
 return checks;
}
