import {describe,it,expect,vi} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {AI_RELEASE_RUNTIME_FAMILIES} from '../../../engine/ai-release-runtime/contracts';
import {AI_RELEASE_DECISION_RECIPES} from '../../../engine/ai-release-decisions/catalog';
import {aiReleaseConfigurationSchema,verifyAiReleaseConfiguration,aiReleaseFamilyMethodsSha256,type AiReleaseConfiguration,ownerEngineeringConfigurationSchema,verifyOwnerEngineeringConfiguration} from './ai-release-configuration';
import {getCompiledAiReleaseBuild,aiReleaseBuildManifestSchema} from './ai-release-build';

vi.mock('server-only',()=>({}));
const build=getCompiledAiReleaseBuild(),h=(label:string)=>canonicalSha256({synthetic:label});
const validity={issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
const period={from:'2026-06-01',to:'2026-06-30'},population='general_private_adult_21_59';
const seal=<T extends object>(body:T)=>({...body,sha256:canonicalSha256(body)});
function engineeringConfiguration(){
 const f=fixture(),policy={...f.policy,schema_version:'tivdoc-owner-engineering-policy-v1',purpose:'owner_engineering_review',claim_kind:'owner_engineering_review',namespace:'isolated_test',allowed_environments:['development'],
  owner_scope:{case_id:'77777777-7777-4777-8777-777777777777',identity_id:'22222222-2222-4222-8222-222222222222',enrollment_id:'33333333-3333-4333-8333-333333333333'}};
 reseal(policy);const registry={...f.registry,policy_sha256:policy.sha256,namespace:'isolated_test'};reseal(registry);
 const value={...f,schema_version:'tivdoc-owner-engineering-configuration-v1',policy,registry};reseal(value);
 return ownerEngineeringConfigurationSchema.parse(value);
}
describe('separate compiled owner engineering configuration',()=>{
 it('verifies exact compiled metadata without resolving its unknown interpretation',()=>{
  const f=engineeringConfiguration(),r=verifyOwnerEngineeringConfiguration(f,build);expect(r.configuration).toEqual(f);
  expect(r.configuration.interpretation_receipts.every(i=>i.human_by_law.state==='unresolved'&&i.status==='unknown')).toBe(true);
  expect(()=>verifyAiReleaseConfiguration(f,build)).toThrow();expect(()=>verifyOwnerEngineeringConfiguration(fixture(),build)).toThrow();
 });
 it('retains static build, hash, and namespace validation',()=>{
  const f=engineeringConfiguration();f.build_manifest_sha256='0'.repeat(64);reseal(f);expect(()=>verifyOwnerEngineeringConfiguration(f,build)).toThrow('AI_CONFIGURATION_BUILD_MISMATCH');
  const namespace={...engineeringConfiguration().policy,namespace:'real'};reseal(namespace);expect(ownerEngineeringConfigurationSchema.safeParse({...engineeringConfiguration(),policy:namespace}).success).toBe(false);
 });
});
function reseal(record:{sha256:string}){const {sha256,...body}=record;void sha256;record.sha256=canonicalSha256(body);}

// Synthetic configuration metadata only: no source approval, customer facts,
// namespace enrollment, assessment or external publication is produced.
function fixture(withMethod=false):AiReleaseConfiguration{
 const recipe=AI_RELEASE_DECISION_RECIPES[0],law=recipe.legal_sources[0];
 const review={reviewer_id:'synthetic-ai',reviewer_version:'1',review_method_version:'synthetic-reviewed-rules-v1',confidence:0.9,
  confidence_explanation:'Synthetic test receipt, not a real review.',...validity};
 const source=seal({schema_version:'tivdoc-ai-source-review-v1',receipt_id:'synthetic-source',source_version_id:law.version_id,
  artifact_sha256:law.file_sha256,transcription_sha256:h('transcription'),acquisition:'synthetic_fixture',source_url:'https://example.test/fixture.pdf',
  locators:[{page:1,provision:'Synthetic test pin only',excerpt_sha256:h('excerpt')}],verification_evidence_sha256:h('evidence'),
  amendment_inventory_sha256:h('amendments'),authority_analysis_sha256:h('authority'),valid_period:{from:'2026-01-01',to:null},
  available_from:validity.issued_at,populations:[population],topics:AI_RELEASE_RUNTIME_FAMILIES.map(f=>f.topic),status:'accepted',...review});
 const interpretations=build.trusted_generator_pins.map(pin=>seal({schema_version:'tivdoc-ai-interpretation-review-v1',receipt_id:`i.${pin.family_id}`,
  branch_id:pin.family_id,generator:pin.generator,source_receipt_sha256s:[source.sha256],period,populations:[population],
  method_sha256:withMethod&&pin.family_id==='entitlement.pension'?aiReleaseFamilyMethodsSha256(pin.family_id,[recipe]):h('interpretation'),reasoning:'Synthetic bounded method.',limitations:['No legal attestation.'],
  human_by_law:{state:'unresolved',basis_sha256:h('unresolved'),source_receipt_sha256s:[source.sha256],explanation:'No actual legal boundary decision.'},status:'unknown',...review}));
 const tests=interpretations.map(i=>seal({schema_version:'tivdoc-ai-rule-tests-v1',receipt_id:`t.${i.branch_id}`,branch_id:i.branch_id,generator:i.generator,
  source_receipt_sha256s:[source.sha256],interpretation_receipt_sha256:i.sha256,code_sha256:build.manifest.source_graph_sha256,
  test_definition_sha256:h('test definition'),independent_oracle_sha256:h('oracle'),results_sha256:h('result'),categories:['positive','unknown'],
  passed:2,failed:0,outcome:'passed',...validity}));
 const policy=seal({schema_version:'tivdoc-ai-release-policy-v1',policy_id:'synthetic-policy',version:'1',namespace:'isolated_test',allowed_environments:['development','test'],
  product_decision_sha256:h('synthetic product decision'),review_method_version:review.review_method_version,minimum_review_confidence:0.8,
  claim_kind:'qualified_ai_report',human_attestation:null,...validity,
  branches:AI_RELEASE_RUNTIME_FAMILIES.map((f,i)=>({branch_id:f.branch_id,topic:f.topic,generator:build.trusted_generator_pins[i].generator,period,populations:[population],
   source_receipt_sha256s:[source.sha256],interpretation_receipt_sha256:interpretations[i].sha256,test_receipt_sha256s:[tests[i].sha256],
   required_test_categories:['positive','unknown'],required_fact_keys:['generated.case_evidence'],document_reading_fact_keys:[],required_decision_ids:[]}))});
 const registry=seal({schema_version:'tivdoc-ai-release-registry-v1',registry_id:'synthetic-registry',revision:1,namespace:'isolated_test',policy_sha256:policy.sha256,...validity,
  reviewers:[{actor_kind:'ai_reviewer',actor_id:review.reviewer_id,actor_version:review.reviewer_version,model_reference:'synthetic-development-review',
   review_method_version:review.review_method_version,...validity}],revocations:[]});
 return aiReleaseConfigurationSchema.parse(seal({schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:'11111111-1111-4111-8111-111111111111',revision:1,
  population,build_manifest_sha256:build.manifest.sha256,policy,registry,source_receipts:[source],interpretation_receipts:interpretations,test_receipts:tests,
  ...(withMethod?{methods:[{recipe_id:recipe.recipe_id,recipe_version:recipe.recipe_version,recipe_sha256:recipe.recipe_sha256,source_policy_sha256:recipe.source_policy_sha256,
   interpretation_receipt_sha256:interpretations.find(i=>i.branch_id==='entitlement.pension')!.sha256,
   source_receipts:[{receipt_sha256:source.sha256,source_version_id:source.source_version_id,artifact_sha256:source.artifact_sha256}],...validity}]}:{})}));
}
function relink(c:AiReleaseConfiguration){
 c.source_receipts.forEach(reseal);
 const sourceHashes=c.source_receipts.map(s=>s.sha256);
 for(const i of c.interpretation_receipts){i.source_receipt_sha256s=sourceHashes;i.human_by_law.source_receipt_sha256s=sourceHashes;reseal(i);}
 for(const t of c.test_receipts){t.source_receipt_sha256s=sourceHashes;t.interpretation_receipt_sha256=c.interpretation_receipts.find(i=>i.branch_id===t.branch_id)!.sha256;reseal(t);}
 for(const b of c.policy.branches){b.source_receipt_sha256s=sourceHashes;b.interpretation_receipt_sha256=c.interpretation_receipts.find(i=>i.branch_id===b.branch_id)!.sha256;b.test_receipt_sha256s=c.test_receipts.filter(t=>t.branch_id===b.branch_id).map(t=>t.sha256);}
 reseal(c.policy);c.registry.policy_sha256=c.policy.sha256;reseal(c.registry);reseal(c);
}
const verify=(c:unknown)=>verifyAiReleaseConfiguration(c,build);

describe('immutable AI release configuration',()=>{
 it('returns nine compiled pins and retains unresolved reviews without admitting facts',()=>{
  const input=fixture(),result=verify(input);expect(result.trusted_generator_pins).toBe(build.trusted_generator_pins);
  expect(result.trusted_generator_pins).toHaveLength(9);expect(new Set(result.trusted_generator_pins.map(p=>p.generator.code_sha256))).toEqual(new Set([build.manifest.source_graph_sha256]));
  expect(result.configuration.interpretation_receipts.every(i=>i.status==='unknown'&&i.human_by_law.state==='unresolved')).toBe(true);
  expect(Object.isFrozen(result.configuration.policy.branches[0])).toBe(true);
  input.population='changed after verification';expect(result.configuration.population).toBe(population);
 });
 it.each(['facts','assessment','current','case_id','trusted_generator_pins'])('rejects caller case/expectation field %s',key=>{
  expect(()=>verify({...fixture(),[key]:{}})).toThrow();
 });
 it('rejects altered config bytes and independently resealed wrong build',()=>{
  const c=fixture();c.population='tampered';expect(()=>verify(c)).toThrow('AI_CONFIGURATION_CONTENT_HASH');
  const wrong=fixture();wrong.build_manifest_sha256=h('foreign build');reseal(wrong);expect(()=>verify(wrong)).toThrow('AI_CONFIGURATION_BUILD_MISMATCH');
 });
 it('rejects a serialized or forged expected build even if its own hashes agree',()=>{
  expect(()=>verifyAiReleaseConfiguration(fixture(),structuredClone(build))).toThrow('AI_RELEASE_UNTRUSTED_BUILD_EXPECTATION');
 });
 it('requires all policy generator pins to match compiled family and code',()=>{
  const c=fixture(),b=c.policy.branches[0];if(!('generator'in b))throw Error('fixture');b.generator={...b.generator,code_sha256:h('old source')};relink(c);
  expect(()=>verify(c)).toThrow('AI_CONFIGURATION_GENERATOR_BUILD');
 });
 it('rejects old-build tests even if rehashed and linked into a new policy',()=>{
  const c=fixture();c.test_receipts[0].code_sha256=h('old tested build');relink(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_TEST_BUILD');
 });
 it('rejects foreign registry policy, missing receipt and duplicate identity',()=>{
  const c=fixture();c.registry.policy_sha256=h('foreign');reseal(c.registry);reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_REGISTRY_POLICY');
  const missing=fixture();missing.policy.branches[0].source_receipt_sha256s=[h('missing')];reseal(missing.policy);missing.registry.policy_sha256=missing.policy.sha256;reseal(missing.registry);reseal(missing);
  expect(()=>verify(missing)).toThrow('AI_CONFIGURATION_SOURCE_MISSING');
  const duplicate=fixture();duplicate.source_receipts.push(duplicate.source_receipts[0]);reseal(duplicate);expect(()=>verify(duplicate)).toThrow('AI_CONFIGURATION_DUPLICATE_RECEIPT');
 });
 it('rejects foreign population and a manifest disguised as document reading',()=>{
  const c=fixture();c.population='other-population';reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_POPULATION');
  const fake=fixture();fake.policy.branches[0].document_reading_fact_keys=['generated.case_evidence'];relink(fake);expect(()=>verify(fake)).toThrow('AI_CONFIGURATION_MANIFEST_IS_NOT_DOCUMENT_READING');
 });
 it('requires positive validity windows without treating an old valid config as current',()=>{
  const c=fixture();expect(verify(c).configuration.registry.expires_at).toBe(validity.expires_at);
  c.registry.expires_at=c.registry.issued_at;reseal(c.registry);reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_VALIDITY');
 });
 it('rejects a test receipt linked to another interpretation',()=>{
  const c=fixture();c.test_receipts[0].interpretation_receipt_sha256=c.interpretation_receipts[1].sha256;reseal(c.test_receipts[0]);c.policy.branches[0].test_receipt_sha256s=[c.test_receipts[0].sha256];reseal(c.policy);c.registry.policy_sha256=c.policy.sha256;reseal(c.registry);reseal(c);
  expect(()=>verify(c)).toThrow('AI_CONFIGURATION_TEST_BINDING');
 });
 it('accepts optional exact compiled method, without changing absent historical fields',()=>{
  expect('methods'in verify(fixture()).configuration).toBe(false);expect(verify(fixture(true)).configuration.methods).toHaveLength(1);
 });
 it('rejects changed recipes and unpinned source artifacts',()=>{
  const c=fixture(true);c.methods![0].recipe_sha256=h('recipe');reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_METHOD_INTERPRETATION_HASH');
  const foreign=fixture(true);foreign.methods![0].source_receipts[0].artifact_sha256=h('foreign artifact');reseal(foreign);expect(()=>verify(foreign)).toThrow('AI_CONFIGURATION_METHOD_LEGAL_SOURCES');
 });
 it('rejects method expiry beyond its source or interpretation receipt',()=>{
  const c=fixture(true);c.methods![0].expires_at='2026-09-14T00:00:00Z';reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_METHOD_WINDOW');
  const narrow=fixture(true);narrow.source_receipts[0].expires_at='2026-09-12T12:00:00Z';relink(narrow);
  narrow.methods![0].source_receipts[0].receipt_sha256=narrow.source_receipts[0].sha256;
  narrow.methods![0].interpretation_receipt_sha256=narrow.interpretation_receipts.find(i=>i.branch_id==='entitlement.pension')!.sha256;reseal(narrow);
  expect(()=>verify(narrow)).toThrow('AI_CONFIGURATION_METHOD_SOURCE_WINDOW');
 });
 it('binds the exact family recipe set to its reviewed interpretation, independent of order',()=>{
  const recipes=AI_RELEASE_DECISION_RECIPES.filter(r=>r.branch==='travel');
  expect(aiReleaseFamilyMethodsSha256('entitlement.travel',recipes)).toBe(aiReleaseFamilyMethodsSha256('entitlement.travel',[...recipes].reverse()));
  expect(aiReleaseFamilyMethodsSha256('entitlement.travel',recipes)).not.toBe(aiReleaseFamilyMethodsSha256('entitlement.pension',recipes));
  const c=fixture(true),i=c.interpretation_receipts.find(r=>r.branch_id==='entitlement.pension')!;
  i.method_sha256=h('unrelated interpretation method');relink(c);c.methods![0].interpretation_receipt_sha256=i.sha256;reseal(c);
  expect(()=>verify(c)).toThrow('AI_CONFIGURATION_METHOD_INTERPRETATION_HASH');
 });
 it('does not allow resealing an unknown recipe into a reviewed family method',()=>{
  const c=fixture(true),i=c.interpretation_receipts.find(r=>r.branch_id==='entitlement.pension')!;
  c.methods![0].recipe_id='ai-method.unknown';i.method_sha256=aiReleaseFamilyMethodsSha256(i.branch_id,c.methods!);relink(c);
  c.methods![0].interpretation_receipt_sha256=i.sha256;reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_METHOD_RECIPE');
 });
 it('rejects method source receipt substitution and duplicates',()=>{
  const c=fixture(true);c.methods![0].source_receipts[0].receipt_sha256=h('wrong receipt');reseal(c);expect(()=>verify(c)).toThrow('AI_CONFIGURATION_METHOD_SOURCE_BINDING');
  const duplicate=fixture(true);duplicate.methods!.push(duplicate.methods![0]);reseal(duplicate);expect(()=>verify(duplicate)).toThrow('AI_CONFIGURATION_DUPLICATE_METHOD');
 });
});

describe('AI release build source identity',()=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url));
 const script=path.join(root,'scripts/ai-release-build-manifest.mjs');
 const scriptUrl=pathToFileURL(script).href;
 const env={...process.env,NODE_ENV:'test' as const,VERCEL_ENV:'development'};
 function manifests(){
  const code=`const {manifestFromSources:m}=await import(${JSON.stringify(scriptUrl)});const a=[{path:'src/b.ts',content:'B\\r\\n'},{path:'src/a.ts',content:'A\\r\\n'}];const base=m(['src/a.ts'],a);const lf=m(['src/a.ts'],a.toReversed().map(f=>({...f,content:f.content.replaceAll('\\r','')})));const changed=m(['src/a.ts'],a.map(f=>f.path==='src/b.ts'?{...f,content:'different'}:f));const bad=['../secret.ts','src/test.fixture.ts','src/server/product/processing/ai-release-build-manifest.json'].map(path=>{try{m([path],[{path,content:'x'}]);return false;}catch{return true;}});console.log(JSON.stringify({base,lf,changed,bad}));`;
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',env})) as {base:unknown;lf:unknown;changed:unknown;bad:boolean[]};
 }
 it('normalizes LF and sort order, but changes digest for imported implementation changes',()=>{
  const r=manifests();expect(r.base).toEqual(r.lf);expect(r.base).not.toEqual(r.changed);expect(r.bad).toEqual([true,true,true]);
  expect(aiReleaseBuildManifestSchema.parse(r.base).source_graph_sha256).toMatch(/^[a-f0-9]{64}$/u);
 });
 it('compiled inventory contains all automatic branches/decision code and no fixtures',()=>{
  const paths=build.manifest.files.map(f=>f.path);
  expect(paths).toContain('src/engine/ai-release-decisions/catalog.ts');expect(paths).toContain('src/engine/entitlement-review/automatic-nonpay.ts');
  expect(paths.some(p=>/\.(?:test|fixture)\./u.test(p))).toBe(false);expect(paths).not.toContain('src/server/product/processing/ai-release-build-manifest.json');
  expect(paths).toContain('package-lock.json');
 });
 it('checks a real transitive source graph and refuses drift without rewriting its manifest',()=>{
  const code=`const {collectAiReleaseBuildManifest:collect,checkAiReleaseBuildManifest:check}=await import(${JSON.stringify(scriptUrl)});
const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'tivdoc-ai-build-unit-'));
try{
 const output=path.join(temp,'src/server/product/processing/ai-release-build-manifest.json');await fs.mkdir(path.dirname(output),{recursive:true});
 await fs.writeFile(path.join(temp,'tsconfig.json'),JSON.stringify({compilerOptions:{moduleResolution:'bundler'}}));
 await fs.writeFile(path.join(temp,'src/entry.ts'),"import './helper.ts';\\n");await fs.writeFile(path.join(temp,'src/helper.ts'),'export const value=1;\\r\\n');
 const options={entrypoints:['src/entry.ts'],buildInputs:['tsconfig.json']};const first=await collect(temp,options),bytes=JSON.stringify(first,null,2)+'\\n';await fs.writeFile(output,bytes);
 await fs.writeFile(path.join(temp,'src/unused.test.ts'),'not in graph');await check(temp,options);
 await fs.writeFile(path.join(temp,'src/helper.ts'),'export const value=1;\\n');await check(temp,options);
 await fs.writeFile(path.join(temp,'src/helper.ts'),'export const value=2;\\n');let drift=false;try{await check(temp,options);}catch(e){drift=e.message==='AI_BUILD_MANIFEST_DRIFT';}
 const preserved=(await fs.readFile(output,'utf8'))===bytes;
 await fs.writeFile(path.join(temp,'src/entry.ts'),"import './unused.test.ts';\\n");let excluded=false;try{await collect(temp,options);}catch(e){excluded=e.message==='AI_BUILD_EXCLUDED_DEPENDENCY';}
 console.log(JSON.stringify({paths:first.files.map(f=>f.path),drift,preserved,excluded}));
}finally{const actual=await fs.realpath(temp),parent=await fs.realpath(os.tmpdir());if(path.dirname(actual)!==parent||!path.basename(actual).startsWith('tivdoc-ai-build-unit-'))throw Error('TEST_CLEANUP_SCOPE');await fs.rm(actual,{recursive:true});}`;
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',env})) as {paths:string[];drift:boolean;preserved:boolean;excluded:boolean};
  expect(result.paths).toEqual(['src/entry.ts','src/helper.ts','tsconfig.json']);expect(result.drift).toBe(true);expect(result.preserved).toBe(true);expect(result.excluded).toBe(true);
 });
 it.each([{NODE_ENV:'production',VERCEL_ENV:'development'},{NODE_ENV:'test',VERCEL_ENV:'preview'}] as const)('refuses the direct script before reading or writing in %o',override=>{
  const r=spawnSync(process.execPath,[script,'--write'],{cwd:root,encoding:'utf8',env:{...env,...override}});
  expect(r.status).toBe(2);expect(r.stderr).toContain('PRODUCTION_ENVIRONMENT_REFUSED');expect(r.stdout).toBe('');
 });
});
