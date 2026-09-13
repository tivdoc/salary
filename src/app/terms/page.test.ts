import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import TermsPage from './page';
import PrivacyPage from '../privacy/page';
import {TERMS_VERSION,RETAINED_TERMS_VERSION} from '@/lib/legal-terms';
const guard=vi.hoisted(()=>vi.fn());
vi.mock('server-only',()=>({}));
vi.mock('@/server/platform/capabilities/stable-next-entrypoint',()=>({guardStableAppEntrypoint:guard}));
vi.mock('@/components/site-header',()=>({SiteHeader:()=>null}));
vi.mock('@/components/site-footer',()=>({SiteFooter:()=>null}));
beforeEach(()=>vi.clearAllMocks());
it.each([TermsPage,PrivacyPage])('renders the new notice only on the current version',async Page=>{
 const html=renderToStaticMarkup(await Page());expect(html).toContain('13.9.2026');
 expect(html).toContain('כאשר דוח חדש זמין בתיק');expect(html).toContain('ללא מסמכי השכר');expect(html).toContain('לא הודעות פרסומיות');
 expect(guard).toHaveBeenCalledTimes(1);
 const explicit=renderToStaticMarkup(await Page({searchParams:Promise.resolve({version:TERMS_VERSION})}));expect(explicit).toBe(html);
});
it.each([TermsPage,PrivacyPage])('serves the retained older wording without adding report-notice permission',async Page=>{
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({version:RETAINED_TERMS_VERSION})}));
 expect(html).toContain('7.9.2026');expect(html).toContain('עותק של הנוסח');expect(html).toContain('אין בכך אימות');
 expect(html).not.toContain('כאשר דוח חדש זמין בתיק');expect(html).not.toContain('13.9.2026');expect(guard).toHaveBeenCalledTimes(1);
});
it('keeps retained terms prices and privacy link tied to the retained copy',async()=>{
 const html=renderToStaticMarkup(await TermsPage({searchParams:Promise.resolve({version:RETAINED_TERMS_VERSION})}));
 expect(html).toContain('9.99 ₪');expect(html).toContain('99 ₪');expect(html).toContain('349 ₪');
 expect(html).toContain(`/privacy?version=${RETAINED_TERMS_VERSION}`);expect(html).not.toContain('href="/privacy"');
});
it.each(['2026-08-22','unknown',[TERMS_VERSION,RETAINED_TERMS_VERSION]])('does not reinterpret unretained or ambiguous version %j as current terms',async version=>{
 for(const Page of [TermsPage,PrivacyPage]){
  const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({version})}));
  expect(html).toContain('אינו זמין כאן');expect(html).not.toContain('כאשר דוח חדש זמין בתיק');expect(html).not.toContain('13.9.2026');
 }
});
