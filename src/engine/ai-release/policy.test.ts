import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {aiReleaseAssessmentInputSchema,aiReleasePolicySchema,aiReleaseRegistrySchema,aiReleaseSourceReceiptSchema,
 aiReleaseInterpretationReceiptSchema,aiReleaseTestReceiptSchema,aiReleaseAssessmentSchema,
 type AiReleaseAssessmentInput} from './contracts.ts';
import {evaluateAiReleaseAssessment,assertAiReleaseAdmission,aiReleaseAdmittedBranch} from './policy.ts';

const h=(label:string)=>canonicalSha256({synthetic:label});
const seal=<T extends object>(body:T)=>({...body,sha256:canonicalSha256(body)});
const reseal=(record:{sha256:string})=>{const {sha256:prior,...body}=record;void prior;record.sha256=canonicalSha256(body);};
const validity={issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
const period={from:'2026-06-01',to:'2026-06-30'},population='general_private_adult_21_59';
const generator={id:'synthetic.clause.generator',version:'1',code_sha256:h('compiled generator')};
const review={reviewer_id:'synthetic-ai',reviewer_version:'1',review_method_version:'source-method-v1',confidence:0.9,
 confidence_explanation:'Synthetic source review confidence, independent of OCR confidence.',...validity};

/** Entirely synthetic metadata exercising the verifier. No real legal review,
 * registration, customer input, source acquisition or publication is made. */
function fixture(generated=false):AiReleaseAssessmentInput{
 const source=aiReleaseSourceReceiptSchema.parse(seal({schema_version:'tivdoc-ai-source-review-v1',receipt_id:'synthetic-source-receipt',
  source_version_id:'synthetic-law-v1',artifact_sha256:h('source bytes'),transcription_sha256:h('source transcription'),
  acquisition:'synthetic_fixture',source_url:'https://example.test/synthetic-law.pdf',
  locators:[{page:1,provision:'synthetic provision',excerpt_sha256:h('source excerpt')}],
  verification_evidence_sha256:h('verification evidence'),amendment_inventory_sha256:h('amendments'),authority_analysis_sha256:h('authority analysis'),
  valid_period:{from:'2026-01-01',to:null},available_from:validity.issued_at,populations:[population],topics:['pension','travel'],status:'accepted',...review}));
 const specs=([{branch_id:'pension.employee',topic:'pension'},{branch_id:'travel.actual',topic:'travel'}] as const).map(s=>({
  ...s,period,populations:[population],...(generated?{generator}:{rule_sha256:h(s.branch_id),parameter_set_sha256:h('parameters')}),
  source_receipt_sha256s:[source.sha256],interpretation_receipt_sha256:h('temporary'),test_receipt_sha256s:[h('temporary')],
  required_test_categories:['positive','unknown','boundary'],required_fact_keys:['wage'],document_reading_fact_keys:['wage'],required_decision_ids:['applicable'],
 }));
 const interpretations=specs.map(s=>aiReleaseInterpretationReceiptSchema.parse(seal({schema_version:'tivdoc-ai-interpretation-review-v1',
  receipt_id:`${s.branch_id}.interpretation`,branch_id:s.branch_id,...(generated?{generator}:{rule_sha256:h(s.branch_id),parameter_set_sha256:h('parameters')}),
  source_receipt_sha256s:[source.sha256],period,populations:[population],method_sha256:h('method'),reasoning:'Synthetic bounded interpretation.',
  limitations:['No cash-debt attestation.'],human_by_law:{state:'not_required_for_supported_branch',basis_sha256:h('human-by-law basis'),
   source_receipt_sha256s:[source.sha256],explanation:'Synthetic branch decision, not a statement of actual law.'},status:'accepted',...review})));
 const tests=specs.map((s,i)=>aiReleaseTestReceiptSchema.parse(seal({schema_version:'tivdoc-ai-rule-tests-v1',receipt_id:`${s.branch_id}.tests`,
  branch_id:s.branch_id,...(generated?{generator}:{rule_sha256:h(s.branch_id),parameter_set_sha256:h('parameters')}),source_receipt_sha256s:[source.sha256],
  interpretation_receipt_sha256:interpretations[i].sha256,code_sha256:h('test build'),test_definition_sha256:h('tests'),
  independent_oracle_sha256:h('independent expected outputs'),results_sha256:h('actual test results'),
  categories:['positive','unknown','boundary'],passed:3,failed:0,outcome:'passed',...validity})));
 const policy=aiReleasePolicySchema.parse(seal({schema_version:'tivdoc-ai-release-policy-v1',policy_id:'synthetic.policy',version:'1',
  namespace:'isolated_test',allowed_environments:['development','test'],product_decision_sha256:h('product decision'),
  review_method_version:review.review_method_version,minimum_review_confidence:0.8,claim_kind:'qualified_ai_report',human_attestation:null,...validity,
  branches:specs.map((s,i)=>({...s,interpretation_receipt_sha256:interpretations[i].sha256,test_receipt_sha256s:[tests[i].sha256]}))}));
 const registry=aiReleaseRegistrySchema.parse(seal({schema_version:'tivdoc-ai-release-registry-v1',registry_id:'synthetic.registry',revision:1,
  namespace:'isolated_test',policy_sha256:policy.sha256,...validity,reviewers:[{actor_kind:'ai_reviewer',actor_id:review.reviewer_id,
   actor_version:review.reviewer_version,model_reference:'synthetic-model',review_method_version:review.review_method_version,...validity}],revocations:[]}));
 const scope={case_id:'synthetic-case',order_id:'synthetic-order',order_origin:'legacy_paid_receipt',order_receipt_sha256:h('paid receipt'),
  input_revision:4,input_sha256:h('source head'),period,facts_sha256:h('facts snapshot'),population,authority_dependency_sha256:h('authority dependency')};
 const pin={case_id:scope.case_id,document_id:'synthetic-document',version_id:'synthetic-version',source_sha256:h('document bytes')};
 const assessment=aiReleaseAssessmentSchema.parse(seal({schema_version:'tivdoc-ai-case-assessment-v1',assessment_id:'synthetic-assessment',
  policy_sha256:policy.sha256,registry_sha256:registry.sha256,actor_kind:'ai_reviewer',reviewer_id:review.reviewer_id,reviewer_version:review.reviewer_version,
  scope,...validity,branches:specs.map(s=>({branch_id:s.branch_id,rule_sha256:h(s.branch_id),parameter_set_sha256:h('parameters'),
   ...(generated?{generated_from:{generator,source_evidence_sha256:h('source packet')}}:{}),
   facts:[{fact_key:'wage',state:'known',origin:'identified_document_reading',value_sha256:h('observed amount'),source_pins:[pin],reading_receipt_sha256:h('reading receipt'),derivation_sha256:null}],
   decisions:[{decision_id:'applicable',state:'accepted',basis:'ai_source_assessment',evidence_sha256:h('case applicability evidence'),source_pins:[pin],
    explanation:'Synthetic applicability from scoped evidence.',...validity}]}))}));
 return aiReleaseAssessmentInputSchema.parse({policy,registry,source_receipts:[source],interpretation_receipts:interpretations,test_receipts:tests,assessment,
  current:{evaluated_at:'2026-09-12T02:00:00Z',environment:'development',namespace:'isolated_test',is_qa:true,
   policy_sha256:policy.sha256,registry_sha256:registry.sha256,registry_revision:1,assessment_sha256:assessment.sha256,scope,source_pins:[pin],
   ...(generated?{expected_generated_rules:specs.map(s=>({branch_id:s.branch_id,generator,source_evidence_sha256:h('source packet'),rule_sha256:h(s.branch_id),parameter_set_sha256:h('parameters')}))}:{})}});
}

/** Represents issuance of a NEW policy/registry/assessment after an intentional
 * fixture change. Tampering tests deliberately do not call this helper. */
function repin(f:AiReleaseAssessmentInput){
 f.source_receipts.forEach(reseal);
 for(const r of f.interpretation_receipts){r.source_receipt_sha256s=f.source_receipts.map(s=>s.sha256);r.human_by_law.source_receipt_sha256s=[...r.source_receipt_sha256s];reseal(r);}
 for(const r of f.test_receipts){r.source_receipt_sha256s=f.source_receipts.map(s=>s.sha256);r.interpretation_receipt_sha256=f.interpretation_receipts.find(i=>i.branch_id===r.branch_id)!.sha256;reseal(r);}
 for(const b of f.policy.branches){b.source_receipt_sha256s=f.source_receipts.map(s=>s.sha256);b.interpretation_receipt_sha256=f.interpretation_receipts.find(i=>i.branch_id===b.branch_id)!.sha256;b.test_receipt_sha256s=f.test_receipts.filter(t=>t.branch_id===b.branch_id).map(t=>t.sha256);}
 reseal(f.policy);f.registry.policy_sha256=f.policy.sha256;reseal(f.registry);
 f.assessment.policy_sha256=f.policy.sha256;f.assessment.registry_sha256=f.registry.sha256;reseal(f.assessment);
 f.current.policy_sha256=f.policy.sha256;f.current.registry_sha256=f.registry.sha256;f.current.assessment_sha256=f.assessment.sha256;
}
function admission(f:AiReleaseAssessmentInput){const r=evaluateAiReleaseAssessment(f);expect(r.state,JSON.stringify(r)).toBe('admitted');if(r.state!=='admitted')throw Error('FIXTURE_NOT_ADMITTED');return r.receipt;}
function reason(f:AiReleaseAssessmentInput,code:string,branch='pension.employee'){
 const r=evaluateAiReleaseAssessment(f);expect(r.branches.find(b=>b.branch_id===branch)?.blockers.map(b=>b.code)??r.blockers.map(b=>b.code)).toContain(code);return r;
}

describe('AI release admission (synthetic evidence only)',()=>{
 it('issues a scoped immutable capability, without READY or a human attestation',()=>{
  const f=fixture(),r=admission(f);expect(r.admitted_branch_ids).toEqual(['pension.employee','travel.actual']);
  expect(r).toMatchObject({actor_kind:'ai_reviewer',human_attestation:null,claim_kind:'qualified_ai_report',scope:f.current.scope});
  expect(r).not.toHaveProperty('human_reviewed');expect(r).not.toHaveProperty('READY');expect(Object.isFrozen(r.branches)).toBe(true);
  expect(()=>assertAiReleaseAdmission(r,f.current)).not.toThrow();expect(aiReleaseAdmittedBranch(r,'travel.actual',f.current).state).toBe('admitted');
 });
 it('does not issue a capability for serialized admission JSON',()=>{const f=fixture(),r=admission(f);expect(()=>assertAiReleaseAdmission(JSON.parse(JSON.stringify(r)))).toThrow('AI_RELEASE_FACTORY_ADMISSION_REQUIRED');});
 it('replays deterministically and retains a stable dependency hash across rechecks within validity',()=>{
  const f=fixture(),a=admission(f);expect(admission(f)).toEqual(a);f.current.evaluated_at='2026-09-12T03:00:00Z';const b=admission(f);
  expect(b.dependency_sha256).toBe(a.dependency_sha256);expect(b.sha256).not.toBe(a.sha256);
 });
 it.each(['missing','unknown','conflict','stale','expired','unreadable'] as const)('keeps %s local to its branch',state=>{
  const f=fixture();f.assessment.branches[0].facts[0].state=state;repin(f);
  const r=reason(f,`AI_RELEASE_FACT_${state.toUpperCase()}`);expect(r.state).toBe('admitted');expect(r.branches[1].state).toBe('admitted');
  if(r.state==='admitted')expect(()=>aiReleaseAdmittedBranch(r.receipt,'pension.employee',f.current)).toThrow('AI_RELEASE_BRANCH_NOT_ADMITTED');
 });
 it('keeps a missing branch input blocked rather than treating absence as zero',()=>{const f=fixture();f.assessment.branches[0].facts=[];repin(f);reason(f,'AI_RELEASE_FACT_MISSING');});
 it('does not treat a declaration as an identified documentary reading',()=>{const f=fixture();f.assessment.branches[0].facts[0].origin='customer_declaration';repin(f);reason(f,'AI_RELEASE_DOCUMENT_READING_REQUIRED');});
 it('accepts an explicit declaration only where the pinned policy permits it',()=>{
  const f=fixture();f.policy.branches[0].document_reading_fact_keys=[];f.assessment.branches[0].facts[0].origin='customer_declaration';
  f.assessment.branches[0].facts[0].reading_receipt_sha256=null;repin(f);admission(f);
 });
 it('requires evidence even for a derived known fact',()=>{const f=fixture();f.policy.branches[0].document_reading_fact_keys=[];f.assessment.branches[0].facts[0].origin='derived';repin(f);reason(f,'AI_RELEASE_DERIVATION_MISSING');});
 it('requires a reading receipt, not a positive status alone',()=>{const f=fixture();f.assessment.branches[0].facts[0].reading_receipt_sha256=null;repin(f);reason(f,'AI_RELEASE_READING_RECEIPT_MISSING');});
 it.each(['case_id','document_id','version_id','source_sha256'] as const)('rejects a foreign fact source pin: %s',key=>{
  const f=fixture();f.assessment.branches[0].facts[0].source_pins[0][key]=key==='source_sha256'?h('foreign'):'foreign';repin(f);reason(f,'AI_RELEASE_FACT_SOURCE_MISMATCH');
 });
 it.each(['input_sha256','facts_sha256','order_receipt_sha256','authority_dependency_sha256'] as const)('fences current %s before any branch',key=>{
  const f=fixture();f.current.scope[key]=h('new head');const r=reason(f,'AI_RELEASE_CURRENT_SCOPE_MISMATCH');expect(r.state).toBe('blocked');
 });
 it('does not accept a new registry revision under an old server pin',()=>{const f=fixture();f.current.registry_revision++;reason(f,'AI_RELEASE_REGISTRY_PIN_MISMATCH');});
 it('rejects a hash-consistent assessment that the server did not select',()=>{const f=fixture();f.assessment.assessment_id='another';reseal(f.assessment);reason(f,'AI_RELEASE_ASSESSMENT_PIN_MISMATCH');});
 it.each(['policy','registry','assessment'] as const)('rejects changed bytes in %s without recomputing its hash',key=>{
  const f=fixture();f[key].expires_at='2026-09-14T00:00:00Z';expect(evaluateAiReleaseAssessment(f)).toMatchObject({state:'blocked',receipt:null,blockers:[{code:'AI_RELEASE_INPUT_INVALID'}]});
 });
 it('does not convert source-review confidence into OCR confidence',()=>{
  const f=fixture();f.source_receipts[0].confidence=0.91;repin(f);const r=admission(f);expect(r.branches[0].source_confidence).toBe(0.91);
  expect(r).not.toHaveProperty('ocr_confidence');expect(r).not.toHaveProperty('facts');
 });
 it('enforces the explicit source review confidence policy',()=>{const f=fixture();f.source_receipts[0].confidence=0.79;repin(f);reason(f,'AI_RELEASE_REVIEW_CONFIDENCE_BELOW_POLICY');});
 it.each(['required','unresolved'] as const)('retains the actual-law human requirement %s locally',state=>{
  const f=fixture();f.interpretation_receipts[0].human_by_law.state=state;repin(f);const r=reason(f,state==='required'?'AI_RELEASE_HUMAN_BY_LAW_REQUIRED':'AI_RELEASE_HUMAN_BY_LAW_UNRESOLVED');
  expect(r.branches[1].state).toBe('admitted');
 });
 it('blocks unknown applicability instead of inferring the supported population',()=>{const f=fixture();f.assessment.branches[0].decisions[0].state='unknown';repin(f);reason(f,'AI_RELEASE_CASE_DECISION_UNKNOWN');});
 it('requires source evidence for an accepted case-applicability decision',()=>{const f=fixture();f.assessment.branches[0].decisions[0].source_pins=[];repin(f);reason(f,'AI_RELEASE_CASE_DECISION_EVIDENCE_MISSING');});
 it('requires the exact source receipt pinned by policy',()=>{const f=fixture();f.source_receipts=[];reason(f,'AI_RELEASE_SOURCE_RECEIPT_MISSING');});
 it('rejects a legal source outside the selected period',()=>{const f=fixture();f.source_receipts[0].valid_period.to='2026-05-31';repin(f);reason(f,'AI_RELEASE_SOURCE_PERIOD');});
 it('rejects an inapplicable source topic without blocking another topic',()=>{const f=fixture();f.source_receipts[0].topics=['travel'];repin(f);const r=reason(f,'AI_RELEASE_SOURCE_APPLICABILITY');expect(r.branches[1].state).toBe('admitted');});
 it('keeps failed tests and missing test categories out of admission',()=>{
  const f=fixture();f.test_receipts[0].failed=1;f.test_receipts[0].categories=['positive'];repin(f);reason(f,'AI_RELEASE_TESTS_NOT_PASSED');reason(f,'AI_RELEASE_TEST_COVERAGE_MISSING');
 });
 it('does not admit untested parameter changes even with a new policy hash',()=>{
  const f=fixture();const test=f.test_receipts[0];if('parameter_set_sha256' in test)test.parameter_set_sha256=h('other parameters');repin(f);reason(f,'AI_RELEASE_TEST_PIN_MISMATCH');
 });
 it('blocks expiry at the exact boundary',()=>{const f=fixture();f.current.evaluated_at=validity.expires_at;const r=reason(f,'AI_RELEASE_EXPIRED');expect(r.state).toBe('blocked');});
 it('blocks time before the assessment was issued',()=>{const f=fixture();f.current.evaluated_at='2026-09-11T23:59:59Z';reason(f,'AI_RELEASE_NOT_YET_VALID');});
 it('blocks a revoked rule only on the consuming branch',()=>{
  const f=fixture();f.registry.revocations=[{target_sha256:h('pension.employee'),effective_at:validity.issued_at,reason_code:'synthetic revocation'}];repin(f);
  const r=reason(f,'AI_RELEASE_REVOKED');expect(r.branches[1].state).toBe('admitted');
 });
 it('bounds admission expiry by a future revocation already in the registry',()=>{
  const f=fixture(),at='2026-09-12T04:00:00Z';f.registry.revocations=[{target_sha256:h('pension.employee'),effective_at:at,reason_code:'future revocation'}];repin(f);
  const r=admission(f);expect(r.expires_at).toBe('2026-09-12T04:00:00.000Z');f.current.evaluated_at=at;
  expect(()=>assertAiReleaseAdmission(r,f.current)).toThrow('AI_RELEASE_ADMISSION_EXPIRED');expect(admission(f).admitted_branch_ids).toEqual(['travel.actual']);
 });
 it('does not shorten an independent branch for an unrelated future revocation',()=>{
  const f=fixture();f.registry.revocations=[{target_sha256:h('unrelated'),effective_at:'2026-09-12T04:00:00Z',reason_code:'unrelated'}];repin(f);expect(admission(f).expires_at).toBe('2026-09-13T00:00:00.000Z');
 });
 it.each(['preview','production'] as const)('rejects isolated test authority in %s even when policy lists it',environment=>{
  const f=fixture();f.policy.allowed_environments.push(environment);f.current.environment=environment;repin(f);reason(f,'AI_RELEASE_TEST_SCOPE_FORBIDDEN');
 });
 it('rejects isolated authority in a non-QA case',()=>{const f=fixture();f.current.is_qa=false;reason(f,'AI_RELEASE_TEST_SCOPE_FORBIDDEN');});
 it('never treats a synthetic legal source as real authority',()=>{
  const f=fixture();f.policy.namespace='real';f.registry.namespace='real';f.current.namespace='real';repin(f);reason(f,'AI_RELEASE_SYNTHETIC_LEGAL_SOURCE');
 });
 it('rejects human impersonation in the assessment schema',()=>{const f=fixture();expect(evaluateAiReleaseAssessment({...f,assessment:{...f.assessment,actor_kind:'human_reviewer'}}).state).toBe('blocked');});
 it('rechecks runtime environment and malformed current time on the capability',()=>{
  const f=fixture(),r=admission(f);expect(()=>assertAiReleaseAdmission(r,{...f.current,environment:'production'})).toThrow('AI_RELEASE_CURRENT_ADMISSION_MISMATCH');
  expect(()=>assertAiReleaseAdmission(r,{...f.current,evaluated_at:'not-a-time'})).toThrow('AI_RELEASE_CURRENT_CONTEXT_INVALID');
 });
});

describe('compiled generators and accepted provider readings',()=>{
 it('pins a generator recipe while admitting independently recomposed exact outputs',()=>{const f=fixture(true);expect(admission(f).admitted_branch_ids).toHaveLength(2);});
 it('requires the server-generated expectation rather than trusting assessment output',()=>{const f=fixture(true);f.current.expected_generated_rules=[];reason(f,'AI_RELEASE_GENERATED_RULE_EXPECTATION_MISSING');});
 it.each(['rule_sha256','parameter_set_sha256','source_evidence_sha256'] as const)('rejects a generated %s mismatch',key=>{
  const f=fixture(true);f.current.expected_generated_rules![0][key]=h('different');reason(f,'AI_RELEASE_GENERATED_RULE_MISMATCH');
 });
 it('rejects a different compiled generator version',()=>{const f=fixture(true);f.current.expected_generated_rules![0].generator.version='2';reason(f,'AI_RELEASE_GENERATED_RULE_MISMATCH');});
 it('does not accept exact-rule test receipts for an untested generator',()=>{
  const f=fixture(true),old=fixture().test_receipts[0];f.test_receipts[0]=old;repin(f);reason(f,'AI_RELEASE_TEST_PIN_MISMATCH');
 });
 it('admits another source-specific output without changing policy or registry',()=>{
  const f=fixture(true),policy=f.policy.sha256,registry=f.registry.sha256;
  f.assessment.branches[0].rule_sha256=h('a new generated clause');f.current.expected_generated_rules![0].rule_sha256=h('a new generated clause');
  f.assessment.branches[0].generated_from!.source_evidence_sha256=h('new source evidence');f.current.expected_generated_rules![0].source_evidence_sha256=h('new source evidence');
  reseal(f.assessment);f.current.assessment_sha256=f.assessment.sha256;admission(f);expect(f.policy.sha256).toBe(policy);expect(f.registry.sha256).toBe(registry);
 });
 it('fences a generated output changed after admission',()=>{const f=fixture(true),r=admission(f);f.current.expected_generated_rules![0].rule_sha256=h('new');expect(()=>assertAiReleaseAdmission(r,f.current)).toThrow('AI_RELEASE_CURRENT_ADMISSION_MISMATCH');});
 it('accepts a provider reading only with explicit acceptance policy and validation receipt',()=>{
  const f=fixture(),fact=f.assessment.branches[0].facts[0];fact.origin='accepted_provider_reading';fact.reading_receipt_sha256=null;
  fact.reading_policy_sha256=h('existing Gate0/resolver policy');fact.validation_receipt_sha256=h('accepted validation');
  f.policy.accepted_provider_reading_policy_sha256s=[fact.reading_policy_sha256];repin(f);admission(f);
 });
 it('does not substitute an unregistered provider policy for an identified reading',()=>{const f=fixture();f.assessment.branches[0].facts[0].origin='accepted_provider_reading';repin(f);reason(f,'AI_RELEASE_PROVIDER_READING_POLICY_REQUIRED');reason(f,'AI_RELEASE_PROVIDER_VALIDATION_RECEIPT_MISSING');});
 it('rejects a revoked provider validation receipt even under an allowed policy',()=>{
  const f=fixture(),fact=f.assessment.branches[0].facts[0];fact.origin='accepted_provider_reading';fact.reading_policy_sha256=h('accepted reading policy');fact.validation_receipt_sha256=h('invalidated validation');
  f.policy.accepted_provider_reading_policy_sha256s=[fact.reading_policy_sha256];f.registry.revocations=[{target_sha256:fact.validation_receipt_sha256,effective_at:validity.issued_at,reason_code:'rejected evidence'}];repin(f);reason(f,'AI_RELEASE_REVOKED');
 });
});
