import "../production-refusal.mjs";
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,readdirSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AI_ASSEMBLY_VERSION,aiAssemblySchemas,loadAiAssemblyHelpers,assembleAiReleaseConfiguration,aiAssemblyReviewBinding,parseAiAssemblyArgs,
 readAiAssemblyEvidence,writeAiAssemblyOutput,runAiAssembly,safeAiAssemblyError} from './ai-release-configuration-assemble.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const digest=value=>createHash('sha256').update(value).digest('hex');
const from='2026-09-12T09:00:00Z',reviewAt='2026-09-12T09:01:00Z',testsAt='2026-09-12T09:02:00Z',at='2026-09-12T10:00:00Z',to='2026-09-12T12:00:00Z';
let h;
beforeAll(async()=>{h=await loadAiAssemblyHelpers();},30000);
function fixture(withMethod=false){
 const build=h.getCompiledAiReleaseBuild(),store=new Map(),evidence=[];
 const add=(id,kind,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);store.set(id,bytes);evidence.push({id,kind,path:`${id}.private.txt`,sha256:digest(bytes)});return id;};
 for(const kind of ['artifact','transcription','excerpt','verification','amendment_inventory','authority_analysis','product_decision','human_law_basis','test_definition','independent_oracle'])add(kind,kind,`Synthetic ${kind}; no case facts or human attestation.`);
 const recipe=h.AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-method.mw.method');
 if(withMethod){
  const bytes=readFileSync(path.join(ROOT,'docs/release-evidence/minimum-wage-june2026/minimum-wage-law-nii.pdf'));
  store.set('artifact',bytes);evidence.find(e=>e.id==='artifact').sha256=digest(bytes);
 }else add('method_review','method_review','Synthetic method review remains unresolved.');
 const result={schema_version:'tivdoc-ai-release-test-results-evidence-v1',branch_id:'entitlement.minimum_wage',code_sha256:build.manifest.source_graph_sha256,review_binding_sha256:'0'.repeat(64),
  test_definition_sha256:evidence.find(e=>e.id==='test_definition').sha256,independent_oracle_sha256:evidence.find(e=>e.id==='independent_oracle').sha256,
  categories:['positive','unknown','boundary'],passed:3,failed:0,outcome:'passed',issued_at:testsAt};
 add('results','test_results',JSON.stringify(result));
 const review={reviewer_id:'synthetic-ai-reviewer',reviewer_version:'1',review_method_version:'synthetic-offline-review-v1',confidence:0.8,
  confidence_explanation:'Synthetic incomplete review for assembly tests only.',issued_at:from,expires_at:to};
 const source={schema_version:'tivdoc-ai-source-review-v1',receipt_id:'source.one',source_version_id:withMethod?recipe.legal_sources[0].version_id:'synthetic.source@1',
  acquisition:withMethod?'primary_copy':'synthetic_fixture',source_url:'https://example.invalid/synthetic-source',
  artifact_evidence_id:'artifact',transcription_evidence_id:'transcription',verification_evidence_id:'verification',
  amendment_inventory_evidence_id:'amendment_inventory',authority_analysis_evidence_id:'authority_analysis',
  locators:[{page:1,provision:'Synthetic locator; not an approved reading',excerpt_evidence_id:'excerpt'}],
  valid_period:{from:'2026-05-01',to:'2026-07-31'},available_from:from,populations:['synthetic-adult-general'],topics:['minimum_wage'],status:'unknown',...review};
 const interpretation={schema_version:'tivdoc-ai-interpretation-review-v1',receipt_id:'interpretation.one',branch_id:'entitlement.minimum_wage',source_receipt_ids:['source.one'],
  period:{from:'2026-05-01',to:'2026-07-31'},populations:['synthetic-adult-general'],method_evidence_id:withMethod?null:'method_review',
  reasoning:'Synthetic assembly only; no source or legal acceptance is asserted.',limitations:['The legal review remains unresolved.'],
  human_by_law:{state:'unresolved',basis_evidence_id:'human_law_basis',source_receipt_ids:['source.one'],explanation:'No supported determination made.'},
  status:'unknown',...review,issued_at:reviewAt};
 const input={schema_version:AI_ASSEMBLY_VERSION,build_manifest_sha256:build.manifest.sha256,evaluated_at:at,
  configuration:{configuration_id:'22222222-2222-4222-8222-222222222222',revision:1,population:'synthetic-adult-general'},evidence,
  policy:{schema_version:'tivdoc-ai-release-policy-v1',policy_id:'synthetic-assembly-policy',version:'1',namespace:'isolated_test',allowed_environments:['development','test'],
   product_decision_evidence_id:'product_decision',review_method_version:review.review_method_version,minimum_review_confidence:0.7,
   claim_kind:'qualified_ai_report',human_attestation:null,issued_at:from,expires_at:to},
  registry:{schema_version:'tivdoc-ai-release-registry-v1',registry_id:'synthetic-assembly-registry',revision:1,namespace:'isolated_test',issued_at:from,expires_at:to,
   reviewers:[{actor_kind:'ai_reviewer',actor_id:review.reviewer_id,actor_version:'1',model_reference:'synthetic-test-only',review_method_version:review.review_method_version,issued_at:from,expires_at:to}],revocations:[]},
  source_reviews:[source],interpretations:[interpretation],
  tests:[{schema_version:'tivdoc-ai-rule-tests-v1',receipt_id:'tests.one',branch_id:'entitlement.minimum_wage',source_receipt_ids:['source.one'],
   interpretation_receipt_id:'interpretation.one',test_definition_evidence_id:'test_definition',independent_oracle_evidence_id:'independent_oracle',results_evidence_id:'results',expires_at:to}],
  methods:withMethod?[{recipe_id:recipe.recipe_id,recipe_version:recipe.recipe_version,recipe_sha256:recipe.recipe_sha256,source_policy_sha256:recipe.source_policy_sha256,
   interpretation_receipt_id:'interpretation.one',issued_at:reviewAt,expires_at:to}]:[],
  branches:[{branch_id:'entitlement.minimum_wage',period:{from:'2026-05-01',to:'2026-07-31'},populations:['synthetic-adult-general'],source_receipt_ids:['source.one'],
   interpretation_receipt_id:'interpretation.one',test_receipt_ids:['tests.one'],required_test_categories:['positive','unknown','boundary'],
   required_fact_keys:['generated.case_evidence'],document_reading_fact_keys:[],required_decision_ids:['mw.population']}]};
 const run=()=>assembleAiReleaseConfiguration(input,h,async e=>store.get(e.id));
 const setResult=change=>{Object.assign(result,change);const bytes=Buffer.from(JSON.stringify(result));store.set('results',bytes);evidence.find(e=>e.id==='results').sha256=digest(bytes);};
 setResult({review_binding_sha256:aiAssemblyReviewBinding(input,'interpretation.one',h)});
 return {input,store,result,setResult,run};
}

it('shares the bounded method capacity with the ordinary configuration contract',()=>{
 const f=fixture(true),method=f.input.methods[0],schema=aiAssemblySchemas(h).input.shape.methods;
 expect(h.AI_RELEASE_MAX_DECISION_METHODS).toBe(64);
 expect(schema.safeParse(Array.from({length:64},(_,i)=>({...method,recipe_id:'synthetic.capacity.'+i}))).success).toBe(true);
 expect(schema.safeParse(Array.from({length:65},(_,i)=>({...method,recipe_id:'synthetic.capacity.'+i}))).success).toBe(false);
 // Schema capacity does not accept invented recipe identities for assembly.
 f.input.methods[0].recipe_id='synthetic.unknown';return expect(f.run()).rejects.toThrow('AI_ASSEMBLY_RECIPE_PIN');
});

describe('offline immutable AI configuration assembly',()=>{
 it('produces the versioned evidence anchor only by explicit ordinary input without changing measured evidence',async()=>{
  const f=fixture(),legacy=await f.run();expect(legacy.configuration).not.toHaveProperty('evaluation_anchor_policy');
  f.input.configuration.evaluation_anchor_policy='bound-evidence-anchor-v1';
  const next=await f.run();expect(next.configuration.evaluation_anchor_policy).toBe('bound-evidence-anchor-v1');
  expect(next.configuration.sha256).not.toBe(legacy.configuration.sha256);expect(next.configuration.test_receipts).toEqual(legacy.configuration.test_receipts);
  expect(next.configuration.test_receipts[0].issued_at).toBe(testsAt);expect(next.configuration.policy).toEqual(legacy.configuration.policy);
  expect(await f.run()).toEqual(next);
  delete f.input.configuration.evaluation_anchor_policy;expect(await f.run()).toEqual(legacy);
  f.input.configuration.evaluation_anchor_policy='wall-clock-now';await expect(f.run()).rejects.toThrow();
 });
 it('assembles a distinct owner purpose without upgrading source or human-law status',async()=>{
  const f=fixture();f.input.schema_version='tivdoc-owner-engineering-assembly-input-v1';
  Object.assign(f.input.policy,{schema_version:'tivdoc-owner-engineering-policy-v1',purpose:'owner_engineering_review',claim_kind:'owner_engineering_review',allowed_environments:['development'],
   owner_scope:{case_id:'11111111-1111-4111-8111-111111111111',identity_id:'33333333-3333-4333-8333-333333333333',enrollment_id:'44444444-4444-4444-8444-444444444444'}});
  const r=await f.run();expect(r.configuration.schema_version).toBe('tivdoc-owner-engineering-configuration-v1');
  expect(r.configuration.interpretation_receipts[0].human_by_law.state).toBe('unresolved');
  expect(r.configuration.source_receipts[0].status).toBe('unknown');
  expect(r.receipt.schema_version).toBe('tivdoc-owner-engineering-assembly-receipt-v1');
  expect(()=>h.verifyAiReleaseConfiguration(r.configuration,h.getCompiledAiReleaseBuild())).toThrow();
  f.input.schema_version=AI_ASSEMBLY_VERSION;await expect(f.run()).rejects.toThrow('AI_ASSEMBLY_PURPOSE_MISMATCH');
 });
 it('builds all links from receipt IDs and preserves unresolved status and original input',async()=>{
  const f=fixture(),original=structuredClone(f.input),r=await f.run(),c=r.configuration;
  expect(f.input).toEqual(original);expect(c.source_receipts[0].status).toBe('unknown');expect(c.interpretation_receipts[0].human_by_law.state).toBe('unresolved');
  expect(c.policy.branches[0].source_receipt_sha256s).toEqual([c.source_receipts[0].sha256]);
  expect(c.test_receipts[0].interpretation_receipt_sha256).toBe(c.interpretation_receipts[0].sha256);expect(c.registry.policy_sha256).toBe(c.policy.sha256);
  expect(h.verifyAiReleaseConfiguration(c,h.getCompiledAiReleaseBuild()).configuration).toEqual(c);
  expect(r.receipt.preflight_reasons.map(x=>x.code)).toContain('HUMAN_BY_LAW_UNRESOLVED');expect(r.receipt.runtime_admission_evaluated).toBe(false);
  expect(JSON.stringify(c)).not.toContain('.private.txt');expect(JSON.stringify(c)).not.toContain('case_id');
 });
 it('produces exactly the same bytes on a retry without new dates',async()=>{const f=fixture();expect(await f.run()).toEqual(await f.run());});
 it('binds current catalog methods without a receipt-hash cycle',async()=>{
  const f=fixture(true),r=await f.run(),c=r.configuration;
  expect(c.methods[0].interpretation_receipt_sha256).toBe(c.interpretation_receipts[0].sha256);
  expect(c.interpretation_receipts[0].method_sha256).toBe(h.aiReleaseFamilyMethodsSha256('entitlement.minimum_wage',c.methods));
  expect(c.methods[0].source_receipts[0].receipt_sha256).toBe(c.source_receipts[0].sha256);
 });
 it.each(['recipe_sha256','source_policy_sha256'])('refuses changed method pin %s',async key=>{const f=fixture(true);f.input.methods[0][key]='0'.repeat(64);await expect(f.run()).rejects.toThrow('AI_ASSEMBLY_RECIPE_PIN');});
 it('refuses a changed compiled build before reading evidence',async()=>{
  const f=fixture();f.input.build_manifest_sha256='0'.repeat(64);const read=vi.fn();await expect(assembleAiReleaseConfiguration(f.input,h,read)).rejects.toThrow('AI_ASSEMBLY_BUILD_MISMATCH');expect(read).not.toHaveBeenCalled();
 });
 it('refuses missing explicit status, invented actor kind and any case payload',async()=>{
  for(const edit of [i=>delete i.source_reviews[0].status,i=>i.registry.reviewers[0].actor_kind='human_reviewer',
   i=>i.policy.human_attestation={signed:true},i=>i.case_facts={hours:100},i=>i.interpretations[0].facts={approved:true}]){
   const f=fixture();edit(f.input);await expect(f.run()).rejects.toThrow();
  }
 });
 it('refuses incorrect actual bytes and incorrect evidence purpose',async()=>{
  const f=fixture();f.store.set('artifact',Buffer.from('changed'));await expect(f.run()).rejects.toThrow('AI_ASSEMBLY_EVIDENCE_HASH');
  const g=fixture();g.input.source_reviews[0].artifact_evidence_id='transcription';await expect(g.run()).rejects.toThrow('AI_ASSEMBLY_EVIDENCE_REFERENCE');
 });
 it('refuses duplicate IDs, dangling receipt references and unused evidence',async()=>{
  for(const edit of [f=>f.input.evidence.push({...f.input.evidence[0]}),f=>f.input.source_reviews.push({...f.input.source_reviews[0]}),
   f=>f.input.branches[0].source_receipt_ids=['absent'],f=>f.input.evidence.push({...f.input.evidence[0],id:'unused'})]){
   const f=fixture();edit(f);f.store.set('unused',f.store.get('artifact'));await expect(f.run()).rejects.toThrow();
  }
 });
 it('refuses an unknown family, a period beyond the freeze and sources outside branch scope',async()=>{
  for(const edit of [i=>i.interpretations[0].branch_id='entitlement.other',i=>i.branches[0].period.to='2026-08-01',i=>i.source_reviews[0].topics=['travel']]){
   const f=fixture();edit(f.input);await expect(f.run()).rejects.toThrow();
  }
 });
 it('reads measured counts and categories from the pinned results file without converting failure to success',async()=>{
  const f=fixture();f.setResult({outcome:'failed',passed:1,failed:2,categories:['positive']});const r=await f.run();
  expect(r.configuration.test_receipts[0]).toMatchObject({outcome:'failed',passed:1,failed:2,categories:['positive']});
  expect(r.receipt.preflight_reasons.map(x=>x.code)).toEqual(expect.arrayContaining(['TESTS_NOT_PASSED','TEST_COVERAGE_MISSING']));
  f.input.tests[0].passed=100;await expect(f.run()).rejects.toThrow();
 });
 it.each(['code_sha256','test_definition_sha256','independent_oracle_sha256'])('refuses results whose %s does not match the actual evidence',async key=>{
  const f=fixture();f.setResult({[key]:'0'.repeat(64)});await expect(f.run()).rejects.toThrow('AI_ASSEMBLY_TEST_RESULTS_BINDING');
 });
 it('does not rebind old test results after a source or interpretation review is changed',async()=>{
  for(const edit of [i=>i.source_reviews[0].status='accepted',i=>i.interpretations[0].human_by_law.state='not_required_for_supported_branch',
   i=>i.interpretations[0].reasoning='A materially different reviewed method.']){
   const f=fixture();edit(f.input);await expect(f.run()).rejects.toThrow('AI_ASSEMBLY_TEST_RESULTS_BINDING');
  }
 });
 it('preserves expiry and chronology instead of minting new review dates',async()=>{
  const f=fixture();f.input.evaluated_at='2026-09-13T10:00:00Z';const r=await f.run();expect(r.receipt.preflight_reasons.map(x=>x.code)).toContain('EXPIRED');
  expect(r.configuration.policy.expires_at).toBe(to);f.setResult({issued_at:from});await expect(f.run()).rejects.toThrow('AI_CONFIGURATION_TEST_PRECEDES_INTERPRETATION');
 });
 it('does not accept synthetic sources for a real namespace',async()=>{const f=fixture();f.input.policy.namespace='real';f.input.registry.namespace='real';await expect(f.run()).rejects.toThrow('AI_CONFIGURATION_SYNTHETIC_SOURCE');});
 it('requires an unambiguous method basis and all catalog legal sources',async()=>{
  const f=fixture();f.input.interpretations[0].method_evidence_id=null;await expect(f.run()).rejects.toThrow('AI_ASSEMBLY_METHOD_BASIS');
  const g=fixture(true);g.input.source_reviews[0].source_version_id='different';await expect(g.run()).rejects.toThrow('AI_ASSEMBLY_METHOD_SOURCE');
 });
});

describe('assembly filesystem and CLI boundary',()=>{
 it('has strict non-DB commands and requires an explicit output only for assemble',()=>{
  expect(parseAiAssemblyArgs(['validate','--input','private.json'])).toEqual({command:'validate',input:'private.json'});
  for(const bad of [[],['activate'],['assemble','--input','x'],['validate','--input','x','--apply'],['validate','--input','x','--input','y'],['validate','--input','x','--credentials','y']])expect(()=>parseAiAssemblyArgs(bad)).toThrow('AI_ASSEMBLY_USAGE');
 });
 it('refuses production/preview before input reads, and refuses dynamically as an entry point',async()=>{
  const readInput=vi.fn();await expect(runAiAssembly(['validate','--input','x'],{env:{NODE_ENV:'production'},readInput})).rejects.toThrow();expect(readInput).not.toHaveBeenCalled();
  for(const env of [{NODE_ENV:'production'},{NODE_ENV:'test',VERCEL_ENV:'preview'}]){
   const r=spawnSync(process.execPath,['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','--experimental-strip-types','scripts/product-workers/ai-release-configuration-assemble.mjs'],
    {cwd:ROOT,env:{...process.env,...env},encoding:'utf8'});expect(r.status).toBe(2);expect(r.stderr).toContain('PRODUCTION_ENVIRONMENT_REFUSED');
  }
 });
 it('does not write for validate, mismatched evidence or a drift failure',async()=>{
  const f=fixture(),ports={env:{NODE_ENV:'test'},readInput:async()=>f.input,checkBuild:vi.fn(async()=>{}),helpers:async()=>h,
   readEvidence:async e=>f.store.get(e.id),writeOutput:vi.fn()};
  const result=await runAiAssembly(['validate','--input','x'],ports);expect(result.written).toBe(false);expect(ports.writeOutput).not.toHaveBeenCalled();
  ports.checkBuild.mockRejectedValueOnce(Error('AI_BUILD_MANIFEST_DRIFT'));await expect(runAiAssembly(['assemble','--input','x','--output-dir','y'],ports)).rejects.toThrow('AI_BUILD_MANIFEST_DRIFT');
  f.store.set('artifact',Buffer.from('wrong'));await expect(runAiAssembly(['assemble','--input','x','--output-dir','y'],ports)).rejects.toThrow('AI_ASSEMBLY_EVIDENCE_HASH');expect(ports.writeOutput).not.toHaveBeenCalled();
 });
 it('reads only explicit public evidence inside the checkout',()=>{
  const law='docs/release-evidence/minimum-wage-june2026/minimum-wage-law-nii.pdf';expect(digest(readAiAssemblyEvidence(law,ROOT))).toBe('4674f07928a2397b626db362c6c9b98b7c4e77e693e397463fdabd83c7f4f161');
  expect(()=>readAiAssemblyEvidence('package.json',ROOT)).toThrow('AI_CONTROL_PRIVATE_PATH_IN_CHECKOUT');
 });
 it('publishes one immutable private directory atomically and refuses changed retry bytes',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'tivdoc-private-unit-')),target=path.join(dir,'assembled');
  try{
   const result=await fixture().run();expect(writeAiAssemblyOutput(target,result)).toEqual({replayed:false});
   expect(writeAiAssemblyOutput(target,result)).toEqual({replayed:true});expect(readdirSync(dir)).toEqual(['assembled']);
   const changed=structuredClone(result);changed.receipt.integrity_valid=false;expect(()=>writeAiAssemblyOutput(target,changed)).toThrow('AI_ASSEMBLY_OUTPUT_MISMATCH');
   expect(JSON.parse(readFileSync(path.join(target,'assembly-receipt.private.json'),'utf8')).integrity_valid).toBe(true);
   expect(()=>writeAiAssemblyOutput(path.join(ROOT,'output/forbidden-assembly'),result)).toThrow('AI_CONTROL_PRIVATE_PATH_IN_CHECKOUT');
  }finally{
   if(existsSync(target)){for(const file of readdirSync(target))unlinkSync(path.join(target,file));rmdirSync(target);}rmdirSync(dir);
  }
 });
 it('rejects a nonempty output before creating any staging files',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'tivdoc-private-unit-')),target=path.join(dir,'existing');mkdirSync(target);writeFileSync(path.join(target,'keep.txt'),'kept');
  try{expect(()=>writeAiAssemblyOutput(target,{configuration:{},receipt:{}})).toThrow('AI_ASSEMBLY_OUTPUT_MISMATCH');expect(readdirSync(dir)).toEqual(['existing']);}
  finally{unlinkSync(path.join(target,'keep.txt'));rmdirSync(target);rmdirSync(dir);}
 });
 it('redacts parser errors and private paths',()=>{expect(safeAiAssemblyError(Error('secret C:/private/customer.txt'))).toBe('AI_ASSEMBLY_INVALID_INPUT');expect(safeAiAssemblyError(Error('AI_ASSEMBLY_EVIDENCE_HASH'))).toBe('AI_ASSEMBLY_EVIDENCE_HASH');});
});
