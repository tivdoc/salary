import {expect,it,vi} from 'vitest';
import {privateMarkdownBlocks,renderPrivateOwnerReport} from './report';
vi.mock('server-only',()=>({}));
it('renders identical source text and amounts to both formats without external HTML execution',()=>{
 const markdown='# נתוני בדיקה מומצאים\n\nערך מודפס 123.45 ₪; אין קביעת חוב.\n\n| נושא | מצב |\n|---|---|\n| פנסיה | חסר מקור |\n\n<script>alert(1)</script>';
 const a=renderPrivateOwnerReport({workId:'CASE-01',markdown,fixedDate:'20260911'}),b=renderPrivateOwnerReport({workId:'CASE-01',markdown,fixedDate:'20260911'});
 expect(a.pdf).toEqual(b.pdf);expect(a.manifest).toEqual(b.manifest);expect(a.html.toString()).toContain('123.45');
 expect(a.html.toString()).not.toContain('<script>');expect(a.html.toString()).toContain('&lt;script&gt;');expect(a.html.toString()).toContain("default-src 'none'");
 expect(a.manifest.customer_publication).toBe(false);expect(Buffer.from(a.pdf).toString('latin1')).toContain('/ActualText');
});
it('rejects a ragged table rather than silently dropping a source cell',()=>{
 expect(()=>privateMarkdownBlocks('| א | ב |\n|---|---|\n| 1 | 2 | 3 |')).toThrow('PRIVATE_REPORT_TABLE_WIDTH');
});
