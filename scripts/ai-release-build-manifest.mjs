import "./production-refusal.mjs";
import {createHash} from 'node:crypto';
import {readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const OUTPUT='src/server/product/processing/ai-release-build-manifest.json';
const DECISIONS='src/engine/ai-release-decisions';
const ENTRIES=[
 'src/engine/ai-release-runtime/index.ts',
 'src/engine/ai-release-runtime/automatic-assessment.ts',
 'src/engine/case-analysis/service.ts',
 'src/server/product/processing/saved-ai-release.ts',
 'src/server/product/processing/saved-real-ai-service-configuration.ts',
 'src/server/product/processing/automatic-real-service.ts',
 'src/server/product/processing/real-service-activation.ts',
 'src/server/product/processing/real-service-worker-host.ts',
 'src/server/product/processing/real-service-notification-dispatch.ts',
 'src/server/product/processing/automatic-dev-notifications.ts',
 'src/server/product/reports/ai-release-report.ts',
 'src/server/product/reports/real-ai-service-delivery.ts',
 'src/server/product/reports/real-ai-service-customer.ts',
 'src/server/product/reports/real-ai-service-notification.ts',
 'src/engine/document-review/non-payslip.ts',
 ...['pension','payroll','benefits','nonpay'].map(name=>`src/engine/entitlement-review/automatic-${name}.ts`),
 'src/server/product/processing/ai-release-build.ts',
 'src/server/product/processing/ai-release-configuration.ts',
];
const BUILD_INPUTS=['package-lock.json','tsconfig.json','scripts/ai-release-build-manifest.mjs'];
const excluded=p=>p===OUTPUT||/(?:^|\/)(?:__tests__|fixtures?|benchmarks?)(?:\/|$)|(?:\.|-)(?:test|spec|fixture)s?\.[^.]+$/u.test(p);
const order=(a,b)=>a<b?-1:a>b?1:0;
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:
 value!==null&&typeof value==='object'?`{${Object.keys(value).sort(order).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);

/** Source build identity, not a legal review, test pass or deployment attestation.
 * Line ending differences alone do not change the identity. */
export function manifestFromSources(entrypoints,sources){
 const entries=[...new Set(entrypoints)].sort(order);
 if(entries.length!==entrypoints.length)throw Error('AI_BUILD_DUPLICATE_ENTRY');
 const files=sources.map(({path:relative,content})=>{
  if(!/^[A-Za-z0-9_./-]+$/u.test(relative)||relative.startsWith('/')||relative.split('/').some(p=>p==='..'||p==='.'||p===''))throw Error('AI_BUILD_SOURCE_PATH');
  if(excluded(relative))throw Error('AI_BUILD_EXCLUDED_SOURCE');
  return {path:relative,sha256:hash(content.replace(/\r\n?/gu,'\n'))};
 }).sort((a,b)=>order(a.path,b.path));
 if(new Set(files.map(f=>f.path)).size!==files.length)throw Error('AI_BUILD_DUPLICATE_SOURCE');
 if(entries.some(p=>!files.some(f=>f.path===p)))throw Error('AI_BUILD_ENTRY_MISSING');
 const body={schema_version:'tivdoc-ai-release-build-manifest-v1',normalization:'utf8-lf-v1',entrypoints:entries,files};
 const source_graph_sha256=hash(canonical(body));
 const manifest={...body,source_graph_sha256};
 return {...manifest,sha256:hash(canonical(manifest))};
}

/** Resolve local imports without executing any engine or provider. Nonliteral
 * dynamic imports are refused; npm implementation changes are pinned by lock. */
export async function collectAiReleaseBuildManifest(root=ROOT,options={}){
 const base=await realpath(root),sourceMap=new Map();
 const relative=full=>path.relative(base,full).split(path.sep).join('/');
 async function source(p){
  const full=await realpath(path.resolve(base,p)),rel=relative(full);
  if(rel.startsWith('../')||path.isAbsolute(rel)||rel!==p)throw Error('AI_BUILD_SOURCE_OUTSIDE_ROOT_OR_SYMLINK');
  const bytes=await readFile(full);
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 }
 const tsconfig=JSON.parse(await source('tsconfig.json'));
 const parsed=ts.convertCompilerOptionsFromJson(tsconfig.compilerOptions??{},base);
 if(parsed.errors.length)throw Error('AI_BUILD_TSCONFIG');
 const entrypoints=options.entrypoints??[...ENTRIES,...(await readdir(path.join(base,DECISIONS))).filter(n=>/\.(?:ts|tsx|json)$/u.test(n)&&!excluded(`${DECISIONS}/${n}`)).map(n=>`${DECISIONS}/${n}`)];
 const pending=entrypoints.map(p=>({p,chain:[]}));
 while(pending.length){
  const {p,chain}=pending.pop();
  if(sourceMap.has(p)||p===OUTPUT)continue;
  if(excluded(p))throw Error('AI_BUILD_EXCLUDED_DEPENDENCY',{cause:{path:p,chain:[...chain,p]}});
  const content=await source(p);sourceMap.set(p,content);
  if(p.endsWith('.json'))continue;
  const ast=ts.createSourceFile(p,content,ts.ScriptTarget.Latest,true),imports=[];
  function visit(node){
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){
    if(!ts.isStringLiteral(node.moduleSpecifier))throw Error('AI_BUILD_NONLITERAL_IMPORT');imports.push(node.moduleSpecifier.text);
   }
   if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)){
    const expression=node.moduleReference.expression;
    if(!expression||!ts.isStringLiteral(expression))throw Error('AI_BUILD_NONLITERAL_IMPORT');imports.push(expression.text);
   }
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))){
    if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw Error('AI_BUILD_NONLITERAL_IMPORT');imports.push(node.arguments[0].text);
   }
   ts.forEachChild(node,visit);
  }
  visit(ast);
  for(const specifier of imports){
   if(!specifier.startsWith('.')&&!specifier.startsWith('@/'))continue;
   const resolved=ts.resolveModuleName(specifier,path.join(base,p),parsed.options,ts.sys).resolvedModule;
   // The manifest is deliberately not part of its own source digest.
   if(!resolved&&path.resolve(path.dirname(path.join(base,p)),specifier)===path.join(base,OUTPUT))continue;
   if(!resolved)throw Error(`AI_BUILD_IMPORT_UNRESOLVED:${p}:${specifier}`);
   const rel=relative(resolved.resolvedFileName);
   if(!rel.startsWith('src/')||rel.includes('/node_modules/'))throw Error('AI_BUILD_IMPORT_OUTSIDE_SOURCE');
   pending.push({p:rel,chain:[...chain,p]});
  }
 }
 for(const p of options.buildInputs??BUILD_INPUTS)sourceMap.set(p,await source(p));
 return manifestFromSources(entrypoints,[...sourceMap].map(([path,content])=>({path,content})));
}

export async function checkAiReleaseBuildManifest(root=ROOT,options={}){
 const manifest=await collectAiReleaseBuildManifest(root,options),bytes=JSON.stringify(manifest,null,2)+'\n';
 let prior;try{prior=await readFile(path.join(root,OUTPUT),'utf8');}catch{throw Error('AI_BUILD_MANIFEST_MISSING');}
 if(prior.replace(/\r\n?/gu,'\n')!==bytes)throw Error('AI_BUILD_MANIFEST_DRIFT');
 return manifest;
}

async function main(){
 const args=process.argv.slice(2);
 if(args.length!==1||!['--check','--write'].includes(args[0]))throw Error('AI_BUILD_USAGE: --check | --write');
 const manifest=await (args[0]==='--check'?checkAiReleaseBuildManifest():collectAiReleaseBuildManifest());
 if(args[0]==='--write')await writeFile(path.join(ROOT,OUTPUT),JSON.stringify(manifest,null,2)+'\n','utf8');
 console.log(JSON.stringify({action:args[0],source_graph_sha256:manifest.source_graph_sha256,manifest_sha256:manifest.sha256,source_files:manifest.files.length,policy_reapproved:false}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
main().catch(error=>{console.error(error instanceof Error?error.message:'AI_BUILD_FAILED');process.exitCode=1;});
}
