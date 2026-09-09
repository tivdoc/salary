import {expect,it} from 'vitest';
import {isolatedPreviewWebhookDatabase} from './preview-webhook-database';
const config={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/tivdoc-release-completion',NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/tivdoc_release_replay_20260907?sslmode=verify-full'};
it('requires a dedicated setting and returns the exact worker target without URL TLS overrides',()=>{
 expect(isolatedPreviewWebhookDatabase({})).toBeNull();
 expect(isolatedPreviewWebhookDatabase(config)).toBe(config.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL.split('?')[0]);
});
it.each([
 {VERCEL_ENV:'production'}, {VERCEL_GIT_COMMIT_REF:'main'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://hedgdltsonvypefbigag.supabase.co'},
 ...['tivdoc_web_runtime','postgres'].map(role=>({TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL:config.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL.replace('tivdoc_worker_runtime',role)})),
 ...['postgres','tivdoc_release_other'].map(database=>({TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL:config.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL.replace('tivdoc_release_replay_20260907',database)})),
 {TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL:config.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL.replace('verify-full','disable')},
 {TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL:config.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL+'&options=anything'},
])('refuses mismatched role, branch, database and TLS without fallback (%j)',override=>{
 expect(()=>isolatedPreviewWebhookDatabase({...config,...override})).toThrow('ISOLATED_PREVIEW_WEBHOOK_DATABASE_REFUSED');
});
