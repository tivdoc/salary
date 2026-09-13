import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {createJune2026RegularAuthority} from '@/engine/minimum-wage-june2026/regular-service/authority';
import type {June2026RegularAuthorityInput} from '@/engine/minimum-wage-june2026/regular-service/contracts';
import {signedHumanDecisionEnvelopeSchema} from '@/engine/legal-operations/human-trust';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {replaySavedRegularTrust,savedRegularTrustJournalSchema} from './saved-regular-trust';
import {savedMonthIdempotencyKey} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const registrySchema=z.object({registry:z.object({namespace:z.enum(['real','isolated_test']),organization_id:z.string(),organization_version:z.string(),policy_version:z.string()}).strict(),
 trust_journal:savedRegularTrustJournalSchema,legal:z.unknown()}).strict();
const loadedSchema=z.object({state:z.literal('loaded'),registry:registrySchema,registry_sha256:sha,registry_revision:z.number().int().positive(),
 assessment:z.object({payload:z.unknown(),envelope:signedHumanDecisionEnvelopeSchema}).strict(),assessment_sha256:sha,evaluated_at:z.string()}).strict();
const issued=new WeakSet<object>();
export const JUNE_REGULAR_READING_POLICY='identified-agreeing-candidates-v1' as const;
export function june2026RegularReviewIdempotencyKey(job:SourceJob,orderId:string){
 return `june-regular-review:${canonicalSha256({base:savedMonthIdempotencyKey(job,orderId,'2026-06'),composition:'june2026-regular-service-v3',reading_policy:JUNE_REGULAR_READING_POLICY})}`;
}
export async function loadSavedJune2026RegularAuthority(context:PostgresTransactionContext,job:SourceJob,orderId:string){
 const rows=await context.client.query(statement('june_regular_authority',
  'select private.june2026_regular_authority($1::uuid,$2::uuid,$3,$4) authority',[job.case_id,orderId,job.revision,job.input_sha256]));
 if(rows.rows.length!==1)throw Error('REGULAR_AUTHORITY_ACK');
 const raw=rows.rows[0].authority;
 if(raw===null)return null;
 if(z.object({state:z.literal('blocked'),reason:z.string()}).safeParse(raw).success)
  return deepFreeze({state:'blocked' as const,blockers:[z.object({reason:z.string()}).parse(raw).reason]});
 const value=loadedSchema.parse(raw),evaluatedAt=new Date(value.evaluated_at).toISOString();
 if(canonicalSha256(value.registry)!==value.registry_sha256||canonicalSha256(value.assessment)!==value.assessment_sha256)throw Error('REGULAR_AUTHORITY_HASH');
 const mode=value.registry.registry.namespace==='real'?'real' as const:'synthetic_test' as const;
 // The composition validates all imported artifact/event payloads. JSON is
 // never cast to an authority; only its verified factory can issue the brand.
 const checked=createJune2026RegularAuthority({mode,evaluatedAt,
  registry:{...value.registry.registry,registry_sha256:value.registry_sha256},
  trust:replaySavedRegularTrust(value.registry.trust_journal,evaluatedAt),
  legal:value.registry.legal as June2026RegularAuthorityInput['legal'],assessment:value.assessment});
 if(checked.state!=='ready')return checked;
 const result=deepFreeze({state:'ready' as const,authority:checked.authority,mode,registry_sha256:value.registry_sha256,
  registry_revision:value.registry_revision,assessment_sha256:value.assessment_sha256,evaluated_at:evaluatedAt,
  scope:{case_id:job.case_id,order_id:orderId,input_revision:job.revision,input_sha256:job.input_sha256}});
 issued.add(result);return result;
}
export type SavedJune2026RegularAuthority=Extract<NonNullable<Awaited<ReturnType<typeof loadSavedJune2026RegularAuthority>>>,{state:'ready'}>;
export function assertSavedJune2026RegularAuthority(value:SavedJune2026RegularAuthority,job:SourceJob,orderId:string){
 if(!issued.has(value)||value.scope.case_id!==job.case_id||value.scope.order_id!==orderId
  ||value.scope.input_revision!==job.revision||value.scope.input_sha256!==job.input_sha256)throw Error('REGULAR_LOADED_AUTHORITY_REQUIRED');
}
export function june2026RegularIdempotencyKey(job:SourceJob,orderId:string,value:SavedJune2026RegularAuthority){
 assertSavedJune2026RegularAuthority(value,job,orderId);
 return `june-regular:${canonicalSha256({base:savedMonthIdempotencyKey(job,orderId,'2026-06'),registry:value.registry_sha256,
  assessment:value.assessment_sha256,composition:'june2026-regular-service-v3',reading_policy:JUNE_REGULAR_READING_POLICY})}`;
}
