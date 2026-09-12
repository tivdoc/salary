import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../../../engine/rule-runtime/canonical';
import {aiReleasePolicySchema,aiReleaseRegistrySchema,aiReleaseSourceReceiptSchema,
 aiReleaseInterpretationReceiptSchema,aiReleaseTestReceiptSchema,ownerEngineeringPolicySchema} from '../../../engine/ai-release/contracts';
import {aiReleaseDecisionMethodSchema,AI_RELEASE_MAX_DECISION_METHODS,type AiReleaseDecisionMethod} from '../../../engine/ai-release-decisions/contracts';
import {AI_RELEASE_DECISION_RECIPES} from '../../../engine/ai-release-decisions/catalog';
import {AI_RELEASE_RUNTIME_FAMILIES} from '../../../engine/ai-release-runtime/contracts';
import {assertCompiledAiReleaseBuild,type AiReleaseCompiledBuild} from './ai-release-build';

export const AI_RELEASE_CONFIGURATION_VERSION='tivdoc-ai-release-configuration-v1' as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const aiReleaseConfigurationSchema=z.object({schema_version:z.literal(AI_RELEASE_CONFIGURATION_VERSION),
 configuration_id:z.uuid(),revision:z.number().int().positive(),population:z.string().min(1).max(200),build_manifest_sha256:hash,
 policy:aiReleasePolicySchema,registry:aiReleaseRegistrySchema,
 source_receipts:z.array(aiReleaseSourceReceiptSchema).min(1).max(256),
 interpretation_receipts:z.array(aiReleaseInterpretationReceiptSchema).min(1).max(128),
 test_receipts:z.array(aiReleaseTestReceiptSchema).min(1).max(256),
 methods:z.array(aiReleaseDecisionMethodSchema).max(AI_RELEASE_MAX_DECISION_METHODS).optional(),sha256:hash,
}).strict().superRefine((value,ctx)=>{
 const {sha256,...body}=value;
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'AI_CONFIGURATION_CONTENT_HASH'});
});
export type AiReleaseConfiguration=z.infer<typeof aiReleaseConfigurationSchema>;
export const ownerEngineeringConfigurationSchema=z.object({...aiReleaseConfigurationSchema.shape,
 schema_version:z.literal('tivdoc-owner-engineering-configuration-v1'),policy:ownerEngineeringPolicySchema,
}).strict().superRefine((value,ctx)=>{const {sha256,...body}=value;
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'AI_CONFIGURATION_CONTENT_HASH'});
});
export type OwnerEngineeringConfiguration=z.infer<typeof ownerEngineeringConfigurationSchema>;
export type AiReleaseFamilyMethod=Pick<AiReleaseDecisionMethod,'recipe_id'|'recipe_version'|'recipe_sha256'|'source_policy_sha256'>;
const familyMethodSchema=aiReleaseDecisionMethodSchema.pick({recipe_id:true,recipe_version:true,recipe_sha256:true,source_policy_sha256:true});

/** Issuers call this before sealing the interpretation. No interpretation
 * digest occurs in the body, so descriptor -> interpretation has no cycle. */
export function aiReleaseFamilyMethodsSha256(branchId:string,methods:readonly AiReleaseFamilyMethod[]):string{
 assert(AI_RELEASE_RUNTIME_FAMILIES.some(f=>f.branch_id===branchId),'AI_CONFIGURATION_METHOD_FAMILY');
 const recipes=methods.map(m=>familyMethodSchema.parse({recipe_id:m.recipe_id,recipe_version:m.recipe_version,
  recipe_sha256:m.recipe_sha256,source_policy_sha256:m.source_policy_sha256})).sort((a,b)=>a.recipe_id<b.recipe_id?-1:a.recipe_id>b.recipe_id?1:0);
 assert(new Set(recipes.map(r=>r.recipe_id)).size===recipes.length,'AI_CONFIGURATION_DUPLICATE_METHOD');
 return canonicalSha256({schema_version:'ai-release-family-methods-v1',branch_id:branchId,recipes});
}
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const setSame=(a:readonly string[],b:readonly string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(s=>b.includes(s));
function assert(condition:unknown,code:string):asserts condition{if(!condition)throw Error(code);}
function interval(v:{issued_at:string;expires_at:string}){assert(Date.parse(v.issued_at)<Date.parse(v.expires_at),'AI_CONFIGURATION_VALIDITY');}
function within(child:{issued_at:string;expires_at:string},parent:{issued_at:string;expires_at:string}){
 interval(child);interval(parent);
 return Date.parse(child.issued_at)>=Date.parse(parent.issued_at)&&Date.parse(child.expires_at)<=Date.parse(parent.expires_at);
}
function covers(a:{from:string;to:string|null},b:{from:string;to:string}){return a.from<=b.from&&(a.to===null||a.to>=b.to);}
function unique<T extends {receipt_id:string;sha256:string}>(values:T[]){
 assert(new Set(values.map(v=>v.receipt_id)).size===values.length&&new Set(values.map(v=>v.sha256)).size===values.length,'AI_CONFIGURATION_DUPLICATE_RECEIPT');
 return new Map(values.map(v=>[v.sha256,v]));
}

/** Static integrity only. This does not admit a case, assess facts, accept an
 * unknown legal review, or establish currentness/expiry against DB time.
 * expectedBuild must come from getCompiledAiReleaseBuild(), never the payload.
 * The caller separately authenticates the immutable DB config/enrollment. */
export function verifyAiReleaseConfiguration(candidate:unknown,expectedBuild:AiReleaseCompiledBuild){
 assertCompiledAiReleaseBuild(expectedBuild);
 return verifyConfiguration(aiReleaseConfigurationSchema.parse(candidate),expectedBuild);
}
export function verifyOwnerEngineeringConfiguration(candidate:unknown,expectedBuild:AiReleaseCompiledBuild){
 assertCompiledAiReleaseBuild(expectedBuild);
 return verifyConfiguration(ownerEngineeringConfigurationSchema.parse(candidate),expectedBuild);
}
function verifyConfiguration<T extends AiReleaseConfiguration|OwnerEngineeringConfiguration>(config:T,expectedBuild:AiReleaseCompiledBuild){
 assertCompiledAiReleaseBuild(expectedBuild);
 const {policy,registry}=config;
 assert(config.build_manifest_sha256===expectedBuild.manifest.sha256,'AI_CONFIGURATION_BUILD_MISMATCH');
 assert(registry.policy_sha256===policy.sha256&&registry.namespace===policy.namespace,'AI_CONFIGURATION_REGISTRY_POLICY');
 assert(within(registry,policy),'AI_CONFIGURATION_REGISTRY_WINDOW');
 const sources=unique(config.source_receipts),interpretations=unique(config.interpretation_receipts),tests=unique(config.test_receipts);
 unique([...config.source_receipts,...config.interpretation_receipts,...config.test_receipts]);
 assert(new Set(config.source_receipts.map(s=>s.source_version_id)).size===sources.size,'AI_CONFIGURATION_SOURCE_VERSION_AMBIGUOUS');
 const reviewerById=new Map(registry.reviewers.map(r=>[`${r.actor_id}:${r.actor_version}`,r]));
 for(const reviewer of registry.reviewers){interval(reviewer);assert(reviewer.review_method_version===policy.review_method_version,'AI_CONFIGURATION_REVIEW_METHOD');}
 for(const receipt of [...config.source_receipts,...config.interpretation_receipts]){
  interval(receipt);
  const reviewer=reviewerById.get(`${receipt.reviewer_id}:${receipt.reviewer_version}`);
  assert(reviewer&&within(receipt,reviewer),'AI_CONFIGURATION_REVIEWER_WINDOW');
  assert(receipt.review_method_version===policy.review_method_version,'AI_CONFIGURATION_REVIEW_METHOD');
 }
 const usedSources=new Set<string>(),usedInterpretations=new Set<string>(),usedTests=new Set<string>();
 for(const branch of policy.branches){
  const family=AI_RELEASE_RUNTIME_FAMILIES.find(f=>f.family_id===branch.branch_id&&f.topic===branch.topic);
  const pin=expectedBuild.trusted_generator_pins.find(p=>p.family_id===branch.branch_id);
  assert(family&&pin&&'generator'in branch&&same(branch.generator,pin.generator),'AI_CONFIGURATION_GENERATOR_BUILD');
  assert(branch.populations.includes(config.population),'AI_CONFIGURATION_POPULATION');
  assert(!branch.document_reading_fact_keys.includes('generated.case_evidence'),'AI_CONFIGURATION_MANIFEST_IS_NOT_DOCUMENT_READING');
  for(const sha of branch.source_receipt_sha256s){
   const source=sources.get(sha);assert(source,'AI_CONFIGURATION_SOURCE_MISSING');usedSources.add(sha);
   assert(source.populations.includes(config.population)&&source.topics.includes(branch.topic)&&covers(source.valid_period,branch.period),'AI_CONFIGURATION_SOURCE_SCOPE');
   assert(Date.parse(source.available_from)<=Date.parse(source.issued_at),'AI_CONFIGURATION_SOURCE_AVAILABILITY');
   assert(policy.namespace!=='real'||source.acquisition!=='synthetic_fixture','AI_CONFIGURATION_SYNTHETIC_SOURCE');
  }
  const interpretation=interpretations.get(branch.interpretation_receipt_sha256);
  assert(interpretation,'AI_CONFIGURATION_INTERPRETATION_MISSING');usedInterpretations.add(interpretation.sha256);
  assert(interpretation.branch_id===branch.branch_id&&'generator'in interpretation&&same(interpretation.generator,pin.generator),'AI_CONFIGURATION_INTERPRETATION_BINDING');
  assert(setSame(interpretation.source_receipt_sha256s,branch.source_receipt_sha256s),'AI_CONFIGURATION_INTERPRETATION_SOURCES');
  assert(interpretation.populations.includes(config.population)&&covers(interpretation.period,branch.period),'AI_CONFIGURATION_INTERPRETATION_SCOPE');
  assert(interpretation.human_by_law.source_receipt_sha256s.every(sha=>branch.source_receipt_sha256s.includes(sha)),'AI_CONFIGURATION_HUMAN_LAW_SOURCES');
  for(const sha of interpretation.source_receipt_sha256s){
   const source=sources.get(sha);assert(source&&Date.parse(source.issued_at)<=Date.parse(interpretation.issued_at),'AI_CONFIGURATION_INTERPRETATION_PRECEDES_SOURCE');
  }
  for(const sha of branch.test_receipt_sha256s){
   const test=tests.get(sha);assert(test,'AI_CONFIGURATION_TEST_MISSING');usedTests.add(sha);interval(test);
   assert(test.branch_id===branch.branch_id&&'generator'in test&&same(test.generator,pin.generator)
    &&test.code_sha256===expectedBuild.manifest.source_graph_sha256,'AI_CONFIGURATION_TEST_BUILD');
   assert(test.interpretation_receipt_sha256===interpretation.sha256&&setSame(test.source_receipt_sha256s,branch.source_receipt_sha256s),'AI_CONFIGURATION_TEST_BINDING');
   assert(Date.parse(test.issued_at)>=Date.parse(interpretation.issued_at),'AI_CONFIGURATION_TEST_PRECEDES_INTERPRETATION');
  }
 }
 assert(usedSources.size===sources.size&&usedInterpretations.size===interpretations.size&&usedTests.size===tests.size,'AI_CONFIGURATION_UNUSED_RECEIPT');
 const methods=config.methods??[];
 assert(new Set(methods.map(m=>m.recipe_id)).size===methods.length,'AI_CONFIGURATION_DUPLICATE_METHOD');
 for(const interpretation of config.interpretation_receipts){
  const selected=methods.filter(m=>m.interpretation_receipt_sha256===interpretation.sha256);
  if(selected.length)assert(interpretation.method_sha256===aiReleaseFamilyMethodsSha256(interpretation.branch_id,selected),'AI_CONFIGURATION_METHOD_INTERPRETATION_HASH');
 }
 for(const method of methods){
  const recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===method.recipe_id);
  assert(recipe&&recipe.recipe_version===method.recipe_version&&recipe.recipe_sha256===method.recipe_sha256
   &&recipe.source_policy_sha256===method.source_policy_sha256,'AI_CONFIGURATION_METHOD_RECIPE');
  const interpretation=interpretations.get(method.interpretation_receipt_sha256);
  assert(interpretation&&within(method,interpretation)&&within(method,policy)&&within(method,registry),'AI_CONFIGURATION_METHOD_WINDOW');
  const families=recipe.branch==='working_time'?['entitlement.working_time','entitlement.rest_day']:recipe.branch==='obligations'?['entitlement.contract','entitlement.bonuses']:[`entitlement.${recipe.branch}`];
  assert(families.includes(interpretation.branch_id),'AI_CONFIGURATION_METHOD_FAMILY');
  const required=[...new Set(recipe.legal_sources.map(s=>`${s.version_id}:${s.file_sha256}`))];
  const supplied=method.source_receipts.map(s=>`${s.source_version_id}:${s.artifact_sha256}`);
  assert(setSame(required,supplied),'AI_CONFIGURATION_METHOD_LEGAL_SOURCES');
  for(const ref of method.source_receipts){
   const source=sources.get(ref.receipt_sha256);
   assert(source&&source.source_version_id===ref.source_version_id&&source.artifact_sha256===ref.artifact_sha256
    &&interpretation.source_receipt_sha256s.includes(source.sha256),'AI_CONFIGURATION_METHOD_SOURCE_BINDING');
   assert(within(method,source),'AI_CONFIGURATION_METHOD_SOURCE_WINDOW');
  }
 }
 return deepFreeze({configuration:config,trusted_generator_pins:expectedBuild.trusted_generator_pins});
}
export type VerifiedAiReleaseConfiguration=ReturnType<typeof verifyAiReleaseConfiguration>;
export type VerifiedOwnerEngineeringConfiguration=ReturnType<typeof verifyOwnerEngineeringConfiguration>;
