import 'server-only';
import {z} from 'zod';
import type {ProductSessionBoundary} from '../auth/runtime';
import {productJson,productNotFound,strictJsonObject} from '../routes/http-common';
import {requireSupportOwner} from '../reports/support';
import type {readManagedDevStatus,readManagedDevHealth,retryManagedDevJob} from './managed-worker-host';

/** Reuses the actual operations session/CSRF boundary and configured owner.
 * No worker scheduler secret is exposed in a page or accepted as user identity. */
export function createManagedWorkerHttpHandler(input:{enabled:boolean;sessions:Pick<ProductSessionBoundary,'verify'>;
 read:typeof readManagedDevStatus;readHealth?:typeof readManagedDevHealth;retry:typeof retryManagedDevJob;ownerId?:string}){
 return async(request:Request)=>{
  if(!input.enabled)return productNotFound('SURFACE_DISABLED');
  if(!['GET','POST'].includes(request.method))return productNotFound('PATH_NOT_ROUTED');
  const session=await input.sessions.verify(request,'operations',request.method==='POST');
  if(!session)return productNotFound('SESSION_UNVERIFIED');
  try{requireSupportOwner(session.actor,input.ownerId);}catch{return productNotFound('SESSION_UNVERIFIED');}
  if(request.method==='GET'){
   try{
    const data=await input.read();let health:Awaited<ReturnType<typeof readManagedDevHealth>>=null,healthUnavailable=false;
    if(input.readHealth)try{health=await input.readHealth();}catch{healthUnavailable=true;}
    return productJson({data,health,healthUnavailable});
   }catch{return productJson({code:'MANAGED_DEV_STATUS_UNAVAILABLE'},503);}
  }
  const parsed=z.object({action:z.literal('retry'),caseId:z.uuid(),jobId:z.string().min(1).max(160),expectedRevision:z.number().int().positive()}).strict().safeParse(await strictJsonObject(request,1024));
  if(!parsed.success)return productJson({code:'MANAGED_DEV_RETRY_INVALID'},400);
  try{
   const {caseId,jobId,expectedRevision}=parsed.data;
   return productJson({data:await input.retry({caseId,jobId,expectedRevision})});
  }catch{return productJson({code:'MANAGED_DEV_RETRY_REFUSED'},409);}
 };
}
