import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {isOpaqueToken} from '../../src/server/product/case-access/crypto.ts';

const directory='output/release-completion/preview-order-cancellation';
export async function verifyOrderCancellationPreview(input:{expectedGitSha:string;publicId:string;foreignPublicId:string;session:string;foreignSession:string;orderId:string;initialOrderId:string}){
 assert.ok(isOpaqueToken(input.session)&&isOpaqueToken(input.foreignSession));assert.match(input.orderId,/^[0-9a-f-]{36}$/u);assert.match(input.initialOrderId,/^[0-9a-f-]{36}$/u);
 const deployment=JSON.parse(readFileSync(process.env.TIVDOC_CUSTOMER_CANCEL_PREVIEW_DEPLOYMENT_FILE??'','utf8'));
 assert.match(input.expectedGitSha,/^[0-9a-f]{40}$/u);assert.equal(deployment.sha,input.expectedGitSha);assert.equal(deployment.readyState,'READY');assert.notEqual(deployment.target,'production');
 const origin='https://'+deployment.url;assert.match(origin,/^https:\/\/salary-[a-z0-9]+-tivdoccom-5042s-projects\.vercel\.app$/u);
 const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
 assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].name,'_vercel_jwt');assert.equal(access.cookies[0].domain,new URL(origin).hostname);
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});
 const cookie=(session:string)=>({name:'tivdoc_case_session',value:session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax' as const});
 await context.addCookies([cookie(input.session)]);const page=await context.newPage();page.setDefaultTimeout(20000);
 const checks:{name:string;passed:boolean;detail?:string}[]=[],errors:string[]=[],paymentActions:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url()===origin+'/api/payments/start'&&r.method()==='POST')paymentActions.push(String(r.postDataJSON()?.action));});
 mkdirSync(directory,{recursive:true});const url=origin+`/case/${input.publicId}/orders`;
 const card=()=>page.locator(`[data-order-id="${input.orderId}"]`),button=()=>card().getByRole('button',{name:'ביטול ההזמנה שטרם שולמה',exact:true});
 const save=()=>writeFileSync(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha:input.expectedGitSha,deploymentId:deployment.id,checks,errors,paymentActions,
  scope:'Owned synthetic quote/order/payment/readiness and seeded customer sessions. Actual hosted UI/HTTP/DEV cancellation, lost response/retry/reload. No live quote basis, provider checkout/refund, financial correctness or production.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
 async function check(name:string,run:()=>Promise<void>){try{await run();assert.deepEqual(errors,[]);checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false,detail:e instanceof Error?e.message:'failed'});throw e;}finally{save();}}
 try{
  await check('cancellation Preview is exact isolated DEV with external payment disabled',async()=>{
   const response=await context.request.get(origin+'/api/health');assert.equal(response.status(),200);const health=await response.json();assert.equal(health.configured.payment,false);assert.equal(health.configured.paymentRecovery,false);assert.ok(response.headers()['content-security-policy'].includes('cpzrbidxftzqcfeqqusu.supabase.co'));
  });
  await check('only the selected unstarted order offers cancellation; the paid initial order remains protected',async()=>{
   assert.equal((await page.goto(url))?.status(),200);await button().waitFor();
   const initial=page.locator(`[data-order-id="${input.initialOrderId}"]`);await initial.getByText('התשלום אומת',{exact:true}).waitFor();assert.equal(await initial.getByRole('button',{name:'ביטול ההזמנה שטרם שולמה',exact:true}).count(),0);
   await card().screenshot({path:`${directory}/unstarted-order.png`});
  });
  await check('a separate customer cannot view or cancel the target through either case identifier',async()=>{
   const foreign=await browser.newContext({storageState:access});try{await foreign.addCookies([cookie(input.foreignSession)]);
    assert.equal((await foreign.request.get(url)).status(),404);
    for(const publicId of [input.publicId,input.foreignPublicId])assert.equal((await foreign.request.post(origin+'/api/payments/start',{headers:{origin},data:{action:'cancel_unstarted',publicId,orderId:input.orderId}})).status(),404);
   }finally{await foreign.close();}
  });
  let dropped=false,observedStatus:number|null=null,observedOrder:unknown;
  await page.route('**/api/payments/start',async route=>{
   const body=route.request().postDataJSON();
   if(!dropped&&body?.action==='cancel_unstarted'&&body.orderId===input.orderId){
    const response=await route.fetch();observedStatus=response.status();observedOrder=(await response.json()).cancellation?.order_id;dropped=true;await route.abort('failed');
   }else await route.continue();
  });
  await check('response loss after actual successful HTTP cancellation is presented as unconfirmed',async()=>{
   await button().click();await card().getByRole('alert').filter({hasText:'לא התקבל אישור ביטול. אפשר לבדוק את ההיסטוריה או לנסות שוב.'}).waitFor();
   assert.equal(dropped,true);assert.equal(observedStatus,200);assert.equal(observedOrder,input.orderId);assert.equal(await button().count(),1);
  });
  await page.unroute('**/api/payments/start');
  await check('retry uses the same order, receives confirmation and refreshes stored history',async()=>{
   const response=page.waitForResponse(r=>r.url()===origin+'/api/payments/start'&&r.request().method()==='POST');await button().click();const confirmed=await response;
   assert.equal(confirmed.status(),200);assert.deepEqual((await confirmed.json()).cancellation,{order_id:input.orderId,state:'cancelled',replayed:true});
   await card().getByText('ההזמנה בוטלה',{exact:true}).waitFor();assert.equal(await button().count(),0);
  });
  await check('reload preserves the cancelled order and sends neither checkout nor refund requests',async()=>{
   await page.reload();await card().getByText('ההזמנה בוטלה',{exact:true}).waitFor();assert.equal(await button().count(),0);assert.deepEqual(paymentActions,['cancel_unstarted','cancel_unstarted']);
  });
  for(const width of [360,390,768,1440])await check(`cancelled history fits RTL at ${width}px`,async()=>{
   await page.setViewportSize({width,height:900});await page.reload();await card().getByText('ההזמנה בוטלה',{exact:true}).waitFor();
   assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await card().screenshot({path:`${directory}/cancelled-${width}.png`});
  });
 }catch(e){await page.screenshot({path:`${directory}/failure.png`,fullPage:false}).catch(()=>{});throw e;}
 finally{save();await context.close();await browser.close();}
 return checks;
}
