import { createHash } from 'node:crypto';
import { PDFDocument, PDFRawStream } from 'pdf-lib';
import { expect, it } from 'vitest';
import { renderDocumentReviewArtifacts, type DocumentReviewPresentationInput } from './document-review-artifacts';
import { validateReport } from '@/server/platform/persistence/postgres/analysis/validation';

function input(overrides: Partial<DocumentReviewPresentationInput> = {}): DocumentReviewPresentationInput {
  return { schema_version: 'document-review-presentation-v1', report_id: 'synthetic-report', report_revision: 1,
    analysis_run_id: 'synthetic-analysis', analysis_result_sha256: 'a'.repeat(64), generated_at: '2026-09-11T12:00:00.000Z',
    case_public_id: 'תיק בדיקה', period: { from: '2026-06', to: '2026-06' }, coverage: 'complete',
    what_checked: ['התאמה אריתמטית של נתונים במסמך סינתטי'],
    documents_checked: [{ label: 'תלוש סינתטי לחודש יוני', source_ids: ['private-source-id'] }],
    sources: [{ id: 'private-source-id', title: 'תלוש שנמסר לבדיקה', document_label: 'תלוש סינתטי', page: 1, url: 'https://example.test/source?a=1&b=2' }],
    findings: [{ id: 'synthetic-finding', status: 'derived_arithmetic', title: 'התאמה אריתמטית',
      summary: 'בחישוב הסינתטי התקבלה התאמה בין הסכומים שנבדקו.', source_ids: ['private-source-id'],
      amounts: [{ label: 'הפרש אריתמטי', currency: 'ILS', minor_units: 0 }] }], missing_inputs: [], ...overrides };
}
async function pdfText(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map(page => {
    const stream = page.node.Contents();
    if (!(stream instanceof PDFRawStream)) throw Error('TEST_CONTENTS_REQUIRED');
    return [...stream.getContentsString().matchAll(/\/ActualText <FEFF([0-9a-f]*)>/giu)]
      .map(match => Buffer.from(match[1], 'hex').swap16().toString('utf16le')).join('');
  }).join('\n');
}
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

it('shows an explicit zero arithmetic result in both formats without calling it a debt or missing value', async () => {
  const report = renderDocumentReviewArtifacts(input());
  expect(() => validateReport(report)).not.toThrow();
  const html = Buffer.from(report.html).toString('utf8'), text = await pdfText(report.pdf);
  for (const output of [html, text]) {
    expect(output).toContain('טיוטת דוח בדיקת מסמכים');
    expect(output).toContain('טרם אושרה לפרסום');
    expect(output).toContain('0.00 ₪');
    expect(output).toContain('תוצאה של חישוב אריתמטי');
    expect(output).toContain('הפרש אריתמטי');
    expect(output).not.toContain('חוב מאושר');
    expect(output).not.toContain('לא נקבע סכום להצגה');
  }
  expect(report).toMatchObject({ report_id: 'synthetic-report', report_revision: 1, analysis_result_sha256: 'a'.repeat(64) });
  expect(report.json_sha256).toBe(sha(report.json)); expect(report.html_sha256).toBe(sha(report.html)); expect(report.pdf_sha256).toBe(sha(report.pdf));
  expect(html).toContain('הפרש אריתמטי: 0.00 ₪');
});

it('keeps partial, conditional, observed, supported and unknown results distinct without summing them', async () => {
  const base = input().findings[0];
  const report = renderDocumentReviewArtifacts(input({ coverage: 'partial', findings: [
    { ...base, id: 'observed', status: 'observed', amounts: [{ label: 'סכום מתועד', currency: 'ILS', minor_units: 12345 }] },
    { ...base, id: 'conditional', status: 'conditional', conditions: ['נדרשת בדיקה של ההיקף הרלוונטי'], amounts: [{ label: 'סכום מותנה', currency: 'ILS', minor_units: 5000 }] },
    { ...base, id: 'supported', status: 'supported', amounts: [] },
    { ...base, id: 'unknown', status: 'unknown', amounts: [], summary: 'אין די נתונים לקביעה.' },
  ], missing_inputs: [{ title: 'חסרים נתונים', detail: 'לא נמצא פירוט השעות הנחוץ לבדיקה.', next_step: 'יש לצרף את פירוט השעות.' }] }));
  for (const output of [Buffer.from(report.html).toString('utf8'), await pdfText(report.pdf)]) {
    for (const phrase of ['הבדיקה חלקית', 'נתון שנקרא במסמך', 'תוצאה מותנית', 'ממצא מבוסס במקורות שנבדקו', 'לא ניתן לקבוע מהנתונים הקיימים', '123.45 ₪', '50.00 ₪', 'תנאי לבירור:', 'יש לצרף את פירוט השעות.']) expect(output).toContain(phrase);
    expect(output).not.toContain('173.45'); expect(output).not.toContain('סך זכאות');
  }
});

it('never turns an unknown or no-result report into an implicit zero', async () => {
  const report = renderDocumentReviewArtifacts(input({ coverage: 'partial', findings: [] }));
  for (const output of [Buffer.from(report.html).toString('utf8'), await pdfText(report.pdf)]) {
    expect(output).toContain('לא נקבע סכום להצגה'); expect(output).toContain('מידע חסר אינו סכום אפס'); expect(output).not.toContain('0.00');
  }
  const wrong = input({ coverage: 'partial', findings: [{ ...input().findings[0], status: 'unknown' } as unknown as DocumentReviewPresentationInput['findings'][number]] });
  expect(() => renderDocumentReviewArtifacts(wrong)).toThrow('DOCUMENT_REVIEW_UNKNOWN_AMOUNT_FORBIDDEN');
});

it('renders safe clickable source links and readable numbered PDF references without internal source IDs', async () => {
  const report = renderDocumentReviewArtifacts(input());
  const html = Buffer.from(report.html).toString('utf8'), text = await pdfText(report.pdf);
  expect(html).toContain('href="https://example.test/source?a=1&amp;b=2"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(text).toContain('[1] תלוש שנמסר לבדיקה - תלוש סינתטי, עמוד 1');
  expect(text).toContain('https://example.test/source?a=1&b=2');
  expect(html).not.toContain('private-source-id'); expect(text).not.toContain('private-source-id');
});

it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'file:///C:/private/source.pdf', 'https://user:secret@example.test/source', 'https://example.test/\nsource'])('refuses unsafe source URL %s', url => {
  expect(() => renderDocumentReviewArtifacts(input({ sources: [{ ...input().sources[0], url }] }))).toThrow('DOCUMENT_REVIEW_SOURCE_URL_INVALID');
});

it('escapes customer text and separates private evidence from both customer formats', async () => {
  const report = renderDocumentReviewArtifacts(input({ what_checked: ['<script>alert("synthetic")</script>'] }), {
    commit: 'private-ci-commit', error: 'provider_failed_private_only', local_path: 'C:/private-only/source.pdf',
  });
  const html = Buffer.from(report.html).toString('utf8'), text = await pdfText(report.pdf);
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  for (const value of ['private-ci-commit', 'provider_failed_private_only', 'C:/private-only/source.pdf', 'synthetic-analysis']) {
    expect(html).not.toContain(value); expect(text).not.toContain(value);
  }
  const appendix = JSON.parse(Buffer.from(report.private_evidence_appendix).toString('utf8'));
  expect(appendix.evidence.commit).toBe('private-ci-commit');
  expect(appendix.analysis_run_id).toBe('synthetic-analysis');
  expect(report.private_evidence_appendix_sha256).toBe(sha(report.private_evidence_appendix));
});

it('refuses unbound sources and complete claims with unresolved inputs', () => {
  expect(() => renderDocumentReviewArtifacts(input({ sources: [] }))).toThrow('DOCUMENT_REVIEW_DOCUMENT_SOURCE_MISSING');
  expect(() => renderDocumentReviewArtifacts(input({ missing_inputs: [{ title: 'חסר', detail: 'חסר מקור', next_step: 'להשלים מקור' }] }))).toThrow('DOCUMENT_REVIEW_COMPLETENESS_MISMATCH');
  expect(() => renderDocumentReviewArtifacts(input({ findings: [{ ...input().findings[0], status: 'conditional', conditions: [] }] }))).toThrow('DOCUMENT_REVIEW_CONDITION_REQUIRED');
});

it('preserves exact signed minor units and deterministic bindings without recomputing an amount', async () => {
  const source = input({ findings: [{ ...input().findings[0], status: 'derived_arithmetic', amounts: [{ label: 'הפרש חתום', currency: 'ILS', minor_units: -24058 }] }] });
  const first = renderDocumentReviewArtifacts(source), second = renderDocumentReviewArtifacts(source);
  for(const key of Object.keys(first) as (keyof typeof first)[]){
    const value=first[key],other=second[key];
    if(value instanceof Uint8Array){expect(other).toBeInstanceOf(Uint8Array);expect(Buffer.from(value).equals(Buffer.from(other as Uint8Array))).toBe(true);}
    else expect(value).toEqual(other);
  }
  expect(await pdfText(first.pdf)).toContain('-240.58 ₪');
  const manifest = JSON.parse(Buffer.from(first.manifest).toString('utf8'));
  expect(manifest).toMatchObject({ analysis_run_id: source.analysis_run_id, analysis_result_sha256: source.analysis_result_sha256,
    json_sha256: first.json_sha256, html_sha256: first.html_sha256, pdf_sha256: first.pdf_sha256, layout_version: 'customer-report-v2' });
});


it('bounds the opening to selected findings while retaining every amount in the details', () => {
  const findings = Array.from({length: 8}, (_, index) => ({...input().findings[0], status:'derived_arithmetic' as const, id: `finding-${index}`, title: `בדיקה ${index}`,
    amounts: [{label: 'סכום במסמך', currency: 'ILS' as const, minor_units: 100 + index}]}));
  const report = renderDocumentReviewArtifacts(input({findings, overview_finding_ids: ['finding-7', 'finding-1']}));
  const html = Buffer.from(report.html).toString('utf8');
  const opening = html.split('<h2>עיקרי ההשוואות הכספיות</h2>')[1].split('<h2>פירוט הממצאים</h2>')[0];
  expect(opening).toContain('בדיקה 7'); expect(opening).toContain('בדיקה 1'); expect(opening).not.toContain('בדיקה 0');
  expect(opening).toContain('אין כאן סיכום חוב שנקבע');
  for (let i = 0; i < 8; i++) expect(html).toContain(`<h2>בדיקה ${i}</h2>`);
  expect(() => renderDocumentReviewArtifacts(input({overview_finding_ids: ['foreign']}))).toThrow('DOCUMENT_REVIEW_OVERVIEW_BINDING_INVALID');
  expect(() => renderDocumentReviewArtifacts(input({findings, overview_finding_ids: findings.slice(0, 6).map(f => f.id)}))).toThrow('DOCUMENT_REVIEW_OVERVIEW_BINDING_INVALID');
});


it('separates Hebrew prose from adjacent numeric and percentage tokens without rewriting the saved input', async () => {
  const raw='בדיקת3ימים בעמודת125%הריקה';
  const report=renderDocumentReviewArtifacts(input({what_checked:[raw]}));
  for(const text of [Buffer.from(report.html).toString('utf8'),await pdfText(report.pdf)]) expect(text).toContain('בדיקת 3 ימים בעמודת 125% הריקה');
  expect(JSON.parse(Buffer.from(report.json).toString('utf8')).what_checked).toEqual([raw]);
});
