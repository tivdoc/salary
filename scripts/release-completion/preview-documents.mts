import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {chromium,type Page,type BrowserContext} from 'playwright';
import {PDFDocument,StandardFonts} from 'pdf-lib';

const origin='https://salary-oq30tj1do-tivdoccom-5042s-projects.vercel.app';
const deployedSha='923517ec42e37296a68c69ae2d362a4629808efa';
const directory='output/release-completion/preview-documents';
type Fixture={caseId:string;publicId:string;identity:string;session:string;requests:Record<string,string>};
type Doc={id:string;version_id:string;slot:string;original_filename:string;document_type:string};
type Snapshot={caseId:string;documents:Doc[];status:string;paymentStatus:string;requests:{id:string}[]};
const fixtures=JSON.parse(process.env.TIVDOC_PREVIEW_CASE_FIXTURES??'null') as {origin:string;database:string;cases:Fixture[];pendingBatch?:string;resume?:{run:number;snapshots:Record<string,Snapshot>}};
const access=JSON.parse(process.env.TIVDOC_PREVIEW_BROWSER_STATE??'null');
delete process.env.TIVDOC_PREVIEW_CASE_FIXTURES;delete process.env.TIVDOC_PREVIEW_BROWSER_STATE;
assert.equal(fixtures.origin,origin);assert.equal(fixtures.database,'tivdoc_release_replay_20260907');assert.equal(fixtures.cases.length,2);
assert.equal(access.origins.length,0);assert.equal(access.cookies.length,1);
assert.equal(access.cookies[0].name,'_vercel_jwt');assert.equal(access.cookies[0].domain,new URL(origin).hostname);
assert.notEqual(fixtures.cases[0].caseId,fixtures.cases[1].caseId);
for(const c of fixtures.cases){assert.match(c.caseId,/^[a-f0-9-]{36}$/u);assert.match(c.publicId,/^TV-[A-Z0-9]{8}$/u);assert.match(c.session,/^[A-Za-z0-9_-]{22}$/u);}
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true});
const contexts:BrowserContext[]=[];
const checks:{name:string;passed:boolean;detail?:string}[]=[];
const snapshots:Record<string,Snapshot>={};
const expectedFiles:{name:string;sha256:string;size:number}[]=[];
const errors:string[]=[];const network:{kind:string;status?:number;code?:string|null}[]=[];let observed:Page|undefined;
async function receipt(){await writeFile(`${directory}/receipt.json`,JSON.stringify({origin,deployedSha,resumedPrefixFromRun:fixtures.resume?.run??null,checks,snapshots,expectedFiles,errors,network,
 scope:'Two seeded synthetic QA identities; actual hosted pages, HTTP upload APIs, DEV Storage PUT and isolated web-role DB RPC. No OTP delivery or real payment/provider verification.',
 productionChanged:false,secretsIncluded:false},null,2)+'\n');}
async function check(name:string,run:()=>Promise<void>){try{await run();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){const detail=e instanceof Error?e.message:'failed';checks.push({name,passed:false,detail});console.log('FAIL '+name+': '+detail);if(observed){await observed.screenshot({path:`${directory}/failure.png`,fullPage:true}).catch(()=>{});network.push({kind:'visible alerts: '+(await observed.getByRole('alert').allTextContents()).join(' | ')});}await receipt();throw e;}await receipt();}
async function context(c:Fixture){const ctx=await browser.newContext({storageState:access,locale:'he-IL',timezoneId:'Asia/Jerusalem',viewport:{width:390,height:900},reducedMotion:'reduce'});contexts.push(ctx);ctx.setDefaultTimeout(20000);ctx.setDefaultNavigationTimeout(30000);await ctx.addCookies([{name:'tivdoc_case_session',value:c.session,domain:new URL(origin).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);return ctx;}
function watch(page:Page){page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{const url=new URL(r.url());if(url.origin===origin&&url.pathname.startsWith('/api/documents/')){const body=await r.json().catch(()=>({}));network.push({kind:url.pathname,status:r.status(),code:body.code??null});}else if(url.hostname==='cpzrbidxftzqcfeqqusu.supabase.co'&&r.request().method()==='PUT')network.push({kind:'DEV Storage PUT',status:r.status()});});page.on('requestfailed',r=>{const u=new URL(r.url());if(u.origin===origin&&u.pathname.startsWith('/api/documents/'))network.push({kind:u.pathname+' failed'});else if(u.hostname==='cpzrbidxftzqcfeqqusu.supabase.co')network.push({kind:'DEV Storage request failed'});});}
async function open(page:Page,c:Fixture){observed=page;const response=await page.goto(`${origin}/case/${c.publicId}/documents`,{waitUntil:'domcontentloaded'});assert.equal(response?.status(),200,'owner documents page');await page.getByRole('heading',{name:'המסמכים בתיק',exact:true}).waitFor();await page.getByRole('button',{name:'ניהול המסמכים',exact:true}).click();await page.waitForURL(origin+'/check/upload');await page.getByRole('heading',{name:'השלמת מסמכים לתיק',exact:true}).waitFor();}
async function file(name:string){const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage([400,250]).drawText('SYNTHETIC QA ONLY: '+name,{x:24,y:200,size:12,font});const buffer=Buffer.from(await pdf.save());expectedFiles.push({name,sha256:createHash('sha256').update(buffer).digest('hex'),size:buffer.length});return {name,mimeType:'application/pdf',buffer};}
async function choose(page:Page,label:string,name:string){await page.getByLabel(label,{exact:true}).setInputFiles(await file(name));await page.getByRole('button',{name:'שמירה וחזרה לתיק',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.document-review__actions .button--primary')?.disabled);}
async function submit(page:Page){const result=page.waitForResponse(r=>r.url()===origin+'/api/documents/complete'&&r.request().method()==='POST');await page.getByRole('button',{name:/^(שמירה וחזרה לתיק|ניסיון נוסף להשלמת ההעלאה)$/u}).click();const response=await result;assert.equal(response.status(),200,'completion status');const body=await response.json() as Snapshot;await page.waitForURL(/\/case\/TV-[A-Z0-9]{8}\/documents$/u);return body;}
function doc(s:Snapshot,name:string){const value=s.documents.find(d=>d.original_filename===name);assert.ok(value,'saved document '+name);return value;}
function retained(before:Snapshot,after:Snapshot,names:string[]){for(const name of names)assert.deepEqual(doc(after,name),doc(before,name));assert.equal(after.status,'under_review');assert.equal(after.paymentStatus,'verified');}
async function saved(page:Page,names:string[]){const section=page.getByRole('region',{name:'מסמכים שמורים'});for(const name of names)await section.getByText(name,{exact:true}).waitFor();assert.equal(await section.locator('li').count(),names.length);}
try{
 const [a,b]=fixtures.cases;const ca=await context(a),cb=await context(b);const pa=await ca.newPage(),pb=await cb.newPage();watch(pa);watch(pb);
 if(fixtures.resume){
  assert.equal(fixtures.resume.run,34139129328);Object.assign(snapshots,fixtures.resume.snapshots);assert.equal(snapshots.added.caseId,a.caseId);
  await check('cancel incomplete prior attempt while retaining its three saved documents',async()=>{
   await open(pa,a);await saved(pa,['qa-first.pdf','qa-contract.pdf','qa-second.pdf']);
   const response=await ca.request.post(origin+'/api/documents/complete',{headers:{origin},data:{caseId:a.caseId,batchId:fixtures.pendingBatch,action:'cancel'}});assert.equal(response.status(),200);assert.deepEqual((await response.json()).documents,snapshots.added.documents);
  });
 }else{
 await check('owner session reaches the isolated hosted upload screen',async()=>{await open(pa,a);assert.equal(await pa.getByRole('region',{name:'מסמכים שמורים'}).count(),0);});
 await check('initial payslip and contract are uploaded through UI, Storage and completion',async()=>{await choose(pa,'הוספת תלוש','qa-first.pdf');await choose(pa,'הוספת חוזה','qa-contract.pdf');snapshots.initial=await submit(pa);assert.equal(snapshots.initial.documents.length,2);});
 await check('returning to upload renders the saved first payslip and contract',async()=>{await open(pa,a);await saved(pa,['qa-first.pdf','qa-contract.pdf']);await pa.screenshot({path:`${directory}/saved-initial-390.png`,fullPage:true});});
 await check('adding a second payslip preserves both original document identities and versions',async()=>{await choose(pa,'הוספת תלוש','qa-second.pdf');snapshots.added=await submit(pa);assert.equal(snapshots.added.documents.length,3);retained(snapshots.initial,snapshots.added,['qa-first.pdf','qa-contract.pdf']);});
 }
 await check('connection failure before completion leaves the original replacement target saved',async()=>{
  await open(pa,a);await choose(pa,'החלפת qa-first.pdf','qa-replaced.pdf');
  await pa.route(origin+'/api/documents/complete',route=>route.abort('connectionfailed'),{times:1});
  await Promise.all([pa.waitForRequest(r=>r.url()===origin+'/api/documents/complete'&&r.method()==='POST'),pa.getByRole('button',{name:'שמירה וחזרה לתיק',exact:true}).click()]);await pa.getByRole('alert').waitFor();
  await pa.unroute(origin+'/api/documents/complete');
  await pa.reload({waitUntil:'domcontentloaded'});await saved(pa,['qa-first.pdf','qa-contract.pdf','qa-second.pdf']);
  await pa.getByRole('button',{name:'ניסיון נוסף להשלמת ההעלאה',exact:true}).waitFor();
  await pa.screenshot({path:`${directory}/interrupted-replacement-390.png`,fullPage:true});
 });
 let replacementBatch='';
 await check('reload retry completes the exact prior replacement and changes only the selected version',async()=>{
  const request=pa.waitForRequest(r=>r.url()===origin+'/api/documents/complete'&&r.method()==='POST');
  snapshots.replaced=await submit(pa);replacementBatch=(await request).postDataJSON().batchId;
  assert.equal(snapshots.replaced.documents.length,3);retained(snapshots.added,snapshots.replaced,['qa-contract.pdf','qa-second.pdf']);
  assert.equal(doc(snapshots.replaced,'qa-replaced.pdf').id,doc(snapshots.initial,'qa-first.pdf').id);
  assert.notEqual(doc(snapshots.replaced,'qa-replaced.pdf').version_id,doc(snapshots.initial,'qa-first.pdf').version_id);
 });
 await check('duplicate completion returns the same saved versions without extra rows',async()=>{for(let i=0;i<2;i++){const r=await ca.request.post(origin+'/api/documents/complete',{headers:{origin},data:{caseId:a.caseId,batchId:replacementBatch}});assert.equal(r.status(),200);assert.deepEqual((await r.json()).documents,snapshots.replaced.documents);}});
 await check('two real tabs add payslips concurrently and preserve the prior three documents',async()=>{
  const second=await ca.newPage();watch(second);await Promise.all([open(pa,a),open(second,a)]);
  await Promise.all([choose(pa,'הוספת תלוש','qa-parallel-a.pdf'),choose(second,'הוספת תלוש','qa-parallel-b.pdf')]);
  const results=await Promise.all([submit(pa),submit(second)]);snapshots.concurrent=results.find(s=>s.documents.length===5)!;assert.ok(snapshots.concurrent);
  retained(snapshots.replaced,snapshots.concurrent,['qa-replaced.pdf','qa-contract.pdf','qa-second.pdf']);
  assert.notEqual(doc(snapshots.concurrent,'qa-parallel-a.pdf').slot,doc(snapshots.concurrent,'qa-parallel-b.pdf').slot);
  await open(pa,a);await saved(pa,['qa-replaced.pdf','qa-contract.pdf','qa-second.pdf','qa-parallel-a.pdf','qa-parallel-b.pdf']);await second.close();
 });
 await check('another owner starts with one payslip and two independent completion requests',async()=>{await open(pb,b);await choose(pb,'הוספת תלוש','qa-late-first.pdf');snapshots.lateBefore=await submit(pb);assert.equal(snapshots.lateBefore.documents.length,1);assert.equal(snapshots.lateBefore.requests.length,2);});
 await check('contract-only completion answers its chosen request and preserves status and unrelated request',async()=>{
  await open(pb,b);await choose(pb,'הוספת חוזה','qa-late-contract.pdf');await pb.getByLabel('בקשת ההשלמה שהמסמך עונה עליה',{exact:true}).selectOption(b.requests.contract_missing);
  snapshots.lateAfter=await submit(pb);assert.equal(snapshots.lateAfter.documents.length,2);retained(snapshots.lateBefore,snapshots.lateAfter,['qa-late-first.pdf']);assert.deepEqual(snapshots.lateAfter.requests.map(r=>r.id),[b.requests.attendance_missing]);
 });
 await check('foreign case upload-session, addition, replacement, completion and request linkage are refused',async()=>{
  const post=(path:string,data:unknown)=>ca.request.post(origin+path,{headers:{origin},data});
  assert.equal((await post(`/api/cases/${b.publicId}/upload-session`,{})).status(),404);
  const f=await file('qa-forbidden.pdf');const descriptor={clientId:randomUUID(),documentType:'payslip',name:f.name,type:f.mimeType,size:f.buffer.length,sha256:createHash('sha256').update(f.buffer).digest('hex'),periodMonth:'2026-08'};
  assert.equal((await post('/api/documents/sign',{caseId:b.caseId,batchId:randomUUID(),files:[descriptor]})).status(),403);
  assert.equal((await post('/api/documents/complete',{caseId:b.caseId,batchId:replacementBatch})).status(),403);
  const foreign=doc(snapshots.lateAfter,'qa-late-first.pdf');
  assert.equal((await post('/api/documents/sign',{caseId:a.caseId,batchId:randomUUID(),files:[{...descriptor,replace:{documentId:foreign.id,versionId:foreign.version_id}}]})).status(),409);
  assert.equal((await post('/api/documents/sign',{caseId:a.caseId,batchId:randomUUID(),requestId:b.requests.attendance_missing,files:[{...descriptor,documentType:'attendance',periodMonth:undefined}]})).status(),409);
 });
 await check('saved protected pages fit mobile and desktop without client exceptions',async()=>{
  for(const width of [360,390,768,1440]){await pa.setViewportSize({width,height:900});await open(pa,a);const overflow=await pa.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);assert.ok(overflow<=1,`upload overflow ${width}: ${overflow}`);await pa.screenshot({path:`${directory}/saved-final-${width}.png`,fullPage:true});}
  assert.deepEqual(errors,[]);
 });
}catch{/* each failed check already recorded; stop dependent mutations */}
finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();await receipt();}
if(checks.some(c=>!c.passed)||checks.length<(fixtures.resume?10:13))process.exitCode=1;
