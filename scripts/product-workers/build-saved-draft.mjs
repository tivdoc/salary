import "../production-refusal.mjs";
import {build,version as esbuildVersion} from 'esbuild';
import {builtinModules} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

async function main(){
 const root=process.cwd(),directory=path.join(root,'output/release-completion/saved-worker');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim().length>0;
 await mkdir(path.join(directory,'assets/fonts'),{recursive:true});
 const result=await build({entryPoints:['scripts/product-workers/saved-draft.mts'],outfile:path.join(directory,'worker.cjs'),
  bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',metafile:true,
  define:{TIVDOC_SAVED_WORKER_BUILD_SHA:JSON.stringify(gitSha),TIVDOC_SAVED_WORKER_DIRTY_BUILD:JSON.stringify(dirty)},
  // This bundle is a Node-only program outside Next. The server-only marker
  // has served its client-import check; it is not an executable Node package.
  plugins:[{name:'node-worker-server-only',setup(api){
   api.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'node-worker-marker'}));
   api.onLoad({filter:/.*/,namespace:'node-worker-marker'},()=>({contents:'export {};',loader:'js'}));
  }}],
 });
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const font=await readFile('assets/fonts/DejaVuSans.ttf');if(hash(font)!=='7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954')throw new Error('SAVED_WORKER_FONT_HASH');
 await copyFile('assets/fonts/DejaVuSans.ttf',path.join(directory,'assets/fonts/DejaVuSans.ttf'));
 await copyFile('assets/fonts/LICENSE-DejaVu.txt',path.join(directory,'assets/fonts/LICENSE-DejaVu.txt'));
 const dependencies=JSON.parse(await readFile('package.json','utf8')).dependencies;
 const externals=[...new Set(Object.values(result.metafile.outputs).flatMap(o=>o.imports.filter(i=>i.external&&!i.path.startsWith('node:')&&!builtinModules.includes(i.path)).map(i=>i.path)))];
 const pinnedDependencies=Object.fromEntries(externals.map(name=>{
  const packageName=name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0];
  if(!dependencies[packageName])throw new Error('SAVED_WORKER_UNPINNED_EXTERNAL');return [name,dependencies[packageName]];
 }));
 const sourceHashes=Object.fromEntries(await Promise.all(Object.keys(result.metafile.inputs).filter(p=>!p.startsWith('node-worker-marker:')).sort().map(async p=>[p,hash(await readFile(p))])));
 const receipt={gitSha,dirty,executableForEnabledWork:!dirty,bundleSha256:hash(await readFile(path.join(directory,'worker.cjs'))),fontSha256:hash(font),dependencyLockSha256:hash(await readFile('package-lock.json')),nodeMajor:22,esbuildVersion,dependencies:pinnedDependencies,sourceHashes,environment:'declared-disposable-dev-only',secretsIncluded:false};
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({workerBundle:'output/release-completion/saved-worker/worker.cjs',gitSha,dirty,executableForEnabledWork:!dirty,bundleSha256:receipt.bundleSha256}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'SAVED_WORKER_BUILD_FAILED');process.exitCode=1;});
