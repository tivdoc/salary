import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument} from 'pdf-lib';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {devArtifactSha,renderDevFinancialArtifacts} from '../reports/dev-financial-artifacts';
import {parseDevFinancialRun} from './dev-financial-contract';
vi.mock('server-only',()=>({}));

const CASE='87eb4418-7d9f-4b68-aa86-82be059295ac';
const VERSION='2c9f4382-734a-42ba-9f17-ceb427acc836';
const HISTORICAL='0fd6c29d-cfb2-4349-80a7-c5383a25a056';
const APP_SHA='d85c2f7';
const SCHEMA='20260910044646';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
// node-postgres returns int8 as decimal text. Accept only exact nonnegative
// integers within JavaScript's safe range, without coercing null/blank/decimals.
const pgSafeInteger=z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),z.string().regex(/^(0|[1-9][0-9]*)$/u)])
 .transform(value=>typeof value==='string'?Number(value):value).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const read=(file:string):unknown=>JSON.parse(readFileSync(file,'utf8'));
const artifactRow=z.object({id:z.uuid(),input_revision:pgSafeInteger,input_sha256:sha,payload:z.unknown(),payload_sha256:sha,
 html:z.string(),pdf:z.instanceof(Buffer),html_sha256:sha,pdf_sha256:sha});
const customerRows=z.array(z.object({payload:z.unknown(),payload_sha256:sha,html:z.string(),html_sha256:sha,pdf_sha256:sha,
 pdf_base64:z.string().nullable(),current:z.boolean()}));

/** Existing current data only. This never invokes extraction, the coordinator,
 * notification delivery, answer APIs, or fixture provisioning. The only committed
 * write RPCs repeat the exact already-persisted run and must acknowledge replay. */
it.skipIf(process.env.TIVDOC_RETAINED_REPORT_INTEGRITY!=='1')('preserves the actual retained source-completed report through authenticated reads, exact concurrent replay and rejected tampering',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('RETAINED_INTEGRITY_DEV_ONLY');
 const directory=path.resolve(`output/release-completion/dev-financial-live-flow/${CASE}`);
 const controlPath=path.resolve('../release-work/retained-managed-control.private.json');
 const configPath=path.resolve('../release-work/live-provider-worker-private.json');
 const control=z.object({enabled:z.literal(true),gitSha:z.string(),expires:z.string(),caseId:z.literal(CASE),version:z.literal(VERSION),
  sid:z.string().min(1),jti:z.string().min(1),capabilitySha256:sha,identity:z.uuid()}).parse(read(controlPath));
 const config=z.object({TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:z.string().min(32),TIVDOC_MANAGED_DEV_BUILD_SHA:z.string(),
  NEXT_PUBLIC_SUPABASE_URL:z.literal('https://cpzrbidxftzqcfeqqusu.supabase.co'),SUPABASE_SERVICE_ROLE_KEY:z.string().min(1)}).parse(read(configPath));
 if(Date.parse(control.expires)<=Date.now())throw Error('RETAINED_INTEGRITY_MACHINE_EXPIRED');
 expect(devArtifactSha(config.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY)).toBe(control.capabilitySha256);
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();
 const gitSha=git('rev-parse','HEAD'),appSha=git('rev-parse',APP_SHA);
 expect(git('status','--porcelain')).toBe('');
 // A separately committed driver is allowed; application code must still be the
 // exact build used by the actual scheduler and Preview being checked by root.
 const appChanges=git('diff','--name-only',appSha,gitSha,'--','src','scripts/product-workers','supabase/migrations','package.json','package-lock.json','next.config.ts','vercel.json')
  .split(/\r?\n/u).filter(Boolean).filter(file=>!file.endsWith('.test.ts')&&!file.endsWith('.test.mts')&&!file.endsWith('.test.tsx'));
 expect(appChanges).toEqual([]);expect(git('rev-parse',control.gitSha)).toBe(appSha);expect(git('rev-parse',config.TIVDOC_MANAGED_DEV_BUILD_SHA)).toBe(appSha);
 const output=path.join(directory,'source-completions','integrity-'+randomUUID());mkdirSync(output,{recursive:true});
 const checks:string[]=[],evidence:Record<string,unknown>={caseId:CASE,driverGitSha:gitSha,applicationGitSha:appSha,expectedOrderedChainTail:SCHEMA,
  controlManifestSha256:devArtifactSha(readFileSync(controlPath)),applicationDiff:appChanges,sourceVersion:VERSION,
  existingLiveExtraction:true,sourceIsSynthetic:true,proofProviderCalls:0,seededAnswers:0,seededSessions:0,seededFindings:0,seededReports:0,
  canonicalLegalActivation:false,productionChanged:false,browserProofPerformedByThisDriver:false,visualReviewPerformedByThisDriver:false};
 let phase='connect',passed=false,failureCode:string|null=null;
 const save=()=>writeFileSync(path.join(output,'proof.json'),JSON.stringify({...evidence,phase,checks,verdict:passed?'PASS':'FAIL',failureCode,checkedAt:new Date().toISOString()},null,2)+'\n');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');
  expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';
  return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const clients=[owner,worker,peer,web];
 const transaction=async<T>(db:pg.Client,operation:()=>Promise<T>,rollback=false)=>{
  await db.query('begin');try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[control.sid,control.jti,'retained-report-integrity']);
   await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[appSha]);const result=await operation();await db.query(rollback?'rollback':'commit');return result;
  }catch(error){await db.query('rollback');throw error;}
 };
 const head=async()=>z.object({revision:pgSafeInteger,input_sha256:sha}).parse((await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[CASE])).rows[0]);
 const invocationSnapshot=async()=>(await owner.query(`select invocation_id,version_id,policy_version,source_revision,input_sha256,result_sha256,
  result is not null result_recorded from private.case_extraction_invocations where case_id=$1 order by invocation_id`,[CASE])).rows
  .map(row=>({...row,source_revision:pgSafeInteger.parse(row.source_revision)}));
 const pendingRequests=async()=>(await owner.query(`select r.id request_id,split_part(r.code,':',1) namespace,
  coalesce(f.target#>>'{candidate,field}',j.target#>>'{subject,field}',j.target#>>'{subject,kind}',t.target#>>'{subject,kind}') subject
  from public.case_requests r
  left join private.document_field_targets f on f.request_id=r.id and f.case_id=r.case_id
  left join private.june2026_collection_targets j on j.request_id=r.id and j.case_id=r.case_id
  left join private.document_transcription_targets t on t.request_id=r.id and t.case_id=r.case_id
  left join private.dev_financial_request_targets h on h.request_id=r.id and h.case_id=r.case_id
  where r.case_id=$1 and r.answered_at is null and r.expired_at is null and r.expires_at>clock_timestamp()
   and (f.request_id is not null and private.document_field_current(r.case_id,f.target)
    or j.request_id is not null and private.june2026_collection_current(r.case_id,j.target)
    or t.request_id is not null and private.document_transcription_current(r.case_id,t.target)
    or h.request_id is not null and private.dev_financial_source_current(r.case_id,h.order_id,h.version_id,h.source_sha256))
  order by r.id`,[CASE])).rows;
 const unchangedSnapshot=async()=>({head:await head(),runs:(await owner.query(`select id,input_revision,input_sha256,payload_sha256,html_sha256,pdf_sha256,
  encode(sha256(convert_to(html,'UTF8')),'hex') actual_html_sha256,encode(sha256(pdf),'hex') actual_pdf_sha256
  from private.dev_financial_runs where case_id=$1 order by id`,[CASE])).rows.map(row=>({...row,input_revision:pgSafeInteger.parse(row.input_revision)})),
  findings:(await owner.query('select id,run_id,finding from private.dev_financial_findings where case_id=$1 order by id',[CASE])).rows,
  invocations:await invocationSnapshot(),pendingRequests:await pendingRequests()});
 const customer=async(identity:string,runId:string|null=null)=>customerRows.parse((await web.query('select public.case_report_dev_financial($1,$2,$3) value',[CASE,identity,runId])).rows[0].value);
 try{
  await Promise.all(clients.map(db=>db.connect()));
  for(const [index,db] of clients.entries())expect((await db.query('select session_user principal,current_database() database')).rows[0])
   .toEqual({principal:['tivdoc_dev_migrator','tivdoc_worker_runtime','tivdoc_worker_runtime','tivdoc_web_runtime'][index],database:'tivdoc_release_replay_20260907'});
  phase='retained-source-and-current-run';
  // This isolated replay database has no migration ledger. Bind the ordered
  // repository chain to the actual critical function body and security metadata;
  // do not manufacture evidence that every earlier DDL statement was rechecked.
  const migrations=readdirSync('supabase/migrations').filter(name=>/^(?:\d{12}|\d{14})_.+\.sql$/u.test(name)).sort();
  expect(migrations).toHaveLength(135);expect(migrations.at(-1)).toBe(`${SCHEMA}_dev_financial_completion_target_binding.sql`);
  const migrationLedgers=(await owner.query("select schemaname,tablename from pg_catalog.pg_tables where tablename like '%migration%' order by schemaname,tablename")).rows;
  expect(migrationLedgers).toEqual([]);
  const migrationFile=path.join('supabase/migrations',migrations.at(-1)!);
  const migrationBytes=readFileSync(migrationFile),definitionMatch=migrationBytes.toString('utf8').match(/as \$\$([\s\S]*?)\$\$;/u);
  if(!definitionMatch)throw Error('RETAINED_SCHEMA_BODY_MISSING');
  const definitions=(await owner.query(`select p.prosrc,p.prosecdef,p.proconfig,p.provolatile,l.lanname
   from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
   where p.oid='private.dev_financial_completions_bound(jsonb,jsonb)'::regprocedure`)).rows;
  expect(definitions).toHaveLength(1);expect(definitions[0]).toMatchObject({prosrc:definitionMatch[1],prosecdef:true,provolatile:'s',lanname:'plpgsql'});
  expect(definitions[0].proconfig).toEqual(['search_path=""']);
  expect(devArtifactSha(definitions[0].prosrc)).toBe(devArtifactSha(definitionMatch[1]));
  evidence.schemaEvidence={label:'schema135_ordered_chain_reference_and_actual_critical_function_definition',migrationLedgerPresent:false,
   orderedChainCount:migrations.length,orderedChainTail:SCHEMA,orderedChainSha256:canonicalSha256(migrations.map(name=>({name,sha256:devArtifactSha(readFileSync(path.join('supabase/migrations',name)))}))),
   migrationFileSha256:devArtifactSha(migrationBytes),actualFunctionBodySha256:devArtifactSha(definitions[0].prosrc),
   expectedFunctionBodySha256:devArtifactSha(definitionMatch[1]),securityDefiner:true,searchPath:definitions[0].proconfig,allEarlierDefinitionsRechecked:false};
  const scope=(await owner.query(`select c.public_id,c.is_qa,c.first_name,c.contact_verified_at is not null verified,m.enabled,m.identity_id,
   m.session_sid,m.capability_sha256,b.enabled capability_enabled,b.expires_at>clock_timestamp() capability_unexpired
   from public.cases c join private.managed_dev_worker_cases m on m.case_id=c.id
   join private.managed_dev_worker_capabilities b on b.capability_sha256=m.capability_sha256
   join public.case_identity_cases i on i.case_id=c.id and i.identity_id=m.identity_id where c.id=$1`,[CASE])).rows;
  expect(scope).toHaveLength(1);expect(scope[0]).toMatchObject({public_id:'TV-73299C08',is_qa:true,first_name:'Synthetic DEV live financial flow',verified:true,
   enabled:true,identity_id:control.identity,session_sid:control.sid,capability_sha256:control.capabilitySha256,capability_enabled:true,capability_unexpired:true});
  const currentHead=await head();
  const selected=(await owner.query(`select r.* from private.dev_financial_runs r join private.case_input_heads h on h.case_id=r.case_id
   and h.revision=r.input_revision and h.input_sha256=r.input_sha256 where r.case_id=$1
   and r.payload->>'schema_version'='tivdoc-dev-financial-run-v2' and r.payload#>>'{calculation,state}'='calculated'`,[CASE])).rows;
  if(selected.length!==1)throw Error('RETAINED_CURRENT_FINANCIAL_V2_NOT_READY');
  const stored=artifactRow.parse(selected[0]),run=parseDevFinancialRun(stored.payload);
  if(run.schema_version!=='tivdoc-dev-financial-run-v2'||run.calculation.state!=='calculated')throw Error('RETAINED_FINANCIAL_V2_CALCULATED_REQUIRED');
  expect(run).toMatchObject({run_id:stored.id,case_id:CASE,input_revision:currentHead.revision,input_sha256:currentHead.input_sha256,
   authority:'engineering_only',month:'2026-06',extraction_provider:'openai_live',source:{version_id:VERSION,page:1,mime:'application/pdf'},
   extraction_provenance:{kind:'openai_live',providerAttempted:true,allPassesSucceeded:true},reading:{answer:'100',identity_id:control.identity}});
  const checkpoint=(await owner.query(`select c.result,c.result_sha256,d.id document_id,d.content_sha256,d.storage_path,d.size,d.mime_type
   from private.case_extraction_checkpoints c join public.documents d on d.case_id=c.case_id and d.version_id=c.version_id
   where c.case_id=$1 and c.revision=$2 and c.version_id=$3 and c.policy_version='saved-payslip-v21-p95-v1'`,[CASE,currentHead.revision,VERSION])).rows;
  expect(checkpoint).toHaveLength(1);expect({...checkpoint[0],size:pgSafeInteger.parse(checkpoint[0].size)}).toMatchObject({document_id:run.source.document_id,content_sha256:run.source.source_sha256,
   result_sha256:run.source.checkpoint_sha256,storage_path:run.source.path,size:run.source.size,mime_type:run.source.mime});
  expect(checkpoint[0].result).toEqual(read(path.join(directory,'missing-extraction.json')));
  expect(run.source_completions.checkpoint).toEqual(checkpoint[0].result);
  expect(canonicalSha256(run)).toBe(stored.payload_sha256);
  const before=await unchangedSnapshot();expect(before.invocations.length).toBeGreaterThan(0);
  expect(before.invocations.filter(row=>row.version_id===VERSION)).toHaveLength(1);
  expect(before.invocations.find(row=>row.version_id===VERSION)).toMatchObject({result_recorded:true,input_sha256:run.source.source_sha256,result_sha256:run.source.checkpoint_sha256});
  evidence.before=before;evidence.run={runId:run.run_id,parentRunId:run.parent_run_id,inputRevision:run.input_revision,inputSha256:run.input_sha256,
   payloadSha256:stored.payload_sha256,sourceSha256:run.source.source_sha256,checkpointSha256:run.source.checkpoint_sha256,completionSha256:run.source_completions.snapshot_sha256};save();
  checks.push('Existing current calculated v2 run binds the retained QA case, paid-source admission, exact current checkpoint and authentic saved live-provider invocation.');

  phase='independent-oracle-and-source-bytes';
  // Literal oracle predates the resumed run. No result returned by the engine is
  // reused as its own expected answer: 100 * 35.40 - 3300 = 240.00 ILS.
  const oracle={hours:100,hourlyFloorMinor:3540,recordedMinor:330000,expectedMinor:354000,gapMinor:24000};
  expect(oracle.hours*oracle.hourlyFloorMinor).toBe(oracle.expectedMinor);expect(oracle.expectedMinor-oracle.recordedMinor).toBe(oracle.gapMinor);
  expect(read(path.join(directory,'independent-oracle.json'))).toMatchObject({regularHours:'100',baseMinor:oracle.recordedMinor,expectedMinor:oracle.expectedMinor,gapMinor:oracle.gapMinor,sourceIsSynthetic:true,humanLegalApproval:false});
  expect(run.calculation).toMatchObject({expectedMinor:oracle.expectedMinor,recordedMinor:oracle.recordedMinor,gapMinor:oracle.gapMinor});
  expect(run.finding).toMatchObject({analysis_run_id:run.run_id,expected_minor:oracle.expectedMinor,recorded_minor:oracle.recordedMinor,gap_minor:oracle.gapMinor});
  const localSource=readFileSync(path.join(directory,'synthetic-live-table-june-2026-missing-hours.pdf'));
  expect(devArtifactSha(localSource)).toBe(run.source.source_sha256);
  const storage=createClient(config.NEXT_PUBLIC_SUPABASE_URL,config.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const download=await storage.storage.from('salary-documents').download(run.source.path);
  if(download.error||!download.data)throw Error('RETAINED_SOURCE_STORAGE_READ');
  const sourceBytes=Buffer.from(await download.data.arrayBuffer());expect(sourceBytes.equals(localSource)).toBe(true);
  expect(sourceBytes.length).toBe(run.source.size);expect(devArtifactSha(sourceBytes)).toBe(run.source.source_sha256);
  writeFileSync(path.join(output,'source.pdf'),sourceBytes);evidence.independentOracle=oracle;
  const answers=[...run.source_completions.readings,run.source_completions.component_nature,run.reading!];
  for(const answer of answers){const actual=(await owner.query('select revision,identity_id,answer_text,created_at from private.case_request_answer_versions where request_id=$1 and revision=$2',[answer.request_id,answer.answer_revision])).rows;
   expect(actual).toHaveLength(1);expect({...actual[0],revision:pgSafeInteger.parse(actual[0].revision)}).toMatchObject({revision:answer.answer_revision,identity_id:answer.identity_id,answer_text:answer.answer});
   expect(new Date(actual[0].created_at).toISOString()).toBe(new Date(answer.answered_at).toISOString());}
  evidence.answerPins=answers.map(a=>({requestId:a.request_id,revision:a.answer_revision,answeredAt:a.answered_at}));
  checks.push('Independent 100-hour oracle yields expected 354000, recorded 330000 and gap 24000 minor units; downloaded immutable Storage bytes and four actual identified answer revisions match the saved run.');

  phase='exact-artifact-render-and-history';
  const rendered=renderDevFinancialArtifacts(run);expect(rendered.html).toBe(stored.html);expect(Buffer.from(rendered.pdf).equals(stored.pdf)).toBe(true);
  expect(devArtifactSha(stored.html)).toBe(stored.html_sha256);expect(devArtifactSha(stored.pdf)).toBe(stored.pdf_sha256);
  expect(rendered.htmlSha256).toBe(stored.html_sha256);expect(rendered.pdfSha256).toBe(stored.pdf_sha256);
  writeFileSync(path.join(output,'calculated.json'),JSON.stringify(run,null,2)+'\n');writeFileSync(path.join(output,'calculated.html'),stored.html);
  const pdfPath=path.join(output,'calculated.pdf');writeFileSync(pdfPath,stored.pdf);
  const pdf=await PDFDocument.load(stored.pdf);expect(pdf.getSubject()).toBe(run.run_id);
  // Render the actual persisted bytes for the separate visual review; rendering
  // is evidence generation, not a claim that this driver visually inspected it.
  // Relative native-tool paths avoid Windows MAX_PATH in the evidence directory.
  execFileSync(process.env.TIVDOC_PDFTOPPM??'pdftoppm',['-png','-r','108','calculated.pdf','calculated-page'],{cwd:output,timeout:30000});
  const pages=readdirSync(output).filter(name=>/^calculated-page-\d+\.png$/u.test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const python=process.env.TIVDOC_PDF_PYTHON??'python';
  const extractedText=execFileSync(python,['-c',
   "import sys,pdfplumber\nwith pdfplumber.open(sys.argv[1]) as p: text='\\n'.join(x.extract_text() or '' for x in p.pages)\nsys.stdout.buffer.write(text.encode('utf-8'))",
   pdfPath],{encoding:'utf8',timeout:30000});
  expect(pages.length).toBe(pdf.getPageCount());const pdfText=extractedText.replace(/[\u200e-\u202e\u2066-\u2069]/gu,'');
  writeFileSync(path.join(output,'calculated.txt'),pdfText);
  for(const value of [run.run_id,run.source.version_id,'3540.00','3300.00','240.00']){expect(stored.html).toContain(value);expect(pdfText.replace(/\s/gu,'')).toContain(value);}
  expect(stored.html).toContain('ניסוי הנדסי');expect(stored.html).toContain('אינם פעילים בשירות');
  for(const answer of answers.slice(0,3)){expect(stored.html).toContain(answer.request_id);expect(pdfText.replace(/\s/gu,'')).toContain(answer.request_id);}
  const old=artifactRow.parse((await owner.query('select * from private.dev_financial_runs where case_id=$1 and id=$2',[CASE,HISTORICAL])).rows[0]);
  expect(old.payload).toEqual(read(path.join(directory,'initial-calculated.json')));expect(old.html).toBe(readFileSync(path.join(directory,'initial-calculated.html'),'utf8'));
  expect(old.pdf.equals(readFileSync(path.join(directory,'initial-calculated.pdf')))).toBe(true);
  expect(old.payload_sha256).toBe(canonicalSha256(old.payload));expect(old.html_sha256).toBe(devArtifactSha(old.html));expect(old.pdf_sha256).toBe(devArtifactSha(old.pdf));
  expect(parseDevFinancialRun(old.payload).schema_version).toBe('tivdoc-dev-financial-run-v1');
  evidence.artifacts={htmlSha256:stored.html_sha256,pdfSha256:stored.pdf_sha256,pages:pages.map(name=>({name,sha256:devArtifactSha(readFileSync(path.join(output,name)))})),
   historicalRunId:HISTORICAL,historicalPayloadSha256:old.payload_sha256,historicalHtmlSha256:old.html_sha256,historicalPdfSha256:old.pdf_sha256};
  checks.push('Stored v2 HTML/PDF exactly match deterministic rendering, the same run/version and all three amounts; actual PDF bytes were rasterized. Historical v1 payload, HTML and PDF remain byte-identical to the retained original artifacts.');

  phase='customer-and-foreign-boundaries';
  const list=await customer(control.identity);expect(list.filter(row=>row.current).map(row=>parseDevFinancialRun(row.payload).run_id)).toEqual([run.run_id]);
  expect(list.find(row=>parseDevFinancialRun(row.payload).run_id===HISTORICAL)?.current).toBe(false);
  const detail=await customer(control.identity,run.run_id);expect(detail).toHaveLength(1);expect(detail[0].current).toBe(true);
  expect(detail[0].payload).toEqual(run);expect(detail[0].html).toBe(stored.html);expect(Buffer.from(detail[0].pdf_base64!,'base64').equals(stored.pdf)).toBe(true);
  const foreign=randomUUID();expect(pgSafeInteger.parse((await owner.query('select count(*)::int n from public.case_identity_cases where case_id=$1 and identity_id=$2',[CASE,foreign])).rows[0].n)).toBe(0);
  await expect(customer(foreign,run.run_id)).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');await expect(customer(foreign,HISTORICAL)).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');
  for(const reading of run.source_completions.readings){const source=(await web.query('select public.case_request_document_source($1,$2,$3) value',[CASE,control.identity,reading.request_id])).rows[0].value;
   expect(source).toMatchObject({version:VERSION,sha256:run.source.source_sha256,path:run.source.path,page:1});
   await expect(web.query('select public.case_request_document_source($1,$2,$3)',[CASE,foreign,reading.request_id])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');}
  checks.push('Actual web-role RPC exposes exactly one current v2 report and old v1 history; an unlinked random identity cannot read either report or either transcription source.');

  phase='identical-parallel-replay';
  const replay=(db:pg.Client,body:unknown=run,html=stored.html)=>transaction(db,async()=>
   (await db.query('select private.dev_financial_save($1::jsonb,$2,$3,$4) value',[JSON.stringify(body),canonicalSha256(body),html,stored.pdf.toString('base64')])).rows[0].value);
  expect(await replay(worker)).toEqual({run_id:run.run_id,replayed:true});
  const parallel=await Promise.all([replay(worker),replay(peer)]);expect(parallel).toEqual([{run_id:run.run_id,replayed:true},{run_id:run.run_id,replayed:true}]);
  expect(await unchangedSnapshot()).toEqual(before);evidence.replays={sequential:1,parallel:2,allReplayed:true};
  checks.push('One identical replay and two concurrent calls with the existing scoped machine return replayed=true without adding reports/findings, changing bytes, advancing input or invoking a provider.');

  phase='tampered-completion-rollback';
  const reject=async(body:unknown,html:string,code:string)=>{
   await expect(transaction(worker,async()=>worker.query('select private.dev_financial_save($1::jsonb,$2,$3,$4)',
    [JSON.stringify(body),canonicalSha256(body),html,stored.pdf.toString('base64')]),true)).rejects.toThrow(code);
   expect(await unchangedSnapshot()).toEqual(before);
  };
  // Recompute all submitted hashes so these negatives exercise authenticated
  // journal/target binding, rather than merely a stale checksum supplied by us.
  const changedTarget=structuredClone(stored.payload) as Record<string,unknown>;
  const targetCompletions=structuredClone(run.source_completions);
  const amountIndex=targetCompletions.readings.findIndex(r=>r.target.subject.kind==='component_amount');
  const targetBody={...targetCompletions.readings[amountIndex].target,source_sha256:'b'.repeat(64)};
  const {target_sha256:discardedTargetHash,...newTargetBody}=targetBody;void discardedTargetHash;
  const targetReadings=targetCompletions.readings.map((r,index)=>index===amountIndex?{...r,target:{...newTargetBody,target_sha256:canonicalSha256(newTargetBody)}}:r);
  const {snapshot_sha256:discardedSnapshotHash,...completionBody}=targetCompletions;void discardedSnapshotHash;
  const badTargetBody={...completionBody,readings:targetReadings};
  changedTarget.source_completions={...badTargetBody,snapshot_sha256:canonicalSha256(badTargetBody)};
  await reject(changedTarget,stored.html,'DEV_FINANCIAL_COMPLETIONS_BINDING');
  const badRevisionBody={...completionBody,readings:completionBody.readings.map((r,index)=>index===0?{...r,answer_revision:r.answer_revision+1}:r)};
  await reject({...run,source_completions:{...badRevisionBody,snapshot_sha256:canonicalSha256(badRevisionBody)}},stored.html,'DEV_FINANCIAL_COMPLETIONS_BINDING');
  await reject(run,stored.html+'<!-- changed report -->','DEV_FINANCIAL_REPLAY_CONFLICT');
  checks.push('Altered completion source target and answer revision with recomputed hashes are refused by actual journal binding; changed HTML is refused as replay conflict. Each negative rolls back and preserves all stored bytes.');

  phase='final-invocations-and-status';
  const after=await unchangedSnapshot();expect(after).toEqual(before);evidence.after=after;
  const status=(await worker.query('select case_id,state,last_error,current_run_id from private.managed_dev_worker_status($1)',[config.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY])).rows;
  const currentStatus=status.filter(row=>row.case_id===CASE);expect(currentStatus).toHaveLength(1);expect(currentStatus[0]).toMatchObject({state:'awaiting_input',current_run_id:run.run_id});
  const remaining=after.pendingRequests,fieldRequests=remaining.filter(row=>row.namespace==='document_field'),legalRequests=remaining.filter(row=>row.namespace==='minimum_wage_june2026');
  expect(fieldRequests.map(row=>row.subject)).toEqual(expect.arrayContaining(['net_salary','hourly_rate']));expect(legalRequests.length).toBeGreaterThan(0);
  expect(remaining.filter(row=>row.namespace==='document_transcription'||row.namespace==='dev_financial_hours')).toEqual([]);
  evidence.workerStatus=currentStatus[0];evidence.remainingRequests={currentTotal:remaining.length,documentFieldCount:fieldRequests.length,
   juneCollectionCount:legalRequests.length,requests:remaining,engineeringReportCurrent:true,caseComplete:false,canonicalReady:false,
   distinction:'The current engineering report is calculated, while P06 reading confirmations and June applicability questions remain unanswered. No customer legal answers were invented.'};
  evidence.providerInvocationCounts={before:before.invocations.length,after:after.invocations.length,unchanged:true};
  checks.push('Managed status remains awaiting_input with the same current calculated engineering run: net/hourly reading confirmations and June questions remain open. Durable provider invocation IDs, source versions, hashes and count are unchanged; this does not prove case completion or canonical readiness.');
  passed=true;phase='complete';
 }catch(error){failureCode=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'RETAINED_INTEGRITY_ASSERTION_OR_ENVIRONMENT_FAILURE';throw error;}
 finally{await Promise.allSettled(clients.map(async db=>{try{await db.query('rollback');}finally{await db.end();}}));save();}
},180000);
