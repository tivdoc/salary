import "../production-refusal.mjs";
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

const [root,documentId,credentialsFile,codeRevision]=process.argv.slice(2);
let privateArtifactPath: ((value:string)=>string)|undefined;
async function main(){
 if(!root||!documentId||!credentialsFile||!codeRevision)throw Error('PRIVATE_RUN_ARGUMENTS');
 // Native Node links every static dependency before evaluating the first import.
 // Load the application graph only after the environment refusal has executed;
 // the development launcher still bundles this exact dynamic import into CJS.
 const extraction=await import('../../src/server/private-analysis/extraction.ts');
 privateArtifactPath=extraction.privateArtifactPath;
 const credentials=z.object({OPENAI_API_KEY:z.string().min(1)}).parse(JSON.parse(readFileSync(extraction.privateArtifactPath(credentialsFile),'utf8')));
 const {runPrivatePayslipExtraction}=extraction;
 const result=await runPrivatePayslipExtraction({privateRoot:root,documentId,apiKey:credentials.OPENAI_API_KEY,codeRevision});
 console.log(JSON.stringify(result));
}
main().catch(error=>{
 // Full diagnostic is private; never print model output or customer values.
 if(root&&privateArtifactPath){try{writeFileSync(path.join(privateArtifactPath(root),'operator-error-'+Date.now()+'.private.json'),JSON.stringify({at:new Date().toISOString(),error:String(error)},null,2),{flag:'wx',mode:0o600});}catch{/* Refuse rather than logging private detail. */}}
 console.error('PRIVATE_ANALYSIS_FAILED_SEE_PRIVATE_DIAGNOSTIC');process.exitCode=1;
});
