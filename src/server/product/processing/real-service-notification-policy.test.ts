import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {realServiceNotificationPolicySchema,realAiServiceNotificationAuthorizationSchema,isRealNotificationPolicyOrigin} from './real-service-notification-policy';
import {registerRealServiceNotificationPolicy} from './real-service-notification-policy-registration';
vi.mock('server-only',()=>({}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=(s:string)=>s.repeat(64);
const issued='2026-09-13T08:00:00Z',expires='2026-09-13T09:00:00Z';
const seal=<T extends Record<string,unknown>>(body:T)=>({...body,sha256:canonicalSha256(body)});
function policy(){return seal({schema_version:'tivdoc-real-service-notification-policy-v1',policy_id:id(1),revision:1,state:'active',namespace:'real',
 purpose:'real_service_report_notifications',plan_sha256:hash('a'),service_decision_sha256:hash('b'),template:'real-ai-report-ready-v1',origin:'https://synthetic.example',
 purchase_terms:[{version:'synthetic-notification-terms',evidence_sha256:hash('c')}],evidence_sha256:hash('d'),issued_at:issued,expires_at:expires,predecessor_policy_sha256:null});}
function parent(version:1|2){return seal({schema_version:`tivdoc-real-ai-service-notification-authorization-v${version}`,authorization_id:id(2),state:'active',
 namespace:'real',purpose:'real_service_report_notifications',scope:'current_real_reports',case_id:id(3),identity_id:id(4),service_decision_sha256:hash('b'),
 recipient_sha256:hash('e'),origin:'https://synthetic.example',template:'real-ai-report-ready-v1',issued_at:issued,expires_at:expires,
 authorization_source:version===1?{kind:'operator_case_grant',evidence_sha256:hash('d')}:{kind:'registered_transactional_policy',policy_sha256:policy().sha256,evidence_sha256:hash('d'),
  enrollment_id:id(5),order_id:id(6),order_offer_sha256:hash('f'),terms_version:'synthetic-notification-terms',terms_evidence_sha256:hash('c'),terms_accepted_at:issued,contact_verified_at:issued}});}
function changed(value:Record<string,unknown>,patch:Record<string,unknown>){const {sha256,...body}=value;void sha256;return seal({...body,...patch});}
function context(value:unknown,role='tivdoc_dev_migrator'):PostgresTransactionContext{
 return {transaction_id:'synthetic-no-db',client:{query:vi.fn(async s=>({row_count:1,rows:s.name==='real_notification_policy_operator'
  ?[{session_user:role,current_user:role}]:[{value}]}))}};
}
it('parses exact policy bytes without declaring authority or changing caller input',()=>{
 const p=policy(),before=JSON.stringify(p);expect(realServiceNotificationPolicySchema.parse(p)).toEqual(p);
 expect(JSON.stringify(p)).toBe(before);expect(Object.keys(p)).toHaveLength(16);expect(Object.keys(p.purchase_terms[0])).toHaveLength(2);
});
it.each([1,2] as const)('preserves canonical v%s parent bytes and exact schema field counts',version=>{
 const p=parent(version);expect(realAiServiceNotificationAuthorizationSchema.parse(p)).toEqual(p);
 expect(Object.keys(p)).toHaveLength(16);expect(Object.keys(p.authorization_source)).toHaveLength(version===1?2:10);
});
it.each([
 {namespace:'isolated_test'},{purpose:'real_customer_service'},{template:'marketing'},
 {human_attestation:'invented'},{consent:true},{expires_at:issued},{predecessor_policy_sha256:hash('a')},{revision:2},
 {purchase_terms:[]},{purchase_terms:[{version:'synthetic-terms',evidence_sha256:hash('a')},{version:'synthetic-terms',evidence_sha256:hash('b')}]},
 {purchase_terms:[{version:'synthetic-terms',evidence_sha256:hash('a'),accepted:true}]},
])('rejects policy scope/integrity ambiguity %j',patch=>{
 expect(realServiceNotificationPolicySchema.safeParse(changed(policy(),patch)).success).toBe(false);
});
it.each(['not-a-url','http://synthetic.example','https://user:secret@synthetic.example','https://synthetic.example/path','https://synthetic.example/?token=private','https://synthetic.example/#fragment'])('rejects non-origin %s',origin=>{
 expect(realServiceNotificationPolicySchema.safeParse(changed(policy(),{origin})).success).toBe(false);
});
it('requires unchanged reviewed hashes and permits explicit successor data without minting it',()=>{
 const p=policy();expect(realServiceNotificationPolicySchema.safeParse({...p,origin:'https://changed.example'}).success).toBe(false);
 const next=changed(p,{revision:2,predecessor_policy_sha256:p.sha256});expect(realServiceNotificationPolicySchema.parse(next)).toEqual(next);
});
it.each([1,2] as const)('does not let parent v%s claim the other authorization source',version=>{
 expect(realAiServiceNotificationAuthorizationSchema.safeParse(changed(parent(version),{authorization_source:parent(version===1?2:1).authorization_source})).success).toBe(false);
});
it.each(['terms_accepted_at','contact_verified_at'])('rejects v2 parent with future %s evidence',key=>{
 const p=parent(2);expect(realAiServiceNotificationAuthorizationSchema.safeParse(changed(p,{authorization_source:{...p.authorization_source,[key]:expires}})).success).toBe(false);
});
it('rejects a synthetic customer consent assertion added to derived provenance',()=>{
 const p=parent(2);expect(realAiServiceNotificationAuthorizationSchema.safeParse(changed(p,{authorization_source:{...p.authorization_source,customer_signed:true}})).success).toBe(false);
});
it('registers exact reviewed data through only the explicit operator RPC and repeats without renewal',async()=>{
 const p=policy(),db=context(p.sha256);
 await expect(registerRealServiceNotificationPolicy(db,p,null)).resolves.toEqual({policy_sha256:p.sha256,predecessor_policy_sha256:null});
 await registerRealServiceNotificationPolicy(db,p,null);
 const mutations=vi.mocked(db.client.query).mock.calls.map(([s])=>s).filter(s=>s.name==='real_notification_policy_register');
 expect(mutations).toHaveLength(2);expect(mutations[0]).toEqual(mutations[1]);
 expect(mutations[0].text).toBe('select private.real_ai_service_notification_policy_register($1::jsonb,$2::text) value');
 expect(mutations[0].values).toEqual([JSON.stringify(realServiceNotificationPolicySchema.parse(p)),null]);
});
it.each(['tivdoc_worker_runtime','tivdoc_identity_runtime','tivdoc_operations_runtime','tivdoc_web_runtime','postgres'])('rejects %s before registration',async role=>{
 const p=policy(),db=context(p.sha256,role);
 await expect(registerRealServiceNotificationPolicy(db,p,null)).rejects.toThrow('REAL_NOTIFICATION_POLICY_OPERATOR_REQUIRED');expect(db.client.query).toHaveBeenCalledTimes(1);
});
it('rejects role impersonation and mismatched acknowledgement',async()=>{
 const p=policy(),db=context(p.sha256);vi.mocked(db.client.query).mockResolvedValueOnce({row_count:1,rows:[{session_user:'tivdoc_worker_runtime',current_user:'tivdoc_dev_migrator'}]});
 await expect(registerRealServiceNotificationPolicy(db,p,null)).rejects.toThrow('REAL_NOTIFICATION_POLICY_OPERATOR_REQUIRED');
 await expect(registerRealServiceNotificationPolicy(context(hash('9')),p,null)).rejects.toThrow('REAL_NOTIFICATION_POLICY_REGISTER_ACK');
});
it('rejects predecessor mismatch before SQL and propagates authoritative revocation denial',async()=>{
 const p=policy(),db=context(p.sha256);
 await expect(registerRealServiceNotificationPolicy(db,p,hash('a'))).rejects.toThrow('REAL_NOTIFICATION_POLICY_PREDECESSOR');expect(db.client.query).not.toHaveBeenCalled();
 vi.mocked(db.client.query).mockRejectedValueOnce(Error('REAL_NOTIFICATION_POLICY_NO_RESURRECTION'));
 await expect(registerRealServiceNotificationPolicy(db,p,null)).rejects.toThrow('REAL_NOTIFICATION_POLICY_NO_RESURRECTION');
});
it.each(['https://app.example','https://APP.example/','https://release-123.app.example:1','https://app.example:65535/',
 `https://${'a'.repeat(63)}.example`,`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`])('accepts shared DNS origin grammar %s without rewriting it',value=>{
 expect(isRealNotificationPolicyOrigin(value)).toBe(true);
 expect(realServiceNotificationPolicySchema.parse(changed(policy(),{origin:value})).origin).toBe(value);
 expect(realAiServiceNotificationAuthorizationSchema.parse(changed(parent(2),{origin:value})).origin).toBe(value);
});
it.each(['https://[::1]','https://127.0.0.1','https://app.example:0','https://app.example:65536','https://app.example:999999',
 'https://app.example:0443','https://-app.example','https://app-.example','https://app..example','https://app.example.',
 'https://app_example.test','HTTPS://app.example','https://app.example//',`https://${'a'.repeat(64)}.example`,
 `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`])('rejects the same new policy/v2 origin boundary %s',value=>{
 expect(isRealNotificationPolicyOrigin(value)).toBe(false);
 expect(realServiceNotificationPolicySchema.safeParse(changed(policy(),{origin:value})).success).toBe(false);
 expect(realAiServiceNotificationAuthorizationSchema.safeParse(changed(parent(2),{origin:value})).success).toBe(false);
});
it('preserves the prior v1 origin parser and its exact stored bytes',()=>{
 const p=changed(parent(1),{origin:'https://[::1]:443/'});
 expect(realAiServiceNotificationAuthorizationSchema.parse(p)).toEqual(p);
});
