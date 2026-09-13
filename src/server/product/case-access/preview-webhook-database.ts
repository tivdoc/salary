/** The webhook writes authenticated provider receipts with the worker role.
 * The customer web credential cannot replace it in the isolated Preview DB. */
export function isolatedPreviewWebhookDatabase(env:Readonly<Record<string,string|undefined>>):string|null {
 const value=env.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL;
 if(!value)return null;
 const refuse=()=>{throw Error('ISOLATED_PREVIEW_WEBHOOK_DATABASE_REFUSED');};
 if(env.VERCEL_ENV!=='preview'||env.VERCEL_GIT_COMMIT_REF!=='codex/tivdoc-release-completion'
  ||env.NEXT_PUBLIC_SUPABASE_URL!=='https://cpzrbidxftzqcfeqqusu.supabase.co')return refuse();
 let target:URL;try{target=new URL(value);}catch{return refuse();}
 if(!['postgres:','postgresql:'].includes(target.protocol)||target.hostname!=='aws-0-eu-central-1.pooler.supabase.com'
  ||!['5432','6543'].includes(target.port)||target.pathname!=='/tivdoc_release_replay_20260907'
  ||decodeURIComponent(target.username)!=='tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu'
  ||!target.password||target.hash||target.search!=='?sslmode=verify-full')return refuse();
 target.search=''; // Explicit trusted CA owns TLS instead of pg URL options.
 return target.toString();
}
