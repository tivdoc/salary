import {execFileSync} from 'node:child_process';
import {writeFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {createGithubPreviewReceipt} from './dev-preview-receipt.mjs';

// Read-only acquisition. A receipt cannot be used to claim browser access or
// mutate the deployment. The ordinary gh account must have repository access.
const [sha,output]=process.argv.slice(2);
try{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV==='production'
  ||!/^[a-f0-9]{40}$/u.test(sha??'')||!output)throw Error('DEV_PREVIEW_ACQUIRE_ARGUMENTS');
 const root=realpathSync('../release-work'),file=path.resolve(output),parent=realpathSync(path.dirname(file));
 const relative=path.relative(root,parent);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('DEV_PREVIEW_PRIVATE_OUTPUT_REQUIRED');
 const get=endpoint=>JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}));
 const rows=get(`repos/tivdoc/salary/deployments?sha=${sha}&environment=Preview&per_page=100`);
 const d=rows.filter(x=>x.sha===sha&&x.environment==='Preview'&&x.production_environment===false)
  .sort((a,b)=>b.id-a.id)[0];
 if(!d)throw Error('DEV_PREVIEW_DEPLOYMENT_MISSING');
 const statuses=get(`repos/tivdoc/salary/deployments/${d.id}/statuses?per_page=100`);
 const latest=[...statuses].sort((a,b)=>b.id-a.id)[0];
 const receipt=createGithubPreviewReceipt(d,latest,new Date().toISOString());
 writeFileSync(file,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({state:'acquired',applicationSha:sha,deploymentId:d.id,statusId:latest.id,
  evidence:receipt.source,receiptSha256:receipt.sha256,browserAccessProven:false}));
}catch(error){
 console.error(JSON.stringify({state:'refused',code:/^[A-Z][A-Z0-9_]{3,100}$/u.test(error?.message??'')?error.message:'DEV_PREVIEW_ACQUISITION_FAILED'}));process.exitCode=1;
}
