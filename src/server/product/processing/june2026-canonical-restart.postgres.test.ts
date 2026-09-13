import {expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {sourceMonetaryComparisonSchema} from '@/engine/findings/source-comparison';
import {decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {runSavedWorkerMonth} from './saved-worker';
import {sourceJobSchema} from './source-dispatch';
vi.mock('server-only',()=>({}));

const APPROVED_OWNER='dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a';
const sha=z.string().regex(/^[a-f0-9]{64}$/u),git=z.string().regex(/^[a-f0-9]{40}$/u);
const priorSchema=z.object({schemaVersion:z.literal('june2026-canonical-db-proof-v1'),verdict:z.literal('PASS'),phase:z.literal('complete'),gitSha:git,
 caseId:z.uuid(),orderId:z.uuid(),ownerIdentity:z.literal(APPROVED_OWNER),database:z.literal('tivdoc_release_replay_20260907'),
 retainedPrimaryCase:z.literal(true),machineRevoked:z.literal(true),customerSessionInjected:z.literal(false),productionChanged:z.literal(false),
 schema:z.object({orderedChain:z.number().int().min(138),tail:z.string(),sha256:sha,actualDefinitions:z.array(z.object({name:z.string(),signature:z.string(),
  securityDefiner:z.boolean(),emptySearchPath:z.literal(true),bodyNormalizedSha256:sha})).min(4)}),
 runs:z.array(z.object({label:z.string(),runId:z.uuid(),resultSha256:sha,reportSha256:sha,htmlSha256:sha,pdfSha256:sha,
  sourceVersion:z.uuid(),sourceSha256:sha,comparisonSha256:sha,currentAtExport:z.boolean()})).min(1),
}).passthrough();
const bytesSha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const safeError=(error:unknown)=>{
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
 return /^[A-Z0-9_]{1,100}$/u.test(code)?code:error instanceof Error?error.name:'UNKNOWN_ERROR';
};

/** Run in a NEW Vitest OS process after the original proof ended. This file
 * imports no extractor/provider/storage fixture, reuses only existing saved
 * results, and creates/revokes only its own short-lived worker session. */
it.skipIf(process.env.TIVDOC_JUNE_CANONICAL_RESTART_PROOF!=='1')('replays the retained canonical result byte-identically after a real process restart',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('JUNE_RESTART_DEV_TEST_REQUIRED');
 const proofPath=path.resolve(z.string().min(1).parse(process.env.TIVDOC_JUNE_CANONICAL_PRIOR_PROOF));
 const evidenceRoot=path.resolve('output/release-completion/june-canonical'),relative=path.relative(evidenceRoot,proofPath);
 if(path.isAbsolute(relative)||relative.startsWith('..')||path.basename(proofPath)!=='proof.json')throw Error('JUNE_RESTART_PRIOR_PATH_SCOPE');
 const originalBytes=readFileSync(proofPath),prior=priorSchema.parse(JSON.parse(originalBytes.toString('utf8'))),priorSha256=bytesSha(originalBytes);
 const directory=path.dirname(proofPath);
 if(path.basename(directory)!==prior.caseId.slice(0,8))throw Error('JUNE_RESTART_RECEIPT_SCOPE');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();git.parse(gitSha);
 const receiptPath=path.join(directory,'restart-proof-'+gitSha.slice(0,12)+'.json');if(existsSync(receiptPath))throw Error('JUNE_RESTART_RECEIPT_EXISTS');
 expect(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()).toBe('');
 execFileSync('git',['merge-base','--is-ancestor',prior.gitSha,gitSha],{stdio:'pipe'});
 const processStartedAtMs=Date.now()-process.uptime()*1000,priorWrittenAtMs=statSync(proofPath).mtimeMs;
 if(processStartedAtMs<=priorWrittenAtMs)throw Error('JUNE_RESTART_NEW_PROCESS_REQUIRED');
 const matches=prior.runs.filter(run=>run.label==='replacement-current-calculated');
 expect(matches).toHaveLength(1);const expected=matches[0];expect(expected.currentAtExport).toBe(true);
 const artifactBytes={json:readFileSync(path.join(directory,expected.label+'.json')),html:readFileSync(path.join(directory,expected.label+'.html')),
  pdf:readFileSync(path.join(directory,expected.label+'.pdf')),manifest:readFileSync(path.join(directory,expected.label+'.manifest'))};
 expect(bytesSha(artifactBytes.html)).toBe(expected.htmlSha256);expect(bytesSha(artifactBytes.pdf)).toBe(expected.pdfSha256);
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{
  const u=new URL(z.string().min(1).parse(env.get(key)));
  if(u.pathname!=='/tivdoc_release_replay_20260907'||u.hostname!=='aws-0-eu-central-1.pooler.supabase.com'
   ||!u.username.endsWith('.cpzrbidxftzqcfeqqusu'))throw Error('JUNE_RESTART_DATABASE_SCOPE');
  u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});
 };
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
 const tenant='saved-case:'+prior.caseId,sid='june-canonical-restart:'+randomUUID(),jti=randomUUID();
 let phase='connect',failure:string|null=null,cleanupFailure:string|null=null,machineCreated=false,machineRevoked=false;
 let before:Record<string,unknown>|null=null,after:Record<string,unknown>|null=null,invoked=false,verified=false;
 let replayIdentity:Record<string,unknown>|null=null;
 const definitions:Record<string,unknown>[]=[],checks:string[]=[],statements:string[]=[];
 const counts=async()=>(await owner.query(`select
  (select count(*)::int from public.analysis_runs where tenant_id=$1 and canonical_case_id=$2::text) analyses,
  (select count(*)::int from private.june2026_canonical_test_results where case_id=$2::uuid) results,
  (select count(*)::int from public.engine_report_versions where tenant_id=$1 and canonical_case_id=$2::text) reports,
  (select count(*)::int from public.engine_calculation_trace_versions where tenant_id=$1) traces,
  (select count(*)::int from private.case_extraction_invocations where case_id=$2::uuid) extraction_invocations,
  (select count(*)::int from private.case_extraction_checkpoints where case_id=$2::uuid) extraction_checkpoints`,[tenant,prior.caseId])).rows[0] as Record<string,unknown>;
 try{
  await owner.connect();await worker.connect();
  expect((await owner.query('select current_database() name')).rows[0].name).toBe(prior.database);
  expect((await worker.query('select session_user::text role')).rows[0].role).toBe('tivdoc_worker_runtime');
  phase='existing-source-and-schema';
  const owned=(await owner.query(`select c.id from public.cases c join public.case_identity_cases i on i.case_id=c.id
   where c.id=$1 and c.is_qa and c.first_name='Synthetic June canonical proof' and c.contact_verified_at is not null
    and i.identity_id=$2`,[prior.caseId,prior.ownerIdentity])).rows;expect(owned).toHaveLength(1);
  for(const definition of prior.schema.actualDefinitions){
   const actual=(await owner.query('select prosrc,prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)',[definition.name+'('+definition.signature+')'])).rows[0];
   expect(actual).toBeDefined();expect(actual.prosecdef).toBe(definition.securityDefiner);expect(actual.proconfig).toContain('search_path=""');
   expect(bytesSha(actual.prosrc.replaceAll('\r\n','\n'))).toBe(definition.bodyNormalizedSha256);definitions.push({...definition,actualBodyMatched:true});
  }
  const baselineRow=(await owner.query(`select ar.completion_payload,r.input_revision,r.input_sha256,r.comparison,a.id assessment_id,a.payload_sha256,
   a.revoked_at,a.expires_at,a.payload->>'issued_at' issued_at,h.revision current_revision,h.input_sha256 current_sha,transaction_timestamp() evaluated_at
   from private.june2026_canonical_test_results r join public.analysis_runs ar on ar.id=r.analysis_run_id
    and ar.canonical_case_id=r.case_id::text and ar.tenant_id=$1
   join private.june2026_test_assessments a on a.id=r.assessment_id and a.case_id=r.case_id and a.order_id=$3
   join private.case_input_heads h on h.case_id=r.case_id
   where r.case_id=$2 and ar.canonical_analysis_run_id=$4 and ar.status='completed'`,[tenant,prior.caseId,prior.orderId,expected.runId])).rows;
  expect(baselineRow).toHaveLength(1);const baseline=baselineRow[0];
  expect(baseline.revoked_at).toBeNull();
  expect(new Date(baseline.expires_at).getTime()).toBeGreaterThan(new Date(baseline.evaluated_at).getTime());
  expect(new Date(baseline.issued_at).getTime()).toBeLessThanOrEqual(new Date(baseline.evaluated_at).getTime());
  expect(baseline.current_revision).toBe(baseline.input_revision);expect(baseline.current_sha).toBe(baseline.input_sha256);
  const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:prior.caseId,revision:baseline.current_revision,input_sha256:baseline.current_sha,mode:'draft'});
  const initialReport=decodeReport(baseline.completion_payload.report),initialBundle=decodeBundle(baseline.completion_payload.bundle,['minimum_wage']);
  const comparison=sourceMonetaryComparisonSchema.parse(baseline.comparison);
  expect(initialBundle.analysis_run_id).toBe(expected.runId);expect(initialBundle.result_sha256).toBe(expected.resultSha256);
  expect(initialReport.report_sha256).toBe(expected.reportSha256);expect(comparison.sha256).toBe(expected.comparisonSha256);
  expect(comparison.trace.analysis_run_id).toBe(expected.runId);expect(comparison.signed_difference).toEqual({currency:'ILS',minor_units:24058});
  const data=JSON.parse(Buffer.from(initialReport.json).toString('utf8'));
  expect(canonicalSha256(data.comparison)).toBe(canonicalSha256(comparison));expect(data.human_approval).toBe(false);expect(data.legal_activation).toBe(false);
  expect(data.admission.assessment_sha256).toBe(baseline.payload_sha256);
  for(const key of ['json','html','pdf','manifest'] as const)expect(Buffer.from(initialReport[key])).toEqual(artifactBytes[key]);
  expect((await owner.query('select version_id,content_sha256 from public.documents where case_id=$1 and version_id=$2',[prior.caseId,expected.sourceVersion])).rows)
   .toEqual([{version_id:expected.sourceVersion,content_sha256:expected.sourceSha256}]);
  checks.push('Prior PASS artifacts match the existing current same-run DB completion, source, unexpired assessment and all schema definition hashes.');
  before=await counts();
  phase='new-scoped-machine';
  expect((await owner.query(`insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at)
   values($1,$2,'synthetic.june.canonical.restart.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now()) returning sid`,
  [tenant,sid,jti,canonicalSha256({sid,jti})])).rowCount).toBe(1);machineCreated=true;
  phase='saved-worker-replay';await worker.query('begin');
  try{
   await worker.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'june-canonical-restart-proof']);
   await worker.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(sql){
    statements.push(sql.name);const result=await worker.query(sql.text,[...sql.values]);
    return {rows:result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]))),row_count:result.rowCount??0};
   }}};
   invoked=true;const replay=await runSavedWorkerMonth({context,job,orderId:prior.orderId,month:'2026-06'});
   expect(replay.completed).toBe(true);expect(replay.analysis_run_id).toBe(expected.runId);
   expect(replay.bundle).toEqual(initialBundle);expect(replay.report).toEqual(initialReport);
   if(!replay.report)throw Error('JUNE_RESTART_REPORT_MISSING');
   for(const key of ['json','html','pdf','manifest'] as const)expect(Buffer.from(replay.report[key])).toEqual(artifactBytes[key]);
   expect(statements).toContain('june_test_authority');expect(statements).toContain('analysis_run_completed_idem');
   expect(statements).not.toContain('analysis_run_begin');expect(statements).not.toContain('analysis_report_insert');
   expect(statements).not.toContain('june_canonical_test_save');
   replayIdentity={runId:replay.analysis_run_id,resultSha256:replay.bundle!.result_sha256,reportSha256:replay.report.report_sha256,
    jsonSha256:replay.report.json_sha256,htmlSha256:replay.report.html_sha256,pdfSha256:replay.report.pdf_sha256,manifestSha256:replay.report.manifest_sha256,
    comparisonSha256:comparison.sha256,inputRevision:job.revision,inputSha256:job.input_sha256};
   await worker.query('commit');
  }catch(error){await worker.query('rollback');throw error;}
  after=await counts();expect(after).toEqual(before);expect(bytesSha(readFileSync(proofPath))).toBe(priorSha256);
  checks.push('A newly started OS process and newly minted scoped machine session reran runSavedWorkerMonth and returned the prior run with byte-identical JSON, HTML, PDF and manifest.');
  checks.push('Analysis/result/report/trace/extraction invocation/checkpoint counts did not increase; the existing completion path performed no result save or report insert.');
  verified=true;phase='complete';
 }catch(error){failure=safeError(error);throw Error(`JUNE_CANONICAL_RESTART_FAILED:${phase}:${failure}`);}finally{
  await worker.query('rollback').catch(()=>{});
  if(machineCreated){
   try{
    await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
    expect((await owner.query(`update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now())
     where tenant_id=$1 and sid=$2 and current_jti=$3 returning sid`,[tenant,sid,jti])).rowCount).toBe(1);await owner.query('commit');machineRevoked=true;
   }catch(error){cleanupFailure=safeError(error);await owner.query('rollback').catch(()=>{});}
  }
  const passed=verified&&phase==='complete'&&!failure&&!cleanupFailure&&machineRevoked;
  writeFileSync(receiptPath,JSON.stringify({schemaVersion:'june2026-canonical-process-restart-proof-v1',verdict:passed?'PASS':'FAIL',phase,failure,cleanupFailure,
   gitSha,priorProofGitSha:prior.gitSha,priorProofSha256:priorSha256,priorProofPath:path.relative(process.cwd(),proofPath),
   processId:process.pid,processStartedAt:new Date(processStartedAtMs).toISOString(),priorProofWrittenAt:new Date(priorWrittenAtMs).toISOString(),
   processStartedAfterPriorProof:processStartedAtMs>priorWrittenAtMs,processRestartProof:passed,caseId:prior.caseId,orderId:prior.orderId,database:prior.database,
   schema:{orderedChain:prior.schema.orderedChain,actualDefinitions:definitions,migrationLedgerAvailable:false},checks,before,after,replay:replayIdentity,
   savedWorkerInvoked:invoked,newMachineCreated:machineCreated,newMachineRevoked:machineRevoked,oldMachineRevived:false,
   providerInvocations:0,extractionInvoked:false,storageRead:false,assessmentCreated:false,assessmentRenewed:false,customerSessionInjected:false,
   notificationsSent:false,finalizerVerified:false,finalizerReason:'The prior proof cancelled its owned jobs; this verifies saved-month process replay, not lease acknowledgement.',
   humanApproval:false,legalActivation:false,ordinaryCustomerFindingPublished:false,productionChanged:false},null,2)+'\n',{flag:'wx'});
  await Promise.allSettled([owner.end(),worker.end()]);
  if(cleanupFailure)throw Error('JUNE_CANONICAL_RESTART_MACHINE_REVOCATION_FAILED');
 }
},3*60*1000);
