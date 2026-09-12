import 'server-only';
import {isolatedPreviewDatabase} from '../case-access/preview-database';

/** Visibility of existing private QA drafts, never calculation/publication
 * authority. The ordinary RPC still authenticates owner, QA and current source.
 * An optimized local build is not a Vercel Preview deployment. */
export function privateReviewEnvironmentEnabled(env:Readonly<Record<string,string|undefined>>=process.env):boolean{
 if(env.TIVDOC_PREVIEW_WEB_POSTGRES_URL)return isolatedPreviewDatabase(env)!==null;
 if(env.VERCEL||env.VERCEL_ENV||env.TIVDOC_AI_RELEASE_ENABLED!=='1'
  ||env.TIVDOC_RUNTIME_TARGET!=='local_only'||env.TIVDOC_PRODUCT_PERSISTENCE_MODE!=='isolated_postgres')return false;
 try{
  const origin=new URL(env.NEXT_PUBLIC_SITE_URL??''),db=new URL(env.TIVDOC_WEB_POSTGRES_URL??'');
  return origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)&&!!origin.port
   &&origin.pathname==='/'&&!origin.search&&!origin.hash&&!origin.username&&!origin.password
   &&['postgres:','postgresql:'].includes(db.protocol)&&db.hostname==='aws-0-eu-central-1.pooler.supabase.com'
   &&['5432','6543'].includes(db.port)&&decodeURIComponent(db.username)==='tivdoc_web_runtime.cpzrbidxftzqcfeqqusu'
   &&db.pathname==='/tivdoc_release_replay_20260907'&&!!db.password&&!db.hash&&db.search==='?sslmode=verify-full'
   &&env.NEXT_PUBLIC_SUPABASE_URL==='https://cpzrbidxftzqcfeqqusu.supabase.co';
 }catch{return false;}
}
