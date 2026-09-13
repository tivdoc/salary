import {describe,it,expect} from 'vitest';
import {isolatedPreviewDatabase} from './preview-database';
const config={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/tivdoc-release-completion',
 NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',
 TIVDOC_PREVIEW_WEB_POSTGRES_URL:'postgresql://tivdoc_web_runtime.cpzrbidxftzqcfeqqusu:synthetic@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907?sslmode=verify-full'};
describe('explicit isolated release Preview database',()=>{
 it('does nothing without the dedicated setting',()=>expect(isolatedPreviewDatabase({VERCEL_ENV:'production'})).toBeNull());
 it('accepts only the exact owned web role and database',()=>expect(isolatedPreviewDatabase(config)).toBe(config.TIVDOC_PREVIEW_WEB_POSTGRES_URL));
 it('allows the verified transaction pooler while keeping every target/TLS constraint',()=>{
  const target=config.TIVDOC_PREVIEW_WEB_POSTGRES_URL.replace(':5432/',':6543/');
  expect(isolatedPreviewDatabase({...config,TIVDOC_PREVIEW_WEB_POSTGRES_URL:target})).toBe(target);
  for(const unsafe of [target.replace(':6543/',':6544/'),target.replace('tivdoc_release_replay_20260907','postgres'),target.replace('verify-full','disable')])expect(()=>isolatedPreviewDatabase({...config,TIVDOC_PREVIEW_WEB_POSTGRES_URL:unsafe})).toThrow('ISOLATED_PREVIEW_DATABASE_REFUSED');
 });
 it.each([
  {VERCEL_ENV:'production'},
  {VERCEL_ENV:'development'},
  {VERCEL_GIT_COMMIT_REF:'main'},
  {NEXT_PUBLIC_SUPABASE_URL:'https://hedgdltsonvypefbigag.supabase.co'},
  {TIVDOC_PREVIEW_WEB_POSTGRES_URL:config.TIVDOC_PREVIEW_WEB_POSTGRES_URL.replace('tivdoc_web_runtime','postgres')},
  {TIVDOC_PREVIEW_WEB_POSTGRES_URL:config.TIVDOC_PREVIEW_WEB_POSTGRES_URL.replace('tivdoc_release_replay_20260907','postgres')},
  {TIVDOC_PREVIEW_WEB_POSTGRES_URL:config.TIVDOC_PREVIEW_WEB_POSTGRES_URL.replace('cpzrbidxftzqcfeqqusu','hedgdltsonvypefbigag')},
  {TIVDOC_PREVIEW_WEB_POSTGRES_URL:config.TIVDOC_PREVIEW_WEB_POSTGRES_URL+'&options=-c%20role=postgres'},
  {TIVDOC_PREVIEW_WEB_POSTGRES_URL:'not a connection URL'},
 ])('refuses an unsafe or inconsistent target without fallback (%j)',overrides=>{
  expect(()=>isolatedPreviewDatabase({...config,...overrides})).toThrow('ISOLATED_PREVIEW_DATABASE_REFUSED');
 });
});
