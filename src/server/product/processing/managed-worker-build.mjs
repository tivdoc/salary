import {build,version as esbuildVersion} from 'esbuild';
import {builtinModules} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

async function main(){
 const real=process.argv.includes('--real');
 if(!real&&process.env.VERCEL_ENV==='production')throw Error('MANAGED_DEV_PRODUCTION_REFUSED');
 const output=real?'output/release-completion/real-service-worker':'output/release-completion/managed-worker',directory=path.resolve(output);
 const synthetic=process.argv.includes('--synthetic-proof'),basename=synthetic?'synthetic-proof':'worker';
 if(real&&synthetic)throw Error('REAL_SERVICE_SYNTHETIC_BUILD_REFUSED');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',windowsHide:true}).trim().length>0;
 await mkdir(path.join(directory,'assets/fonts'),{recursive:true});
 const result=await build({entryPoints:[real?'src/server/product/processing/real-service.entry.mts':synthetic?'src/server/product/processing/managed-worker.synthetic-proof.entry.mts':'src/server/product/processing/managed-worker.entry.mts'],outfile:path.join(directory,`${basename}.cjs`),bundle:true,
  platform:'node',format:'cjs',target:'node22',packages:'external',metafile:true,
  define:real?{TIVDOC_REAL_SERVICE_BUILD_SHA:JSON.stringify(gitSha),TIVDOC_REAL_SERVICE_DIRTY_BUILD:JSON.stringify(dirty)}
   :{TIVDOC_MANAGED_WORKER_BUILD_SHA:JSON.stringify(gitSha),TIVDOC_MANAGED_WORKER_DIRTY_BUILD:JSON.stringify(dirty)},
  plugins:[{name:'node-managed-server-only',setup(api){
   api.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'managed-marker'}));
   api.onLoad({filter:/.*/,namespace:'managed-marker'},()=>({contents:'export {};',loader:'js'}));
  }}],
 });
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const font=await readFile('assets/fonts/DejaVuSans.ttf');
 if(hash(font)!=='7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954')throw Error('MANAGED_DEV_FONT_HASH');
 await copyFile('assets/fonts/DejaVuSans.ttf',path.join(directory,'assets/fonts/DejaVuSans.ttf'));
 await copyFile('assets/fonts/LICENSE-DejaVu.txt',path.join(directory,'assets/fonts/LICENSE-DejaVu.txt'));
 const dependencies=JSON.parse(await readFile('package.json','utf8')).dependencies;
 const externals=[...new Set(Object.values(result.metafile.outputs).flatMap(output=>output.imports.filter(i=>i.external&&!i.path.startsWith('node:')&&!builtinModules.includes(i.path)).map(i=>i.path)))];
 const pinnedDependencies=Object.fromEntries(externals.map(name=>{
  const packageName=name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0];
  if(!dependencies[packageName])throw Error('MANAGED_DEV_UNPINNED_EXTERNAL');return [name,dependencies[packageName]];
 }));
 const sourceHashes=Object.fromEntries(await Promise.all(Object.keys(result.metafile.inputs).filter(p=>!p.startsWith('managed-marker:')).sort().map(async p=>[p,hash(await readFile(p))])));
 const receipt={gitSha,dirty,executableForEnabledWork:!dirty,proofOnly:synthetic,bundleSha256:hash(await readFile(path.join(directory,`${basename}.cjs`))),fontSha256:hash(font),
  dependencyLockSha256:hash(await readFile('package-lock.json')),nodeMajor:22,esbuildVersion,dependencies:pinnedDependencies,sourceHashes,
  environment:real?'configured-real-service-only':'exact-isolated-dev-only',...(real?{workerKind:'real_service',maxEnrollmentsPerTick:2}:{}),recurrence:'external-managed-scheduler',maxCasesPerTick:2,secretsIncluded:false};
 await writeFile(path.join(directory,`${basename==='worker'?'manifest':'synthetic-proof-manifest'}.json`),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({workerBundle:`${output}/${basename}.cjs`,gitSha,dirty,executableForEnabledWork:!dirty,proofOnly:synthetic,bundleSha256:receipt.bundleSha256}));
}
main().catch(()=>{console.error(process.argv.includes('--real')?'REAL_SERVICE_BUILD_FAILED':'MANAGED_DEV_BUILD_FAILED');process.exitCode=1;});
