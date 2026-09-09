import {resolveProductSessionBoundary} from '@/server/product/auth/runtime';
import {readStableProductRouteFlags} from '@/server/product/routes/flags';
import {resolveCanonicalOperationsService} from '@/server/product/routes/runtime';
import {productNotFound,refusedEntrypoint} from '@/server/product/routes/http-common';
import {guardStableHttpEntrypoint} from '@/server/platform/capabilities/stable-http-entrypoint';
import {createManagedWorkerHttpHandler} from '@/server/product/processing/managed-worker-http';
import {readManagedDevStatus,retryManagedDevJob} from '@/server/product/processing/managed-worker-host';

export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request){
 try{await guardStableHttpEntrypoint('CEP-020',request);}catch(error){return refusedEntrypoint(error);}
 const sessions=resolveProductSessionBoundary();if(!sessions)return productNotFound('SESSION_BOUNDARY_ABSENT');
 if(!resolveCanonicalOperationsService())return productNotFound('SERVICE_ABSENT');
 return createManagedWorkerHttpHandler({enabled:readStableProductRouteFlags().operationsApi&&process.env.TIVDOC_MANAGED_DEV_WORKER_ENABLED==='true',sessions,
  read:readManagedDevStatus,retry:retryManagedDevJob,ownerId:process.env.TIVDOC_SUPPORT_OWNER_ACTOR_ID})(request);
}
export const GET=handle;
export const POST=handle;
