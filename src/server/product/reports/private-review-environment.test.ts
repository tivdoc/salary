import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {privateReviewEnvironmentEnabled} from './private-review-environment';
const local={NODE_ENV:'production',TIVDOC_AI_RELEASE_ENABLED:'1',TIVDOC_RUNTIME_TARGET:'local_only',TIVDOC_PRODUCT_PERSISTENCE_MODE:'isolated_postgres',
 NEXT_PUBLIC_SITE_URL:'http://localhost:3423',NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',
 TIVDOC_WEB_POSTGRES_URL:'postgresql://tivdoc_web_runtime.cpzrbidxftzqcfeqqusu:synthetic@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907?sslmode=verify-full'};
describe('private QA report visibility in an honest optimized local build',()=>{
 it('supports the exact local DEV web role without Vercel claims',()=>expect(privateReviewEnvironmentEnabled(local)).toBe(true));
 it.each([
  {VERCEL:'1'},{VERCEL_ENV:'production'},{VERCEL_ENV:'preview'},
  {TIVDOC_AI_RELEASE_ENABLED:'0'},{TIVDOC_RUNTIME_TARGET:'production'},{TIVDOC_PRODUCT_PERSISTENCE_MODE:'supabase'},
  {NEXT_PUBLIC_SITE_URL:'https://tivdoc.com'},{NEXT_PUBLIC_SITE_URL:'http://localhost.evil:3423'},
  {NEXT_PUBLIC_SITE_URL:'http://user@localhost:3423'},{NEXT_PUBLIC_SITE_URL:'http://localhost:3423/path'},
  {NEXT_PUBLIC_SUPABASE_URL:'https://foreign.supabase.co'},
  ...['postgres','wrong_database','tivdoc_release_replay_20260907/extra'].map(name=>({TIVDOC_WEB_POSTGRES_URL:local.TIVDOC_WEB_POSTGRES_URL.replace('/tivdoc_release_replay_20260907','/'+name)})),
  ...['tivdoc_worker_runtime','postgres','tivdoc_dev_migrator'].map(role=>({TIVDOC_WEB_POSTGRES_URL:local.TIVDOC_WEB_POSTGRES_URL.replace('tivdoc_web_runtime',role)})),
  {TIVDOC_WEB_POSTGRES_URL:local.TIVDOC_WEB_POSTGRES_URL.replace('verify-full','require')},
  {TIVDOC_WEB_POSTGRES_URL:local.TIVDOC_WEB_POSTGRES_URL.replace(':5432',':9999')},
  {TIVDOC_WEB_POSTGRES_URL:'invalid'},
 ])('refuses an unbound local target %o',change=>expect(privateReviewEnvironmentEnabled({...local,...change})).toBe(false));
 it('leaves the closed default disabled',()=>expect(privateReviewEnvironmentEnabled({NODE_ENV:'production'})).toBe(false));
 it('preserves authenticated Preview selection',()=>expect(privateReviewEnvironmentEnabled({
  VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/tivdoc-release-completion',
  TIVDOC_PREVIEW_WEB_POSTGRES_URL:local.TIVDOC_WEB_POSTGRES_URL,NEXT_PUBLIC_SUPABASE_URL:local.NEXT_PUBLIC_SUPABASE_URL,
 })).toBe(true));
 it('never falls back from invalid Preview settings to local',()=>expect(()=>privateReviewEnvironmentEnabled({...local,
  TIVDOC_PREVIEW_WEB_POSTGRES_URL:local.TIVDOC_WEB_POSTGRES_URL,
 })).toThrow('ISOLATED_PREVIEW_DATABASE_REFUSED'));
});
