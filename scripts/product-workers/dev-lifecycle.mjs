import {build} from 'esbuild';
import {mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const directory=path.resolve('output/release-completion/dev-lifecycle-tool');mkdirSync(directory,{recursive:true});
await build({entryPoints:['scripts/product-workers/dev-lifecycle.entry.mts'],outfile:path.join(directory,'tool.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',plugins:[{name:'server-marker',setup(api){api.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'empty'}));api.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:'export {};'}));}}]});
const {main}=await import(pathToFileURL(path.join(directory,'tool.mjs')).href);
try{await main(process.argv.slice(2));}catch(error){console.error(JSON.stringify({state:'refused',code:/^[A-Z][A-Z0-9_]{3,100}$/.test(error?.message??'')?error.message:'DEV_LIFECYCLE_FAILED'}));process.exitCode=1;}
