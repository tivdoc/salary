declare const TIVDOC_REAL_SERVICE_BUILD_SHA:string;
declare const TIVDOC_REAL_SERVICE_DIRTY_BUILD:boolean;

async function main(){
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'){
  console.log(JSON.stringify({worker:'real_service',state:'disabled'}));return;
 }
 if(process.argv.length!==2)throw Error('REAL_SERVICE_ARGUMENT_INVALID');
 if(typeof TIVDOC_REAL_SERVICE_BUILD_SHA==='undefined'||TIVDOC_REAL_SERVICE_DIRTY_BUILD)throw Error('REAL_SERVICE_CLEAN_BUILD_REQUIRED');
 const {runRealServiceRuntime}=await import('./real-service-runtime');
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const timer=setTimeout(stop,8*60*1000);
 try{
  const result=await runRealServiceRuntime(process.env,TIVDOC_REAL_SERVICE_BUILD_SHA,controller.signal);
  console.log(JSON.stringify({worker:'real_service',buildSha:TIVDOC_REAL_SERVICE_BUILD_SHA,...result}));
  if(['unconfirmed','interrupted','held'].includes(result.state)
   ||result.iteration?.items.some(item=>['unconfirmed','dead_letter','retry_wait','cancelled','held'].includes(item.processing.state)
    ||['unconfirmed','held','interrupted'].includes(item.notification.state)||item.host==='close_unconfirmed')
   ||'machines' in result&&result.machines.some(machine=>machine.state==='unavailable')
   ||'enrollments' in result&&(result.enrollments?.state==='unconfirmed'||result.enrollments?.state==='finished'&&result.enrollments.items.some(item=>item.receipt.state==='unavailable')))process.exitCode=1;
 }finally{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{
 const allowed=new Set(['REAL_SERVICE_ARGUMENT_INVALID','REAL_SERVICE_CLEAN_BUILD_REQUIRED','REAL_SERVICE_RUNTIME_CONFIGURATION',
  'REAL_SERVICE_RUNTIME_BUILD_CHANGED','REAL_SERVICE_RUNTIME_STORAGE_REQUIRED','REAL_SERVICE_RUNTIME_NOTIFICATION_REQUIRED']);
 console.log(JSON.stringify({worker:'real_service',state:'failed',code:error instanceof Error&&allowed.has(error.message)?error.message:'REAL_SERVICE_EXECUTION_FAILED'}));
 process.exitCode=1;
});
