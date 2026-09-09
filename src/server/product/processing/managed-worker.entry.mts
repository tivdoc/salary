declare const TIVDOC_MANAGED_WORKER_BUILD_SHA:string;
declare const TIVDOC_MANAGED_WORKER_DIRTY_BUILD:boolean;

async function main(){
 if(process.env.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true'){
  console.log(JSON.stringify({worker:'managed_dev',state:'disabled'}));return;
 }
 if(typeof TIVDOC_MANAGED_WORKER_BUILD_SHA==='undefined'||TIVDOC_MANAGED_WORKER_DIRTY_BUILD)throw Error('MANAGED_DEV_CLEAN_BUILD_REQUIRED');
 const [{runManagedDevTick},{runAutomaticDevMonth}]=await Promise.all([import('./managed-worker-host'),import('./automatic-dev-flow')]);
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 // Bounded graceful shutdown between units; the provider itself has a timeout.
 // A forced OS shutdown relies on DB fencing and immutable invocation recovery.
 const timer=setTimeout(stop,8*60*1000);
 try{
  const result=await runManagedDevTick(process.env,TIVDOC_MANAGED_WORKER_BUILD_SHA,runAutomaticDevMonth,controller.signal);
  const {runManagedDevNotificationTick}=await import('./automatic-dev-notifications');
  const notifications=await runManagedDevNotificationTick({...process.env,TIVDOC_MANAGED_DEV_BUILD_SHA:TIVDOC_MANAGED_WORKER_BUILD_SHA});
  console.log(JSON.stringify({...result,notifications}));
  if(result.state==='interrupted'||result.state==='blocked'||notifications.state==='blocked'||result.items.some(item=>['dead_letter','retry_wait','held','unconfirmed'].includes(item.state)))process.exitCode=1;
 }finally{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{
 const codes=new Set(['MANAGED_DEV_CLEAN_BUILD_REQUIRED','MANAGED_DEV_CONFIGURATION_INVALID','MANAGED_DEV_PROVIDER_UNCONFIGURED','MANAGED_DEV_STORAGE_UNCONFIGURED','MANAGED_DEV_BUILD_MISMATCH']);
 console.log(JSON.stringify({worker:'managed_dev',state:'failed',code:error instanceof Error&&codes.has(error.message)?error.message:'MANAGED_DEV_EXECUTION_FAILED'}));process.exitCode=1;
});
