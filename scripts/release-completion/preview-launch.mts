import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium,type BrowserContext} from 'playwright';

// Deliberately pinned to the isolated, closed-sales deployment, never production.
const origin='https://salary-fjktz4ngs-tivdoccom-5042s-projects.vercel.app';
const deployedSha='5a7b69e533db037c51820012c485da8aabc42143';
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
const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'chrome'}:{})});
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
  for(const path of ['/','/check','/login','/privacy','/terms','/accessibility']){
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
    if(path==='/'){
     assert.ok((await page.locator('body').innerText()).includes('פתיחת הזמנות חדשות אינה זמינה כרגע'));
     assert.equal(await page.locator('.lens-artwork img').evaluate(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0),true,'Artwork did not load');
     const hero=await page.locator('#hero-title').boundingBox();assert.ok(hero&&hero.x>=0&&hero.x+hero.width<=width+1);
     const explore=await page.locator('.studio-hero .studio-link').boundingBox();assert.ok(explore&&explore.y>=0&&explore.y+explore.height<=900,'Exploration link is outside the opening viewport');
     assert.ok(await page.locator('header a[href="/cases"]').count()>0);
     assert.ok(await page.locator('.studio-service a[href="/cases"]').count()>0);
    }
   });
  }
 }
 await check('integrated explainer assets match the reviewed Git bytes',async()=>{
  for(const name of ['media/tivdoc-explainer.mp4','media/tivdoc-explainer-poster.webp','media/tivdoc-explainer.he.vtt','brand/lens-study.webp']){
   const response=await context!.request.get(origin+'/'+name);assert.equal(response.status(),200);
   const expected=await readFile('public/'+name);
   const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
   assert.equal(hash(await response.body()),hash(expected),name);
  }
 });
 await check('30-second silent explainer plays on demand and has captions and written alternative',async()=>{
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  const video=page.locator('video.explainer-video');assert.equal(await video.count(),1);
  assert.equal(await video.getAttribute('autoplay'),null);assert.equal(await video.getAttribute('preload'),'none');
  assert.equal(await video.evaluate(node=>(node as HTMLVideoElement).paused),true);
  assert.equal(await video.locator('track[kind="captions"][srclang="he"]').count(),1);
  await page.locator('#explainer-transcript summary').click();
  assert.ok((await page.locator('#explainer-transcript').innerText()).includes('אינו הבטחה'));
  await video.evaluate(node=>node.scrollIntoView({block:'center'}));
  await video.evaluate(async node=>{const media=node as HTMLVideoElement;media.textTracks[0].mode='showing';await media.play();});
  await page.waitForFunction(()=>{const node=document.querySelector('video');return node&&node.currentTime>0;});
  const duration=await video.evaluate(node=>{const media=node as HTMLVideoElement;media.pause();return media.duration;});
  assert.ok(duration>=29.9&&duration<=30.1);
  await page.waitForFunction(()=>document.querySelector('video')?.textTracks[0]?.cues?.length===5);
  for(const second of [1,7,13,19,25]){
   await video.evaluate((node,position)=>new Promise<void>(resolve=>{
    const media=node as HTMLVideoElement;media.addEventListener('seeked',()=>resolve(),{once:true});media.currentTime=position;
   }),second);
   assert.ok(await video.evaluate(node=>((node as HTMLVideoElement).textTracks[0]?.activeCues?.length??0)>0));
   await video.evaluate(node=>node.scrollIntoView({block:'center'}));
   await video.screenshot({path:`${directory}/explainer-${second}s.png`});
  }
 });
 await check('keyboard playback pauses offscreen and remains paused on return under reduced motion',async()=>{
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  const video=page.locator('video.explainer-video');
  await video.evaluate(node=>node.scrollIntoView({block:'center'}));await video.focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&!v.paused&&v.currentTime>0;});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>document.querySelector('video')?.paused===true);
  const stopped=await video.evaluate(node=>(node as HTMLVideoElement).currentTime);
  await video.evaluate(node=>node.scrollIntoView({block:'center'}));
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,350)));
  assert.equal(await video.evaluate(node=>(node as HTMLVideoElement).paused),true);
  assert.equal(await video.evaluate(node=>(node as HTMLVideoElement).currentTime),stopped);
  assert.deepEqual(errors,[]);
 });
 await check('failed video transfer exposes an operable written alternative',async()=>{
  const failedContext=await browser.newContext({storageState,locale:'he-IL',timezoneId:'Asia/Jerusalem',reducedMotion:'reduce',viewport:{width:390,height:900}});
  try{
   await failedContext.route('**/media/tivdoc-explainer.mp4',r=>r.abort('failed'));
   const failedPage=await failedContext.newPage();const failedErrors:string[]=[];failedPage.on('pageerror',e=>failedErrors.push(e.message));
   await failedPage.goto(origin,{waitUntil:'domcontentloaded'});
   const video=failedPage.locator('video.explainer-video');await video.evaluate(node=>node.scrollIntoView({block:'center'}));
   await video.evaluate(node=>{void (node as HTMLVideoElement).play().catch(()=>{});});
   const message=failedPage.locator('.explainer-video-error');await message.waitFor();assert.ok((await message.innerText()).includes('לא נטען'));
   await message.getByRole('link').click();assert.equal(await failedPage.locator('#explainer-transcript').getAttribute('open'),'');
   assert.ok((await failedPage.locator('#explainer-transcript').innerText()).includes('אינו הבטחה'));
   await failedPage.screenshot({path:`${directory}/explainer-network-failure-390.png`,fullPage:false});assert.deepEqual(failedErrors,[]);
  }finally{await failedContext.close();}
 });
 await check('accessibility and legal pages have their own canonical URLs and sitemap entries',async()=>{
  const sitemap=await context!.request.get(origin+'/sitemap.xml');assert.equal(sitemap.status(),200);
  for(const path of ['/accessibility','/terms','/privacy']){
   await page.goto(origin+path,{waitUntil:'domcontentloaded'});
   const canonical=await page.locator('link[rel="canonical"]').getAttribute('href');assert.ok(canonical&&new URL(canonical).pathname===path);
   assert.ok((await sitemap.text()).includes(path));
  }
  await page.goto(origin+'/accessibility',{waitUntil:'domcontentloaded'});
  assert.ok((await page.locator('main').innerText()).includes('אינו אישור לעמידה מלאה בתקן'));
 });
 await check('keyboard can reach a visible homepage control',async()=>{
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.keyboard.press('Tab');
  const focused=await page.evaluate(()=>{const e=document.activeElement as HTMLElement|null;return e?{tag:e.tagName,rect:e.getBoundingClientRect().toJSON()}:null;});
  assert.ok(focused&&['A','BUTTON','INPUT'].includes(focused.tag));assert.ok(focused.rect.width>0);
 });
 await check('mobile menu supports keyboard activation, Escape and restored focus',async()=>{
  await page.setViewportSize({width:390,height:900});await page.goto(origin,{waitUntil:'domcontentloaded'});
  const toggle=page.locator('button[aria-controls="public-navigation"]');await toggle.focus();await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  await page.waitForFunction(()=>document.querySelector('#public-navigation a')===document.activeElement);
  await page.keyboard.press('Tab');assert.equal(await page.locator('#public-navigation a').nth(1).evaluate(n=>n===document.activeElement),true);
  await page.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.equal(await toggle.evaluate(e=>e===document.activeElement),true);
 });
 for(const width of [390,1440])await check(`studio dark theme remains usable at ${width}px`,async()=>{
  const dark=await browser.newContext({storageState,colorScheme:'dark',reducedMotion:'reduce',locale:'he-IL',viewport:{width,height:900}});
  try{
   const p=await dark.newPage();const darkErrors:string[]=[];p.on('pageerror',e=>darkErrors.push(e.message));
   await p.goto(origin,{waitUntil:'domcontentloaded'});
   assert.equal(await p.evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches),true);
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);
   assert.equal(await p.locator('.lens-artwork img').evaluate(n=>(n as HTMLImageElement).naturalWidth>0),true);
   assert.equal(await p.locator('.price-tiers tbody tr').count(),4);
   await p.screenshot({path:`${directory}/studio-dark-${width}.png`,fullPage:true});
   await p.locator('#pricing').scrollIntoViewIfNeeded();await p.screenshot({path:`${directory}/studio-dark-pricing-${width}.png`});
   assert.deepEqual(darkErrors,[]);
  }finally{await dark.close();}
 });
 await check('studio process and report tabs respond to the keyboard',async()=>{
  await page.setViewportSize({width:1440,height:900});await page.goto(origin,{waitUntil:'domcontentloaded'});
  const stages=page.locator('.process-tabs [role="tab"]');assert.equal(await stages.count(),4);
  for(let index=0;index<4;index++){
   await stages.nth(index).focus();await page.keyboard.press('Enter');
   assert.equal(await stages.nth(index).getAttribute('aria-selected'),'true');
   assert.equal(await page.locator('#process-illustration').getAttribute('data-phase'),String(index));
  }
  await stages.nth(3).press('Home');assert.equal(await stages.nth(0).getAttribute('aria-selected'),'true');
  for(const [key,index] of [['ArrowLeft',1],['ArrowRight',0],['End',3]] as const){
   await page.keyboard.press(key);assert.equal(await stages.nth(index).getAttribute('aria-selected'),'true');
   assert.equal(await stages.nth(index).evaluate(n=>n===document.activeElement),true);
   assert.equal(await page.locator('#process-panel').getAttribute('aria-labelledby'),'process-tab-'+index);
  }
  assert.equal(await page.getByRole('button',{name:'השלב הבא',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'השלב הקודם',exact:true}).click();
  assert.equal(await stages.nth(2).getAttribute('aria-selected'),'true');
  await page.locator('#report-tab-0').focus();await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#report-tab-1').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#report-tab-1').evaluate(n=>n===document.activeElement),true);
  assert.ok((await page.locator('#report-panel').innerText()).includes('בדיקת AI'));
  await page.keyboard.press('Home');assert.equal(await page.locator('#report-tab-0').getAttribute('aria-selected'),'true');
 });
 for(const width of [390,1440])await check(`process panel stays stable across all stages at ${width}px`,async()=>{
  await page.setViewportSize({width,height:900});await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>document.fonts.ready);const heights:number[]=[];
  for(let i=0;i<4;i++){
   await page.locator('#process-tab-'+i).click();
   heights.push(await page.locator('#how-it-works').evaluate(n=>n.getBoundingClientRect().height));
   assert.equal(await page.locator('.process-tabs [tabindex="0"]').count(),1);
  }
  assert.ok(Math.max(...heights)-Math.min(...heights)<=1,JSON.stringify(heights));
 });
 await check('mobile section navigation transfers focus and closes when focus leaves',async()=>{
  await page.setViewportSize({width:390,height:900});await page.goto(origin,{waitUntil:'domcontentloaded'});
  const toggle=page.locator('button[aria-controls="public-navigation"]');await toggle.click();
  await page.locator('#public-navigation a').first().click();
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#process-title').evaluate(n=>n===document.activeElement),true);
  assert.equal(await page.locator('#public-navigation a').first().getAttribute('aria-current'),'location');
  await toggle.click();await page.locator('#process-tab-0').focus();
  await page.waitForFunction(()=>document.querySelector('button[aria-controls="public-navigation"]')?.getAttribute('aria-expanded')==='false');
  assert.ok((await page.locator('.price-sheet .studio-button').getAttribute('href'))?.startsWith('mailto:'));
 });
 await check('all four process explanations remain visible without JavaScript',async()=>{
  const plain=await browser.newContext({storageState,javaScriptEnabled:false,viewport:{width:390,height:900}});
  try{const p=await plain.newPage();await p.goto(origin,{waitUntil:'domcontentloaded'});
   const steps=p.locator('.process-explorer noscript ol li');assert.equal(await steps.count(),4);
   for(let i=0;i<4;i++){assert.equal(await steps.nth(i).isVisible(),true);assert.ok((await steps.nth(i).innerText()).length>40);}
  }finally{await plain.close();}
 });
 await check('live reduced-motion preference cancels artwork and reveal animation',async()=>{
  const moving=await browser.newContext({storageState,reducedMotion:'no-preference',viewport:{width:1440,height:900}});
  try{
   const p=await moving.newPage();await p.goto(origin,{waitUntil:'domcontentloaded'});
   const art=p.locator('.lens-artwork');const rect=await art.boundingBox();assert.ok(rect);
   await p.mouse.move(rect.x+rect.width*0.75,rect.y+rect.height*0.4);
   assert.ok((await p.locator('.lens-artwork__object').getAttribute('style'))?.includes('perspective'));
   await p.emulateMedia({reducedMotion:'reduce'});
   await p.waitForFunction(()=>getComputedStyle(document.querySelector('.lens-artwork__object')!).transform==='none');
   await p.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'));
  }finally{await moving.close();}
 });
 await check('client navigation away from studio retains the legal page styling',async()=>{
  await page.goto(origin+'/privacy',{waitUntil:'domcontentloaded'});
  const before=await page.locator('main').evaluate(n=>({font:getComputedStyle(n).fontFamily,color:getComputedStyle(n).color,width:n.getBoundingClientRect().width}));
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.locator('.studio-principles a[href="/privacy"]').click();await page.waitForURL(origin+'/privacy');
  assert.equal(await page.locator('.studio-site').count(),0);
  const after=await page.locator('main').evaluate(n=>({font:getComputedStyle(n).fontFamily,color:getComputedStyle(n).color,width:n.getBoundingClientRect().width}));
  assert.deepEqual(after,before);
  await page.goBack();await page.locator('.studio-site #hero-title').waitFor();assert.deepEqual(errors,[]);
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
