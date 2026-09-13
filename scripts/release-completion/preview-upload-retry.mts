import '../production-refusal.mjs';
import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';import {chromium} from 'playwright';
const origin='https://salary-oq30tj1do-tivdoccom-5042s-projects.vercel.app';const f=JSON.parse(process.env.TIVDOC_PREVIEW_CASE_FIXTURES??'null');const state=JSON.parse(process.env.TIVDOC_PREVIEW_BROWSER_STATE??'null');
assert.equal(f.origin,origin);assert.equal(f.database,'tivdoc_release_replay_20260907');assert.equal(state.cookies[0].domain,new URL(origin).hostname);assert.match(f.pendingBatch,/^[a-f0-9-]{36}$/u);
delete process.env.TIVDOC_PREVIEW_CASE_FIXTURES;delete process.env.TIVDOC_PREVIEW_BROWSER_STATE;
const dir='output/release-completion/preview-upload-retry';await mkdir(dir,{recursive:true});const browser=await chromium.launch({headless:true});const events:unknown[]=[];
const context=await browser.newContext({storageState:state,viewport:{width:390,height:900}});context.setDefaultTimeout(30000);const c=f.cases[0];await context.addCookies([{name:'tivdoc_case_session',value:c.session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);const page=await context.newPage();
for(const name of ['request','response','requestfailed'] as const)page.on(name,(r)=>{const url=new URL(r.url());if(url.origin===origin&&url.pathname.startsWith('/api/documents/'))events.push({event:name,path:url.pathname,status:'status'in r?r.status():null});});
try{
 const r=await context.request.post(`${origin}/api/cases/${c.publicId}/upload-session`,{headers:{origin}});assert.equal(r.status(),200);
 await page.goto(origin+'/check/upload',{waitUntil:'domcontentloaded'});await page.evaluate(({caseId,batchId})=>sessionStorage.setItem('tivdoc:document-upload:v1:'+caseId,batchId),{caseId:c.caseId,batchId:f.pendingBatch});await page.reload({waitUntil:'domcontentloaded'});
 const button=page.getByRole('button',{name:'ניסיון נוסף להשלמת ההעלאה',exact:true});await button.waitFor();events.push({buttonEnabled:await button.isEnabled()});
 await button.click();await page.waitForURL(/\/case\/TV-[A-Z0-9]{8}\/documents$/u,{timeout:35000});events.push({retrySucceeded:true});
}catch(e){events.push({failed:true,message:e instanceof Error?e.message:'failed',alerts:await page.getByRole('alert').allTextContents()});process.exitCode=1;}
finally{await page.screenshot({path:dir+'/retry.png',fullPage:true});await writeFile(dir+'/receipt.json',JSON.stringify({origin,events,scope:'Synthetic saved batch retry diagnostic, no request payloads or secrets'},null,2));console.log(JSON.stringify(events));await context.close();await browser.close();}
