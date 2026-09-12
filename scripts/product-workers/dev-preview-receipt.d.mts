export function createGithubPreviewReceipt(rawDeployment:unknown,latestStatus:unknown,acquiredAt:string):Readonly<Record<string,unknown>>;
export function lifecyclePreview(raw:unknown,manifest:unknown):Readonly<{
 sha:string;
 url:string;
 evidence:'github_deployment_success'|'retained_vercel_ready_receipt';
 receiptSha256:string;
}>;
