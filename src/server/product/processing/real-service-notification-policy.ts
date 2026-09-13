import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const termsVersion=z.string().min(4).max(40);
const origin=z.url().refine(value=>{
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/';
 }catch{return false;}
},'REAL_NOTIFICATION_POLICY_ORIGIN');
// Shared with SQL216: DNS names only (final label begins with a letter),
// bounded labels/host and decimal port 1..65535; preserve supplied bytes.
const policyOriginPattern=/^https:\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?::([1-9][0-9]{0,4}))?\/?$/u;
export function isRealNotificationPolicyOrigin(value:string){
 const matched=policyOriginPattern.exec(value);
 return matched!==null&&matched[1].length<=253&&(matched[2]===undefined||Number(matched[2])<=65535);
}
const policyOrigin=z.string().refine(isRealNotificationPolicyOrigin,'REAL_NOTIFICATION_POLICY_ORIGIN');
function integrity(value:{sha256:string;issued_at:string;expires_at:string},ctx:z.RefinementCtx){
 const {sha256,...body}=value;
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'REAL_NOTIFICATION_POLICY_HASH'});
 if(Date.parse(value.issued_at)>=Date.parse(value.expires_at))ctx.addIssue({code:'custom',message:'REAL_NOTIFICATION_POLICY_WINDOW'});
}
/** Registration data only. A valid hash is not operator approval or customer
 * consent. SQL binds this policy to an already registered REAL plan, retained
 * terms evidence and current authority; this schema creates none of them. */
export const realServiceNotificationPolicySchema=z.object({
 schema_version:z.literal('tivdoc-real-service-notification-policy-v1'),policy_id:z.uuid(),revision:z.number().int().positive(),
 state:z.enum(['active','revoked']),namespace:z.literal('real'),purpose:z.literal('real_service_report_notifications'),
 plan_sha256:hash,service_decision_sha256:hash,template:z.literal('real-ai-report-ready-v1'),origin:policyOrigin,
 purchase_terms:z.array(z.object({version:termsVersion,evidence_sha256:hash}).strict()).min(1).max(8),
 evidence_sha256:hash,issued_at:time,expires_at:time,sha256:hash,predecessor_policy_sha256:hash.nullable(),
}).strict().superRefine((v,ctx)=>{
 integrity(v,ctx);
 if((v.revision===1)!==(v.predecessor_policy_sha256===null))ctx.addIssue({code:'custom',message:'REAL_NOTIFICATION_POLICY_PREDECESSOR'});
 if(new Set(v.purchase_terms.map(t=>t.version)).size!==v.purchase_terms.length)ctx.addIssue({code:'custom',message:'REAL_NOTIFICATION_POLICY_DUPLICATE_TERMS'});
});
export type RealServiceNotificationPolicy=z.infer<typeof realServiceNotificationPolicySchema>;

const parent={authorization_id:z.uuid(),state:z.enum(['active','revoked']),namespace:z.literal('real'),
 purpose:z.literal('real_service_report_notifications'),scope:z.literal('current_real_reports'),case_id:z.uuid(),identity_id:z.uuid(),
 service_decision_sha256:hash,recipient_sha256:hash,origin,template:z.literal('real-ai-report-ready-v1'),issued_at:time,expires_at:time,sha256:hash};
/** v1 is the immutable manual parent already stored by SQL202. v2 identifies
 * worker derivation honestly and pins actual saved acceptance/contact facts;
 * neither schema permits a fabricated identity-signed consent assertion. */
export const realAiServiceNotificationAuthorizationSchema=z.discriminatedUnion('schema_version',[
 z.object({schema_version:z.literal('tivdoc-real-ai-service-notification-authorization-v1'),...parent,
  authorization_source:z.object({kind:z.literal('operator_case_grant'),evidence_sha256:hash}).strict()}).strict(),
 z.object({schema_version:z.literal('tivdoc-real-ai-service-notification-authorization-v2'),...parent,origin:policyOrigin,
  authorization_source:z.object({kind:z.literal('registered_transactional_policy'),policy_sha256:hash,evidence_sha256:hash,
   enrollment_id:z.uuid(),order_id:z.uuid(),order_offer_sha256:hash,terms_version:termsVersion,terms_evidence_sha256:hash,
   terms_accepted_at:time,contact_verified_at:time}).strict()}).strict(),
]).superRefine((v,ctx)=>{
 integrity(v,ctx);
 if(v.schema_version==='tivdoc-real-ai-service-notification-authorization-v2'
  &&[v.authorization_source.terms_accepted_at,v.authorization_source.contact_verified_at].some(t=>Date.parse(t)>Date.parse(v.issued_at)))
  ctx.addIssue({code:'custom',message:'REAL_NOTIFICATION_PARENT_EVIDENCE_TIME'});
});
export type RealAiServiceNotificationAuthorization=z.infer<typeof realAiServiceNotificationAuthorizationSchema>;
