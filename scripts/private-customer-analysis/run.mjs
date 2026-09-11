import "../production-refusal.mjs";
import {build} from 'esbuild';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const [privateRoot,documentId,credentialsFile,attemptText]=process.argv.slice(2);
if(!privateRoot||!documentId||!credentialsFile)throw Error('Usage: node scripts/private-customer-analysis/run.mjs PRIVATE_ROOT DOCUMENT_ID PRIVATE_CREDENTIALS_JSON');
const root=path.resolve(privateRoot),repository=process.cwd();
if(root===repository||root.startsWith(repository+path.sep))throw Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim().length>0;
const dir=path.join(root,'tool'),out=path.join(dir,'private-runner.cjs');mkdirSync(dir,{recursive:true});
const result=await build({entryPoints:['scripts/private-customer-analysis/run.mts'],outfile:out,bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',metafile:true,
 plugins:[{name:'private-node-server-marker',setup(api){api.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'private-marker'}));api.onLoad({filter:/.*/,namespace:'private-marker'},()=>({contents:'export {};',loader:'js'}));}}]});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest={revision,dirty,bundle_sha256:hash(readFileSync(out)),sources:Object.fromEntries(Object.keys(result.metafile.inputs).filter(p=>!p.startsWith('private-marker:')).map(p=>[p,hash(readFileSync(p))])),created_at:new Date().toISOString()};
writeFileSync(path.join(dir,`build-${Date.now()}.private.json`),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
const run=spawnSync(process.execPath,[out,root,documentId,path.resolve(credentialsFile),revision,...(attemptText?[attemptText]:[])],{stdio:'inherit',env:{...process.env,NODE_PATH:path.join(repository,'node_modules')}});
process.exitCode=run.status??1;
