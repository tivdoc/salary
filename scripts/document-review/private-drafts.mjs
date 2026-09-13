import '../production-refusal.mjs';
import {build} from 'esbuild';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [packet,out]=process.argv.slice(2);
if(!packet||!out)throw Error('Usage: private-drafts.mjs PRIVATE_PACKET PRIVATE_OUTPUT');
const root=path.resolve(path.dirname(packet));if(root===process.cwd()||root.startsWith(process.cwd()+path.sep))throw Error('PRIVATE_DIRECTORY_REQUIRED');
const dir=path.join(root,'tool');mkdirSync(dir,{recursive:true});const invocation=`${Date.now()}-${process.pid}`,target=path.join(dir,`product-review-${invocation}.cjs`);
const built=await build({entryPoints:['scripts/document-review/private-drafts.mts'],outfile:target,bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',metafile:true,
 plugins:[{name:'private-marker',setup(api){api.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'private-marker'}));api.onLoad({filter:/.*/,namespace:'private-marker'},()=>({contents:'export {};',loader:'js'}));}}]});
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),hash=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(path.join(dir,`build-${invocation}.private.json`),JSON.stringify({revision,dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,bundle_path:target,bundle_sha256:hash(readFileSync(target)),
 sources:Object.fromEntries(Object.keys(built.metafile.inputs).filter(p=>!p.startsWith('private-marker:')).map(p=>[p,hash(readFileSync(p))]))},null,2)+'\n',{flag:'wx',mode:0o600});
const child=spawnSync(process.execPath,[target,path.resolve(packet),path.resolve(out),revision],{stdio:'inherit',env:{...process.env,NODE_PATH:path.join(process.cwd(),'node_modules')}});process.exitCode=child.status??1;
