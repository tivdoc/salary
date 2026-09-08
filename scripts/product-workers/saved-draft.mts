import "../production-refusal.mjs";

declare const TIVDOC_SAVED_WORKER_BUILD_SHA:string;
declare const TIVDOC_SAVED_WORKER_DIRTY_BUILD:boolean;

async function main(){
 if(process.env.TIVDOC_SAVED_DRAFT_WORKER_ENABLED!=='true'){
  console.log(JSON.stringify({worker:'saved_draft',state:'disabled'}));return;
 }
 if(typeof TIVDOC_SAVED_WORKER_BUILD_SHA==='undefined'||TIVDOC_SAVED_WORKER_DIRTY_BUILD)throw new Error('SAVED_WORKER_CLEAN_BUILD_REQUIRED');
 const {runSavedWorkerCommand}=await import('../../src/server/product/processing/saved-worker-command');
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const timer=setTimeout(stop,10*60*1000);
 try{
  const result=await runSavedWorkerCommand(process.env,TIVDOC_SAVED_WORKER_BUILD_SHA,controller.signal);console.log(JSON.stringify(result));
  if(['dead_letter','retry_wait','held','cancelled'].includes(result.state))process.exitCode=1;
 }finally{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{
 const safe=new Set(['SAVED_WORKER_CLEAN_BUILD_REQUIRED','SAVED_HOST_CONFIGURATION_INVALID','SAVED_REPLAY_NOT_COMPLETE']);
 console.log(JSON.stringify({worker:'saved_draft',state:'failed',code:error instanceof Error&&safe.has(error.message)?error.message:'SAVED_WORKER_EXECUTION_FAILED'}));process.exitCode=1;
});
