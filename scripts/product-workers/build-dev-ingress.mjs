import {build} from 'esbuild';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())throw Error('DEV_INGRESS_CLEAN_BUILD_REQUIRED');
const root='output/release-completion/dev-resend-ingress';mkdirSync(`${root}/api`,{recursive:true});
const result=await build({entryPoints:['src/server/product/case-access/dev-resend-ingress.entry.ts'],outfile:`${root}/api/resend.js`,bundle:true,platform:'node',format:'cjs',target:'node22',metafile:true});
writeFileSync(`${root}/vercel.json`,JSON.stringify({version:2,functions:{'api/resend.js':{maxDuration:30}}}));
// Build Output API artifact: only /api/resend exists. The deployment operator
// supplies deployment-scoped env overrides separately; no secret enters this
// artifact and no projectSettings override is needed by the prebuilt upload.
const prebuilt=`${root}/prebuilt/.vercel/output`,fn=`${prebuilt}/functions/api/resend.func`;
mkdirSync(fn,{recursive:true});
writeFileSync(`${fn}/index.js`,readFileSync(`${root}/api/resend.js`));
writeFileSync(`${fn}/.vc-config.json`,JSON.stringify({runtime:'nodejs24.x',handler:'index.js',launcherType:'Nodejs',maxDuration:30,shouldAddHelpers:false}));
writeFileSync(`${prebuilt}/config.json`,JSON.stringify({version:3,routes:[{handle:'filesystem'},{src:'/.*',status:404}]}));
const manifest={source_commit:sha,purpose:'DEV signed webhook ingress only',providerConfigured:false,
 prebuilt_root:`${root}/prebuilt`,prebuilt_files:['.vercel/output/config.json','.vercel/output/functions/api/resend.func/.vc-config.json','.vercel/output/functions/api/resend.func/index.js'],
 inputs:Object.keys(result.metafile.inputs).sort().map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),
 output_sha256:createHash('sha256').update(readFileSync(`${root}/api/resend.js`)).digest('hex')};
writeFileSync(`${root}/build-manifest.json`,JSON.stringify(manifest,null,2));console.log({source_commit:sha,output_sha256:manifest.output_sha256});
