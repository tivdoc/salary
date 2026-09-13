import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {AI_RELEASE_TOPICS} from '@/engine/ai-release/contracts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const month=z.string().regex(/^2026-(05|06|07)$/u);
const identifier=z.string().min(1).max(200);
/** Registration input only. Parsing this record never activates a plan,
 * authorizes a machine, reserves provider spend or establishes consent. */
export const realServiceActivationPlanSchema=z.object({
 schema_version:z.literal('tivdoc-real-service-activation-plan-v1'),plan_id:z.uuid(),revision:z.number().int().positive(),
 state:z.enum(['active','revoked']),purpose:z.literal('real_customer_service'),namespace:z.literal('real'),
 configuration_sha256:hash,service_decision_sha256:hash,build_manifest_sha256:hash,population:identifier,
 environment:z.enum(['development','preview','production','test']),database_name:identifier,target_id:identifier,deployment_sha256:hash,
 period:z.object({from:month,to:month}).strict(),topics:z.array(z.enum(AI_RELEASE_TOPICS)).min(1).max(9),
 purchase:z.object({offer_version:z.literal('tivdoc-order-offer-v3'),purchase_topics_version:z.literal('tivdoc-purchase-topics-v2'),
  terms_versions:z.array(z.string().min(4).max(40)).min(1).max(8)}).strict(),
 machine_issuer_sha256:hash,provider_budget_policy_sha256:hash,activation_evidence_sha256:hash,
 issued_at:time,expires_at:time,sha256:hash,
}).strict().superRefine((v,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const {sha256,...body}=v;
 if(canonicalSha256(body)!==sha256)fail('REAL_ACTIVATION_PLAN_HASH');
 if(Date.parse(v.issued_at)>=Date.parse(v.expires_at))fail('REAL_ACTIVATION_PLAN_WINDOW');
 if(v.period.from>v.period.to)fail('REAL_ACTIVATION_PLAN_PERIOD');
 if(new Set(v.topics).size!==v.topics.length||new Set(v.purchase.terms_versions).size!==v.purchase.terms_versions.length)fail('REAL_ACTIVATION_PLAN_DUPLICATE_SCOPE');
});
export type RealServiceActivationPlan=z.infer<typeof realServiceActivationPlanSchema>;
/** Per-transaction host response after ordinary machine context installation.
 * A host must independently compare its configured target/build/issuer pins. */
export const realServiceActivationWorkerContextSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unavailable'),reason:z.enum(['not_enrolled','revoked','expired','scope_changed'])}).strict(),
 z.object({state:z.literal('authorized'),plan:realServiceActivationPlanSchema,case_id:z.uuid(),identity_id:z.uuid(),
  enrollment_id:z.uuid(),evaluated_at:time,expires_at:time,authority_dependency_sha256:hash}).strict(),
]);
export const realServiceActivationSelectorSchema=z.object({case_id:z.uuid(),identity_id:z.uuid(),source_revision:z.number().int().positive(),
 source_sha256:hash,plan_sha256:hash}).strict();
export type RealServiceActivationSelector=z.infer<typeof realServiceActivationSelectorSchema>;
export const REAL_SERVICE_ACTIVATION_REFUSALS=['not_eligible','not_registered','revoked','expired','scope_changed','source_changed','identity_unverified','terms_incompatible'] as const;
const refusal=z.object({state:z.literal('unavailable'),reason:z.enum(REAL_SERVICE_ACTIVATION_REFUSALS)}).strict();
export const realServiceActivationContextSchema=z.discriminatedUnion('state',[
 refusal,
 z.object({state:z.literal('eligible'),selector:realServiceActivationSelectorSchema,plan:realServiceActivationPlanSchema,
  transition:z.enum(['initial_enrollment','replay','paid_scope_extension']),
  context_sha256:hash,evaluated_at:time,expires_at:time,purchased_scope_sha256:hash,
  configuration_sha256:hash,service_decision_sha256:hash,population:identifier,
  environment:z.enum(['development','preview','production','test']),database_name:identifier,target_id:identifier,deployment_sha256:hash,
  machine_issuer_sha256:hash,provider_budget_policy_sha256:hash,
  prior_enrollment:z.object({event_id:z.uuid(),state:z.enum(['granted','revoked']),plan_sha256:hash,purchased_scope_sha256:hash}).strict().nullable(),
 }).strict(),
]);
export const realServiceActivationReceiptSchema=z.discriminatedUnion('state',[
 refusal,
 z.object({state:z.literal('enrolled'),selector:realServiceActivationSelectorSchema,event_id:z.uuid(),replayed:z.boolean(),
  predecessor_event_id:z.uuid().nullable(),
  context_sha256:hash,purchased_scope_sha256:hash,authority_dependency_sha256:hash,expires_at:time}).strict(),
]);
/** Independent verification of an authenticated DB response. A compatible
 * plan is still only enrollment authority; every execution/delivery reloads
 * its existing REAL configuration and service action evidence. */
export function assertRealServiceActivationContext(candidate:unknown,selector:RealServiceActivationSelector,buildManifestSha256:string){
 const row=realServiceActivationContextSchema.parse(candidate);
 if(row.state==='unavailable')return row;
 const assert=(ok:unknown,code:string)=>{if(!ok)throw Error(code);};
 assert(canonicalSha256(row.selector)===canonicalSha256(selector),'REAL_ACTIVATION_SELECTOR_CHANGED');
 const plan=row.plan,at=Date.parse(row.evaluated_at);
 assert(plan.sha256===selector.plan_sha256&&plan.state==='active','REAL_ACTIVATION_PLAN_REVOKED');
 assert(plan.build_manifest_sha256===buildManifestSha256,'REAL_ACTIVATION_BUILD_CHANGED');
 assert(at>=Date.parse(plan.issued_at)&&at<Date.parse(plan.expires_at)&&at<Date.parse(row.expires_at)
  &&Date.parse(row.expires_at)<=Date.parse(plan.expires_at),'REAL_ACTIVATION_EXPIRED');
 for(const pin of ['configuration_sha256','service_decision_sha256','population','environment','database_name','target_id','deployment_sha256','machine_issuer_sha256','provider_budget_policy_sha256'] as const)
  assert(row[pin]===plan[pin],'REAL_ACTIVATION_CONTEXT_CHANGED');
 if(row.prior_enrollment){
  assert(row.prior_enrollment.state==='granted','REAL_ACTIVATION_NO_RESURRECTION');
  assert(row.prior_enrollment.plan_sha256===plan.sha256,'REAL_ACTIVATION_EXISTING_SCOPE_CHANGED');
  const unchanged=row.prior_enrollment.purchased_scope_sha256===row.purchased_scope_sha256;
  assert(unchanged?row.transition==='replay':row.transition==='paid_scope_extension','REAL_ACTIVATION_SCOPE_TRANSITION');
 }else assert(row.transition==='initial_enrollment','REAL_ACTIVATION_SCOPE_TRANSITION');
 return row;
}
