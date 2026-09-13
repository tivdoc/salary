import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {realServiceActivationContextSchema,realServiceActivationSelectorSchema,realServiceActivationReceiptSchema,
 assertRealServiceActivationContext,type RealServiceActivationSelector} from './real-service-activation-contract';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
export const realServiceDeploymentAuthorizationSchema=z.object({
 schema_version:z.literal('real-service-deployment-successor-v1'),sha256:hash,
 predecessor_plan_sha256:hash,successor_plan_sha256:hash,authorization_evidence_sha256:hash,
 issued_at:time,expires_at:time,
}).strict().superRefine(({sha256,...body},ctx)=>{
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'REAL_DEPLOYMENT_AUTHORIZATION_HASH'});
});
const successorSchema=realServiceActivationContextSchema.options[1].extend({
 transition:z.literal('deployment_successor'),deployment_authorization:realServiceDeploymentAuthorizationSchema,
 prior_enrollment:realServiceActivationContextSchema.options[1].shape.prior_enrollment.unwrap(),
});
/** An authenticated successor response must bind the same paid scope and a
 * separately registered deployment approval. Parsing an approval never grants it. */
export function assertRealServiceDeploymentSuccessor(candidate:unknown,selector:RealServiceActivationSelector,build:string){
 if(typeof candidate==='object'&&candidate!==null&&'transition' in candidate&&candidate.transition==='deployment_successor'){
  const row=successorSchema.parse(candidate),plan=row.plan,prior=row.prior_enrollment,approval=row.deployment_authorization;
  const assert=(ok:unknown,code:string)=>{if(!ok)throw Error(code);};
  assert(canonicalSha256(row.selector)===canonicalSha256(selector),'REAL_ACTIVATION_SELECTOR_CHANGED');
  assert(plan.sha256===selector.plan_sha256&&plan.state==='active'&&plan.build_manifest_sha256===build,'REAL_DEPLOYMENT_PLAN_CHANGED');
  const at=Date.parse(row.evaluated_at),until=Date.parse(row.expires_at);
  assert(at>=Date.parse(plan.issued_at)&&at<Date.parse(plan.expires_at)&&until>at&&until<=Date.parse(plan.expires_at)
   &&at>=Date.parse(approval.issued_at)&&until<=Date.parse(approval.expires_at),'REAL_DEPLOYMENT_EXPIRED');
  for(const pin of ['configuration_sha256','service_decision_sha256','population','environment','database_name','target_id','deployment_sha256','machine_issuer_sha256','provider_budget_policy_sha256'] as const)
   assert(row[pin]===plan[pin],'REAL_ACTIVATION_CONTEXT_CHANGED');
  assert(prior.state==='granted','REAL_ACTIVATION_NO_RESURRECTION');
  assert(prior.plan_sha256!==plan.sha256&&approval.predecessor_plan_sha256===prior.plan_sha256
   &&approval.successor_plan_sha256===plan.sha256,'REAL_DEPLOYMENT_PREDECESSOR_CHANGED');
  assert(prior.purchased_scope_sha256===row.purchased_scope_sha256,'REAL_DEPLOYMENT_PURCHASE_CHANGED');
  return row;
 }
 const row=assertRealServiceActivationContext(candidate,selector,build);
 if(row.state==='eligible'&&row.transition!=='replay')throw Error('REAL_DEPLOYMENT_SUCCESSOR_REQUIRED');
 return row;
}

/** Explicit runtime path for an already enrolled case moving to a separately
 * approved deployment. SQL derives approval and identity; caller supplies only
 * current source selectors. Normal enrollment and paid extension keep their API. */
export async function prepareRealServiceDeploymentSuccessor(context:PostgresTransactionContext,candidate:RealServiceActivationSelector){
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_ENROLLMENT_ENABLED!=='1')throw Error('REAL_ACTIVATION_DISABLED');
 const selector=realServiceActivationSelectorSchema.parse(candidate),build=getCompiledAiReleaseBuild().manifest.sha256;
 const capability=process.env.TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY;
 if(!capability||!/^[A-Za-z0-9._-]{32,256}$/u.test(capability))throw Error('REAL_ACTIVATION_CONTROLLER_UNCONFIGURED');
 const values=[capability,selector.case_id,selector.identity_id,selector.source_revision,selector.source_sha256,selector.plan_sha256,build];
 const loaded=await context.client.query(statement('real_service_deployment_successor_context',
  'select private.real_service_deployment_successor_context($1,$2::uuid,$3::uuid,$4::integer,$5,$6,$7) value',values));
 if(loaded.row_count!==1)throw Error('REAL_ACTIVATION_CONTEXT_ACK');
 const row=assertRealServiceDeploymentSuccessor(loaded.rows[0]?.value,selector,build);
 if(row.state==='unavailable')return row;
 const result=await context.client.query(statement('real_service_deployment_successor_enroll',
  'select private.real_service_deployment_successor_enroll($1,$2::uuid,$3::uuid,$4::integer,$5,$6,$7,$8) value',[...values,row.context_sha256]));
 if(result.row_count!==1)throw Error('REAL_ACTIVATION_ENROLL_ACK');
 const receipt=realServiceActivationReceiptSchema.parse(result.rows[0]?.value);
 if(receipt.state==='unavailable')return receipt;
 if(canonicalSha256(receipt.selector)!==canonicalSha256(selector)||receipt.context_sha256!==row.context_sha256
  ||receipt.purchased_scope_sha256!==row.purchased_scope_sha256||receipt.expires_at!==row.expires_at
  ||row.transition==='deployment_successor'&&(receipt.event_id===row.prior_enrollment.event_id||receipt.predecessor_event_id!==row.prior_enrollment.event_id)
  ||row.transition==='replay'&&(receipt.event_id!==row.prior_enrollment?.event_id||!receipt.replayed))throw Error('REAL_ACTIVATION_ENROLLMENT_CHANGED');
 return receipt;
}
