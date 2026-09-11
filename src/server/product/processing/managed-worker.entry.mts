declare const TIVDOC_MANAGED_WORKER_BUILD_SHA:string;
declare const TIVDOC_MANAGED_WORKER_DIRTY_BUILD:boolean;

async function main(){
 if(process.argv[2]==='--recover-budget-lock'){
  if(process.argv.length!==5||typeof TIVDOC_MANAGED_WORKER_BUILD_SHA==='undefined'||TIVDOC_MANAGED_WORKER_DIRTY_BUILD)throw Error('MANAGED_DEV_CLEAN_BUILD_REQUIRED');
  const {recoverManagedSolBudgetLock}=await import('./sol-budgeted-extractor');
  console.log(JSON.stringify(recoverManagedSolBudgetLock({expectedLockSha256:process.argv[3],expectedLedgerSha256:process.argv[4]})));return;
 }
 if(process.env.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true'){
  console.log(JSON.stringify({worker:'managed_dev',state:'disabled'}));return;
 }
 if(typeof TIVDOC_MANAGED_WORKER_BUILD_SHA==='undefined'||TIVDOC_MANAGED_WORKER_DIRTY_BUILD)throw Error('MANAGED_DEV_CLEAN_BUILD_REQUIRED');
 const {runManagedDevIteration,readManagedDevOperations}=await import('./managed-worker-iteration');
 if(process.argv.slice(2).some(value=>value!=='--status'))throw Error('MANAGED_DEV_ARGUMENT_INVALID');
 if(process.argv.includes('--status')){console.log(JSON.stringify(await readManagedDevOperations(process.env,TIVDOC_MANAGED_WORKER_BUILD_SHA)));return;}
 const {runAutomaticDevMonth}=await import('./automatic-dev-flow');
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 // Bounded graceful shutdown between units; the provider itself has a timeout.
 // A forced OS shutdown relies on DB fencing and immutable invocation recovery.
 const timer=setTimeout(stop,8*60*1000);
 try{
  const result=await runManagedDevIteration(process.env,TIVDOC_MANAGED_WORKER_BUILD_SHA,runAutomaticDevMonth,controller.signal);
  console.log(JSON.stringify(result));
  if(['interrupted','blocked','failed'].includes(result.state)||['blocked','failed','interrupted'].includes(result.notifications.state)||result.health.state==='unavailable'||result.items.some(item=>['dead_letter','retry_wait','held','unconfirmed'].includes(item.state)))process.exitCode=1;
 }finally{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{
 const codes=new Set(['MANAGED_DEV_CLEAN_BUILD_REQUIRED','MANAGED_DEV_CONFIGURATION_INVALID','MANAGED_DEV_PROVIDER_UNCONFIGURED','MANAGED_DEV_STORAGE_UNCONFIGURED','MANAGED_DEV_BUILD_MISMATCH','MANAGED_DEV_ARGUMENT_INVALID',
  'SOL_LEDGER_OWNER_RECOVERY_REQUIRED','SOL_LEDGER_OWNER_STILL_RUNNING','SOL_LEDGER_RECOVERY_HASH_MISMATCH','SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW','SOL_LEDGER_RECOVERY_PATH_MISMATCH','SOL_LEDGER_RECOVERY_ACTIVE']);
 console.log(JSON.stringify({worker:'managed_dev',state:'failed',code:error instanceof Error&&codes.has(error.message)?error.message:'MANAGED_DEV_EXECUTION_FAILED'}));process.exitCode=1;
});
