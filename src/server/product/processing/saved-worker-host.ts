import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {startCanonicalPostgresComposition,requireIsolatedCanonicalPostgres,
 type CanonicalPostgresTarget,type CanonicalVerifiedRuntimeIdentity} from '@/server/platform/composition/canonical-postgres';
import {createPostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/transaction-manager';
import {statement} from '@/server/platform/persistence/postgres/contracts';
import {savedCaseTenant} from './saved-admission';
import type {SavedWorkerTransactions} from './saved-extraction-worker';

export type SavedWorkerHostInput={caseId:string;identity:CanonicalVerifiedRuntimeIdentity;buildSha:string;target:CanonicalPostgresTarget};

/** Bind one externally provisioned machine session to the canonical transaction
 * root. Reinstall and verify that identity on EVERY transaction; never SET ROLE
 * or trust tenant GUCs supplied by a host. The host owns closing its driver.
 * This release host remains restricted to declared disposable databases. */
export async function createSavedWorkerHost(input:SavedWorkerHostInput,driver:PostgresConnectionFactory):Promise<SavedWorkerTransactions>{
 z.uuid().parse(input.caseId);
 if(input.identity.tenant_id!==savedCaseTenant(input.caseId)||input.identity.reviewer_organization_id!==null)throw new Error('SAVED_WORKER_SCOPE_FORBIDDEN');
 // Snapshot host coordinates so a scheduler cannot switch the case/identity
 // under an in-flight heartbeat or change the build pin after initialization.
 const caseId=input.caseId,identity=Object.freeze({...input.identity});
 const root=requireIsolatedCanonicalPostgres(await startCanonicalPostgresComposition({
  mode:'isolated_postgres',execution_boundary:'non_test',target:input.target,build_identity_sha:input.buildSha,
 },{runtime_connection_factories:{worker:driver},
  // Intake writes are not part of this host. Analysis adapters are supplied by
  // the canonical root and the saved worker uses its same transaction context.
  intake_factory:()=>Object.freeze({}),analysis_factory:createPostgresAnalysisRepositories,
 }));
 return async operation=>{
  let operationFailure:{error:unknown}|undefined;
  try{
   return await root.verified_transaction({identity,runtime_role:'worker',case_id:caseId,correlation_id:`saved-host:${randomUUID()}`},async bundle=>{
    const principal=await bundle.context.client.query(statement('saved_host_principal',
     'select session_user::text principal,private.runtime_verified_tenant() tenant_id',[]));
    if(principal.rows[0]?.principal!=='tivdoc_worker_runtime'||principal.rows[0]?.tenant_id!==identity.tenant_id)throw new Error('SAVED_WORKER_SCOPE_FORBIDDEN');
    await bundle.context.client.query(statement('saved_host_timeouts',
     "select set_config('statement_timeout','30000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)",[]));
    try{return await operation(bundle.context);}
    catch(error){operationFailure={error};throw error;}
   });
  }catch(error){
   // The canonical root rolls back before this boundary. Preserve application
   // failures for missing-document/provider holds; infrastructure failures keep
   // the canonical driver's safe classification (including commit uncertainty).
   if(operationFailure)throw operationFailure.error;
   throw error;
  }
 };
}
