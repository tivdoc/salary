import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,unlinkSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import {createLiveExtractionRuntime} from './live-extraction-runtime';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {liveFixtureSha} from './live-extraction-fixtures';
import {loadLiveExtractionCorpus,checkLiveExtractionCorpus} from './live-extraction-corpus';
import {assertLiveExtractionBudgetModel,newLiveExtractionBudgetLedger,parseLiveExtractionBudgetLedger,
 preflightLiveExtractionRequest,reserveLiveExtractionPass,recordLiveExtractionPassReceipt,summarizeLiveExtractionBudget} from './live-extraction-budget';
vi.mock('server-only',()=>({}));

// Explicit opt-in: actual SDK only. The wrapper inspects and reserves budget
// before forwarding to the original extractor; it supplies no provider output,
// transport, customer answer, database finding or report.
it.skipIf(process.env.TIVDOC_LIVE_EXTRACTION_PROOF!=='1')('reads the selected synthetic corpus with the actual provider and a durable cost ceiling',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('LIVE_EXTRACTION_PROOF_DEV_ONLY');
 const selection=process.env.TIVDOC_LIVE_EXTRACTION_CORPUS??'hebrew-june2026';
 const entries=loadLiveExtractionCorpus(selection,process.env.TIVDOC_LIVE_EXTRACTION_IDS);
 const directory='output/release-completion/live-provider-june2026';mkdirSync(directory,{recursive:true});
 const runtime=createLiveExtractionRuntime(),results:unknown[]=[],failures:string[]=[];let providerAttempted=false;
 let providerInvocationEntered=0,providerReceiptConfirmedCalls=0;
 const ledgerPath=`${directory}/live-provider-budget-ledger.json`,lockPath=`${ledgerPath}.lock`;
 let ledger:ReturnType<typeof newLiveExtractionBudgetLedger>|null=null;
 const record=(state:string)=>writeFileSync(`${directory}/live-provider-proof.json`,JSON.stringify({schemaVersion:'tivdoc-live-provider-proof-v2',
  state,checkedAt:new Date().toISOString(),gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  worktreeDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,selection,selectedIds:entries.map(entry=>entry.id),
  providerCalled:providerReceiptConfirmedCalls>0?true:providerInvocationEntered>0?null:false,
  providerInvocationEntered,providerReceiptConfirmedCalls,providerAttemptedOrUnknown:providerAttempted,
  providerKind:runtime.state==='configured'?runtime.provider.kind:null,
  configuration:runtime.state==='blocked'?{state:runtime.state,code:runtime.code}:runtime.provider,
  budget:ledger?summarizeLiveExtractionBudget(ledger):null,results,failures,productionChanged:false,databaseChanged:false,humanConfirmations:false,
  scope:'Actual API extraction only; synthetic English/Hebrew PDFs and raster simulations. Extra components are outside the narrow financial scenario. No actual employee payslip, customer identity, payment or legal activation is proved.'},null,2)+'\n');
 if(runtime.state==='blocked'){record('BLOCKED_CONFIGURATION');throw Error(runtime.code);}
 try{assertLiveExtractionBudgetModel(runtime.provider.model,new Date().toISOString());}
 catch(error){failures.push(error instanceof Error?error.message:'LIVE_BUDGET_CONFIGURATION_INVALID');record('BLOCKED_BUDGET_CONFIGURATION');throw error;}
 // This fixed ledger spans both corpora and every subset. A crash leaves an
 // exclusive lock and unknown reservations for inspection, never a free retry.
 const lock=openSync(lockPath,'wx');
 const persistLedger=()=>{
  const handle=openSync(ledgerPath,'w');
  try{writeFileSync(handle,JSON.stringify(ledger,null,2)+'\n');fsyncSync(handle);}finally{closeSync(handle);}
 };
 const forward=runtime.extractor.extractPreparedPass.bind(runtime.extractor);let budgetBlocked=false;
 try{
  ledger=existsSync(ledgerPath)?parseLiveExtractionBudgetLedger(JSON.parse(readFileSync(ledgerPath,'utf8')))
   :newLiveExtractionBudgetLedger(runtime.provider.model,new Date().toISOString());
  runtime.extractor.extractPreparedPass=async input=>{
   try{
    const entry=entries.find(entry=>entry.sha256===input.request.document.content_sha256);
    if(!entry||input.sourcePageCount!==1||input.request.document.size_bytes!==entry.sizeBytes
     ||input.prepared.original.mime_type!==entry.mimeType)throw Error('LIVE_BUDGET_UNAPPROVED_SOURCE');
    const preflight=await preflightLiveExtractionRequest({model:runtime.provider.model,prepared:input.prepared,
     sourceSha256:entry.sha256,kind:input.kind,requestedFields:input.requestedFields,now:new Date().toISOString()});
    ledger=reserveLiveExtractionPass({ledger:ledger!,sourceSha256:entry.sha256,requestSha256:preflight.requestSha256,
     passKind:input.kind,now:new Date().toISOString()});persistLedger();
    // Once control enters the real extractor, an absent response cannot prove
    // that no network request occurred. Persist this uncertainty before entry.
    providerAttempted=true;providerInvocationEntered++;record('RUNNING');
    const pass=await forward(input);
    if(!pass.provider_receipt)throw Error('LIVE_BUDGET_RECEIPT_MISSING');
    if(pass.provider_receipt.provider_attempted)providerReceiptConfirmedCalls++;
    ledger=recordLiveExtractionPassReceipt(ledger,pass.provider_receipt);persistLedger();return pass;
   }catch(error){budgetBlocked=true;throw error;}
  };
  record('RUNNING');
  for(const entry of entries){
   const bytes=readFileSync(entry.path),caseId=randomUUID(),versionId=randomUUID(),runId=randomUUID();
   const extension=entry.mimeType==='application/pdf'?'pdf':entry.mimeType==='image/png'?'png':'jpg';
   const path=`cases/${caseId}/versions/${versionId}.${extension}`;
   const runResult:Record<string,unknown>={id:entry.id,sourceSha256:entry.sha256,state:'running'};results.push(runResult);
   try{
    expect(liveFixtureSha(bytes)).toBe(entry.sha256);expect(bytes.length).toBe(entry.sizeBytes);
    const checkpoint=await extractSavedPayslip({caseId,versionId,expectedMonth:'2026-06',extractor:runtime.extractor,
     context:{snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:runId,schema_version:'1.0.0',created_at:new Date().toISOString(),
      fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(field=>[field,randomUUID()]))},
     db:{async query(){return {rows:[{id:randomUUID(),case_id:caseId,version_id:versionId,document_type:'payslip',storage_path:path,
      original_filename:entry.path.split('/').at(-1),mime_type:entry.mimeType,size:bytes.length,content_sha256:entry.sha256,period_month:'2026-06-01',created_at:new Date().toISOString()}]};}},
     storage:{async download(requested){expect(requested).toBe(path);return {data:new Blob([bytes],{type:entry.mimeType}),error:null};}},
    });
    writeFileSync(`${directory}/live-checkpoint-${entry.id}.json`,JSON.stringify(checkpoint,null,2)+'\n');
    const provenance=readSavedExtractionProvenance(checkpoint);runResult.provenance=provenance;
    providerAttempted=providerAttempted||provenance.providerAttempted;
    expect(provenance.kind).toBe('openai_live');expect(provenance.providerAttempted).toBe(true);expect(provenance.allPassesSucceeded).toBe(true);
    const comparison=checkLiveExtractionCorpus({entry,extraction:checkpoint.run.result.final_extraction,validation:checkpoint.run.result.final_validation});
    runResult.oracleComparison=comparison;expect(comparison.failures).toEqual([]);
    if(entry.oracle.outcome==='conflicting_observations'){
     const fact=checkpoint.run.snapshot?.facts.find(value=>value.path==='work.regular_hours');
     expect(['conflicted','needs_confirmation','candidate']).toContain(fact?.status);
    }
    runResult.state='passed';
   }catch(error){
    failures.push(entry.id);runResult.state='failed';runResult.errorKind=error instanceof Error?error.name:'unknown';
    if(error instanceof Error&&/^LIVE_[A-Z_]+$/u.test(error.message))runResult.failureCode=error.message;
   }
   record('RUNNING');if(budgetBlocked)break;
  }
  record(budgetBlocked?'BLOCKED_BUDGET':failures.length?'FAIL':'PASS');expect(failures).toEqual([]);
 }finally{runtime.extractor.extractPreparedPass=forward;closeSync(lock);unlinkSync(lockPath);}
},20*60*1000);
