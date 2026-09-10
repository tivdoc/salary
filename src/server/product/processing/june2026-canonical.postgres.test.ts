import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument} from 'pdf-lib';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {june2026CollectionTargetSchema,JUNE2026_COMPONENT_DECLARATIONS,JUNE2026_DECLARATION_OPTIONS,JUNE2026_UNKNOWN_ANSWER,JUNE2026_CONFLICTED_ANSWER} from '@/engine/minimum-wage-june2026/collection';
import {june2026TestAssessmentSchema} from '@/engine/minimum-wage-june2026/evidence-admission';
import type {June2026AssessmentPacket} from '@/engine/minimum-wage-june2026/assessment-packet';
import {createJune2026MinimumWageCandidate} from '@/engine/minimum-wage-june2026/candidate';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from '@/engine/minimum-wage-june2026/sources';
import {sourceMonetaryComparisonSchema} from '@/engine/findings/source-comparison';
import {documentUploadSchema,matchesDocumentSignature} from '@/lib/document-upload';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from '../orders/contracts';
import type {UploadBatch,ReservedFile} from '../documents/upload';
import {documentFieldTargetSchema,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {claimSavedDraftJob} from './saved-job-runtime';
import {runSavedWorkerExtraction,type SavedWorkerTransactions} from './saved-extraction-worker';
import {runSavedWorkerMonth} from './saved-worker';
import type {SourceJob} from './source-dispatch';
import {devFinancialInputFixture,fixtureSha} from './dev-financial-flow.fixture';
import {june2026NoGapFixture} from './june2026-canonical.fixture';
vi.mock('server-only',()=>({}));

const APPROVED_OWNER='dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a';
// Independent integer/rational oracle, not imported from the rule or renderer:
// 644385 minor units * 100 / 182 = 354057.692307...; half-up =>354058.
// 354058 -330000 =24058. Published 35.40*100 instead gives24000.
const ORACLE={month:'2026-06',hours:'100',rateMinor:3300,monthlyMinor:644385,divisor:182,expectedMinor:354058,recordedMinor:330000,gapMinor:24058,
 publishedHourlyGapMinor:24000,rounding:'half_up_only_at_final_minor_unit',humanApproval:false} as const;
type Completed=Awaited<ReturnType<typeof runSavedWorkerMonth>>;
const checkpointSchema=z.object({result_sha256:z.string(),version_id:z.uuid(),input_sha256:z.string(),run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()}).passthrough();

/** Provisioned engineering assumptions are explicit, short-lived DEV records.
 * No findings, reports, extraction checkpoints, customer sessions or answers
 * are inserted as fixtures. The normal saved worker creates every artifact. */
it.skipIf(process.env.TIVDOC_JUNE_CANONICAL_DB_PROOF!=='1')('executes a current uploaded June source through the ordinary saved canonical stages with isolated test authority',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('JUNE_CANONICAL_PROOF_BOUNDARY');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 expect(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()).toBe('');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');let restarted:pg.Client|undefined;
 const storageConfig=z.object({NEXT_PUBLIC_SUPABASE_URL:z.literal('https://cpzrbidxftzqcfeqqusu.supabase.co'),SUPABASE_SERVICE_ROLE_KEY:z.string().min(1)})
  .parse(JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8')));
 const remote=createClient(storageConfig.NEXT_PUBLIC_SUPABASE_URL,storageConfig.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),bucket=remote.storage.from('salary-documents');
 const caseId=randomUUID(),foreignCaseId=randomUUID(),orderId=randomUUID(),sid='june-canonical:'+randomUUID(),jti=randomUUID(),tenant='saved-case:'+caseId;
 const directory='output/release-completion/june-canonical/'+caseId.slice(0,8),privateFile='../release-work/june-canonical-'+caseId+'.private.json';mkdirSync(directory,{recursive:true});
 const originalInput=await devFinancialInputFixture(false),noGapInput=await june2026NoGapFixture();
 // Literal transcription of the same synthetic page as one paid hourly row;
 // mapping, normalization, confidences and canonical facts remain untouched.
 const positiveInput={...originalInput,output:{...originalInput.output,payroll_rows:[{...originalInput.output.payroll_rows[0],
  semantic_kind:'hourly_base' as const,quantity_raw:'100',rate_raw:'33.00',amount_raw:'3300.00'}]}};
 let input:Awaited<ReturnType<typeof devFinancialInputFixture>>=positiveInput;
 const noGapOracle={...ORACLE,hours:'182',rateMinor:null,expectedMinor:644385,recordedMinor:644385,gapMinor:0};
 let oracle:{hours:string;rateMinor:number|null;expectedMinor:number;recordedMinor:number;gapMinor:number}=ORACLE;
 writeFileSync(directory+'/input.pdf',input.bytes);writeFileSync(directory+'/independent-oracle.json',JSON.stringify(ORACLE,null,2)+'\n');
 writeFileSync(directory+'/no-gap-input.pdf',noGapInput.bytes);writeFileSync(directory+'/no-gap-independent-oracle.json',JSON.stringify(noGapOracle,null,2)+'\n');
 const paths:string[]=[],sourceHashesByPath:Record<string,string>={},jobIds:string[]=[],providerCalls:{sourceSha256:string;responseId:string}[]=[],checks:string[]=[],runs:Record<string,unknown>[]=[],assessments:Record<string,unknown>[]=[],confirmationReceipts:unknown[]=[];
 const migrationName='20260910145013_june2026_customer_canonical_case_binding.sql',migrationBytes=readFileSync('supabase/migrations/'+migrationName),definitionChecks:Record<string,unknown>[]=[];
 let phase='connect',failure:string|null=null,cleanupFailure:string|null=null,seeded=false,machineRevoked=false,foreignCleaned=false,foreignIdentity='',publicId='',activeTransactions=0,failBeforeSave=false,tamperBeforeSave=false,newConnectionReplayVerified=false;
 const own=()=>writeFileSync(privateFile,JSON.stringify({caseId,foreignCaseId,orderId,ownerIdentity:APPROVED_OWNER,foreignIdentity,publicId,sid,jti,paths,jobIds,gitSha,
  scope:'Owned synthetic isolated DEV case; no customer session. Preserve primary case and report artifacts; revoke only this worker and cancel only listed jobs.'},null,2)+'\n');own();
 const transactions=(db:pg.Client):SavedWorkerTransactions=>async operation=>{
  await db.query('begin');activeTransactions++;
  try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'june-canonical-proof']);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){if(s.name==='june_canonical_test_save'&&failBeforeSave)throw Error('INJECTED_BEFORE_CANONICAL_TEST_SAVE');
    const values=[...s.values];if(s.name==='june_canonical_test_save'&&tamperBeforeSave){const changed=JSON.parse(String(values[5]));changed.signed_difference.minor_units=24000;values[5]=JSON.stringify(changed);}
    const r=await db.query(s.text,values);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
   const result=await operation(context);await db.query('commit');return result;
  }catch(error){await db.query('rollback');throw error;}finally{activeTransactions--;}
 };
 const head=async():Promise<SourceJob>=>{const h=(await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[caseId])).rows[0];return {schema_version:'saved-case-work-v1',case_id:caseId,revision:z.coerce.number().int().positive().parse(h.revision),input_sha256:h.input_sha256,mode:'draft'};};
 const storage={async download(path:string){expect(paths).toContain(path);expect(activeTransactions).toBe(0);const result=await bucket.download(path);if(result.error||!result.data)throw Error('JUNE_CANONICAL_STORAGE_READ');expect(fixtureSha(Buffer.from(await result.data.arrayBuffer()))).toBe(sourceHashesByPath[path]);return {data:result.data,error:null};}};
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-never-network',model:'synthetic-june-canonical-injected',timeoutMs:1000},{transport:{async parse(request){
  expect(activeTransactions).toBe(0);expect(providerCalls.length).toBeLessThan(6);const file=request.input[0].content.find(p=>p.type==='input_file');if(!file||!('file_data'in file))throw Error('JUNE_CANONICAL_PROVIDER_INPUT');
  const sourceSha256=fixtureSha(Buffer.from(file.file_data.split(',')[1],'base64'));expect(sourceSha256).toBe(input.sha256);const responseId='synthetic-june-canonical-'+randomUUID();providerCalls.push({sourceSha256,responseId});
  return {id:responseId,status:'completed',outputParsed:structuredClone(input.output),usage:null};
 }},log:()=>{}});
 const upload=async(replace?:ReservedFile)=>{
  const manifest=documentUploadSchema.parse({caseId,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:input.name,type:'application/pdf',size:input.bytes.length,sha256:input.sha256,periodMonth:'2026-06',...(replace?{replace:{documentId:replace.documentId,versionId:replace.versionId}}:{})}]});
  const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[caseId,manifest.batchId,manifest])).rows[0].value as UploadBatch;expect(batch.files).toHaveLength(1);const file=batch.files[0];
  expect(file.path).toBe(`cases/${caseId}/versions/${file.versionId}.pdf`);paths.push(file.path);sourceHashesByPath[file.path]=input.sha256;own();
  const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});if(signed.error||!signed.data)throw Error('JUNE_CANONICAL_STORAGE_SIGN');
  const uploaded=await bucket.uploadToSignedUrl(file.path,signed.data.token,input.bytes,{contentType:'application/pdf'});if(uploaded.error)throw Error('JUNE_CANONICAL_STORAGE_TRANSFER');
  const stored=await storage.download(file.path),bytes=new Uint8Array(await stored.data.arrayBuffer());expect(bytes.length).toBe(input.bytes.length);expect(matchesDocumentSignature(bytes,'application/pdf')).toBe(true);expect(stored.data.type.split(';')[0]).toBe('application/pdf');
  await web.query('select public.case_documents_commit($1,$2,$3)',[caseId,manifest.batchId,{[file.versionId]:input.sha256}]);
  expect((await owner.query('select version_id,content_sha256 from public.documents where id=$1 and case_id=$2',[file.documentId,caseId])).rows[0]).toEqual({version_id:file.versionId,content_sha256:input.sha256});return file;
 };
 const claim=async()=>transactions(worker)(async context=>{const lease=await claimSavedDraftJob(context,{caseId,workerId:'june-canonical-proof',leaseMs:300000});if(lease.state!=='claimed')throw Error('JUNE_CANONICAL_EXPECTED_CLAIM');
  const job=(await worker.query('select payload from public.engine_durable_jobs where job_id=$1',[lease.jobId])).rows[0].payload as SourceJob;jobIds.push(lease.jobId);own();return {job,jobId:lease.jobId,workerId:'june-canonical-proof',fencingToken:lease.fencingToken};});
 const extract=(lease:Awaited<ReturnType<typeof claim>>,file:ReservedFile)=>runSavedWorkerExtraction({...lease,versionId:file.versionId,transactions:transactions(worker),storage,extractor,providerEnabled:true});
 const calculate=(job:SourceJob,db=worker)=>transactions(db)(context=>runSavedWorkerMonth({context,job,orderId,month:'2026-06'}));
 const counts=async()=>(await owner.query(`select
  (select count(*)::int from public.analysis_runs where tenant_id=$1) analyses,
  (select count(*)::int from private.june2026_canonical_test_results where case_id=$2) results,
  (select count(*)::int from private.case_extraction_invocations where case_id=$2) invocations`,[tenant,caseId])).rows[0];
 const customer=async(runId:string,identity=APPROVED_OWNER)=>(await web.query('select public.case_report_june_canonical_test($1,$2,$3) value',[caseId,identity,runId])).rows[0].value;
 const confirm=async(file:ReservedFile,checkpoint:unknown)=>{
  const saved=checkpointSchema.parse(checkpoint),expected:Record<string,unknown>={salary_type:'hourly',salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},
   base_monthly_salary:{currency:'ILS',minor_units:oracle.recordedMinor},gross_salary:{currency:'ILS',minor_units:oracle.recordedMinor},net_salary:{currency:'ILS',minor_units:oracle.recordedMinor},regular_hours:{amount:oracle.hours,unit:'hours_per_month'},
   ...(oracle.rateMinor===null?{}:{hourly_rate:{currency:'ILS',minor_units:oracle.rateMinor}})};
  expect(saved.run.result.final_extraction.additional_components).toHaveLength(1);expect(saved.run.result.final_extraction.additional_components[0].amount).toEqual(expected.base_monthly_salary);
  const fields=(await owner.query("select t.request_id,t.target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id where t.case_id=$1 and t.target->>'version_id'=$2 and r.answered_at is null",[caseId,file.versionId])).rows;
  const observed=fields.map(row=>{const target=documentFieldTargetSchema.parse(row.target);expect(target.case_id).toBe(caseId);expect(target.version_id).toBe(file.versionId);expect(target.source_sha256).toBe(input.sha256);expect(target.extraction_result_sha256).toBe(saved.result_sha256);expect(Object.hasOwn(expected,target.candidate.field)).toBe(true);expect(target.candidate.normalized_value).toEqual(expected[target.candidate.field]);return target.candidate.field;});
  expect(observed.sort()).toEqual(Object.keys(expected).sort());
  const june=(await owner.query("select t.request_id,t.target from private.june2026_collection_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id where t.case_id=$1 and t.target->>'version_id'=$2 and r.answered_at is null",[caseId,file.versionId])).rows;
  expect(june).toHaveLength(8);const kinds:string[]=[],answers:{requestId:string;answer:string;targetSha256:string}[]=[];
  for(const row of june){const target=june2026CollectionTargetSchema.parse(row.target);expect(target.case_id).toBe(caseId);expect(target.version_id).toBe(file.versionId);expect(target.source_sha256).toBe(input.sha256);expect(target.extraction_result_sha256).toBe(saved.result_sha256);
   const subject=target.subject;let answer:string;
   if(subject.kind==='component'){expect(subject.component.component_id).toBe(saved.run.result.final_extraction.additional_components[0].component_id);expect(subject.component.amount).toEqual(expected.base_monthly_salary);answer=JUNE2026_COMPONENT_DECLARATIONS.base_salary;kinds.push('component');}
   else if(subject.kind==='earnings_completeness'){answer=JUNE2026_DECLARATION_OPTIONS[0];kinds.push('earnings_completeness');}
   else{const literal:Record<typeof subject.field,string>={age_18_entire_month:JUNE2026_DECLARATION_OPTIONS[0],sector:'Synthetic office supplies shop; no sector or collective agreement is claimed.',
    hours_rest_law_applies:'Synthetic adult hourly clerk with recorded hours, direct supervision and no managerial authority.',no_better_minimum_wage_arrangement:JUNE2026_DECLARATION_OPTIONS[1],no_adapted_minimum_wage:JUNE2026_DECLARATION_OPTIONS[1],regular_hours_exclude_absence_overtime_rest:JUNE2026_DECLARATION_OPTIONS[0]};answer=literal[subject.field];kinds.push(subject.field);}
   answers.push({requestId:row.request_id,answer,targetSha256:target.target_sha256});
  }
  expect(new Set(kinds).size).toBe(8);
  await expect(web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[fields[0].request_id,caseId,foreignIdentity,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  // Genuine identified request APIs, automated known-fixture readings only.
  // These declarations are not professional assessments or human approval.
  await web.query('begin');try{for(const row of fields)await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[row.request_id,caseId,APPROVED_OWNER,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);
   for(const row of answers)await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[row.requestId,caseId,APPROVED_OWNER,row.answer]);await web.query('commit');
  }catch(error){await web.query('rollback');throw error;}
  const current=await head();for(const row of answers)await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[row.requestId,caseId,APPROVED_OWNER,row.answer]);expect(await head()).toEqual(current);
  const revisions=(await owner.query('select request_id,count(*)::int n from private.case_request_answer_versions where request_id=any($1::uuid[]) group by request_id',[answers.map(a=>a.requestId)])).rows;expect(revisions).toHaveLength(8);expect(revisions.every(r=>r.n===1)).toBe(true);
  const before=providerCalls.length,lease=await claim(),reused=await extract(lease,file);expect(reused.reused).toBe(true);expect(canonicalSha256(reused.result)).toBe(canonicalSha256(checkpoint));expect(providerCalls).toHaveLength(before);
  confirmationReceipts.push({versionId:file.versionId,checkpointSha256:saved.result_sha256,fields:observed,juneTargets:answers.map(a=>({requestId:a.requestId,targetSha256:a.targetSha256})),identity:APPROVED_OWNER,actor:'automated_synthetic_fixture_actions',humanApproval:false,checkpointReused:true});
  return {lease,ageRequest:june.find(r=>r.target.subject.kind==='applicability'&&r.target.subject.field==='age_18_entire_month').request_id as string};
 };
 const exportRun=async(label:string,run:Completed,file:ReservedFile)=>{
  expect(run.completed).toBe(true);expect(run.report).not.toBeNull();expect(run.bundle?.analysis_run_id).toBe(run.analysis_run_id);
  const report=run.report!,bundle=run.bundle!;for(const [ext,bytes]of Object.entries({json:report.json,html:report.html,pdf:report.pdf,manifest:report.manifest}))writeFileSync(`${directory}/${label}.${ext}`,bytes);
  const data=JSON.parse(Buffer.from(report.json).toString('utf8'));expect(data.human_approval).toBe(false);expect(data.legal_activation).toBe(false);expect(canonicalSha256(data.bundle)).toBe(canonicalSha256(bundle));
  const comparison=sourceMonetaryComparisonSchema.parse(data.comparison);expect(comparison).toMatchObject({schema_version:'tivdoc-source-monetary-comparison-v2',is_finding:false,expected:{currency:'ILS',minor_units:oracle.expectedMinor},recorded:{currency:'ILS',minor_units:oracle.recordedMinor},signed_difference:{currency:'ILS',minor_units:oracle.gapMinor}});
  expect(comparison.trace.analysis_run_id).toBe(run.analysis_run_id);expect(bundle.topic_results[0].amount).toEqual({currency:'ILS',minor_units:oracle.gapMinor});expect(canonicalSha256(bundle.topic_results[0].trace)).toBe(canonicalSha256(comparison.trace));
  expect(data.admission).toMatchObject({authority:'isolated_dev_test_assumptions',human_approval:false,legal_activation:false,customer_publication_allowed:false,execution_allowed:true});
  const amounts=[oracle.expectedMinor,oracle.recordedMinor,oracle.gapMinor].map(n=>(n/100).toFixed(2));
  const html=Buffer.from(report.html).toString('utf8');for(const text of [run.analysis_run_id,file.versionId,input.sha256,...amounts])expect(html).toContain(text);
  expect((await PDFDocument.load(report.pdf)).getSubject()).toBe('Canonical run '+run.analysis_run_id);
  const pdfText=execFileSync(z.string().min(1).parse(process.env.TIVDOC_PDF_PYTHON),['-c',
   "import sys,pdfplumber; p=pdfplumber.open(sys.argv[1]); sys.stdout.buffer.write(('\\n'.join(page.extract_text() or '' for page in p.pages)).encode('utf-8')); p.close()",
   `${directory}/${label}.pdf`],{encoding:'utf8'}).replace(/[\u200e-\u202e\u2066-\u2069]/gu,'');
  writeFileSync(`${directory}/${label}.txt`,pdfText);for(const text of [run.analysis_run_id,...amounts])expect(pdfText).toContain(text);
  const row=await customer(run.analysis_run_id);expect(row.current).toBe(true);expect(canonicalSha256(row.comparison)).toBe(canonicalSha256(comparison));
  const savedBundle=decodeBundle(row.completion.bundle,['minimum_wage']),savedReport=decodeReport(row.completion.report);expect(canonicalSha256(savedBundle)).toBe(canonicalSha256(bundle));
  expect(fixtureSha(savedReport.pdf)).toBe(report.pdf_sha256);expect(fixtureSha(savedReport.html)).toBe(report.html_sha256);expect(fixtureSha(savedReport.json)).toBe(report.json_sha256);
  runs.push({label,runId:run.analysis_run_id,caseRevision:bundle.case_revision,resultSha256:bundle.result_sha256,reportSha256:report.report_sha256,htmlSha256:report.html_sha256,pdfSha256:report.pdf_sha256,sourceVersion:file.versionId,sourceSha256:input.sha256,comparisonSha256:comparison.sha256,currentAtExport:true});return row;
 };
 const provisionFromBlocked=async(job:SourceJob,label:string)=>{
  const blocked=await calculate(job);expect(blocked.command.mode).toBe('real');expect(blocked.bundle?.topic_results[0].amount).toBeNull();expect(blocked.bundle?.topic_results[0].trace).toBeNull();
  const review=blocked.stages.find(s=>s.stage==='review_pending')!.payload;
  writeFileSync(`${directory}/${label}-real-blocked-review.json`,JSON.stringify(review,null,2)+'\n');
  const saved=z.object({diagnostics:z.object({factual_context:z.object({state:z.literal('context_loaded'),admission_assessment:z.unknown()})})}).parse(review).diagnostics.factual_context;
  const packet=saved.admission_assessment as June2026AssessmentPacket,{packet_sha256,...body}=packet;
  expect(canonicalSha256(body)).toBe(packet_sha256);expect(packet.execution_allowed).toBe(false);expect(packet.factual_issues).toEqual([]);expect(packet.gates).toHaveLength(8);expect(packet.gates.every(g=>g.state==='declared_unreviewed'&&!g.admitted)).toBe(true);
  expect(packet.current).toMatchObject({case_id:caseId,order_id:orderId,input_revision:job.revision,input_sha256:job.input_sha256,analysis_run_id:blocked.analysis_run_id});
  const candidate=createJune2026MinimumWageCandidate(1),now=new Date(),expires=new Date(now.getTime()+2*60*60*1000);
  const assessment=june2026TestAssessmentSchema.parse({schema_version:'june2026-isolated-test-assessment-v1',authority:'isolated_dev_test_assumptions',human_approval:false,
   assessment_id:randomUUID(),case_id:caseId,order_id:orderId,input_revision:job.revision,input_sha256:job.input_sha256,document_version_id:packet.document.version_id,document_sha256:packet.document.sha256,
   policy_sha256:JUNE2026_MINIMUM_WAGE_POLICY_SHA256,rule_sha256:candidate.rule.content_sha256,golden_cases_sha256:candidate.goldenCases.content_sha256,issued_at:now.toISOString(),expires_at:expires.toISOString(),
   source:`Synthetic uploaded fixture ${input.sha256}; independent oracle ${fixtureSha(JSON.stringify(oracle))}; engineering test assumptions, no professional authority`,
   decisions:packet.gates.map(g=>{if(!g.observed_declaration||!g.current_target_sha256)throw Error('JUNE_CANONICAL_TEST_DECLARATION_REQUIRED');return {field:g.field,
    decision_kind:g.field==='components.legal_classification'?'component_classification':g.field==='wage_components_complete'?'inventory_assessment':'applicability_assessment',target_sha256:g.current_target_sha256,declaration_sha256:g.observed_declaration.declaration_sha256,
    value:g.field==='applicability.sector'?'general_private':g.field==='components.legal_classification'?'base_salary':true,
    source:'Synthetic fixture facts and explicit isolated test assumptions',rationale:'This test assumes the stated general adult hourly scenario and one eligible base component; no human attestation or customer law determination is supplied.'};})});
  await owner.query('insert into private.june2026_test_assessments(id,case_id,order_id,input_revision,input_sha256,payload,payload_sha256,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8)',
   [assessment.assessment_id,caseId,orderId,job.revision,job.input_sha256,assessment,canonicalSha256(assessment),assessment.expires_at]);
  assessments.push({id:assessment.assessment_id,sha256:canonicalSha256(assessment),packetSha256:packet_sha256,blockedRealRunId:blocked.analysis_run_id,inputRevision:job.revision,expiresAt:assessment.expires_at,authority:assessment.authority,humanApproval:false});
  writeFileSync(`${directory}/${label}-test-assessment.json`,JSON.stringify(assessment,null,2)+'\n');return blocked;
 };
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  expect((await owner.query("select to_regprocedure('private.june2026_canonical_test_save(uuid,uuid,integer,text,text,jsonb,jsonb)') ready")).rows[0].ready).not.toBeNull();
  // This isolated database has no migration ledger. Compare actual definitions
  // with the ordered-chain file instead of fabricating a migrations-table proof.
  const migration=migrationBytes.toString('utf8').replaceAll('\r\n','\n');
  for(const [name,signature]of [['private.june2026_test_assessment','uuid,uuid,integer,text'],['private.june2026_canonical_test_save','uuid,uuid,integer,text,text,jsonb,jsonb'],['public.case_report_june_canonical_test','uuid,uuid,uuid'],['private.june2026_canonical_test_customer','uuid,uuid,uuid']]){
   const currentDefinition=name==='private.june2026_canonical_test_customer'?migration:readFileSync('supabase/migrations/'+(name==='private.june2026_canonical_test_save'?'20260910144517_june2026_comparison_stage_binding.sql':'20260910141530_june2026_isolated_canonical_assessments.sql'),'utf8').replaceAll('\r\n','\n');
   const declaration=currentDefinition.indexOf((['private.june2026_canonical_test_save','private.june2026_canonical_test_customer'].includes(name)?'create or replace function ':'create function ')+name+'(');expect(declaration).toBeGreaterThanOrEqual(0);
   const start=currentDefinition.indexOf('as $$',declaration)+5,end=currentDefinition.indexOf('$$;',start),expectedBody=currentDefinition.slice(start,end);
   const actual=(await owner.query('select prosrc,prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)',[name+'('+signature+')'])).rows[0];
   expect(actual.prosecdef).toBe(name.startsWith('private.'));expect(actual.proconfig).toContain('search_path=""');expect(actual.prosrc.replaceAll('\r\n','\n')).toBe(expectedBody);
   definitionChecks.push({name,signature,securityDefiner:actual.prosecdef,emptySearchPath:true,bodyNormalizedSha256:fixtureSha(expectedBody)});
  }
  const bucketInfo=await remote.storage.getBucket('salary-documents');if(bucketInfo.error||bucketInfo.data.public)throw Error('JUNE_CANONICAL_PRIVATE_BUCKET_REQUIRED');
  expect((await owner.query('select id from public.case_identities where id=$1',[APPROVED_OWNER])).rows).toHaveLength(1);
  phase='synthetic-provision';await owner.query('begin');
  publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic June canonical proof',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[caseId,'june-canonical-'+caseId+'@example.invalid'])).rows[0].public_id;
  await owner.query('select public.case_access_identity_link($1,$2)',[APPROVED_OWNER,caseId]);
  const foreignEmail='june-canonical-foreign-'+foreignCaseId+'@example.invalid';await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic June canonical foreign',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01')",[foreignCaseId,foreignEmail]);
  foreignIdentity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[fixtureSha('email|'+foreignEmail),foreignEmail])).rows[0].id;await owner.query('select public.case_access_identity_link($1,$2)',[foreignIdentity,foreignCaseId]);
  const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);await owner.query("select private.capture_case_input($1,'synthetic_june_canonical_paid_scope')",[caseId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.june.canonical.worker',$3,now()-interval '1 minute',now()+interval '2 hours',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);await owner.query('commit');seeded=true;own();
  phase='actual-upload-and-extraction';const first=await upload(),firstRaw=await claim(),extracted=await extract(firstRaw,first);writeFileSync(directory+'/initial-extraction.json',JSON.stringify(extracted.result,null,2)+'\n');
  const initial=await confirm(first,extracted.result);checks.push('Actual private Storage bytes and web-role reservation/commit feed durable injected extraction; seven exact P06 readings and eight identified June declarations are answered and checkpoint reuse makes no provider call.');
  phase='real-blocked-and-explicit-test-authority';await provisionFromBlocked(initial.lease.job,'initial');const before=await counts();expect(before.results).toBe(0);
  failBeforeSave=true;try{await expect(calculate(initial.lease.job)).rejects.toThrow('INJECTED_BEFORE_CANONICAL_TEST_SAVE');}finally{failBeforeSave=false;}expect(await counts()).toEqual(before);await storage.download(first.path);
  checks.push('Without registry authority the actual REAL run remains blocked; the two-hour test record binds its saved packet, all eight declaration hashes, source, current input, policy and candidate. Failure immediately before test-result save rolls back the new canonical run and report.');
  tamperBeforeSave=true;try{await expect(calculate(initial.lease.job)).rejects.toThrow('JUNE_TEST_CANONICAL_RUN_REQUIRED');}finally{tamperBeforeSave=false;}expect(await counts()).toEqual(before);
  phase='canonical-positive';const firstCalculated=await calculate(initial.lease.job);await exportRun('initial-calculated',firstCalculated,first);expect((await counts()).results).toBe(1);
  const priorCalls=providerCalls.length,priorCounts=await counts(),replays=await Promise.all([calculate(initial.lease.job),calculate(initial.lease.job,peer)]);
  expect(replays.every(r=>r.analysis_run_id===firstCalculated.analysis_run_id&&r.report?.report_sha256===firstCalculated.report?.report_sha256)).toBe(true);expect(await counts()).toEqual(priorCounts);
  restarted=client('TIVDOC_WORKER_POSTGRES_URL');await restarted.connect();const restartedRun=await calculate(initial.lease.job,restarted);expect(restartedRun.report?.report_sha256).toBe(firstCalculated.report?.report_sha256);expect(providerCalls).toHaveLength(priorCalls);expect(await counts()).toEqual(priorCounts);newConnectionReplayVerified=true;
  checks.push('Ordinary CaseAnalysisService executes the pinned arity-one rule and persists same-run source trace and report: expected354058, recorded330000, difference24058. HTML/PDF/JSON and customer RPC agree. Parallel retries and a new DB connection preserve one result and exact bytes.');
  phase='foreign-and-tamper';await expect(customer(firstCalculated.analysis_run_id,foreignIdentity)).rejects.toThrow('JUNE_TEST_REPORT_FORBIDDEN');
  await expect(worker.query('select public.case_report_june_canonical_test($1,$2,$3)',[caseId,APPROVED_OWNER,firstCalculated.analysis_run_id])).rejects.toMatchObject({code:'42501'});await expect(web.query('select * from private.june2026_test_assessments')).rejects.toMatchObject({code:'42501'});
  const firstJson=JSON.parse(Buffer.from(firstCalculated.report!.json).toString('utf8'));
  await expect(transactions(worker)(async()=>worker.query('select private.june2026_canonical_test_save($1,$2,$3,$4,$5,$6,$7)',[caseId,orderId,initial.lease.job.revision,initial.lease.job.input_sha256,firstCalculated.analysis_run_id,{...firstJson.comparison,signed_difference:{currency:'ILS',minor_units:24000}},firstJson.admission]))).rejects.toThrow();
  expect(await counts()).toEqual(priorCounts);expect((await customer(firstCalculated.analysis_run_id)).comparison).toEqual(firstJson.comparison);
  await expect(web.query('select public.case_request_document_source($1,$2,$3)',[caseId,foreignIdentity,initial.ageRequest])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  checks.push('Foreign owner cannot read the report or its source; web cannot read registry rows and worker cannot use customer RPC. Altered comparison retry is refused without changing stored bytes.');
  phase='identified-answer-stales-prior-run';await web.query('select public.case_request_edit($1,$2,$3,$4,1,\'correction\')',[caseId,initial.ageRequest,APPROVED_OWNER,JUNE2026_UNKNOWN_ANSWER]);
  expect((await customer(firstCalculated.analysis_run_id)).current).toBe(false);await expect(calculate(initial.lease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  const changedLease=await claim(),changedCalls=providerCalls.length;expect((await extract(changedLease,first)).reused).toBe(true);expect(providerCalls).toHaveLength(changedCalls);
  const changed=await calculate(changedLease.job);expect(changed.command.mode).toBe('real');expect(changed.bundle?.topic_results[0].amount).toBeNull();writeFileSync(directory+'/answer-changed-blocked-review.json',JSON.stringify(changed.stages.find(s=>s.stage==='review_pending')!.payload,null,2)+'\n');
  const gateStates=(run:Completed)=>z.object({diagnostics:z.object({factual_context:z.object({admission_assessment:z.object({gates:z.array(z.object({field:z.string(),state:z.string()}))})})})})
   .parse(run.stages.find(s=>s.stage==='review_pending')!.payload).diagnostics.factual_context.admission_assessment.gates;
  expect(gateStates(changed).find(g=>g.field==='applicability.age_18_entire_month')?.state).toBe('unknown');
  phase='identified-conflicting-answer';await web.query("select public.case_request_edit($1,$2,$3,$4,2,'correction')",[caseId,initial.ageRequest,APPROVED_OWNER,JUNE2026_CONFLICTED_ANSWER]);
  const conflictHead=await head();await web.query("select public.case_request_edit($1,$2,$3,$4,2,'correction')",[caseId,initial.ageRequest,APPROVED_OWNER,JUNE2026_CONFLICTED_ANSWER]);expect(await head()).toEqual(conflictHead);
  await expect(calculate(changedLease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');const conflictLease=await claim(),conflictCalls=providerCalls.length;
  expect((await extract(conflictLease,first)).reused).toBe(true);expect(providerCalls).toHaveLength(conflictCalls);
  const conflicted=await calculate(conflictLease.job);expect(conflicted.command.mode).toBe('real');expect(conflicted.bundle?.topic_results[0].amount).toBeNull();expect(gateStates(conflicted).find(g=>g.field==='applicability.age_18_entire_month')?.state).toBe('conflicted');
  writeFileSync(directory+'/answer-conflicted-blocked-review.json',JSON.stringify(conflicted.stages.find(s=>s.stage==='review_pending')!.payload,null,2)+'\n');
  expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[initial.ageRequest])).rows[0].n).toBe(3);
  checks.push('Identified unknown and conflicted corrections create new inputs with exactly three answer revisions including the original; repeat correction is idempotent. Both states remain explicit in new blocked REAL packets; prior report and jobs cannot become current through old authority.');
  phase='no-gap-source';input=noGapInput;oracle=noGapOracle;const zeroFile=await upload(first);await storage.download(first.path);
  await expect(calculate(conflictLease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');const zeroRaw=await claim(),zeroExtraction=await extract(zeroRaw,zeroFile);
  const zeroCheckpoint=checkpointSchema.parse(zeroExtraction.result);expect(zeroCheckpoint.run.result.final_extraction.fields.some(f=>f.field==='hourly_rate'&&f.normalized_value!==null)).toBe(false);
  writeFileSync(directory+'/no-gap-extraction.json',JSON.stringify(zeroExtraction.result,null,2)+'\n');const zeroConfirmed=await confirm(zeroFile,zeroExtraction.result);
  await provisionFromBlocked(zeroConfirmed.lease.job,'no-gap');const zeroRun=await calculate(zeroConfirmed.lease.job);await exportRun('no-gap-calculated',zeroRun,zeroFile);expect((await counts()).results).toBe(2);
  checks.push('A separately generated and actually uploaded182-hour6443.85 document yields exactly zero difference through fresh REAL packet and isolated assessment. Its hourly-rate cell is absent, never backsolved or seeded; only six existing P06 candidates are confirmed.');
  phase='actual-replacement';input=positiveInput;oracle=ORACLE;const replacement=await upload(zeroFile);expect(replacement.documentId).toBe(first.documentId);expect(replacement.versionId).not.toBe(first.versionId);expect(replacement.versionId).not.toBe(zeroFile.versionId);await storage.download(first.path);await storage.download(zeroFile.path);await expect(calculate(zeroConfirmed.lease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  expect((await customer(firstCalculated.analysis_run_id)).current).toBe(false);const replacementRaw=await claim(),replacementExtraction=await extract(replacementRaw,replacement);writeFileSync(directory+'/replacement-extraction.json',JSON.stringify(replacementExtraction.result,null,2)+'\n');
  const next=await confirm(replacement,replacementExtraction.result);await provisionFromBlocked(next.lease.job,'replacement');const latest=await calculate(next.lease.job);await exportRun('replacement-current-calculated',latest,replacement);
  expect(latest.analysis_run_id).not.toBe(firstCalculated.analysis_run_id);expect((await counts()).results).toBe(3);expect((await customer(firstCalculated.analysis_run_id)).current).toBe(false);expect((await customer(zeroRun.analysis_run_id)).current).toBe(false);expect((await customer(latest.analysis_run_id)).current).toBe(true);
  expect(fixtureSha(decodeReport((await customer(firstCalculated.analysis_run_id)).completion.report).pdf)).toBe(firstCalculated.report!.pdf_sha256);
  expect(fixtureSha(decodeReport((await customer(zeroRun.analysis_run_id)).completion.report).pdf)).toBe(zeroRun.report!.pdf_sha256);
  checks.push('Actual replacements preserve all three immutable Storage versions and historical reports; only new-version readings, a new REAL packet and an explicit new test assessment yield the final current24058 report.');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[caseId])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  expect((await owner.query('select count(*)::int n from private.dev_financial_runs where case_id=$1',[caseId])).rows[0].n).toBe(0);
  phase='complete';
 }catch(error){failure=error instanceof Error?error.message:'JUNE_CANONICAL_PROOF_FAILED';throw error;}finally{
  for(const db of [worker,peer,web,owner,...(restarted?[restarted]:[])])await db.query('rollback').catch(()=>{});
  try{if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where job_id=any($1::text[]) and tenant_id=$2 and canonical_case_id=$3 and state in ('queued','leased','running','retry_wait')",[jobIds,tenant,caseId]);
   expect((await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2 returning sid',[tenant,sid])).rowCount).toBe(1);await owner.query('commit');machineRevoked=true;
   await owner.query('begin');expect((await owner.query("delete from public.cases where id=$1 and is_qa and first_name='Synthetic June canonical foreign'",[foreignCaseId])).rowCount).toBe(1);
   expect((await owner.query('delete from public.case_identities where id=$1',[foreignIdentity])).rowCount).toBe(1);await owner.query('commit');foreignCleaned=true;
  }}catch(error){cleanupFailure=error instanceof Error?error.message:'JUNE_CANONICAL_CLEANUP_FAILED';await owner.query('rollback').catch(()=>{});}finally{
   own();writeFileSync(directory+'/proof.json',JSON.stringify({schemaVersion:'june2026-canonical-db-proof-v1',verdict:!failure&&!cleanupFailure&&phase==='complete'&&checks.length===7&&machineRevoked&&foreignCleaned?'PASS':'FAIL',gitSha,phase,failure,cleanupFailure,
    caseId,publicId,orderId,ownerIdentity:APPROVED_OWNER,database:'tivdoc_release_replay_20260907',schema:{orderedChain:138,tail:migrationName,sha256:fixtureSha(migrationBytes),actualDefinitions:definitionChecks,migrationLedgerAvailable:false},checks,runs,assessments,confirmationReceipts,providerCalls,
    sources:[{path:directory+'/input.pdf',sha256:positiveInput.sha256,bytes:positiveInput.bytes.length},{path:directory+'/no-gap-input.pdf',sha256:noGapInput.sha256,bytes:noGapInput.bytes.length}],independentOracle:ORACLE,noGapOracle,
    retainedPrimaryCase:seeded,retainedStoragePaths:paths,sourceHashesByPath,machineRevoked,foreignFixtureRemoved:foreignCleaned,customerSessionInjected:false,liveOcr:false,
    provider:'injected_synthetic_transport',realPayment:false,notificationsSent:false,humanApproval:false,legalActivation:false,ordinaryCustomerFindingPublished:false,
    processRestartProof:false,newConnectionRestartProof:newConnectionReplayVerified,productionChanged:false,browserProof:false},null,2)+'\n');
   await Promise.all([owner.end(),worker.end(),peer.end(),web.end(),...(restarted?[restarted.end()]:[])]);
  }
  if(cleanupFailure)throw Error('JUNE_CANONICAL_CLEANUP_FAILED');
 }
},8*60*1000);
