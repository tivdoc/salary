/** The isolated release database is not PostgREST's default `postgres` DB.
 * Only this exact Preview target may use the existing web-role RPC adapter.
 * A configured but invalid target fails closed; it never falls back to another DB.
 * This is not a production database selector or a replacement for production rehearsal. */
export function isolatedPreviewDatabase(env:Readonly<Record<string,string|undefined>>):string|null {
 const value=env.TIVDOC_PREVIEW_WEB_POSTGRES_URL;
 if(!value)return null;
 const refuse=()=>{throw new Error('ISOLATED_PREVIEW_DATABASE_REFUSED');};
 if(env.VERCEL_ENV!=='preview'||env.VERCEL_GIT_COMMIT_REF!=='codex/tivdoc-release-completion')return refuse();
 let target:URL;
 try{target=new URL(value);}catch{return refuse();}
 if(target.protocol!=='postgresql:'&&target.protocol!=='postgres:')return refuse();
 // Stateless one-statement RPCs can use Supavisor transaction pooling. Keep
 // the previously verified session endpoint valid for explicit rollback.
 if(target.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||!['5432','6543'].includes(target.port)
  ||decodeURIComponent(target.username)!=='tivdoc_web_runtime.cpzrbidxftzqcfeqqusu'
  ||target.pathname!=='/tivdoc_release_replay_20260907'||!target.password
  ||target.hash||target.search!=='?sslmode=verify-full'
  ||env.NEXT_PUBLIC_SUPABASE_URL!=='https://cpzrbidxftzqcfeqqusu.supabase.co')return refuse();
 return value;
}
