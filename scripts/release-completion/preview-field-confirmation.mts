import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../../src/server/product/reports/document-field-confirmation.ts';

const directory='output/release-completion/preview-field-confirmation';
type Phase='open'|'stale-open'|'answer'|'correct'|'replace'|'stale-answer';
export async function verifyFieldConfirmationPreview(input:{phase:Phase;publicId:string;foreignPublicId:string;session:string;foreignSession:string;requestId:string;question:string;sourceSha256:string;expectedGitSha:string;replacement?:{documentId:string;versionId:string;bytes:Uint8Array}}){
 const deployedSha=input.expectedGitSha;assert.match(deployedSha,/^[a-f0-9]{40}$/u);
 const deployment=JSON.parse(readFileSync(process.env.TIVDOC_FIELD_PREVIEW_DEPLOYMENT_FILE??'','utf8'));
 assert.equal(deployment.sha,deployedSha);assert.equal(deployment.readyState,'READY');assert.notEqual(deployment.target,'production');
 const origin='https://'+deployment.url;assert.match(origin,/^https:\/\/salary-[a-z0-9]+-tivdoccom-5042s-projects\.vercel\.app$/u);
 const access=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_BROWSER_STATE_FILE??'','utf8'));
 assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);assert.equal(access.cookies[0].name,'_vercel_jwt');assert.equal(access.cookies[0].domain,new URL(origin).hostname);
 mkdirSync(directory,{recursive:true});
 const checks:{name:string;passed:boolean;detail?:string}[]=input.phase==='open'?[]:JSON.parse(readFileSync(`${directory}/receipt.json`,'utf8')).checks;
 const errors:string[]=[];const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});
 const cookie=(session:string)=>({name:'tivdoc_case_session',value:session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax' as const});
 await context.addCookies([cookie(input.session)]);const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 const route=`/api/cases/${input.publicId}/requests`,url=origin+`/case/${input.publicId}/thread`,card=()=>page.locator(`#request-${input.requestId}`);
 const save=()=>writeFileSync(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,deploymentId:deployment.id,checks,errors,scope:'Owned synthetic source PDF, stored extraction, paid order and seeded authenticated sessions; hosted source/reading/history journey. No live OCR, OTP, legal activation, monetary calculation or production.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
 async function check(name:string,run:()=>Promise<void>){try{await run();assert.deepEqual(errors,[]);checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false,detail:e instanceof Error?e.message:'failed'});throw e;}finally{save();}}
 try{
  assert.equal((await page.goto(url))?.status(),200);
  if(input.phase==='open'){
   await check('exact stored field, normalized value and purchased February question opens with reading-only disclosure',async()=>{
    await card().getByRole('heading',{name:input.question,exact:true}).waitFor();await card().getByText('תקופת השאלה: פברואר 2025',{exact:true}).waitFor();
    assert.ok((await card().innerText()).includes('האישור מתייחס לקריאת הנתון במסמך ואינו אישור של החישוב או של הזכאות.'));
   });
   await check('protected source link returns the exact actual Storage PDF with no-store',async()=>{
    const href=await card().getByRole('link',{name:'פתיחת המסמך לאימות השדה'}).getAttribute('href');assert.equal(href,route+'?source='+input.requestId);
    const response=await context.request.get(origin+href);assert.equal(response.status(),200);assert.ok(response.headers()['content-type'].includes('application/pdf'));assert.ok(response.headers()['cache-control'].includes('no-store'));
    const bytes=await response.body();assert.equal(createHash('sha256').update(bytes).digest('hex'),input.sourceSha256);writeFileSync(`${directory}/synthetic-field-source.pdf`,bytes);
   });
   await check('another actual customer cannot read or answer this bound question',async()=>{
    const foreign=await browser.newContext({storageState:access});try{await foreign.addCookies([cookie(input.foreignSession)]);
     assert.equal((await foreign.request.get(origin+route+'?source='+input.requestId)).status(),404);
     assert.equal((await foreign.request.post(origin+route,{headers:{origin},data:{requestId:input.requestId,answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]}})).status(),404);
     assert.equal((await context.request.get(origin+`/api/cases/${input.foreignPublicId}/requests?source=${input.requestId}`)).status(),404);
    }finally{await foreign.close();}
   });
   for(const width of [360,390,768,1440])await check(`saved source question reloads with operable choices in RTL at ${width}px`,async()=>{
    await page.setViewportSize({width,height:900});await page.reload();await card().getByRole('button',{name:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],exact:true}).waitFor();
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);
    await page.screenshot({path:`${directory}/field-${width}.png`,fullPage:true});
   });
  }else if(input.phase==='stale-open'){
   await check('changed document month presents unanswered history without a stale confirmation form',async()=>{
    await page.getByRole('heading',{name:'שאלות ממסמך קודם',exact:true}).waitFor();assert.equal(await card().count(),0);assert.equal(await page.getByRole('button',{name:'שליחת תשובה',exact:true}).count(),0);
    assert.ok((await page.locator('.thread-view').innerText()).includes(input.question));
    assert.equal((await context.request.post(origin+route,{headers:{origin},data:{requestId:input.requestId,answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]}})).status(),409);
   });
  }else if(input.phase==='answer'){
   await check('saved affirmative reading survives response loss, exact retry and full reload',async()=>{
    await card().getByRole('button',{name:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],exact:true}).click();
    await page.route('**'+route,async r=>{const response=await r.fetch();assert.equal(response.status(),200);await r.abort('failed');},{times:1});
    await card().getByRole('button',{name:'שליחת תשובה',exact:true}).click();await card().locator('.form-error').waitFor();
    await card().getByRole('button',{name:'שליחת תשובה',exact:true}).click();await page.locator('.thread-answered__answer').getByText(DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],{exact:true}).waitFor();
    await page.reload();assert.equal((await page.locator('.thread-answered__answer').innerText()).trim(),DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]);
   });
  }else if(input.phase==='correct'){
   await check('negative reading correction persists as a new answer without inventing a replacement amount',async()=>{
    await page.getByText('תיקון התשובה',{exact:true}).click();const form=page.locator('.thread-answered .thread-answer');
    await form.getByRole('button',{name:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1],exact:true}).click();await form.getByRole('button',{name:'שליחת תיקון',exact:true}).click();
    await page.locator('.thread-answered__answer').getByText(DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1],{exact:true}).waitFor();await page.reload();
    assert.equal((await page.locator('.thread-answered__answer').innerText()).trim(),DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1]);
   });
  }else if(input.phase==='replace'){
   const replacement=input.replacement;assert.ok(replacement);
   const endpoint=`/api/cases/${input.publicId}/upload-session?sourceRequestId=${input.requestId}`;
   await check('source replacement navigation refuses foreign identity and cross-origin requests',async()=>{
    const foreign=await browser.newContext({storageState:access});try{await foreign.addCookies([cookie(input.foreignSession)]);assert.equal((await foreign.request.post(origin+endpoint,{headers:{origin}})).status(),404);}finally{await foreign.close();}
    assert.equal((await context.request.post(origin+endpoint,{headers:{origin:'https://foreign.example'}})).status(),403);
   });
   await check('negative source answer opens only its exact stored document for explicit replacement',async()=>{
    await page.getByRole('button',{name:'החלפת המסמך של השאלה',exact:true}).click();await page.waitForURL(origin+`/check/upload?replaceVersionId=${replacement.versionId}`);
    await page.getByText('זה המסמך של השאלה. להחלפתו, בחרו קובץ דרך ״החלפת מסמך״ בכרטיס זה. שאר המסמכים נשמרים בתיק.',{exact:true}).waitFor();
    assert.equal(await page.getByText(input.question,{exact:true}).count(),0);
   });
   let updatedVersion:string|undefined;
   await check('explicit file replacement commits through signed Storage upload and returns saved case documents',async()=>{
    await page.getByLabel('החלפת synthetic.pdf',{exact:true}).setInputFiles({name:'synthetic-replacement.pdf',mimeType:'application/pdf',buffer:Buffer.from(replacement.bytes)});
    await page.getByText('החלפה ממתינה',{exact:false}).waitFor();
    const completed=page.waitForResponse(r=>r.url()===origin+'/api/documents/complete'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'שמירה וחזרה לתיק',exact:true}).click();const response=await completed;assert.equal(response.status(),200);
    const snapshot=await response.json();assert.equal(snapshot.publicId,input.publicId);assert.equal(snapshot.documents.length,1);
    const document=snapshot.documents.find((d:{id:string})=>d.id===replacement.documentId);assert.ok(document);assert.notEqual(document.version_id,replacement.versionId);assert.match(document.version_id,/^[a-f0-9-]{36}$/u);updatedVersion=document.version_id;
    assert.equal(document.original_filename,'synthetic-replacement.pdf');assert.equal(document.period_month,'2025-02');
    await page.waitForURL(origin+`/case/${input.publicId}/documents`);await page.getByText('synthetic-replacement.pdf',{exact:true}).waitFor();await page.reload();await page.getByText('synthetic-replacement.pdf',{exact:true}).waitFor();
    await page.screenshot({path:`${directory}/replaced-source-390.png`,fullPage:true});
   });
   assert.ok(updatedVersion);return {updatedVersion};
  }else{
   await check('replacement keeps answered history with explicit stale-source explanation and refuses the old source endpoint',async()=>{
    await page.getByText('התשובה נשמרה ביחס למסמך הקודם. היא אינה מאשרת נתונים מהמסמך העדכני.',{exact:true}).waitFor();
    assert.equal((await page.locator('.thread-answered__answer').innerText()).trim(),DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1]);assert.equal(await page.getByText('תיקון התשובה',{exact:true}).count(),0);
    assert.equal((await context.request.get(origin+route+'?source='+input.requestId)).status(),404);
    if(input.replacement){assert.equal(await page.getByRole('button',{name:'החלפת המסמך של השאלה',exact:true}).count(),0);assert.equal((await context.request.post(origin+`/api/cases/${input.publicId}/upload-session?sourceRequestId=${input.requestId}`,{headers:{origin}})).status(),409);}
    await page.screenshot({path:`${directory}/historical-field-390.png`,fullPage:true});
   });
  }
 }finally{save();await context.close();await browser.close();}
}
