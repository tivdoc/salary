import {expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {admitRealAiServiceDelivery,QUALIFIED_AI_RENDERER_ACTIONS,realAiServiceDecisionSchema,realAiServiceDeliveryRequestSchema,
 REAL_AI_SERVICE_DECISION_VERSION,type RealAiServiceDecision,type RealAiServiceCurrentContext} from './real-ai-service-admission';
import {AI_RELEASE_REPORT_TEMPLATE} from './ai-release-report';

const h=(value:string)=>canonicalSha256({synthetic_service_test:value});
function reseal<T extends {sha256:string}>(value:T):T{const {sha256,...body}=value;void sha256;return {...body,sha256:canonicalSha256(body)} as T;}
/** In-memory negative/positive protocol fixtures only. Labels simulate a REAL
 * context to exercise guards; these are not acquired sources, operator
 * decisions, release approvals or evidence to save/enroll anywhere. */
function fixture(humanLaw:'required'|'unresolved'|'not_required_for_supported_branch'='not_required_for_supported_branch'){
 const runtime=structuredClone(runtimeFixture()),input=runtime.assessment_input,replacements=new Map<string,string>();
 const replace=<T>(value:T):T=>JSON.parse(JSON.stringify(value,(_key,v)=>typeof v==='string'?(replacements.get(v)??v):v));
 const update=<T extends {sha256:string}>(value:T):T=>{
  const next=reseal(replace(value));replacements.set(value.sha256,next.sha256);return next;
 };
 input.source_receipts=input.source_receipts.map(r=>update({...r,acquisition:'primary_copy' as const}));
 input.interpretation_receipts=input.interpretation_receipts.map(r=>update({...r,human_by_law:{...r.human_by_law,state:humanLaw}}));
 input.test_receipts=input.test_receipts.map(update);
 input.policy=update({...input.policy,namespace:'real' as const});
 input.registry=update({...input.registry,namespace:'real' as const});
 input.assessment=update(input.assessment);
 input.current=replace({...input.current,namespace:'real' as const,is_qa:false});
 const envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:7,source_journal:{case_id:input.current.scope.case_id,
  input_revision:input.current.scope.input_revision,input_sha256:input.current.scope.input_sha256}});
 const interpretation=input.interpretation_receipts[0];
 const decision=reseal({schema_version:REAL_AI_SERVICE_DECISION_VERSION,decision_id:'synthetic-service',version:'1',namespace:'real',
  purpose:'real_customer_service',status:'active',policy_sha256:input.policy.sha256,product_decision_sha256:input.policy.product_decision_sha256,
  human_attestation:null,action_matrix_sha256:h('matrix'),
  action_reviews:QUALIFIED_AI_RENDERER_ACTIONS.map(action=>({action,interpretation_receipt_sha256:interpretation.sha256,basis_sha256:interpretation.human_by_law.basis_sha256})),
  renderer:{template:AI_RELEASE_REPORT_TEMPLATE,code_sha256:h('renderer')},
  evidence:{operator_identity_sha256:h('operator'),purchase_presentation_sha256:h('purchase'),support_presentation_sha256:h('support'),
   sample_html_sha256:h('sample html'),sample_pdf_sha256:h('sample pdf')},
  issued_at:'2026-09-12T01:00:00Z',expires_at:'2026-09-12T20:00:00Z',sha256:h('replace')} as RealAiServiceDecision);
 const artifacts=realAiServiceDeliveryRequestSchema.shape.artifacts.parse({case_id:input.current.scope.case_id,report_id:'synthetic-report',analysis_run_id:envelope.result.analysis_run_id,
  envelope_sha256:envelope.sha256,renderer_template:AI_RELEASE_REPORT_TEMPLATE,renderer_code_sha256:decision.renderer.code_sha256,
  html_sha256:h('actual html'),pdf_sha256:h('actual pdf'),purchased_topics:[...runtime.source.purchased_scope.topics],represented_topics:[...runtime.source.purchased_scope.topics]});
 const current:RealAiServiceCurrentContext={assessment:structuredClone(input.current),identity_id:'55555555-5555-4555-8555-555555555555',
  service_decision_sha256:decision.sha256,artifacts:structuredClone(artifacts),trusted_generator_pins:structuredClone(runtime.trusted_generator_pins),
  available_evidence_sha256s:[...new Set([decision.action_matrix_sha256,...Object.values(decision.evidence),...decision.action_reviews.map(r=>r.basis_sha256)])],revocations:[]};
 const request={identity_id:current.identity_id,artifacts};
 return {candidate:{decision,envelope,request},current};
}
function changeDecision(f:ReturnType<typeof fixture>,change:(decision:RealAiServiceDecision)=>void){
 change(f.candidate.decision);f.candidate.decision=reseal(f.candidate.decision);f.current.service_decision_sha256=f.candidate.decision.sha256;
}

it('replays the ordinary all-nine engine and binds delivery without publishing, notifying or charging',()=>{
 const f=fixture(),receipt=admitRealAiServiceDelivery(f.candidate,f.current);
 expect(f.candidate.envelope.result.checks.some(c=>c.state==='calculated')).toBe(true);
 expect(receipt.artifacts.represented_topics).toHaveLength(9);
 expect(receipt.artifacts.envelope_sha256).toBe(f.candidate.envelope.sha256);
 expect(receipt).toMatchObject({namespace:'real',human_attestation:null,legal_debt_total:null,combined_amount:null,
  publication_performed:false,notification_allowed:false,commercial_charge_allowed:false});
 expect(Object.isFrozen(receipt.artifacts)).toBe(true);
});
it.each(['namespace','is_qa'] as const)('rejects an engineering/test current %s',field=>{
 const f=fixture();if(field==='namespace')f.current.assessment.namespace='isolated_test';else f.current.assessment.is_qa=true;
 expect(()=>admitRealAiServiceDelivery(f.candidate,f.current)).toThrow('REAL_SERVICE_REAL_CONTEXT_REQUIRED');
});
it('rejects an isolated runtime and an owner envelope even under a REAL service decision',()=>{
 const f=fixture(),runtime=runtimeFixture(),scope=runtime.assessment_input.current.scope;
 const envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:7,source_journal:{case_id:scope.case_id,input_revision:scope.input_revision,input_sha256:scope.input_sha256}});
 expect(()=>admitRealAiServiceDelivery({...f.candidate,envelope},f.current)).toThrow('REAL_SERVICE_REAL_ENVELOPE_REQUIRED');
 expect(()=>admitRealAiServiceDelivery({...f.candidate,envelope:{...envelope,schema_version:'case-analysis-owner-engineering-v1'}},f.current)).toThrow();
});
it.each(['proposed','missing_action','false_basis','missing_evidence','changed_product'] as const)('rejects %s without treating owner approval or arithmetic as rights authority',kind=>{
 const f=fixture();
 if(kind==='proposed')changeDecision(f,d=>{d.status='proposed_not_activated';});
 if(kind==='missing_action')changeDecision(f,d=>{d.action_reviews=d.action_reviews.filter(r=>!['A05','A06','A07'].includes(r.action));});
 if(kind==='false_basis'){changeDecision(f,d=>{d.action_reviews[0].basis_sha256=h('unrelated basis');});f.current.available_evidence_sha256s.push(h('unrelated basis'));}
 if(kind==='missing_evidence')f.current.available_evidence_sha256s.pop();
 if(kind==='changed_product')changeDecision(f,d=>{d.product_decision_sha256=h('other product decision');});
 const code={proposed:'REAL_SERVICE_ACTIVE_DECISION_REQUIRED',missing_action:'REAL_SERVICE_ACTION_NOT_ALLOWED',false_basis:'REAL_SERVICE_ACTION_REVIEW_BINDING',
  missing_evidence:'REAL_SERVICE_EVIDENCE_UNAVAILABLE',changed_product:'REAL_SERVICE_PRODUCT_DECISION_MISMATCH'}[kind];
 expect(()=>admitRealAiServiceDelivery(f.candidate,f.current)).toThrow(code);
});
it.each(['required','unresolved'] as const)('preserves the ordinary human_by_law %s guard',state=>{
 const f=fixture(state);expect(()=>admitRealAiServiceDelivery(f.candidate,f.current)).toThrow('REAL_SERVICE_RUNTIME_NOT_ADMITTED');
});
it.each(['recipient','artifact','input','source','registry','build','coverage'] as const)('fences changed live %s',kind=>{
 const f=fixture();
 if(kind==='recipient')f.candidate.request.identity_id='66666666-6666-4666-8666-666666666666';
 if(kind==='artifact')f.current.artifacts.pdf_sha256=h('different pdf');
 if(kind==='input')f.current.assessment.scope.input_sha256=h('new answer journal');
 if(kind==='source')f.current.assessment.source_pins[0].source_sha256=h('new document');
 if(kind==='registry')f.current.assessment.registry_sha256=h('new registry');
 if(kind==='build')f.current.trusted_generator_pins[0].generator.code_sha256=h('new build');
 if(kind==='coverage'){f.current.artifacts.represented_topics.pop();f.candidate.request.artifacts.represented_topics.pop();}
 const code={recipient:'REAL_SERVICE_RECIPIENT_MISMATCH',artifact:'REAL_SERVICE_ARTIFACTS_CHANGED',input:'REAL_SERVICE_JOURNAL_CHANGED',
  source:'AI_RELEASE_CURRENT_ADMISSION_MISMATCH',registry:'AI_RELEASE_CURRENT_ADMISSION_MISMATCH',build:'REAL_SERVICE_BUILD_CHANGED',coverage:'REAL_SERVICE_PURCHASE_COVERAGE'}[kind];
 expect(()=>admitRealAiServiceDelivery(f.candidate,f.current)).toThrow(code);
});
it('does not revive an expired or revoked service decision on replay and clips future revocation',()=>{
 const f=fixture();f.current.revocations=[{target_sha256:f.candidate.decision.evidence.purchase_presentation_sha256,effective_at:'2026-09-12T11:00:00Z'}];
 expect(admitRealAiServiceDelivery(f.candidate,f.current).expires_at).toBe('2026-09-12T11:00:00.000Z');
 f.current.assessment.evaluated_at='2026-09-12T11:00:00Z';
 expect(()=>admitRealAiServiceDelivery(f.candidate,f.current)).toThrow('REAL_SERVICE_REVOKED');
 f.current.revocations=[];f.current.assessment.evaluated_at=f.candidate.decision.expires_at;
 expect(()=>admitRealAiServiceDelivery(f.candidate,f.current)).toThrow('REAL_SERVICE_DECISION_EXPIRED');
});
it('rejects out-of-scope legal-action grants, forged human signatures and tampered decision bytes',()=>{
 const f=fixture();
 expect(realAiServiceDecisionSchema.safeParse({...f.candidate.decision,action_reviews:[{...f.candidate.decision.action_reviews[0],action:'A10'}]}).success).toBe(false);
 expect(realAiServiceDecisionSchema.safeParse({...f.candidate.decision,human_attestation:'invented reviewer'}).success).toBe(false);
 expect(realAiServiceDecisionSchema.safeParse({...f.candidate.decision,version:'tampered'}).success).toBe(false);
});
