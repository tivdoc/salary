import 'server-only';
import {runManagedDevTick,readManagedDevHealth,readManagedDevStatus} from './managed-worker-host';
import {runManagedDevNotificationTick} from './automatic-dev-notifications';
import {managedWorkerError} from './managed-worker-contract';
import type {SavedMonthCompletion} from './saved-job-runner';

/** Each phase has a separate effect/error boundary. A blocked OCR package
 * cannot silently suppress configured notifications or read-only health. */
export async function runManagedDevIteration(env:Readonly<Record<string,string|undefined>>,buildSha:string,onMonth:SavedMonthCompletion,signal:AbortSignal){
 const scoped={...env,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha};
 const processing=await runManagedDevTick(scoped,buildSha,onMonth,signal).catch(error=>({worker:'managed_dev',state:'failed' as const,code:managedWorkerError(error),items:[]}));
 const notifications=await runManagedDevNotificationTick(scoped,signal).catch(()=>({state:'failed' as const,code:'notification_processing_failed'}));
 const health=signal.aborted?{state:'interrupted' as const}:await readManagedDevHealth(scoped)
  .then(data=>({state:data?'available' as const:'disabled' as const,data}))
  .catch(()=>({state:'unavailable' as const,code:'managed_health_unavailable'}));
 return {...processing,notifications,health};
}

/** Machine capability remains mandatory, but no provider key is needed. */
export async function readManagedDevOperations(env:Readonly<Record<string,string|undefined>>,buildSha:string){
 const scoped={...env,TIVDOC_MANAGED_DEV_BUILD_SHA:buildSha};
 const rows=await readManagedDevStatus(scoped),health=await readManagedDevHealth(scoped);
 return {worker:'managed_dev',state:'status' as const,buildSha,rows,health};
}
