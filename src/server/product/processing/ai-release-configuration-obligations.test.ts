import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {AI_RELEASE_DECISION_RECIPES} from '../../../engine/ai-release-decisions/catalog';
import {AI_RELEASE_RUNTIME_FAMILIES} from '../../../engine/ai-release-runtime/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {aiReleaseConfigurationSchema,aiReleaseFamilyMethodsSha256,verifyAiReleaseConfiguration} from './ai-release-configuration';

vi.mock('server-only',()=>({}));
const build=getCompiledAiReleaseBuild();
const recipes=AI_RELEASE_DECISION_RECIPES.filter(recipe=>recipe.branch==='obligations');
const h=(label:string)=>canonicalSha256({synthetic:label});
const validity={issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
const period={from:'2026-06-01',to:'2026-06-30'},population='general_private_adult_21_59';
const seal=<T extends object>(body:T)=>({...body,sha256:canonicalSha256(body)});
function reseal(record:{sha256:string}){const {sha256,...body}=record;void sha256;record.sha256=canonicalSha256(body);}

// Full ordinary configuration shape with synthetic review metadata. This tests
// compiled family/source binding, not case admission or a real source review.
function configuration(methodFamily:string){
 if(recipes.length!==5)throw Error('OBLIGATION_RECIPE_FIXTURE_COUNT');
 const review={reviewer_id:'synthetic-obligation-reviewer',reviewer_version:'1',review_method_version:'synthetic-method-v1',
  confidence:0.9,confidence_explanation:'Synthetic configuration fixture only.',...validity};
 const laws=[...new Map(recipes.flatMap(recipe=>recipe.legal_sources).map(source=>[source.version_id,source])).values()];
 const sources=laws.map((law,index)=>seal({schema_version:'tivdoc-ai-source-review-v1',receipt_id:`source.${index}`,
  source_version_id:law.version_id,artifact_sha256:law.file_sha256,transcription_sha256:h(`transcription.${index}`),
  acquisition:'synthetic_fixture',source_url:'https://example.test/synthetic-law.pdf',
  locators:[{page:1,provision:'Synthetic locator; no source attestation.',excerpt_sha256:h(`excerpt.${index}`)}],
  verification_evidence_sha256:h(`verification.${index}`),amendment_inventory_sha256:h('amendments'),authority_analysis_sha256:h('authority'),
  valid_period:{from:'2026-01-01',to:null},available_from:validity.issued_at,populations:[population],
  topics:AI_RELEASE_RUNTIME_FAMILIES.map(family=>family.topic),status:'accepted',...review}));
 const sourceHashes=sources.map(source=>source.sha256);
 const interpretations=build.trusted_generator_pins.map(pin=>seal({schema_version:'tivdoc-ai-interpretation-review-v1',
  receipt_id:`interpretation.${pin.family_id}`,branch_id:pin.family_id,generator:pin.generator,
  source_receipt_sha256s:sourceHashes,period,populations:[population],
  method_sha256:pin.family_id===methodFamily?aiReleaseFamilyMethodsSha256(pin.family_id,recipes):h(`method.${pin.family_id}`),
  reasoning:'Synthetic bounded interpretation metadata.',limitations:['No legal attestation.'],
  human_by_law:{state:'unresolved',basis_sha256:h('unresolved'),source_receipt_sha256s:sourceHashes,explanation:'No actual case or legal authority.'},
  status:'unknown',...review}));
 const tests=interpretations.map(interpretation=>seal({schema_version:'tivdoc-ai-rule-tests-v1',receipt_id:`tests.${interpretation.branch_id}`,
  branch_id:interpretation.branch_id,generator:interpretation.generator,source_receipt_sha256s:sourceHashes,
  interpretation_receipt_sha256:interpretation.sha256,code_sha256:build.manifest.source_graph_sha256,
  test_definition_sha256:h('test definitions'),independent_oracle_sha256:h('synthetic oracle'),results_sha256:h('test results'),
  categories:['positive','unknown'],passed:2,failed:0,outcome:'passed',...validity}));
 const policy=seal({schema_version:'tivdoc-ai-release-policy-v1',policy_id:'synthetic-obligation-policy',version:'1',namespace:'isolated_test',
  allowed_environments:['development','test'],product_decision_sha256:h('product scope'),review_method_version:review.review_method_version,
  minimum_review_confidence:0.8,claim_kind:'qualified_ai_report',human_attestation:null,...validity,
  branches:AI_RELEASE_RUNTIME_FAMILIES.map((family,index)=>({branch_id:family.branch_id,topic:family.topic,
   generator:build.trusted_generator_pins[index].generator,period,populations:[population],source_receipt_sha256s:sourceHashes,
   interpretation_receipt_sha256:interpretations[index].sha256,test_receipt_sha256s:[tests[index].sha256],
   required_test_categories:['positive','unknown'],required_fact_keys:['generated.case_evidence'],document_reading_fact_keys:[],required_decision_ids:[]}))});
 const registry=seal({schema_version:'tivdoc-ai-release-registry-v1',registry_id:'synthetic-obligation-registry',revision:1,namespace:'isolated_test',
  policy_sha256:policy.sha256,...validity,reviewers:[{actor_kind:'ai_reviewer',actor_id:review.reviewer_id,actor_version:review.reviewer_version,
   model_reference:'synthetic-development-review',review_method_version:review.review_method_version,...validity}],revocations:[]});
 const interpretation=interpretations.find(value=>value.branch_id===methodFamily);
 if(!interpretation)throw Error('METHOD_FAMILY_FIXTURE');
 return aiReleaseConfigurationSchema.parse(seal({schema_version:'tivdoc-ai-release-configuration-v1',
  configuration_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',revision:1,population,build_manifest_sha256:build.manifest.sha256,
  policy,registry,source_receipts:sources,interpretation_receipts:interpretations,test_receipts:tests,
  methods:recipes.map(recipe=>({recipe_id:recipe.recipe_id,recipe_version:recipe.recipe_version,recipe_sha256:recipe.recipe_sha256,
   source_policy_sha256:recipe.source_policy_sha256,interpretation_receipt_sha256:interpretation.sha256,
   source_receipts:sources.map(source=>({receipt_sha256:source.sha256,source_version_id:source.source_version_id,artifact_sha256:source.artifact_sha256})),...validity}))}));
}

describe('ordinary full configuration obligation families',()=>{
 it.each(['entitlement.contract','entitlement.bonuses'])('binds all five compiled recipes to %s and all three source versions',family=>{
  const input=configuration(family),result=verifyAiReleaseConfiguration(input,build);
  expect(result.configuration.policy.branches).toHaveLength(9);
  expect(result.configuration.methods).toHaveLength(5);
  expect(result.configuration.methods?.every(method=>method.source_receipts.length===3)).toBe(true);
  expect(result.configuration.interpretation_receipts.every(receipt=>receipt.status==='unknown')).toBe(true);
  expect(result.configuration.policy.human_attestation).toBeNull();
 });
 it('rejects a correctly hashed method manifest assigned to an unrelated family',()=>{
  expect(()=>verifyAiReleaseConfiguration(configuration('entitlement.minimum_wage'),build)).toThrow('AI_CONFIGURATION_METHOD_FAMILY');
 });
 it('rejects a substituted historical source pin even when configuration bytes are resealed',()=>{
  const input=configuration('entitlement.contract');
  if(!input.methods)throw Error('METHOD_FIXTURE');
  input.methods[0].source_receipts[0].artifact_sha256=h('substituted source');reseal(input);
  expect(()=>verifyAiReleaseConfiguration(input,build)).toThrow('AI_CONFIGURATION_METHOD_LEGAL_SOURCES');
 });
});
