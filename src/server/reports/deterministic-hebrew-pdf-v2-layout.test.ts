import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { expect, it } from 'vitest';
import { renderDeterministicRtlDocument, type RtlDocument } from './deterministic-hebrew-pdf';

/** Read the actual positioned glyph operators and embedded widths independently
 * of the renderer's run segmentation and TrueType measurement helpers. */
async function layout(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map(page => {
    const font = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
    const widths = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('W'), PDFArray);
    const widthByGlyph = new Map<number, number>();
    for (let i = 0; i < widths.size(); i += 2) {
      const first = widths.lookup(i, PDFNumber).asNumber(), values = widths.lookup(i + 1, PDFArray);
      for (let j = 0; j < values.size(); j++) widthByGlyph.set(first + j, values.lookup(j, PDFNumber).asNumber());
    }
    const unicodeStream = font.lookup(PDFName.of('ToUnicode'));
    if (!(unicodeStream instanceof PDFRawStream)) throw Error('TEST_UNICODE_STREAM_REQUIRED');
    const unicode = unicodeStream.getContentsString();
    const byGlyph = new Map([...unicode.matchAll(/^<([0-9a-f]{4})> <([0-9a-f]+)>$/gimu)]
      .map(match => [parseInt(match[1], 16), Buffer.from(match[2], 'hex').swap16().toString('utf16le')]));
    const contents = page.node.Contents();
    if (!(contents instanceof PDFRawStream)) throw Error('TEST_CONTENTS_REQUIRED');
    const runs = [...contents.getContentsString().matchAll(/\/ActualText <FEFF([0-9a-f]*)> >> BDC BT \/F1 ([\d.]+) Tf 1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm <([0-9a-f]*)> Tj/giu)].map(match => {
      const glyphs = (match[5].match(/.{4}/gu) ?? []).map(value => parseInt(value, 16));
      const size = Number(match[2]);
      return { text: Buffer.from(match[1], 'hex').swap16().toString('utf16le'), size,
        x: Number(match[3]), y: Number(match[4]), visual: glyphs.map(glyph => byGlyph.get(glyph)).join(''),
        width: glyphs.reduce((sum, glyph) => sum + (widthByGlyph.get(glyph) ?? 0) * size / 1000, 0) };
    });
    return { runs, text: runs.map(run => run.text).join(''), width: page.getWidth(), height: page.getHeight() };
  });
}

function document(blocks: RtlDocument['blocks'], modern = true): RtlDocument {
  return { title: 'מסמך בדיקה סינתטי', subject: 'synthetic-layout-only', fixed_date: '20260911',
    ...(modern ? { layout_version: 'customer-report-v2' as const } : {}), blocks };
}

it('puts independent spaces on both sides of a numeric run and preserves numeric glyph order', async () => {
  const text = 'סכום 240.58 ₪ לחודש';
  const pages = await layout(renderDeterministicRtlDocument(document([{ kind: 'paragraph', text }])));
  expect(pages).toHaveLength(1);
  expect(pages[0].text).toBe(text);
  const amount = pages[0].runs.find(run => run.text === '240.58 ₪')!;
  const before = pages[0].runs.find(run => run.text === 'סכום')!;
  const after = pages[0].runs.find(run => run.text === 'לחודש')!;
  expect(amount.visual).toBe('240.58 ₪');
  expect(before.x - amount.x - amount.width).toBeGreaterThan(2);
  expect(amount.x - after.x - after.width).toBeGreaterThan(2);
  const old = await layout(renderDeterministicRtlDocument(document([{ kind: 'paragraph', text }], false)));
  const oldAmount = old[0].runs.find(run => run.text === '240.58 ₪ ')!;
  const oldAfter = old[0].runs.find(run => run.text === 'לחודש')!;
  expect(Math.abs(oldAmount.x - oldAfter.x - oldAfter.width)).toBeLessThan(0.1);
});

it('keeps label punctuation at the Hebrew boundary instead of moving it around the amount', async () => {
  const text = 'הפרש אריתמטי: 240.58 ₪ לחודש.';
  const pages = await layout(renderDeterministicRtlDocument(document([{ kind: 'paragraph', text }])));
  expect(pages[0].text).toBe(text);
  const amount = pages[0].runs.find(run => run.text === '240.58 ₪')!;
  const before = pages[0].runs.find(run => run.text === 'אריתמטי')!;
  const punctuation = pages[0].runs.find(run => run.text === ': ')!;
  const after = pages[0].runs.find(run => run.text === 'לחודש')!;
  expect(punctuation.visual).toBe(' :');
  expect(Math.abs(before.x - punctuation.x - punctuation.width)).toBeLessThan(0.1);
  expect(punctuation.x - amount.x - amount.width).toBeGreaterThanOrEqual(-0.1);
  expect(amount.visual).toBe('240.58 ₪');
  expect(amount.x - after.x - after.width).toBeGreaterThan(2);
});

it('keeps a heading and its following content on the same page at the legacy orphan boundary', async () => {
  const blocks: RtlDocument['blocks'] = [
    ...Array.from({ length: 41 }, () => ({ kind: 'paragraph' as const, text: 'שורת מילוי' })),
    { kind: 'heading', level: 1, text: 'כותרת חדשה' },
    { kind: 'paragraph', text: 'continued-body-sentinel' },
  ];
  const old = await layout(renderDeterministicRtlDocument(document(blocks, false)));
  expect(old[0].text).toContain('כותרת חדשה');
  expect(old[0].text).not.toContain('continued-body-sentinel');
  const pages = await layout(renderDeterministicRtlDocument(document(blocks)));
  expect(pages[0].text).not.toContain('כותרת חדשה');
  expect(pages[1].text).toContain('כותרת חדשהcontinued-body-sentinel');
});

it('keeps a finding heading and its status with the actual summary at the status-only orphan boundary', async () => {
  const blocks: RtlDocument['blocks'] = [
    ...Array.from({length:40},()=>({kind:'paragraph' as const,text:'שורת מילוי'})),
    {kind:'heading',level:2,text:'כותרת הבדיקה'},
    {kind:'paragraph',text:'סטטוס הבדיקה'},
    {kind:'paragraph',text:'summary-body-sentinel'},
  ];
  const old=await layout(renderDeterministicRtlDocument(document(blocks)));
  expect(old[0].text).toContain('כותרת הבדיקהסטטוס הבדיקה');
  expect(old[0].text).not.toContain('summary-body-sentinel');
  const next=blocks.map(block=>block.kind==='paragraph'&&block.text==='סטטוס הבדיקה'?{...block,keep_with_next:true}:block);
  const pages=await layout(renderDeterministicRtlDocument(document(next)));
  expect(pages[0].text).not.toContain('כותרת הבדיקה');
  expect(pages[1].text).toContain('כותרת הבדיקהסטטוס הבדיקהsummary-body-sentinel');
  expect(pages.map(page=>page.text).join('')).toBe(old.map(page=>page.text).join(''));
});

it('wraps headings and full source URLs inside the page without losing their text', async () => {
  const title = ('כותרת ארוכה עם סכום 1,234.50 ₪ ').repeat(9);
  const source = 'מקור https://example.test/official/' + 'W'.repeat(600);
  const pages = await layout(renderDeterministicRtlDocument(document([
    { kind: 'heading', level: 1, text: title }, { kind: 'paragraph', text: source },
  ])));
  expect(pages.map(page => page.text).join('')).toBe(title + source);
  for (const page of pages) for (const run of page.runs) {
    expect(run.x, run.text).toBeGreaterThanOrEqual(41.8);
    expect(run.x + run.width, run.text).toBeLessThanOrEqual(page.width - 41.8);
    expect(run.y, run.text).toBeGreaterThanOrEqual(66);
  }
});

it('continues a long first table row below repeated headers while keeping its heading with actual content', async () => {
  const value = 'W'.repeat(5000);
  const pages = await layout(renderDeterministicRtlDocument(document([
    ...Array.from({ length: 39 }, () => ({ kind: 'paragraph' as const, text: 'שורת מילוי' })),
    { kind: 'heading', level: 2, text: 'פירוט מקורות' },
    { kind: 'table', columns: ['מקור', 'תיאור'], rows: [['מקור סינתטי', value]] },
  ])));
  const headingPage = pages.find(page => page.text.includes('פירוט מקורות'))!;
  expect(headingPage.text).toContain('W');
  const valuePages = pages.filter(page => page.text.includes('W'));
  expect(valuePages.length).toBeGreaterThan(1);
  expect(valuePages.flatMap(page => page.runs.filter(run => /^W+$/u.test(run.text)).map(run => run.text)).join('')).toBe(value);
  for (const page of valuePages) expect(page.text).toContain('מקורתיאור');
});

it('keeps opt-in rendering deterministic and refuses an impossible heading group instead of clipping it', () => {
  const input = document([{ kind: 'paragraph', text: 'תוצאה 0.00 ₪ נשארת אפס מדוד' }]);
  expect(renderDeterministicRtlDocument(input)).toEqual(renderDeterministicRtlDocument(input));
  expect(() => renderDeterministicRtlDocument(document([
    { kind: 'heading', level: 1, text: 'כותרת '.repeat(4000) },
  ]))).toThrow('RTL_HEADING_GROUP_TOO_TALL');
});
