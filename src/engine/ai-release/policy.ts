import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {aiReleaseAssessmentInputSchema,aiReleaseCurrentContextSchema,type AiReleaseAssessmentInput,type AiReleaseBranchPolicy,type AiReleaseCurrentContext,
 type AiReleaseSourcePin,ownerEngineeringAssessmentInputSchema,ownerEngineeringCurrentContextSchema,
 type OwnerEngineeringAssessmentInput,type OwnerEngineeringCurrentContext} from './contracts.ts';

export type AiReleaseBlocker=Readonly<{code:string;dependency_id:string|null}>;
export type AiReleaseBranchDecision=Readonly<{branch_id:string;topic:AiReleaseBranchPolicy['topic']|null;
 state:'admitted'|'blocked';blockers:readonly AiReleaseBlocker[];dependency_sha256:string;
 expires_at:string|null;source_confidence:number|null;interpretation_confidence:number|null;limitations:readonly string[]}>;
type ReceiptBody=Readonly<{schema_version:'tivdoc-ai-release-admission-v1';claim_kind:'qualified_ai_report';
 actor_kind:'ai_reviewer';reviewer_id:string;reviewer_version:string;human_attestation:null;
 namespace:AiReleaseCurrentContext['namespace'];environment:AiReleaseCurrentContext['environment'];is_qa:boolean;
 policy_sha256:string;registry_sha256:string;registry_revision:number;
 assessment_sha256:string;scope:AiReleaseCurrentContext['scope'];source_pins:readonly AiReleaseSourcePin[];
 branches:readonly AiReleaseBranchDecision[];admitted_branch_ids:readonly string[];dependency_sha256:string;
 expected_generated_rules:NonNullable<AiReleaseCurrentContext['expected_generated_rules']>;
 evaluated_at:string;expires_at:string}>;
export type AiReleaseAdmission=Readonly<ReceiptBody&{sha256:string}>;
export type AiReleaseAssessmentResult=Readonly<{
 state:'admitted';receipt:AiReleaseAdmission;branches:readonly AiReleaseBranchDecision[];blockers:readonly AiReleaseBlocker[];
}|{state:'blocked';receipt:null;branches:readonly AiReleaseBranchDecision[];blockers:readonly AiReleaseBlocker[]}>;

export type OwnerEngineeringAdmission=Readonly<Omit<ReceiptBody,'schema_version'|'claim_kind'>&{
 schema_version:'tivdoc-owner-engineering-admission-v1';claim_kind:'owner_engineering_review';
 owner_scope:OwnerEngineeringCurrentContext['owner_scope'];release_authorized:false;publication_allowed:false;notification_allowed:false;
 human_law_reviews:readonly {branch_id:string;interpretation_receipt_sha256:string;human_by_law:OwnerEngineeringAssessmentInput['interpretation_receipts'][number]['human_by_law']}[];
 sha256:string}>;
export type OwnerEngineeringAssessmentResult=Readonly<{state:'admitted';receipt:OwnerEngineeringAdmission;branches:readonly AiReleaseBranchDecision[];blockers:readonly AiReleaseBlocker[]}|
 {state:'blocked';receipt:null;branches:readonly AiReleaseBranchDecision[];blockers:readonly AiReleaseBlocker[]}>;

const issued=new WeakSet<object>();
const engineeringIssued=new WeakSet<object>();
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const setSame=(a:readonly string[],b:readonly string[])=>same([...a].sort(),[...b].sort());
type Validity={issued_at:string;expires_at:string};
const covers=(outer:{from:string;to:string|null},inner:{from:string;to:string})=>outer.from<=inner.from&&(outer.to===null||outer.to>=inner.to);
const earliest=(dates:readonly string[])=>new Date(Math.min(...dates.map(d=>Date.parse(d)))).toISOString();
const ruleBinding=(r:{rule_sha256:string;parameter_set_sha256:string}|{generator:{id:string;version:string;code_sha256:string}})=>
 'generator' in r?{generator:r.generator}:{rule_sha256:r.rule_sha256,parameter_set_sha256:r.parameter_set_sha256};
const add=(list:AiReleaseBlocker[],code:string,dependency_id:string|null=null)=>{
 if(!list.some(b=>b.code===code&&b.dependency_id===dependency_id))list.push({code,dependency_id});
};
function checkValidity(value:Validity,at:string,list:AiReleaseBlocker[],label:string){
 const start=Date.parse(value.issued_at),end=Date.parse(value.expires_at),now=Date.parse(at);
 if(end<=start)add(list,'AI_RELEASE_VALIDITY_INVALID',label);
 if(now<start)add(list,'AI_RELEASE_NOT_YET_VALID',label);
 if(now>=end)add(list,'AI_RELEASE_EXPIRED',label);
}
function uniqueReceipts(items:readonly {receipt_id:string;sha256:string}[]){
 return new Set(items.map(i=>i.receipt_id)).size===items.length&&new Set(items.map(i=>i.sha256)).size===items.length;
}

/** Validates immutable evidence against expectations supplied separately by a
 * trusted server loader. No network, database, clock, model or human signature
 * is invoked. The caller MUST re-load current pins for execute/publish/read;
 * self-consistent JSON cannot establish that a registry is current. */
export function evaluateAiReleaseAssessment(candidate:unknown):AiReleaseAssessmentResult{
 const parsed=aiReleaseAssessmentInputSchema.safeParse(candidate);
 if(!parsed.success)return deepFreeze({state:'blocked',receipt:null,branches:[],blockers:[{code:'AI_RELEASE_INPUT_INVALID',dependency_id:null}]});
 const result=evaluateAssessment(parsed.data);
 if(result.state==='blocked')return result;
 if(result.receipt.schema_version!=='tivdoc-ai-release-admission-v1')throw Error('AI_RELEASE_PURPOSE_MISMATCH');
 return deepFreeze({...result,receipt:result.receipt});
}
export function evaluateOwnerEngineeringAssessment(candidate:unknown):OwnerEngineeringAssessmentResult{
 const parsed=ownerEngineeringAssessmentInputSchema.safeParse(candidate);
 if(!parsed.success)return deepFreeze({state:'blocked',receipt:null,branches:[],blockers:[{code:'OWNER_ENGINEERING_INPUT_INVALID',dependency_id:null}]});
 const result=evaluateAssessment(parsed.data);
 if(result.state==='blocked')return result;
 if(result.receipt.schema_version!=='tivdoc-owner-engineering-admission-v1')throw Error('OWNER_ENGINEERING_PURPOSE_MISMATCH');
 return deepFreeze({...result,receipt:result.receipt});
}
/** One evaluator for all evidence/expiry/currentness fences; only the explicit
 * engineering purpose retains unresolved human-law review as a qualification. */
function evaluateAssessment(input:AiReleaseAssessmentInput|OwnerEngineeringAssessmentInput):AiReleaseAssessmentResult|OwnerEngineeringAssessmentResult{
 const {policy,registry,assessment,current}=input,global:AiReleaseBlocker[]=[];
 const engineering=policy.schema_version==='tivdoc-owner-engineering-policy-v1';
 if(engineering&&(!('owner_scope' in current)||!same(policy.owner_scope,current.owner_scope)))add(global,'OWNER_ENGINEERING_OWNER_SCOPE_MISMATCH');
 const now=current.evaluated_at;
 const futureRevocations=new WeakMap<AiReleaseBlocker[],string[]>();
 const revoked=(sha:string)=>registry.revocations.some(r=>r.target_sha256===sha&&Date.parse(r.effective_at)<=Date.parse(now));
 const checkRevoked=(sha:string,list:AiReleaseBlocker[],label:string)=>{
  if(revoked(sha))add(list,'AI_RELEASE_REVOKED',label);
  const future=registry.revocations.filter(r=>r.target_sha256===sha&&Date.parse(r.effective_at)>Date.parse(now)).map(r=>r.effective_at);
  futureRevocations.set(list,[...(futureRevocations.get(list)??[]),...future]);
 };
 if(!same(assessment.scope,current.scope))add(global,'AI_RELEASE_CURRENT_SCOPE_MISMATCH');
 if(policy.sha256!==current.policy_sha256||registry.policy_sha256!==policy.sha256||assessment.policy_sha256!==policy.sha256)
  add(global,'AI_RELEASE_POLICY_PIN_MISMATCH');
 if(registry.sha256!==current.registry_sha256||registry.revision!==current.registry_revision||assessment.registry_sha256!==registry.sha256)
  add(global,'AI_RELEASE_REGISTRY_PIN_MISMATCH');
 if(assessment.sha256!==current.assessment_sha256)add(global,'AI_RELEASE_ASSESSMENT_PIN_MISMATCH');
 if(policy.namespace!==current.namespace||registry.namespace!==current.namespace)add(global,'AI_RELEASE_NAMESPACE_MISMATCH');
 if(!policy.allowed_environments.some(value=>value===current.environment))add(global,'AI_RELEASE_ENVIRONMENT_FORBIDDEN');
 if(current.namespace==='isolated_test'&&(!current.is_qa||!['development','test'].includes(current.environment)))add(global,'AI_RELEASE_TEST_SCOPE_FORBIDDEN');
 if(current.source_pins.some(p=>p.case_id!==current.scope.case_id))add(global,'AI_RELEASE_FOREIGN_CURRENT_SOURCE');
 for(const [label,value] of [['policy',policy],['registry',registry],['assessment',assessment]] as const){
  checkValidity(value,now,global,label);checkRevoked(value.sha256,global,label);
 }
 if(!uniqueReceipts(input.source_receipts)||!uniqueReceipts(input.interpretation_receipts)||!uniqueReceipts(input.test_receipts))
  add(global,'AI_RELEASE_DUPLICATE_RECEIPT');
 const assessor=registry.reviewers.find(r=>r.actor_id===assessment.reviewer_id&&r.actor_version===assessment.reviewer_version);
 if(!assessor)add(global,'AI_RELEASE_ASSESSOR_UNKNOWN');
 else{
  checkValidity(assessor,now,global,'assessor');checkRevoked(canonicalSha256(assessor),global,'assessor');
  if(assessor.review_method_version!==policy.review_method_version)add(global,'AI_RELEASE_REVIEW_METHOD_MISMATCH','assessor');
  if(Date.parse(assessment.issued_at)<Date.parse(assessor.issued_at)||Date.parse(assessment.issued_at)<Date.parse(policy.issued_at)
   ||Date.parse(assessment.issued_at)<Date.parse(registry.issued_at))add(global,'AI_RELEASE_ASSESSMENT_CHRONOLOGY');
 }

 const sourceByHash=new Map(input.source_receipts.map(r=>[r.sha256,r]));
 const interpretationByHash=new Map(input.interpretation_receipts.map(r=>[r.sha256,r]));
 const testByHash=new Map(input.test_receipts.map(r=>[r.sha256,r]));
 const commonExpiry=[policy.expires_at,registry.expires_at,assessment.expires_at,...(assessor?[assessor.expires_at]:[])];
 const pinKnown=(pin:AiReleaseSourcePin)=>pin.case_id===current.scope.case_id&&current.source_pins.some(p=>same(p,pin));
 const validateReview=(r:Validity&{reviewer_id:string;reviewer_version:string;review_method_version:string;confidence:number},
  label:string,list:AiReleaseBlocker[],expiries:string[])=>{
  checkValidity(r,now,list,label);expiries.push(r.expires_at);
  const actor=registry.reviewers.find(a=>a.actor_id===r.reviewer_id&&a.actor_version===r.reviewer_version);
  if(!actor)add(list,'AI_RELEASE_REVIEWER_UNKNOWN',label);
  else{
   checkValidity(actor,now,list,label);checkRevoked(canonicalSha256(actor),list,label);expiries.push(actor.expires_at);
   if(Date.parse(r.issued_at)<Date.parse(actor.issued_at))add(list,'AI_RELEASE_REVIEWER_CHRONOLOGY',label);
   if(actor.review_method_version!==policy.review_method_version)add(list,'AI_RELEASE_REVIEW_METHOD_MISMATCH',label);
  }
  if(r.review_method_version!==policy.review_method_version)add(list,'AI_RELEASE_REVIEW_METHOD_MISMATCH',label);
  if(r.confidence<policy.minimum_review_confidence)add(list,'AI_RELEASE_REVIEW_CONFIDENCE_BELOW_POLICY',label);
  if(Date.parse(r.issued_at)>Date.parse(assessment.issued_at))add(list,'AI_RELEASE_ASSESSMENT_PRECEDES_EVIDENCE',label);
 };

 const branches:AiReleaseBranchDecision[]=assessment.branches.map(candidateBranch=>{
  const branch=policy.branches.find(b=>b.branch_id===candidateBranch.branch_id),blockers=[...global],expiries=[...commonExpiry];
  const sources=branch?.source_receipt_sha256s.map(h=>sourceByHash.get(h))??[];
  const interpretation=branch?interpretationByHash.get(branch.interpretation_receipt_sha256):undefined;
  if(!branch)add(blockers,'AI_RELEASE_BRANCH_NOT_ALLOWED',candidateBranch.branch_id);
  else{
   if(!covers(branch.period,current.scope.period))add(blockers,'AI_RELEASE_PERIOD_OUTSIDE_BRANCH',branch.branch_id);
   if(!branch.populations.includes(current.scope.population))add(blockers,'AI_RELEASE_POPULATION_OUTSIDE_BRANCH',branch.branch_id);
   if('generator' in branch){
    const expected=current.expected_generated_rules?.find(r=>r.branch_id===branch.branch_id),from=candidateBranch.generated_from;
    if(!expected)add(blockers,'AI_RELEASE_GENERATED_RULE_EXPECTATION_MISSING',branch.branch_id);
    else if(!from||!same(from.generator,branch.generator)||!same(expected.generator,branch.generator)
     ||expected.source_evidence_sha256!==from.source_evidence_sha256||expected.rule_sha256!==candidateBranch.rule_sha256
     ||expected.parameter_set_sha256!==candidateBranch.parameter_set_sha256)add(blockers,'AI_RELEASE_GENERATED_RULE_MISMATCH',branch.branch_id);
    checkRevoked(branch.generator.code_sha256,blockers,branch.branch_id);
   }else if(candidateBranch.generated_from||branch.rule_sha256!==candidateBranch.rule_sha256||branch.parameter_set_sha256!==candidateBranch.parameter_set_sha256)
    add(blockers,'AI_RELEASE_RULE_PIN_MISMATCH',branch.branch_id);
   checkRevoked(candidateBranch.rule_sha256,blockers,branch.branch_id);checkRevoked(candidateBranch.parameter_set_sha256,blockers,branch.branch_id);
   for(const sha of branch.source_receipt_sha256s){
    const r=sourceByHash.get(sha);
    if(!r){add(blockers,'AI_RELEASE_SOURCE_RECEIPT_MISSING',sha);continue;}
    checkRevoked(r.sha256,blockers,r.source_version_id);checkRevoked(r.artifact_sha256,blockers,r.source_version_id);
    checkRevoked(r.transcription_sha256,blockers,r.source_version_id);validateReview(r,r.source_version_id,blockers,expiries);
    if(r.status!=='accepted')add(blockers,`AI_RELEASE_SOURCE_${r.status.toUpperCase()}`,r.source_version_id);
    if(current.namespace==='real'&&r.acquisition==='synthetic_fixture')add(blockers,'AI_RELEASE_SYNTHETIC_LEGAL_SOURCE',r.source_version_id);
    if(!covers(r.valid_period,current.scope.period))add(blockers,'AI_RELEASE_SOURCE_PERIOD',r.source_version_id);
    if(!r.populations.includes(current.scope.population)||!r.topics.includes(branch.topic))add(blockers,'AI_RELEASE_SOURCE_APPLICABILITY',r.source_version_id);
    if(Date.parse(r.available_from)>Date.parse(r.issued_at)||Date.parse(r.available_from)>Date.parse(now))add(blockers,'AI_RELEASE_SOURCE_NOT_AVAILABLE',r.source_version_id);
   }
   if(!interpretation)add(blockers,'AI_RELEASE_INTERPRETATION_MISSING',branch.interpretation_receipt_sha256);
   else{
    const r=interpretation;
    checkRevoked(r.sha256,blockers,r.receipt_id);validateReview(r,r.receipt_id,blockers,expiries);
    if(r.status!=='accepted')add(blockers,`AI_RELEASE_INTERPRETATION_${r.status.toUpperCase()}`,r.receipt_id);
    if(r.branch_id!==branch.branch_id||!same(ruleBinding(r),ruleBinding(branch))
     ||!setSame(r.source_receipt_sha256s,branch.source_receipt_sha256s))add(blockers,'AI_RELEASE_INTERPRETATION_PIN_MISMATCH',r.receipt_id);
    if(!covers(r.period,current.scope.period)||!r.populations.includes(current.scope.population))add(blockers,'AI_RELEASE_INTERPRETATION_SCOPE',r.receipt_id);
    if(r.human_by_law.source_receipt_sha256s.some(h=>!branch.source_receipt_sha256s.includes(h)))add(blockers,'AI_RELEASE_HUMAN_LAW_SOURCE_MISMATCH',r.receipt_id);
    if(r.human_by_law.state==='required'||r.human_by_law.state==='unresolved'&&!engineering)add(blockers,r.human_by_law.state==='required'?'AI_RELEASE_HUMAN_BY_LAW_REQUIRED':'AI_RELEASE_HUMAN_BY_LAW_UNRESOLVED',r.receipt_id);
    if(sources.some(s=>s&&Date.parse(s.issued_at)>Date.parse(r.issued_at)))add(blockers,'AI_RELEASE_INTERPRETATION_PRECEDES_SOURCE',r.receipt_id);
   }
   const categories=new Set<string>();
   for(const sha of branch.test_receipt_sha256s){
    const r=testByHash.get(sha);
    if(!r){add(blockers,'AI_RELEASE_TEST_RECEIPT_MISSING',sha);continue;}
    checkRevoked(r.sha256,blockers,r.receipt_id);checkValidity(r,now,blockers,r.receipt_id);expiries.push(r.expires_at);
    if(r.outcome!=='passed'||r.failed!==0||r.passed<1)add(blockers,'AI_RELEASE_TESTS_NOT_PASSED',r.receipt_id);
    if(r.branch_id!==branch.branch_id||!same(ruleBinding(r),ruleBinding(branch))
     ||r.interpretation_receipt_sha256!==branch.interpretation_receipt_sha256||!setSame(r.source_receipt_sha256s,branch.source_receipt_sha256s))
     add(blockers,'AI_RELEASE_TEST_PIN_MISMATCH',r.receipt_id);
    if(Date.parse(r.issued_at)>Date.parse(assessment.issued_at)||interpretation&&Date.parse(r.issued_at)<Date.parse(interpretation.issued_at))add(blockers,'AI_RELEASE_TEST_CHRONOLOGY',r.receipt_id);
    for(const c of r.categories)categories.add(c);
   }
   for(const c of branch.required_test_categories)if(!categories.has(c))add(blockers,'AI_RELEASE_TEST_COVERAGE_MISSING',c);
   for(const key of branch.required_fact_keys){
    const fact=candidateBranch.facts.find(f=>f.fact_key===key);
    if(!fact){add(blockers,'AI_RELEASE_FACT_MISSING',key);continue;}
    if(fact.state!=='known'){add(blockers,`AI_RELEASE_FACT_${fact.state.toUpperCase()}`,key);continue;}
    if(!fact.value_sha256||fact.source_pins.length===0)add(blockers,'AI_RELEASE_FACT_EVIDENCE_MISSING',key);
    if(fact.source_pins.some(p=>!pinKnown(p)))add(blockers,'AI_RELEASE_FACT_SOURCE_MISMATCH',key);
    if(branch.document_reading_fact_keys.includes(key)&&!['identified_document_reading','accepted_provider_reading'].includes(fact.origin))add(blockers,'AI_RELEASE_DOCUMENT_READING_REQUIRED',key);
    if(fact.origin==='identified_document_reading'&&!fact.reading_receipt_sha256)add(blockers,'AI_RELEASE_READING_RECEIPT_MISSING',key);
    if(fact.origin==='accepted_provider_reading'){
     if(!fact.reading_policy_sha256||!policy.accepted_provider_reading_policy_sha256s?.includes(fact.reading_policy_sha256))add(blockers,'AI_RELEASE_PROVIDER_READING_POLICY_REQUIRED',key);
     if(!fact.validation_receipt_sha256)add(blockers,'AI_RELEASE_PROVIDER_VALIDATION_RECEIPT_MISSING',key);
     if(fact.reading_policy_sha256)checkRevoked(fact.reading_policy_sha256,blockers,key);
     if(fact.validation_receipt_sha256)checkRevoked(fact.validation_receipt_sha256,blockers,key);
    }
    if(fact.origin==='derived'&&!fact.derivation_sha256)add(blockers,'AI_RELEASE_DERIVATION_MISSING',key);
    if(fact.reading_receipt_sha256)checkRevoked(fact.reading_receipt_sha256,blockers,key);
    if(fact.derivation_sha256)checkRevoked(fact.derivation_sha256,blockers,key);
   }
   for(const id of branch.required_decision_ids){
    const decision=candidateBranch.decisions.find(d=>d.decision_id===id);
    if(!decision){add(blockers,'AI_RELEASE_CASE_DECISION_MISSING',id);continue;}
    if(decision.state!=='accepted')add(blockers,`AI_RELEASE_CASE_DECISION_${decision.state.toUpperCase()}`,id);
    checkValidity(decision,now,blockers,id);expiries.push(decision.expires_at);checkRevoked(decision.evidence_sha256,blockers,id);
    if(!decision.source_pins.length)add(blockers,'AI_RELEASE_CASE_DECISION_EVIDENCE_MISSING',id);
    if(decision.source_pins.some(p=>!pinKnown(p)))add(blockers,'AI_RELEASE_CASE_DECISION_SOURCE_MISMATCH',id);
    if(Date.parse(decision.issued_at)>Date.parse(assessment.issued_at))add(blockers,'AI_RELEASE_CASE_DECISION_CHRONOLOGY',id);
   }
  }
  const state=blockers.length?'blocked' as const:'admitted' as const;
  return {branch_id:candidateBranch.branch_id,topic:branch?.topic??null,state,blockers,
   dependency_sha256:canonicalSha256({branch:branch??null,assessment:candidateBranch,scope:current.scope,
    policy:policy.sha256,registry:registry.sha256,state,blockers}),expires_at:state==='admitted'?earliest([...expiries,
     ...(futureRevocations.get(global)??[]),...(futureRevocations.get(blockers)??[])]):null,
   source_confidence:sources.length&&sources.every(s=>s!==undefined)?Math.min(...sources.map(s=>s!.confidence)):null,
   interpretation_confidence:interpretation?.confidence??null,limitations:interpretation?.limitations??[]};
 });
 const admitted=branches.filter(b=>b.state==='admitted');
 if(global.length||!admitted.length)return deepFreeze({state:'blocked',receipt:null,branches,
  blockers:global.length?global:[{code:'AI_RELEASE_NO_ADMITTED_BRANCH',dependency_id:null}]});
 const dependencies={scope:current.scope,policy_sha256:policy.sha256,registry_sha256:registry.sha256,assessment_sha256:assessment.sha256,
  source_pins:current.source_pins,expected_generated_rules:current.expected_generated_rules??[],
  branches:branches.map(b=>({branch_id:b.branch_id,dependency_sha256:b.dependency_sha256}))};
 const body:ReceiptBody={schema_version:'tivdoc-ai-release-admission-v1',claim_kind:'qualified_ai_report',actor_kind:'ai_reviewer',
  reviewer_id:assessment.reviewer_id,reviewer_version:assessment.reviewer_version,human_attestation:null,namespace:current.namespace,
  environment:current.environment,is_qa:current.is_qa,expected_generated_rules:current.expected_generated_rules??[],
  policy_sha256:policy.sha256,registry_sha256:registry.sha256,registry_revision:registry.revision,assessment_sha256:assessment.sha256,
  scope:current.scope,source_pins:current.source_pins,branches,admitted_branch_ids:admitted.map(b=>b.branch_id),
  dependency_sha256:canonicalSha256(dependencies),evaluated_at:now,expires_at:earliest(admitted.map(b=>b.expires_at!))};
 if(engineering&&'owner_scope' in current){
  const engineeringBody={...body,schema_version:'tivdoc-owner-engineering-admission-v1' as const,claim_kind:'owner_engineering_review' as const,
   owner_scope:current.owner_scope,release_authorized:false as const,publication_allowed:false as const,notification_allowed:false as const,
   human_law_reviews:assessment.branches.flatMap(b=>{const p=policy.branches.find(p=>p.branch_id===b.branch_id),r=p?interpretationByHash.get(p.interpretation_receipt_sha256):undefined;
    return r?[{branch_id:b.branch_id,interpretation_receipt_sha256:r.sha256,human_by_law:r.human_by_law}]:[];})};
  const receipt=deepFreeze({...engineeringBody,sha256:canonicalSha256(engineeringBody)});engineeringIssued.add(receipt);
  return deepFreeze({state:'admitted',receipt,branches,blockers:[]});
 }
 const receipt=deepFreeze({...body,sha256:canonicalSha256(body)});issued.add(receipt);
 return deepFreeze({state:'admitted',receipt,branches,blockers:[]});
}

/** Brand protects against replacing a verified result with deserialized JSON.
 * Re-evaluate persisted input to obtain a new capability after restart. When
 * current context is supplied, also fence time and every server-owned pin. */
export function assertAiReleaseAdmission(receipt:AiReleaseAdmission,current?:AiReleaseCurrentContext):void{
 if(!issued.has(receipt))throw Error('AI_RELEASE_FACTORY_ADMISSION_REQUIRED');
 assertAdmissionCurrent(receipt,current);
}
export function assertOwnerEngineeringAdmission(receipt:OwnerEngineeringAdmission,current?:OwnerEngineeringCurrentContext):void{
 if(!engineeringIssued.has(receipt))throw Error('OWNER_ENGINEERING_FACTORY_ADMISSION_REQUIRED');
 if(current){
  if(!ownerEngineeringCurrentContextSchema.safeParse(current).success||!same(receipt.owner_scope,current.owner_scope))throw Error('OWNER_ENGINEERING_CURRENT_OWNER_MISMATCH');
  const {owner_scope,...common}=current;void owner_scope;assertAdmissionCurrent(receipt,common);
 }
}
function assertAdmissionCurrent(receipt:AiReleaseAdmission|OwnerEngineeringAdmission,current?:AiReleaseCurrentContext):void{
 if(!current)return;
 if(!aiReleaseCurrentContextSchema.safeParse(current).success)throw Error('AI_RELEASE_CURRENT_CONTEXT_INVALID');
 if(receipt.policy_sha256!==current.policy_sha256||receipt.registry_sha256!==current.registry_sha256
  ||receipt.registry_revision!==current.registry_revision||receipt.assessment_sha256!==current.assessment_sha256
  ||receipt.namespace!==current.namespace||receipt.environment!==current.environment||receipt.is_qa!==current.is_qa
  ||!same(receipt.expected_generated_rules,current.expected_generated_rules??[])
  ||!same(receipt.scope,current.scope)||!same(receipt.source_pins,current.source_pins))
  throw Error('AI_RELEASE_CURRENT_ADMISSION_MISMATCH');
 if(Date.parse(current.evaluated_at)<Date.parse(receipt.evaluated_at)||Date.parse(current.evaluated_at)>=Date.parse(receipt.expires_at))throw Error('AI_RELEASE_ADMISSION_EXPIRED');
}

export function aiReleaseAdmittedBranch(receipt:AiReleaseAdmission,branchId:string,current:AiReleaseCurrentContext):AiReleaseBranchDecision{
 assertAiReleaseAdmission(receipt,current);
 const branch=receipt.branches.find(b=>b.branch_id===branchId&&b.state==='admitted');
 if(!branch)throw Error('AI_RELEASE_BRANCH_NOT_ADMITTED');
 return branch;
}

export type {AiReleaseAssessmentInput};
