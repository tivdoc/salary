import {createHash} from 'node:crypto';
import {z} from 'zod';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=z.string().regex(/^[a-f0-9]{40}$/u);
const creator=z.object({login:z.literal('vercel[bot]')}).passthrough();
const deployment=z.object({id:z.number().int().positive(),sha:hash,environment:z.literal('Preview'),creator,
 repository_url:z.literal('https://api.github.com/repos/tivdoc/salary'),
 production_environment:z.literal(false),statuses_url:z.string(),created_at:z.iso.datetime()}).passthrough();
const status=z.object({id:z.number().int().positive(),state:z.literal('success'),environment:z.literal('Preview'),creator,
 deployment_url:z.string(),url:z.string(),
 environment_url:z.string(),created_at:z.iso.datetime()}).passthrough();
const body=z.object({schema_version:z.literal('tivdoc-github-preview-receipt-v1'),repository:z.literal('tivdoc/salary'),
 acquired_at:z.iso.datetime(),deployment,status,source:z.literal('authenticated_gh_api'),
 browser_access_proven:z.literal(false)}).strict();
function validate(value){
 const parsed=body.parse(value),d=parsed.deployment,s=parsed.status;
 const deploymentUrl=`https://api.github.com/repos/tivdoc/salary/deployments/${d.id}`;
 if(d.statuses_url!==deploymentUrl+'/statuses'||s.deployment_url!==deploymentUrl||s.url!==deploymentUrl+'/statuses/'+s.id
  ||Date.parse(s.created_at)<Date.parse(d.created_at)||Date.parse(s.created_at)>Date.parse(parsed.acquired_at))throw Error('DEV_PREVIEW_RECEIPT_SCOPE');
 const url=new URL(s.environment_url);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash
  ||!/^salary-[a-z0-9-]+\.vercel\.app$/u.test(url.hostname))throw Error('DEV_PREVIEW_RECEIPT_ORIGIN');
 return {parsed,url:url.hostname};
}
/** The latest authenticated GitHub deployment status is a deployment receipt,
 * not a Vercel API READY response or proof of access through Preview SSO. */
export function createGithubPreviewReceipt(rawDeployment,latestStatus,acquiredAt){
 const value={schema_version:'tivdoc-github-preview-receipt-v1',repository:'tivdoc/salary',
  acquired_at:acquiredAt,deployment:rawDeployment,status:latestStatus,source:'authenticated_gh_api',browser_access_proven:false};
 validate(value);return {...value,sha256:digest(value)};
}
export function lifecyclePreview(raw,manifest){
 if(manifest?.dirty!==false||manifest.proofOnly!==false||!hash.safeParse(manifest.gitSha).success)throw Error('MATCHING_READY_PREVIEW_REQUIRED');
 if(raw?.schema_version==='tivdoc-github-preview-receipt-v1'){
  const {sha256,...candidate}=raw;
  const {parsed,url}=validate(candidate);
  if(sha256!==digest(candidate)||parsed.deployment.sha!==manifest.gitSha)throw Error('MATCHING_READY_PREVIEW_REQUIRED');
  return {sha:parsed.deployment.sha,url,evidence:'github_deployment_success',receiptSha256:sha256};
 }
 if(manifest.gitSha!==raw?.sha||raw.target!=='preview'||raw.readyState!=='READY'||!/^salary-[a-z0-9-]+\.vercel\.app$/u.test(raw.url))throw Error('MATCHING_READY_PREVIEW_REQUIRED');
 return {sha:raw.sha,url:raw.url,evidence:'retained_vercel_ready_receipt',receiptSha256:digest(raw)};
}
