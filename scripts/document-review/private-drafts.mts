import "../production-refusal.mjs";
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

let diagnosticRoot:string|undefined;
async function main(){
 const [{CaseAnalysisService},{documentReviewInputSchema},{canonicalSha256},{June2026ReviewCatalog},
  {InMemoryCaseAnalysisRepository},{SavedAnalysisDraftBuilder,savedAnalysisId},{privateArtifactPath},{WAVE3_TOPICS},{validateReport,decodeBundle},{DOCUMENT_REVIEW_RENDER_POLICY}]=await Promise.all([
  import('../../src/engine/case-analysis/service.ts'),import('../../src/engine/document-review/contracts.ts'),import('../../src/engine/rule-runtime/canonical.ts'),
  import('../../src/engine/legal-operations/june2026-catalog.ts'),import('../../src/server/engine/case-analysis/in-memory-repository.ts'),
  import('../../src/server/product/processing/saved-draft-report.ts'),import('../../src/server/private-analysis/extraction.ts'),import('../../src/engine/wave3/contracts.ts'),
  import('../../src/server/platform/persistence/postgres/analysis/validation.ts'),import('../../src/server/product/reports/document-review-render-policy.ts')]);
 const [manifestPath,outArg,revision]=process.argv.slice(2);
 if(!manifestPath||!outArg||!revision)throw Error('PRIVATE_REVIEW_ARGUMENTS');
 const packet=JSON.parse(readFileSync(privateArtifactPath(manifestPath),'utf8'));
 const out=privateArtifactPath(outArg);mkdirSync(out,{recursive:true});diagnosticRoot=out;
 const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const summary=[];
 const failures:{case_alias:string;error:string}[]=[];
 for(const item of packet.cases){
  if(!/^CASE-(?:0[1-9]|[1-9]\d)$/u.test(item.case_alias))throw Error('PRIVATE_REVIEW_ALIAS');
  try{
  const review=documentReviewInputSchema.parse(item.input);
  // This adapter loads private source copies, not findings or previous reports.
  // Every source file and source-reading receipt is checked independently.
  for(const file of item.source_files){if(digest(readFileSync(privateArtifactPath(file.path)))!==file.sha256)throw Error('PRIVATE_REVIEW_SOURCE_CHANGED');}
  for(const d of review.documents){if(!item.source_files.some((f:{sha256:string})=>f.sha256===d.file_sha256)
   ||[d.reading_sha256,...(d.accepted_reading_sha256??[])].some(h=>!item.source_files.some((f:{sha256:string})=>f.sha256===h)))throw Error('PRIVATE_REVIEW_RECEIPT_REQUIRED');}
  const hash=canonicalSha256(review),empty=canonicalSha256([]),created=packet.created_at;
  const stored={documents:[],document_snapshot_id:`review-documents:${hash}`,document_snapshot_sha256:empty,
   extractions:[],extraction_snapshot_id:`review-extractions:${hash}`,extraction_snapshot_sha256:empty,
   declared_fact_snapshot:{snapshot_id:`review-declarations:${hash}`,snapshot_sha256:empty,facts:[]},document_review_input:review};
  const repository=new InMemoryCaseAnalysisRepository();
  const service=new CaseAnalysisService({clock:{now:()=>created},ids:{derive:savedAnalysisId},hashes:{hashCanonical:canonicalSha256,hashBytes:digest},
   snapshots:{async loadPinned(){return stored;}},repository,legalCatalog:new June2026ReviewCatalog(),executor:{async execute(){throw Error('UNAUTHORIZED_REAL_EXECUTION');}},
   reportBuilder:new SavedAnalysisDraftBuilder(),reportRegistration:{registerReport(){}},logs:{write(){}},templateVersion:`document-review-product-v1:${DOCUMENT_REVIEW_RENDER_POLICY}`});
  const requested=review.purchased_scope.topics.filter((t):t is typeof WAVE3_TOPICS[number]=>WAVE3_TOPICS.some(v=>v===t));
  const command={case_id:review.case_id,case_revision:item.report_revision,document_snapshot_id:stored.document_snapshot_id,document_snapshot_sha256:empty,
   extraction_snapshot_id:stored.extraction_snapshot_id,extraction_snapshot_sha256:empty,declared_fact_snapshot_id:stored.declared_fact_snapshot.snapshot_id,declared_fact_snapshot_sha256:empty,
   document_review_sha256:hash,period:{start_date:review.period.from,end_date:review.period.to},as_of:created.slice(0,10),requested_topics:requested,
   sector:'unverified',population:'unverified',mode:'real' as const,idempotency_key:`private-review:${hash}:${item.report_revision}:${DOCUMENT_REVIEW_RENDER_POLICY}`};
  const bundle=await service.runCaseAnalysis(command),run=await service.getCompletedRun(bundle.analysis_run_id);
  if(!run?.report)throw Error('PRIVATE_REVIEW_REPORT_MISSING');
  validateReport(run.report);decodeBundle(bundle,requested);
  if(canonicalSha256(await service.runCaseAnalysis(command))!==canonicalSha256(bundle))throw Error('PRIVATE_REVIEW_RETRY_CHANGED');
  const dir=path.join(out,item.case_alias);if(existsSync(dir))throw Error('PRIVATE_REVIEW_OUTPUT_EXISTS');mkdirSync(dir);
  const write=(name:string,bytes:Uint8Array|string)=>writeFileSync(path.join(dir,name),bytes,{flag:'wx',mode:0o600});
  for(const kind of ['html','pdf','json','manifest'] as const)write(kind==='manifest'?'manifest.private.json':`report.${kind}`,run.report[kind]);
  if('private_evidence_appendix' in run.report){
   if(!(run.report.private_evidence_appendix instanceof Uint8Array))throw Error('PRIVATE_REVIEW_APPENDIX_INVALID');
   write('evidence-appendix.private.json',run.report.private_evidence_appendix);
  }
  write('analysis.private.json',JSON.stringify({application_commit:revision,storage:'private file artifact; canonical service, no production DB write',command,stages:run.stages,dependencies:run.dependencies,bundle},null,2)+'\n');
  summary.push({case_alias:item.case_alias,analysis_run_id:bundle.analysis_run_id,analysis_result_sha256:bundle.result_sha256,report_id:run.report.report_id,
   report_sha256:run.report.report_sha256,pdf_sha256:run.report.pdf_sha256,checks:bundle.document_review!.checks.length,
   calculated:bundle.document_review!.checks.filter(c=>c.calculation.state==='calculated').length,completions:bundle.document_review!.completions.customer_requests.length,
   gaps:bundle.document_review!.coverage_gaps.length});
  }catch(error){
   const name=error instanceof Error?error.message:'PRIVATE_REVIEW_CASE_FAILED';
   failures.push({case_alias:item.case_alias,error:name});
   writeFileSync(path.join(out,`${item.case_alias}-error.private.txt`),String(error instanceof Error?error.stack:error),{flag:'wx',mode:0o600});
  }
 }
 writeFileSync(path.join(out,'summary.private.json'),JSON.stringify({application_commit:revision,created_at:packet.created_at,source:'saved private observations; no live provider claim',cases:summary,failures,complete:failures.length===0},null,2)+'\n',{flag:'wx',mode:0o600});
 writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>טיוטות סקירת מסמכים</title><h1>טיוטות סקירת מסמכים</h1><p>קבצים פרטיים לבדיקת הבעלים; לא נשלחו ללקוחות.</p><ul>${summary.map(s=>`<li>${s.case_alias}: <a href="${s.case_alias}/report.html">דוח</a> · <a href="${s.case_alias}/report.pdf">PDF</a></li>`).join('')}</ul></html>`,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({cases:summary.length,failed:failures.length,output:out,customer_delivery:false,production_writes:0}));
 if(failures.length)process.exitCode=1;
}
main().catch(error=>{if(diagnosticRoot)writeFileSync(path.join(diagnosticRoot,`error-${Date.now()}.private.txt`),String(error?.stack??error),{flag:'wx',mode:0o600});console.error('PRIVATE_REVIEW_FAILED_SEE_LOCAL_DIAGNOSTIC');process.exitCode=1;});
