import { createHash } from 'node:crypto';
import type { DeterministicReportArtifacts } from '@/engine/wave3/contracts';
import { canonicalJson } from '@/engine/case-operations/canonical';
import { canonicalSha256 } from '@/engine/rule-runtime/canonical';
import { renderDeterministicRtlDocument, type RtlBlock } from '@/server/reports/deterministic-hebrew-pdf';

export type DocumentReviewFindingStatus = 'observed' | 'derived_arithmetic' | 'conditional' | 'supported' | 'unknown';
export type DocumentReviewDisplayAmount = Readonly<{ label: string; currency: 'ILS'; minor_units: number }>;
export type DocumentReviewSource = Readonly<{
  id: string; title: string; url?: string; document_label?: string; page?: number;
}>;
type FindingBase = Readonly<{ id: string; title: string; summary: string; source_ids: readonly string[] }>;
export type DocumentReviewPresentationFinding = FindingBase & (
  | Readonly<{ status: 'observed' | 'derived_arithmetic' | 'supported'; amounts: readonly DocumentReviewDisplayAmount[] }>
  | Readonly<{ status: 'conditional'; amounts: readonly DocumentReviewDisplayAmount[]; conditions: readonly string[] }>
  | Readonly<{ status: 'unknown'; amounts: readonly [] }>
);
/** Customer-facing fields only. Commit/provider/trace details belong in the
 * separate private evidence argument, never in these presentation fields. */
export type DocumentReviewPresentationInput = Readonly<{
  schema_version: 'document-review-presentation-v1';
  report_id: string; report_revision: number; analysis_run_id: string; analysis_result_sha256: string;
  generated_at: string; case_public_id: string;
  period: Readonly<{ from: string; to: string }>;
  coverage: 'complete' | 'partial';
  what_checked: readonly string[];
  documents_checked: readonly Readonly<{ label: string; source_ids: readonly string[] }>[];
  findings: readonly DocumentReviewPresentationFinding[];
  /** Optional, source-bound selection for a concise opening. Full findings remain below. */
  overview_finding_ids?: readonly string[];
  missing_inputs: readonly Readonly<{ title: string; detail: string; next_step: string }>[];
  sources: readonly DocumentReviewSource[];
}>;
export type DocumentReviewArtifacts = DeterministicReportArtifacts & Readonly<{
  private_evidence_appendix: Uint8Array;
  private_evidence_appendix_sha256: string;
}>;
export const DOCUMENT_REVIEW_PRESENTATION_VERSION = 'document-review-artifacts-v1' as const;
const STATUS: Readonly<Record<DocumentReviewFindingStatus, string>> = Object.freeze({
  observed: 'נתון שנקרא במסמך',
  derived_arithmetic: 'תוצאה של חישוב אריתמטי',
  conditional: 'תוצאה מותנית',
  supported: 'ממצא מבוסס במקורות שנבדקו',
  unknown: 'לא ניתן לקבוע מהנתונים הקיימים',
});
const DISCLOSURE = 'הדוח נערך באמצעות AI על סמך המסמכים והמידע הרשומים בו. קריאת נתון וחישוב אריתמטי אינם כשלעצמם קביעת זכאות או חוב. התנאים והמידע החסר מפורטים ליד כל ממצא.';
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function safeLink(value: string): string {
  if (/[\u0000-\u0020\u007f]/u.test(value)) throw Error('DOCUMENT_REVIEW_SOURCE_URL_INVALID');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Error('DOCUMENT_REVIEW_SOURCE_URL_INVALID'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('DOCUMENT_REVIEW_SOURCE_URL_INVALID');
  return parsed.href;
}
function money(value: DocumentReviewDisplayAmount): string {
  const minor = BigInt(value.minor_units), zero = BigInt(0), hundred = BigInt(100);
  const absolute = minor < zero ? -minor : minor;
  const major = (absolute / hundred).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${minor < zero ? '-' : ''}${major}.${(absolute % hundred).toString().padStart(2, '0')}`;
}
function validate(input: DocumentReviewPresentationInput): void {
  const text = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (input.schema_version !== 'document-review-presentation-v1' || !text(input.report_id) || !text(input.analysis_run_id)
    || !text(input.case_public_id) || !Number.isSafeInteger(input.report_revision) || input.report_revision < 1
    || !/^[a-f0-9]{64}$/u.test(input.analysis_result_sha256) || !Number.isFinite(Date.parse(input.generated_at))
    || !/^\d{4}-\d{2}-\d{2}T/u.test(input.generated_at) || !text(input.period.from) || !text(input.period.to)
    || !['complete', 'partial'].includes(input.coverage) || !input.what_checked.length || input.what_checked.some(value => !text(value))) {
    throw Error('DOCUMENT_REVIEW_PRESENTATION_INVALID');
  }
  const sources = new Set(input.sources.map(source => source.id));
  if (sources.size !== input.sources.length || input.sources.some(source => !text(source.id) || !text(source.title)
    || (source.page !== undefined && (!Number.isSafeInteger(source.page) || source.page < 1)))) throw Error('DOCUMENT_REVIEW_SOURCE_INVALID');
  for (const source of input.sources) if (source.url !== undefined) safeLink(source.url);
  const refs = (ids: readonly string[]) => new Set(ids).size === ids.length && ids.every(id => sources.has(id));
  if (!input.documents_checked.length || input.documents_checked.some(document => !text(document.label) || !document.source_ids.length || !refs(document.source_ids))) {
    throw Error('DOCUMENT_REVIEW_DOCUMENT_SOURCE_MISSING');
  }
  if (new Set(input.findings.map(finding => finding.id)).size !== input.findings.length) throw Error('DOCUMENT_REVIEW_FINDING_DUPLICATE');
  if (input.overview_finding_ids !== undefined && (input.overview_finding_ids.length > 5
    || new Set(input.overview_finding_ids).size !== input.overview_finding_ids.length
    || input.overview_finding_ids.some(id => !input.findings.some(f => f.id === id && f.amounts.length)))) throw Error('DOCUMENT_REVIEW_OVERVIEW_BINDING_INVALID');
  for (const finding of input.findings) {
    if (!text(finding.id) || !text(finding.title) || !text(finding.summary) || !Object.hasOwn(STATUS, finding.status)
      || !refs(finding.source_ids) || (finding.status !== 'unknown' && !finding.source_ids.length)) throw Error('DOCUMENT_REVIEW_FINDING_SOURCE_INVALID');
    if (finding.status === 'unknown' && finding.amounts.length) throw Error('DOCUMENT_REVIEW_UNKNOWN_AMOUNT_FORBIDDEN');
    if (finding.status === 'conditional' && (!Array.isArray(finding.conditions) || !finding.conditions.length || finding.conditions.some(value => !text(value)))) throw Error('DOCUMENT_REVIEW_CONDITION_REQUIRED');
    for (const amount of finding.amounts) if (!text(amount.label) || amount.currency !== 'ILS' || !Number.isSafeInteger(amount.minor_units)) throw Error('DOCUMENT_REVIEW_AMOUNT_INVALID');
  }
  if (input.missing_inputs.some(item => !text(item.title) || !text(item.detail) || !text(item.next_step))) throw Error('DOCUMENT_REVIEW_MISSING_INPUT_INVALID');
  if (input.coverage === 'complete' && (input.missing_inputs.length || input.findings.some(finding => ['conditional', 'unknown'].includes(finding.status)))) {
    throw Error('DOCUMENT_REVIEW_COMPLETENESS_MISMATCH');
  }
}

/** Presentation only: no new finding, sum, authority, or publication decision is
 * computed here. Both formats use the same typed input and explicit amounts. */
export function renderDocumentReviewArtifacts(
  input: DocumentReviewPresentationInput,
  privateEvidence: Readonly<Record<string, unknown>> = {},
): DocumentReviewArtifacts {
  validate(input);
  const sourceNumber = new Map(input.sources.map((source, index) => [source.id, index + 1]));
  const references = (ids: readonly string[]) => ids.map(id => `[${sourceNumber.get(id)}]`).join(' ');
  const title = 'טיוטת דוח בדיקת מסמכים';
  const blocks: RtlBlock[] = [];
  const html: string[] = [];
  const heading = (text: string, level: 1 | 2 = 2) => { blocks.push({ kind: 'heading', level, text }); html.push(`<h${level}>${escape(text)}</h${level}>`); };
  const paragraph = (raw: string) => {
    // Display-only spacing between adjacent Hebrew prose and numeric tokens.
    // The typed input, raw readings and source labels remain unchanged.
    const text = raw.replace(/(?<=\p{Script=Hebrew})(?=\d)|(?<=[\d%])(?=\p{Script=Hebrew})/gu, ' ');
    blocks.push({ kind: 'paragraph', text }); html.push(`<p>${escape(text)}</p>`);
  };
  const table = (columns: readonly string[], rows: readonly (readonly string[])[]) => {
    blocks.push({ kind: 'table', columns, rows });
    html.push(`<table><thead><tr>${columns.map(value => `<th scope="col">${escape(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  };
  heading(title, 1);
  paragraph('טיוטה זו טרם אושרה לפרסום. אין בה אישור אנושי או קביעת חוב.');
  paragraph(`תיק ${input.case_public_id} | תקופה ${input.period.from} - ${input.period.to} | גרסה ${input.report_revision}`);
  paragraph(input.coverage === 'partial' ? 'הבדיקה חלקית: נותרו תנאים או נתונים שדורשים בירור.' : 'הבדיקה הושלמה בהיקף המסמכים והנושאים המפורטים בדוח.');
  paragraph(DISCLOSURE);
  heading('מה נבדק');
  for (const item of input.what_checked) paragraph(item);
  table(['מסמך שנבדק', 'אסמכתאות'], input.documents_checked.map(document => [document.label, references(document.source_ids)]));
  heading('עיקרי ההשוואות הכספיות');
  const overview = input.overview_finding_ids === undefined
    ? input.findings.filter(finding => finding.amounts.length).slice(0, 5)
    : input.overview_finding_ids.map(id => input.findings.find(finding => finding.id === id)!);
  const amounts = overview.map(finding => [finding.title, STATUS[finding.status], finding.amounts.map(amount => `${amount.label}: ${money(amount)} ₪`).join('\n')]);
  if (amounts.length) {
    table(['בדיקה', 'סוג התוצאה', 'הסכומים שנבדקו'], amounts);
    paragraph('זהו מבחר מתוך הבדיקות. כל הסכומים וההסתייגויות מופיעים בפירוט; אין כאן סיכום חוב שנקבע.');
  }
  else paragraph('לא נקבע סכום להצגה על בסיס הנתונים שנבדקו. מידע חסר אינו סכום אפס.');
  heading('פירוט הממצאים');
  if (!input.findings.length) paragraph('לא נוספו ממצאים בהיקף הבדיקה הנוכחי. אין בכך קביעה שכל הזכויות נבדקו או שאין פערים.');
  for (const finding of input.findings) {
    heading(finding.title);
    paragraph(STATUS[finding.status]);
    paragraph(finding.summary);
    if (finding.status === 'conditional') for (const condition of finding.conditions) paragraph(`תנאי לבירור: ${condition}`);
    for (const amount of finding.amounts) paragraph(`${amount.label}: ${money(amount)} ₪`);
    if (finding.source_ids.length) paragraph(`אסמכתאות: ${references(finding.source_ids)}`);
  }
  heading('מה חסר ומה צריך להשלים');
  if (!input.missing_inputs.length) paragraph('לא נדרשת השלמה נוספת בהיקף הבדיקה המפורט כאן.');
  for (const item of input.missing_inputs) { heading(item.title); paragraph(item.detail); paragraph(`להשלמה: ${item.next_step}`); }
  heading('מקורות ואסמכתאות');
  input.sources.forEach((source, index) => {
    const label = `[${index + 1}] ${source.title}${source.document_label ? ` - ${source.document_label}` : ''}${source.page ? `, עמוד ${source.page}` : ''}`;
    const url = source.url === undefined ? undefined : safeLink(source.url);
    blocks.push({ kind: 'paragraph', text: label + (url ? `\n${url}` : '') });
    html.push(`<p>${escape(label)}${url ? `<br><a href="${escape(url)}" target="_blank" rel="noopener noreferrer"><bdi dir="ltr">${escape(url)}</bdi></a>` : ''}</p>`);
  });
  const json = Buffer.from(canonicalJson(input), 'utf8');
  const htmlBytes = Buffer.from(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:32px auto;padding:0 24px;color:#172434;line-height:1.7}h1{font-size:26px}h2{font-size:19px;margin-top:28px;break-after:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{padding:9px;border:1px solid #cbd5e1;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#eef2f6}thead{display:table-header-group}a{color:#174d72}bdi{unicode-bidi:isolate}@media print{body{margin:0}}</style></head><body>${html.join('\n')}</body></html>`, 'utf8');
  const pdf = renderDeterministicRtlDocument({ title, subject: 'Tivdoc document review', fixed_date: input.generated_at.slice(0, 10).replaceAll('-', ''), layout_version: 'customer-report-v2', blocks });
  const json_sha256 = sha(json), html_sha256 = sha(htmlBytes), pdf_sha256 = sha(pdf);
  const private_evidence_appendix = Buffer.from(canonicalJson({
    schema_version: 'document-review-private-evidence-v1', report_id: input.report_id,
    analysis_run_id: input.analysis_run_id, analysis_result_sha256: input.analysis_result_sha256,
    evidence: privateEvidence,
  }), 'utf8');
  const private_evidence_appendix_sha256 = sha(private_evidence_appendix);
  const manifest = Buffer.from(canonicalJson({ schema_version: DOCUMENT_REVIEW_PRESENTATION_VERSION,
    report_id: input.report_id, report_revision: input.report_revision,
    analysis_run_id: input.analysis_run_id, analysis_result_sha256: input.analysis_result_sha256,
    layout_version: 'customer-report-v2', json_sha256, html_sha256, pdf_sha256,
    private_evidence_appendix_sha256, customer_body_contains_private_evidence: false,
  }), 'utf8');
  const manifest_sha256 = sha(manifest);
  const identity = { report_id: input.report_id, report_revision: input.report_revision,
    analysis_result_sha256: input.analysis_result_sha256, json_sha256, html_sha256, pdf_sha256, manifest_sha256 };
  return { ...identity, json, html: htmlBytes, pdf, manifest, report_sha256: canonicalSha256(identity),
    private_evidence_appendix, private_evidence_appendix_sha256 };
}
