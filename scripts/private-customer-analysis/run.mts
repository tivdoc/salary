import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {privateArtifactPath,runPrivatePayslipExtraction} from '../../src/server/private-analysis/extraction';

const [root,documentId,credentialsFile,codeRevision]=process.argv.slice(2);
async function main(){
 if(!root||!documentId||!credentialsFile||!codeRevision)throw Error('PRIVATE_RUN_ARGUMENTS');
 const credentials=z.object({OPENAI_API_KEY:z.string().min(1)}).parse(JSON.parse(readFileSync(privateArtifactPath(credentialsFile),'utf8')));
 const result=await runPrivatePayslipExtraction({privateRoot:root,documentId,apiKey:credentials.OPENAI_API_KEY,codeRevision});
 console.log(JSON.stringify(result));
}
main().catch(error=>{
 // Full diagnostic is private; never print model output or customer values.
 if(root){try{writeFileSync(path.join(privateArtifactPath(root),'operator-error-'+Date.now()+'.private.json'),JSON.stringify({at:new Date().toISOString(),error:String(error)},null,2),{flag:'wx',mode:0o600});}catch{/* Refuse rather than logging private detail. */}}
 console.error('PRIVATE_ANALYSIS_FAILED_SEE_PRIVATE_DIAGNOSTIC');process.exitCode=1;
});
