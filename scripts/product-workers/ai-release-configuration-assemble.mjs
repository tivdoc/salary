import "../production-refusal.mjs";
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,statSync,readdirSync,mkdtempSync,writeFileSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileFunction} from 'node:vm';
import {assertLocalAiControl,aiControlPrivatePath} from './ai-release-control.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const AI_ASSEMBLY_VERSION='tivdoc-ai-release-assembly-input-v1';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const assert=(condition,code)=>{if(!condition)throw Error(code);};
const kinds=['artifact','transcription','excerpt','verification','amendment_inventory','authority_analysis','product_decision',
 'human_law_basis','method_review','test_definition','independent_oracle','test_results'];
const inside=(base,file)=>{const rel=path.relative(base,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};

/** Fixed repository entry only. No caller text, credentials, DB modules or
 * environment-file loader is put in executable source. */
export async function loadAiAssemblyHelpers(){
 const {build}=await import('esbuild');
 const result=await build({stdin:{contents:`export {z} from 'zod';
 export * from './src/engine/ai-release/contracts';
 export {canonicalSha256} from './src/engine/rule-runtime/canonical';
 export {AI_RELEASE_RUNTIME_FAMILIES} from './src/engine/ai-release-runtime/contracts';
 export {AI_RELEASE_DECISION_RECIPES} from './src/engine/ai-release-decisions/catalog';
 export {aiReleaseDecisionMethodSchema,AI_RELEASE_MAX_DECISION_METHODS} from './src/engine/ai-release-decisions/contracts';
 export {aiReleaseConfigurationSchema,aiReleaseFamilyMethodsSha256,verifyAiReleaseConfiguration} from './src/server/product/processing/ai-release-configuration';
 export {getCompiledAiReleaseBuild} from './src/server/product/processing/ai-release-build';`,resolveDir:ROOT,loader:'ts'},
  absWorkingDir:ROOT,bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',write:false,logLevel:'silent',
  plugins:[{name:'assembly-server-only',setup(b){b.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'empty'}));
   b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:''}));}}]});
 const bundledModule={exports:{}};
 compileFunction(result.outputFiles[0].text,['require','module','exports'])(createRequire(path.join(ROOT,'package.json')),bundledModule,bundledModule.exports);
 return bundledModule.exports;
}

/** Reuse field contracts, then validate the sealed output with the existing
 * full verifier. Assembly references replace hashes, never review decisions. */
export function aiAssemblySchemas(h){
 const {z}=h,sha=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().min(1).max(200);
 const ids=z.array(id).min(1).max(256).refine(v=>new Set(v).size===v.length);
 const fields=(schema,omit)=>Object.fromEntries(Object.entries(schema.shape).filter(([key])=>!omit.includes(key)));
 const generated=schema=>schema.options.find(option=>option.shape.generator);
 const source=z.object({...fields(h.aiReleaseSourceReceiptSchema,['sha256','artifact_sha256','transcription_sha256','locators',
  'verification_evidence_sha256','amendment_inventory_sha256','authority_analysis_sha256']),
  artifact_evidence_id:id,transcription_evidence_id:id,verification_evidence_id:id,amendment_inventory_evidence_id:id,authority_analysis_evidence_id:id,
  locators:z.array(z.object({page:z.number().int().positive(),provision:id,excerpt_evidence_id:id}).strict()).min(1).max(128)}).strict();
 const interpretation=z.object({...fields(generated(h.aiReleaseInterpretationReceiptSchema),['sha256','generator','source_receipt_sha256s','method_sha256','human_by_law']),
  source_receipt_ids:ids,method_evidence_id:id.nullable(),
  human_by_law:z.object({state:z.enum(['required','not_required_for_supported_branch','unresolved']),basis_evidence_id:id,
   source_receipt_ids:ids,explanation:z.string().min(1).max(2000)}).strict()}).strict();
 const test=z.object({...fields(generated(h.aiReleaseTestReceiptSchema),['sha256','generator','source_receipt_sha256s','interpretation_receipt_sha256',
  'code_sha256','test_definition_sha256','independent_oracle_sha256','results_sha256','categories','passed','failed','outcome','issued_at']),
  source_receipt_ids:ids,interpretation_receipt_id:id,test_definition_evidence_id:id,independent_oracle_evidence_id:id,results_evidence_id:id}).strict();
 const method=z.object({...fields(h.aiReleaseDecisionMethodSchema,['interpretation_receipt_sha256','source_receipts']),interpretation_receipt_id:id}).strict();
 const branch=z.object({...fields(generated(h.aiReleaseBranchPolicySchema),['generator','topic','source_receipt_sha256s','interpretation_receipt_sha256','test_receipt_sha256s']),
  source_receipt_ids:ids,interpretation_receipt_id:id,test_receipt_ids:ids}).strict();
 const policy=z.object({...fields(h.aiReleasePolicySchema,['sha256','branches','product_decision_sha256']),product_decision_evidence_id:id}).strict();
 const registry=z.object(fields(h.aiReleaseRegistrySchema,['sha256','policy_sha256'])).strict();
 const result=z.object({schema_version:z.literal('tivdoc-ai-release-test-results-evidence-v1'),branch_id:id,code_sha256:sha,review_binding_sha256:sha,
  test_definition_sha256:sha,independent_oracle_sha256:sha,categories:ids,passed:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),
  outcome:z.enum(['passed','failed','incomplete']),issued_at:z.iso.datetime({offset:true})}).strict();
 const input=z.object({schema_version:z.literal(AI_ASSEMBLY_VERSION),build_manifest_sha256:sha,evaluated_at:z.iso.datetime({offset:true}),
  configuration:z.object({configuration_id:z.uuid(),revision:z.number().int().positive(),population:id}).strict(),
  evidence:z.array(z.object({id,kind:z.enum(kinds),path:z.string().min(1).max(2048),sha256:sha}).strict()).min(1).max(2048),
  policy,registry,source_reviews:z.array(source).min(1).max(256),interpretations:z.array(interpretation).min(1).max(128),
  tests:z.array(test).min(1).max(256),methods:z.array(method).max(h.AI_RELEASE_MAX_DECISION_METHODS),branches:z.array(branch).min(1).max(9)}).strict();
 return {input,result};
}

function index(values,key,code){const map=new Map(values.map(v=>[v[key],v]));assert(map.size===values.length,code);return map;}

/** The test collector computes this before its run from the reviewed inputs.
 * It binds approval/status changes as well as source bytes and method pins.
 * Test results are deliberately excluded: this graph has no hash cycle. */
export function aiAssemblyReviewBinding(candidate,interpretationId,h){
 const {build_manifest_sha256,source_reviews,interpretations,methods,evidence}=candidate;
 const input=aiAssemblySchemas(h).input.pick({build_manifest_sha256:true,source_reviews:true,interpretations:true,methods:true,evidence:true})
  .parse({build_manifest_sha256,source_reviews,interpretations,methods,evidence});
 assert(input.build_manifest_sha256===h.getCompiledAiReleaseBuild().manifest.sha256,'AI_ASSEMBLY_BUILD_MISMATCH');
 const interpretation=index(input.interpretations,'receipt_id','AI_ASSEMBLY_DUPLICATE_INTERPRETATION').get(interpretationId);
 assert(interpretation,'AI_ASSEMBLY_RECEIPT_REFERENCE');
 const sourceMap=index(input.source_reviews,'receipt_id','AI_ASSEMBLY_DUPLICATE_SOURCE');
 const selectedSources=interpretation.source_receipt_ids.map(id=>{const s=sourceMap.get(id);assert(s,'AI_ASSEMBLY_RECEIPT_REFERENCE');return s;})
  .sort((a,b)=>a.receipt_id.localeCompare(b.receipt_id,'en'));
 const selectedMethods=input.methods.filter(m=>m.interpretation_receipt_id===interpretationId).sort((a,b)=>a.recipe_id.localeCompare(b.recipe_id,'en'));
 const evidenceIds=new Set([interpretation.human_by_law.basis_evidence_id,...(interpretation.method_evidence_id?[interpretation.method_evidence_id]:[]),
  ...selectedSources.flatMap(s=>[s.artifact_evidence_id,s.transcription_evidence_id,s.verification_evidence_id,s.amendment_inventory_evidence_id,
   s.authority_analysis_evidence_id,...s.locators.map(l=>l.excerpt_evidence_id)])]);
 const evidenceMap=index(input.evidence,'id','AI_ASSEMBLY_DUPLICATE_EVIDENCE');
 const boundEvidence=[...evidenceIds].sort().map(id=>{const e=evidenceMap.get(id);assert(e,'AI_ASSEMBLY_EVIDENCE_REFERENCE');return {id,kind:e.kind,sha256:e.sha256};});
 return h.canonicalSha256({schema_version:'tivdoc-ai-release-test-review-binding-v1',build_manifest_sha256:input.build_manifest_sha256,
  interpretation,source_reviews:selectedSources,methods:selectedMethods,evidence:boundEvidence});
}

function preflightReasons(config,at){
 const reasons=[];const add=(code,id)=>reasons.push({code,id});
 const windows=[{receipt_id:'policy',...config.policy},{receipt_id:'registry',...config.registry},
  ...config.registry.reviewers.map(r=>({...r,receipt_id:r.actor_id})),...config.source_receipts,...config.interpretation_receipts,...config.test_receipts,
  ...(config.methods??[]).map(m=>({...m,receipt_id:m.recipe_id}))];
 for(const v of windows){if(Date.parse(v.issued_at)>Date.parse(at))add('NOT_YET_VALID',v.receipt_id);if(Date.parse(v.expires_at)<=Date.parse(at))add('EXPIRED',v.receipt_id);}
 for(const v of [...config.source_receipts,...config.interpretation_receipts]){
  if(v.status!=='accepted')add(`REVIEW_${v.status.toUpperCase()}`,v.receipt_id);
  if(v.confidence<config.policy.minimum_review_confidence)add('REVIEW_CONFIDENCE',v.receipt_id);
 }
 for(const v of config.interpretation_receipts)if(v.human_by_law.state!=='not_required_for_supported_branch')add(`HUMAN_BY_LAW_${v.human_by_law.state.toUpperCase()}`,v.receipt_id);
 for(const v of config.test_receipts)if(v.outcome!=='passed'||v.failed!==0||v.passed<1)add('TESTS_NOT_PASSED',v.receipt_id);
 for(const b of config.policy.branches){
  const categories=new Set(config.test_receipts.filter(t=>b.test_receipt_sha256s.includes(t.sha256)).flatMap(t=>t.categories));
  for(const c of b.required_test_categories)if(!categories.has(c))add('TEST_COVERAGE_MISSING',`${b.branch_id}:${c}`);
 }
 for(const r of config.registry.revocations)if(Date.parse(r.effective_at)<=Date.parse(at))add('REVOCATION_REQUIRES_RUNTIME_CHECK',r.target_sha256);
 return reasons.sort((a,b)=>(a.code+':'+a.id).localeCompare(b.code+':'+b.id,'en'));
}

/** Offline, side-effect-free apart from supplied evidence reads. The compiled
 * verifier supplies trust; ports do not supply a replacement build or pins. */
export async function assembleAiReleaseConfiguration(candidate,h,readEvidence){
 const schemas=aiAssemblySchemas(h),input=schemas.input.parse(candidate),build=h.getCompiledAiReleaseBuild();
 assert(input.build_manifest_sha256===build.manifest.sha256,'AI_ASSEMBLY_BUILD_MISMATCH');
 const evidence=index(input.evidence,'id','AI_ASSEMBLY_DUPLICATE_EVIDENCE'),usedEvidence=new Set(),bytesById=new Map();
 let total=0;
 for(const e of evidence.values()){
  const bytes=await readEvidence(e);assert(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=32*1024*1024,'AI_ASSEMBLY_EVIDENCE_SIZE');
  total+=bytes.byteLength;assert(total<=128*1024*1024,'AI_ASSEMBLY_TOTAL_SIZE');
  assert(hash(bytes)===e.sha256,'AI_ASSEMBLY_EVIDENCE_HASH');bytesById.set(e.id,bytes);
 }
 const evidenceHash=(id,kind)=>{const e=evidence.get(id);assert(e&&e.kind===kind,'AI_ASSEMBLY_EVIDENCE_REFERENCE');usedEvidence.add(id);return e.sha256;};
 const seal=body=>({...body,sha256:h.canonicalSha256(body)});
 const pins=index(build.trusted_generator_pins,'family_id','AI_ASSEMBLY_DUPLICATE_FAMILY');
 const generator=id=>{const p=pins.get(id);assert(p,'AI_ASSEMBLY_UNKNOWN_FAMILY');return p.generator;};
 const sources=input.source_reviews.map(s=>{
  const {artifact_evidence_id,transcription_evidence_id,verification_evidence_id,amendment_inventory_evidence_id,authority_analysis_evidence_id,locators,...body}=s;
  return seal({...body,artifact_sha256:evidenceHash(artifact_evidence_id,'artifact'),transcription_sha256:evidenceHash(transcription_evidence_id,'transcription'),
   verification_evidence_sha256:evidenceHash(verification_evidence_id,'verification'),amendment_inventory_sha256:evidenceHash(amendment_inventory_evidence_id,'amendment_inventory'),
   authority_analysis_sha256:evidenceHash(authority_analysis_evidence_id,'authority_analysis'),
   locators:locators.map(({excerpt_evidence_id,...l})=>({...l,excerpt_sha256:evidenceHash(excerpt_evidence_id,'excerpt')}))});
 });
 const sourceMap=index(sources,'receipt_id','AI_ASSEMBLY_DUPLICATE_SOURCE');
 const refs=(ids,map)=>ids.map(id=>{const value=map.get(id);assert(value,'AI_ASSEMBLY_RECEIPT_REFERENCE');return value.sha256;});
 const recipeMap=index(h.AI_RELEASE_DECISION_RECIPES,'recipe_id','AI_ASSEMBLY_DUPLICATE_RECIPE');
 index(input.methods,'recipe_id','AI_ASSEMBLY_DUPLICATE_METHOD');
 for(const m of input.methods){const recipe=recipeMap.get(m.recipe_id);assert(recipe&&['recipe_version','recipe_sha256','source_policy_sha256'].every(key=>m[key]===recipe[key]),'AI_ASSEMBLY_RECIPE_PIN');}
 const interpretations=input.interpretations.map(i=>{
  const {source_receipt_ids,method_evidence_id,human_by_law,...body}=i;
  const selected=input.methods.filter(m=>m.interpretation_receipt_id===i.receipt_id);
  assert(selected.length?method_evidence_id===null:method_evidence_id!==null,'AI_ASSEMBLY_METHOD_BASIS');
  const {basis_evidence_id,source_receipt_ids:lawSources,...law}=human_by_law;
  return seal({...body,generator:generator(i.branch_id),source_receipt_sha256s:refs(source_receipt_ids,sourceMap),
   method_sha256:selected.length?h.aiReleaseFamilyMethodsSha256(i.branch_id,selected):evidenceHash(method_evidence_id,'method_review'),
   human_by_law:{...law,basis_sha256:evidenceHash(basis_evidence_id,'human_law_basis'),source_receipt_sha256s:refs(lawSources,sourceMap)}});
 });
 const interpretationMap=index(interpretations,'receipt_id','AI_ASSEMBLY_DUPLICATE_INTERPRETATION');
 const methods=input.methods.map(m=>{
  const {interpretation_receipt_id,...body}=m,i=interpretationMap.get(interpretation_receipt_id);assert(i,'AI_ASSEMBLY_RECEIPT_REFERENCE');
  const required=new Map(recipeMap.get(m.recipe_id).legal_sources.map(s=>[`${s.version_id}:${s.file_sha256}`,s]));
  const source_receipts=[...required.values()].map(pin=>{
   const found=sources.filter(s=>s.source_version_id===pin.version_id&&s.artifact_sha256===pin.file_sha256&&i.source_receipt_sha256s.includes(s.sha256));
   assert(found.length===1,'AI_ASSEMBLY_METHOD_SOURCE');return {receipt_sha256:found[0].sha256,source_version_id:pin.version_id,artifact_sha256:pin.file_sha256};
  });
  return {...body,interpretation_receipt_sha256:i.sha256,source_receipts};
 });
 const tests=input.tests.map(t=>{
  const {source_receipt_ids,interpretation_receipt_id,test_definition_evidence_id,independent_oracle_evidence_id,results_evidence_id,...body}=t;
  const results_sha256=evidenceHash(results_evidence_id,'test_results');
  let value;try{value=JSON.parse(Buffer.from(bytesById.get(results_evidence_id)).toString('utf8'));}catch{throw Error('AI_ASSEMBLY_TEST_RESULTS_JSON');}
  const result=schemas.result.parse(value),test_definition_sha256=evidenceHash(test_definition_evidence_id,'test_definition'),independent_oracle_sha256=evidenceHash(independent_oracle_evidence_id,'independent_oracle');
  assert(result.branch_id===t.branch_id&&result.code_sha256===build.manifest.source_graph_sha256
   &&result.test_definition_sha256===test_definition_sha256&&result.independent_oracle_sha256===independent_oracle_sha256
   &&result.review_binding_sha256===aiAssemblyReviewBinding(input,interpretation_receipt_id,h),'AI_ASSEMBLY_TEST_RESULTS_BINDING');
  const {schema_version:_schema,review_binding_sha256:_binding,...measured}=result;void _schema;void _binding;
  return seal({...body,...measured,generator:generator(t.branch_id),source_receipt_sha256s:refs(source_receipt_ids,sourceMap),
   interpretation_receipt_sha256:refs([interpretation_receipt_id],interpretationMap)[0],results_sha256});
 });
 const testMap=index(tests,'receipt_id','AI_ASSEMBLY_DUPLICATE_TEST');
 const branches=input.branches.map(b=>{
  const {source_receipt_ids,interpretation_receipt_id,test_receipt_ids,...body}=b;
  const family=h.AI_RELEASE_RUNTIME_FAMILIES.find(f=>f.branch_id===b.branch_id);assert(family,'AI_ASSEMBLY_UNKNOWN_FAMILY');
  return {...body,topic:family.topic,generator:generator(b.branch_id),source_receipt_sha256s:refs(source_receipt_ids,sourceMap),
   interpretation_receipt_sha256:refs([interpretation_receipt_id],interpretationMap)[0],test_receipt_sha256s:refs(test_receipt_ids,testMap)};
 });
 const {product_decision_evidence_id,...policyBody}=input.policy;
 const policy=seal({...policyBody,product_decision_sha256:evidenceHash(product_decision_evidence_id,'product_decision'),branches});
 const registry=seal({...input.registry,policy_sha256:policy.sha256});
 const configuration=seal({schema_version:'tivdoc-ai-release-configuration-v1',...input.configuration,build_manifest_sha256:build.manifest.sha256,
  policy,registry,source_receipts:sources,interpretation_receipts:interpretations,test_receipts:tests,methods});
 assert(usedEvidence.size===evidence.size,'AI_ASSEMBLY_UNUSED_EVIDENCE');
 h.verifyAiReleaseConfiguration(configuration,build);
 const receipt=seal({schema_version:'tivdoc-ai-release-assembly-receipt-v1',input_sha256:h.canonicalSha256(input),configuration_sha256:configuration.sha256,
  build_manifest_sha256:build.manifest.sha256,source_graph_sha256:build.manifest.source_graph_sha256,evaluated_at:input.evaluated_at,
  evidence:input.evidence.map(e=>({id:e.id,kind:e.kind,sha256:e.sha256,bytes:bytesById.get(e.id).byteLength})),
  integrity_valid:true,runtime_admission_evaluated:false,preflight_reasons:preflightReasons(configuration,input.evaluated_at)});
 return {configuration,receipt};
}

export function parseAiAssemblyArgs(args){
 const [command,...rest]=args;assert(['validate','assemble'].includes(command),'AI_ASSEMBLY_USAGE');
 const out={command},allowed=command==='assemble'?['input','output-dir']:['input'];
 for(let i=0;i<rest.length;i+=2){const key=rest[i]?.slice(2),value=rest[i+1];
  assert(rest[i]?.startsWith('--')&&allowed.includes(key)&&!Object.hasOwn(out,key)&&value&&!value.startsWith('--'),'AI_ASSEMBLY_USAGE');out[key]=value;}
 assert(allowed.every(k=>typeof out[k]==='string'),'AI_ASSEMBLY_USAGE');return out;
}

export function readAiAssemblyEvidence(file,baseDir,repo=ROOT){
 const requested=path.resolve(baseDir,file),resolved=realpathSync(requested),publicRoot=realpathSync(path.join(repo,'docs/release-evidence'));
 // Only the existing public evidence tree may be read inside this checkout.
 const safe=inside(publicRoot,resolved)&&inside(path.join(repo,'docs/release-evidence'),requested)?resolved:aiControlPrivatePath(requested,repo);
 const stat=statSync(safe);assert(stat.isFile()&&stat.size>0&&stat.size<=32*1024*1024,'AI_ASSEMBLY_EVIDENCE_SIZE');return readFileSync(safe);
}

/** Atomic new-directory publication; exact retries reuse existing bytes. No
 * overwrite of a prior package or deletion outside our verified staging dir. */
export function writeAiAssemblyOutput(output,result,repo=ROOT){
 const target=aiControlPrivatePath(output,repo),parent=aiControlPrivatePath(path.dirname(target),repo);
 assert(statSync(parent).isDirectory(),'AI_ASSEMBLY_OUTPUT_PARENT');
 const files={'configuration.private.json':JSON.stringify(result.configuration,null,2)+'\n','assembly-receipt.private.json':JSON.stringify(result.receipt,null,2)+'\n'};
 if(existsSync(target)){
  assert(statSync(target).isDirectory()&&readdirSync(target).length===2,'AI_ASSEMBLY_OUTPUT_MISMATCH');
  for(const [name,bytes]of Object.entries(files)){
   const file=aiControlPrivatePath(path.join(target,name),repo);
   assert(path.dirname(file)===target&&existsSync(file)&&readFileSync(file,'utf8')===bytes,'AI_ASSEMBLY_OUTPUT_MISMATCH');
  }return {replayed:true};
 }
 const stage=mkdtempSync(path.join(parent,'.ai-release-assembly-'));let verified=false;
 try{
  const safe=aiControlPrivatePath(stage,repo);assert(path.dirname(safe)===parent,'AI_ASSEMBLY_OUTPUT_PARENT');verified=true;
  for(const [name,bytes]of Object.entries(files))writeFileSync(path.join(safe,name),bytes,{flag:'wx',mode:0o600});
  assert(!existsSync(target),'AI_ASSEMBLY_OUTPUT_MISMATCH');renameSync(safe,target);return {replayed:false};
 }finally{
  if(existsSync(stage)){
   if(verified)for(const name of Object.keys(files)){const file=path.join(stage,name);if(existsSync(file))unlinkSync(file);}
   rmdirSync(stage);
  }
 }
}

export async function runAiAssembly(args,ports){
 assertLocalAiControl(ports.env??process.env);const options=parseAiAssemblyArgs(args);
 const candidate=await ports.readInput(options.input);await ports.checkBuild();
 const result=await assembleAiReleaseConfiguration(candidate,await ports.helpers(),e=>ports.readEvidence(e,options.input));
 const written=options.command==='assemble'?await ports.writeOutput(options['output-dir'],result):{replayed:false};
 return {schema_version:'tivdoc-ai-release-assembly-result-v1',command:options.command,written:options.command==='assemble',...written,
  configuration_sha256:result.configuration.sha256,receipt_sha256:result.receipt.sha256,build_manifest_sha256:result.configuration.build_manifest_sha256,
  integrity_valid:true,runtime_admission_evaluated:false,preflight_reason_codes:[...new Set(result.receipt.preflight_reasons.map(r=>r.code))]};
}

export function safeAiAssemblyError(error){const message=error instanceof Error?error.message:'';
 return /^(?:AI_ASSEMBLY_|AI_CONTROL_|AI_BUILD_|AI_CONFIGURATION_)[A-Z0-9_]+$/u.test(message)?message:'AI_ASSEMBLY_INVALID_INPUT';}
async function main(){
 assertLocalAiControl();parseAiAssemblyArgs(process.argv.slice(2));
 let helper;
 const result=await runAiAssembly(process.argv.slice(2),{env:process.env,
  readInput:file=>{const safe=aiControlPrivatePath(file);assert(statSync(safe).isFile()&&statSync(safe).size<=4*1024*1024,'AI_ASSEMBLY_INPUT_SIZE');return JSON.parse(readFileSync(safe,'utf8'));},
  checkBuild:async()=>{const {checkAiReleaseBuildManifest}=await import('../ai-release-build-manifest.mjs');await checkAiReleaseBuildManifest(ROOT);},
  helpers:async()=>helper??=await loadAiAssemblyHelpers(),readEvidence:(e,input)=>readAiAssemblyEvidence(e.path,path.dirname(aiControlPrivatePath(input))),writeOutput:writeAiAssemblyOutput});
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(safeAiAssemblyError(error)+'\n');process.exitCode=1;});
