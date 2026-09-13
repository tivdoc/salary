import 'server-only';
import {z} from 'zod';
import {deepFreeze} from '@/engine/rule-runtime/canonical';
import {CANONICAL_POSTGRES_SCHEMA_VERSION} from '@/server/platform/composition/canonical-postgres';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {prepareRealServiceActivationEnrollment} from './real-service-activation';
import {realServiceActivationSelectorSchema} from './real-service-activation-contract';
import type {RealServiceWorkerTarget} from './real-service-worker-host';

/** Durable purchase/source consumer. The ordinary verified-payment and source
 * writers already update case_input_heads. Only a new eligible paid scope is
 * selected; a source-only advance retains the existing enrollment and expiry.
 * Selection and the existing enrollment CAS share this controller transaction. */
export async function enrollCurrentPaidRealServiceSources(context:PostgresTransactionContext,input:{target:RealServiceWorkerTarget;planSha256:string;limit:number}){
 const items:Array<{case_id:string;receipt:Awaited<ReturnType<typeof prepareRealServiceActivationEnrollment>>}>=[];
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_ENROLLMENT_ENABLED!=='1')return {state:'disabled' as const,items};
 const plan=z.string().regex(/^[a-f0-9]{64}$/u).parse(input.planSha256),limit=z.number().int().min(1).max(2).parse(input.limit),target=deepFreeze({...input.target}),
  capability=process.env.TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY;
 if(!capability||!/^[A-Za-z0-9._-]{32,256}$/u.test(capability))throw Error('REAL_ACTIVATION_CONTROLLER_UNCONFIGURED');
 const actual=await context.client.query(statement('real_service_paid_source_actual',
  `select current_database() database,session_user::text principal,
   (select schema_version from public.engine_schema_metadata where component='canonical_postgresql_composition') schema_version`,[]));
 if(actual.row_count!==1||actual.rows.length!==1||actual.rows[0].database!==target.database||actual.rows[0].principal!=='tivdoc_worker_runtime'
  ||actual.rows[0].schema_version!==CANONICAL_POSTGRES_SCHEMA_VERSION)throw Error('REAL_SERVICE_CONTROLLER_DATABASE');
 const selected=await context.client.query(statement('real_service_paid_source_selectors',
  'select private.real_service_paid_source_selectors($1,$2,$3,$4::jsonb,$5::integer) value',
  [capability,plan,getCompiledAiReleaseBuild().manifest.sha256,JSON.stringify({target_id:target.target_id,database_name:target.database,
   environment:target.environment,deployment_sha256:target.deployment_sha256,machine_issuer_sha256:target.machine_issuer_sha256,
   provider_budget_policy_sha256:target.provider_budget_policy_sha256}),limit]));
 if(selected.row_count!==1||selected.rows.length!==1)throw Error('REAL_SERVICE_PAID_SOURCE_ACK');
 const selectors=deepFreeze(z.array(realServiceActivationSelectorSchema).max(2).parse(selected.rows[0].value));
 if(selectors.length>limit||selectors.some(s=>s.plan_sha256!==plan)||new Set(selectors.map(s=>s.case_id)).size!==selectors.length)throw Error('REAL_SERVICE_PAID_SOURCE_SCOPE');
 for(const selector of selectors){
  // The existing helper reloads exact paid receipts/terms/identity/current
  // source under the same locks; nothing in a selector manufactures authority.
  const receipt=await prepareRealServiceActivationEnrollment(context,selector);
  items.push({case_id:selector.case_id,receipt});
 }
 return deepFreeze({state:'finished' as const,items});
}
