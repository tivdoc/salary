import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CanonicalCaseReport } from "./deterministic-report-builder";

export const HEBREW_REPORT_FONT = Object.freeze({
  family: "DejaVu Sans",
  version: "2.37",
  file: "assets/fonts/DejaVuSans.ttf",
  sha256: "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
  license: "Bitstream Vera license with DejaVu changes in the public domain",
  provenance: "DejaVu Fonts 2.37 release; local copy supplied by the pinned Codex Poppler runtime",
  upstream: "https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37",
} as const);

export const HEBREW_REPORT_PAGE_COUNT = 4;
export const SYNTHETIC_REPORT_WATERMARK = "נתוני בדיקה סינתטיים בלבד";

type PdfTopic = CanonicalCaseReport["topics"][number];
type Align = "left" | "right" | "center";

type TtfMetrics = Readonly<{
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: readonly [number, number, number, number];
  glyphForCodePoint: (codePoint: number) => number;
  glyphWidth: (glyph: number) => number;
}>;

type TextRun = Readonly<{
  logical: string;
  glyphs: readonly number[];
  width: number;
}>;

type PdfContext = Readonly<{
  metrics: TtfMetrics;
  used: Map<number, number>;
  commands: string[];
}>;

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;

const TOPIC_HEBREW: Readonly<Record<PdfTopic["topic"], string>> = Object.freeze({
  minimum_wage: "שכר מינימום",
  working_time: "שעות עבודה ומנוחה",
  pension: "פנסיה",
  travel: "נסיעות",
  convalescence: "דמי הבראה",
  vacation: "חופשה",
  sick_leave: "מחלה",
});

const STATUS_HEBREW: Readonly<Record<PdfTopic["status"], string>> = Object.freeze({
  calculated: "חושב לפי קלט סינתטי",
  not_applicable: "לא חל לפי קלט סינתטי",
  blocked_missing_facts: "חסום בשל עובדות חסרות",
  blocked_conflict: "חסום בשל עובדות סותרות",
  blocked_legal_readiness: "חסום בשל אי מוכנות משפטית",
  error: "שגיאה סגורה",
});

export function hebrewTopicLabel(topic: PdfTopic["topic"]): string {
  return TOPIC_HEBREW[topic];
}

export function renderCanonicalHebrewPdf(
  report: CanonicalCaseReport,
  jsonSha256: string,
  htmlSha256: string,
): Uint8Array {
  const fontBytes = readPinnedFont();
  const metrics = parseTrueType(fontBytes);
  const used = new Map<number, number>();
  const pages = [
    renderCoverPage(report, metrics, used, jsonSha256),
    renderTopicPage(report, metrics, used, 1, report.topics.slice(0, 3)),
    renderTopicPage(report, metrics, used, 2, report.topics.slice(3)),
    renderTracePage(report, metrics, used, jsonSha256, htmlSha256),
  ];
  return assemblePdf(report, fontBytes, metrics, used, pages, jsonSha256, htmlSha256);
}

function readPinnedFont(): Uint8Array {
  // L8-1 / D2. The path is spelled as literals here, and not read from the
  // frozen constant above, because the build's file tracer can only follow a
  // literal: `resolve(cwd(), <expression>)` made it copy the whole repository
  // (docs, scripts, assets) into the instrumentation trace. The constant still
  // names the file for the report's own provenance block; the test pins the two.
  const fontPath = path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf");
  const bytes = readFileSync(fontPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== HEBREW_REPORT_FONT.sha256) throw new Error("HEBREW_REPORT_FONT_HASH_MISMATCH");
  return bytes;
}

function renderCoverPage(
  report: CanonicalCaseReport,
  metrics: TtfMetrics,
  used: Map<number, number>,
  jsonSha256: string,
): Uint8Array {
  const ctx = pageContext(metrics, used);
  pageChrome(ctx, report, 1);
  rtl(ctx, "דוח בדיקה קנוני", PAGE_WIDTH - MARGIN, 760, 24, "right", "0.08 0.19 0.24");
  rtl(ctx, "ניתוח סינתטי דטרמיניסטי לצורכי אימות בלבד", PAGE_WIDTH - MARGIN, 730, 11, "right", "0.25 0.34 0.38");
  line(ctx, MARGIN, 710, PAGE_WIDTH - MARGIN, 710, "0.23 0.50 0.45", 1.2);

  metadataRow(ctx, 680, "מזהה תיק", report.case_id);
  metadataRow(ctx, 654, "מזהה דוח", report.report_id);
  metadataRow(ctx, 628, "תקופה", `${report.period.start_date} - ${report.period.end_date}`);
  metadataRow(ctx, 602, "נכון ליום", report.as_of);
  metadataRow(ctx, 576, "מטבע בדיקה", "XTS");
  metadataRow(ctx, 550, "גרסת תבנית", report.template_version);

  rtl(ctx, "סיכום שבעת הנושאים", PAGE_WIDTH - MARGIN, 514, 15, "right", "0.08 0.19 0.24");
  const tableTop = 493;
  const rowHeight = 38;
  fillRect(ctx, MARGIN, tableTop - rowHeight, PAGE_WIDTH - MARGIN * 2, rowHeight, "0.91 0.95 0.94");
  strokeRect(ctx, MARGIN, tableTop - rowHeight * 8, PAGE_WIDTH - MARGIN * 2, rowHeight * 8, "0.65 0.72 0.71", 0.7);
  [MARGIN + 110, MARGIN + 270, MARGIN + 405].forEach((x) => line(ctx, x, tableTop, x, tableTop - rowHeight * 8, "0.65 0.72 0.71", 0.5));
  for (let index = 1; index < 8; index += 1) line(ctx, MARGIN, tableTop - rowHeight * index, PAGE_WIDTH - MARGIN, tableTop - rowHeight * index, "0.65 0.72 0.71", 0.5);
  rtl(ctx, "נושא", PAGE_WIDTH - MARGIN - 8, tableTop - 24, 9, "right");
  rtl(ctx, "מצב", MARGIN + 397, tableTop - 24, 9, "right");
  rtl(ctx, "סכום", MARGIN + 262, tableTop - 24, 9, "right");
  rtl(ctx, "חסמים", MARGIN + 102, tableTop - 24, 9, "right");
  report.topics.forEach((topic, index) => {
    const y = tableTop - rowHeight * (index + 1) - 24;
    rtl(ctx, TOPIC_HEBREW[topic.topic], PAGE_WIDTH - MARGIN - 8, y, 8.5, "right");
    rtl(ctx, topic.status === "calculated" ? "חושב" : "חסום", MARGIN + 397, y, 8.5, "right");
    ltr(ctx, formatAmount(topic), MARGIN + 262, y, 8, "right");
    ltr(ctx, String(topic.blockers.length), MARGIN + 55, y, 8.5, "center");
  });
  rtl(ctx, "הדוח אינו ייעוץ משפטי ואינו מפעיל מקור, פרמטר או כלל ישראלי.", PAGE_WIDTH - MARGIN, 150, 10, "right", "0.42 0.18 0.15");
  ltr(ctx, `JSON SHA-256: ${jsonSha256}`, MARGIN, 125, 6.8, "left", "0.25 0.34 0.38");
  return finishPage(ctx);
}

function renderTopicPage(
  report: CanonicalCaseReport,
  metrics: TtfMetrics,
  used: Map<number, number>,
  pageNumber: number,
  topics: readonly PdfTopic[],
): Uint8Array {
  const ctx = pageContext(metrics, used);
  const actualPage = pageNumber + 1;
  pageChrome(ctx, report, actualPage);
  rtl(ctx, actualPage === 2 ? "פירוט נושאים - חלק ראשון" : "פירוט נושאים - חלק שני", PAGE_WIDTH - MARGIN, 760, 19, "right", "0.08 0.19 0.24");
  rtl(ctx, "כל נושא מציג מצב, סכום, חסמים ועקיבות אסמכתה מבלי להסיק דין.", PAGE_WIDTH - MARGIN, 734, 9.5, "right", "0.25 0.34 0.38");

  const cardHeight = topics.length === 3 ? 180 : 135;
  topics.forEach((topic, index) => {
    const top = 700 - index * (cardHeight + 10);
    topicCard(ctx, topic, top, cardHeight);
  });
  return finishPage(ctx);
}

function topicCard(ctx: PdfContext, topic: PdfTopic, top: number, height: number): void {
  fillRect(ctx, MARGIN, top - height, PAGE_WIDTH - MARGIN * 2, height, topic.status === "calculated" ? "0.94 0.98 0.96" : "0.99 0.96 0.95");
  strokeRect(ctx, MARGIN, top - height, PAGE_WIDTH - MARGIN * 2, height, topic.status === "calculated" ? "0.23 0.50 0.45" : "0.66 0.31 0.24", 0.8);
  rtl(ctx, TOPIC_HEBREW[topic.topic], PAGE_WIDTH - MARGIN - 14, top - 26, 14, "right", "0.08 0.19 0.24");
  rtl(ctx, STATUS_HEBREW[topic.status], PAGE_WIDTH - MARGIN - 14, top - 48, 9, "right", "0.25 0.34 0.38");
  rtl(ctx, "סכום", PAGE_WIDTH - MARGIN - 14, top - 74, 8.5, "right");
  ltr(ctx, formatAmount(topic), PAGE_WIDTH - MARGIN - 150, top - 74, 8.5, "right");
  rtl(ctx, "חסמים", PAGE_WIDTH - MARGIN - 14, top - 98, 8.5, "right");
  const blockers = topic.blockers.length === 0 ? "ללא חסם בקלט הסינתטי" : `${topic.blockers.length} חסמים מפורשים`;
  rtl(ctx, blockers, PAGE_WIDTH - MARGIN - 150, top - 98, 8.2, "right");
  rtl(ctx, "אסמכתאות", PAGE_WIDTH - MARGIN - 14, top - 122, 8.5, "right");
  const source = topic.legal_basis.source_version_ids[0] ?? "NO_ACTIVE_SOURCE";
  ltr(ctx, source, MARGIN + 14, top - 122, 7.2, "left", "0.18 0.31 0.35");
  if (height >= 190) {
    rtl(ctx, "עקיבות חישוב", PAGE_WIDTH - MARGIN - 14, top - 148, 8.5, "right");
    ltr(ctx, topic.calculation_trace?.formula_id ?? "NO_CALCULATION", MARGIN + 14, top - 148, 7.2, "left", "0.18 0.31 0.35");
    ltr(ctx, topic.rule_input_sha256 ?? "NO_RULE_INPUT", MARGIN + 14, top - 173, 6.2, "left", "0.25 0.34 0.38");
  }
}

function renderTracePage(
  report: CanonicalCaseReport,
  metrics: TtfMetrics,
  used: Map<number, number>,
  jsonSha256: string,
  htmlSha256: string,
): Uint8Array {
  const ctx = pageContext(metrics, used);
  pageChrome(ctx, report, 4);
  rtl(ctx, "עקיבות, סכום ביניים ואישור", PAGE_WIDTH - MARGIN, 760, 19, "right", "0.08 0.19 0.24");
  rtl(ctx, "הייצוגים נקשרים לאותו תיק ולאותו צילום עובדות באמצעות גיבובים מדויקים.", PAGE_WIDTH - MARGIN, 730, 9.5, "right", "0.25 0.34 0.38");

  rtl(ctx, "גיבובי רכיבים", PAGE_WIDTH - MARGIN, 690, 13, "right");
  hashRow(ctx, 666, "ניתוח", report.analysis_result_sha256);
  hashRow(ctx, 644, "עובדות", report.facts_snapshot_sha256);
  hashRow(ctx, 622, "קטלוג", report.catalog_sha256);
  hashRow(ctx, 600, "JSON", jsonSha256);
  hashRow(ctx, 578, "HTML", htmlSha256);

  rtl(ctx, "סכום ביניים", PAGE_WIDTH - MARGIN, 536, 13, "right");
  ltr(ctx, report.known_subtotal ? `${report.known_subtotal.currency} ${report.known_subtotal.minor_units}` : "NO_KNOWN_SUBTOTAL", MARGIN, 510, 11, "left", "0.08 0.19 0.24");
  rtl(ctx, "זהו סכום ביניים ידוע בלבד. נושא חסום או לא ידוע אינו שווה לאפס.", PAGE_WIDTH - MARGIN, 484, 9.5, "right", "0.66 0.31 0.24");

  rtl(ctx, "מגבלות והחלטת בודק", PAGE_WIDTH - MARGIN, 440, 13, "right");
  const limitations = [
    "נדרש אישור אנושי הקשור לגיבוב המדויק של הדוח.",
    "אין אפשרות להחליף סכום מנוע בהחלטה ידנית.",
    "אישור דוח אינו מחליף אישור של מקור, פרמטר או כלל.",
    "נתוני התיק, המזהים והמטבע בדוח זה סינתטיים בלבד.",
  ];
  limitations.forEach((item, index) => rtl(ctx, item, PAGE_WIDTH - MARGIN, 410 - index * 25, 9.2, "right"));

  rtl(ctx, "שדה קשירת אישור", PAGE_WIDTH - MARGIN, 292, 9, "right");
  ltr(ctx, report.review.approval_binding_field, MARGIN, 292, 8, "left");
  rtl(ctx, "מצב סקירה", PAGE_WIDTH - MARGIN, 266, 9, "right");
  ltr(ctx, report.review.status, MARGIN, 266, 8, "left");
  rtl(ctx, "גרסת גופן מקומי", PAGE_WIDTH - MARGIN, 240, 9, "right");
  ltr(ctx, `${HEBREW_REPORT_FONT.family} ${HEBREW_REPORT_FONT.version}`, MARGIN, 240, 8, "left");
  ltr(ctx, `FONT SHA-256: ${HEBREW_REPORT_FONT.sha256}`, MARGIN, 212, 6.8, "left", "0.25 0.34 0.38");
  rtl(ctx, "אין בדוח קוד פעיל, טופס, קובץ מצורף או משאב מרוחק.", PAGE_WIDTH - MARGIN, 168, 9.5, "right", "0.42 0.18 0.15");
  return finishPage(ctx);
}

function pageContext(metrics: TtfMetrics, used: Map<number, number>): PdfContext {
  return { metrics, used, commands: [] };
}

function pageChrome(ctx: PdfContext, report: CanonicalCaseReport, pageNumber: number): void {
  fillRect(ctx, 0, PAGE_HEIGHT - 28, PAGE_WIDTH, 28, "0.08 0.19 0.24");
  ltr(ctx, "TIVDOC", MARGIN, PAGE_HEIGHT - 19, 8, "left", "1 1 1");
  rtl(ctx, "דוח סינתטי קנוני", PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 19, 8, "right", "1 1 1");
  line(ctx, MARGIN, 58, PAGE_WIDTH - MARGIN, 58, "0.70 0.75 0.74", 0.5);
  rtl(ctx, `עמוד ${pageNumber} מתוך ${HEBREW_REPORT_PAGE_COUNT}`, PAGE_WIDTH - MARGIN, 38, 7.5, "right", "0.35 0.40 0.41");
  ltr(ctx, report.report_id, MARGIN, 38, 6.5, "left", "0.35 0.40 0.41");
  ctx.commands.push("q 0.86 0.27 0.21 rg 0.94 g");
  rtl(ctx, SYNTHETIC_REPORT_WATERMARK, PAGE_WIDTH / 2, 78, 12, "center", "0.70 0.20 0.16");
  ctx.commands.push("Q");
}

function metadataRow(ctx: PdfContext, y: number, label: string, value: string): void {
  rtl(ctx, label, PAGE_WIDTH - MARGIN, y, 9, "right", "0.25 0.34 0.38");
  ltr(ctx, value, MARGIN, y, 8.2, "left", "0.08 0.19 0.24");
  line(ctx, MARGIN, y - 9, PAGE_WIDTH - MARGIN, y - 9, "0.86 0.89 0.88", 0.4);
}

function hashRow(ctx: PdfContext, y: number, label: string, value: string): void {
  if (/^[\x20-\x7e]+$/u.test(label)) ltr(ctx, label, PAGE_WIDTH - MARGIN, y, 8.5, "right");
  else rtl(ctx, label, PAGE_WIDTH - MARGIN, y, 8.5, "right");
  ltr(ctx, value, MARGIN, y, 6.8, "left", "0.18 0.31 0.35");
}

function formatAmount(topic: PdfTopic): string {
  return topic.amount ? `${topic.amount.currency} ${topic.amount.minor_units}` : "NOT_CALCULATED";
}

function rtl(ctx: PdfContext, text: string, x: number, y: number, size: number, align: Align, color = "0.08 0.13 0.20"): void {
  textCommand(ctx, text, [...text].reverse().join(""), x, y, size, align, color);
}

function ltr(ctx: PdfContext, text: string, x: number, y: number, size: number, align: Align, color = "0.08 0.13 0.20"): void {
  textCommand(ctx, text, text, x, y, size, align, color);
}

function textCommand(
  ctx: PdfContext,
  logical: string,
  visual: string,
  x: number,
  y: number,
  size: number,
  align: Align,
  color: string,
): void {
  const run = encodeRun(ctx, visual);
  const start = align === "right" ? x - run.width * size / 1000 : align === "center" ? x - run.width * size / 2000 : x;
  const actualText = utf16Hex(logical);
  const glyphHex = run.glyphs.map((glyph) => glyph.toString(16).padStart(4, "0")).join("");
  ctx.commands.push(`${color} rg /Span << /ActualText <FEFF${actualText}> >> BDC BT /F1 ${number(size)} Tf 1 0 0 1 ${number(start)} ${number(y)} Tm <${glyphHex}> Tj ET EMC`);
}

function encodeRun(ctx: PdfContext, text: string): TextRun {
  const glyphs: number[] = [];
  let width = 0;
  for (const symbol of text) {
    const codePoint = symbol.codePointAt(0);
    if (codePoint === undefined) continue;
    const glyph = ctx.metrics.glyphForCodePoint(codePoint);
    if (glyph === 0 && codePoint !== 0) throw new Error(`HEBREW_REPORT_FONT_MISSING_GLYPH:${codePoint.toString(16)}`);
    glyphs.push(glyph);
    width += ctx.metrics.glyphWidth(glyph) * 1000 / ctx.metrics.unitsPerEm;
    if (!ctx.used.has(glyph)) ctx.used.set(glyph, codePoint);
  }
  return { logical: text, glyphs, width };
}

function line(ctx: PdfContext, x1: number, y1: number, x2: number, y2: number, color: string, width: number): void {
  ctx.commands.push(`${color} RG ${number(width)} w ${number(x1)} ${number(y1)} m ${number(x2)} ${number(y2)} l S`);
}

function fillRect(ctx: PdfContext, x: number, y: number, width: number, height: number, color: string): void {
  ctx.commands.push(`${color} rg ${number(x)} ${number(y)} ${number(width)} ${number(height)} re f`);
}

function strokeRect(ctx: PdfContext, x: number, y: number, width: number, height: number, color: string, lineWidth: number): void {
  ctx.commands.push(`${color} RG ${number(lineWidth)} w ${number(x)} ${number(y)} ${number(width)} ${number(height)} re S`);
}

function finishPage(ctx: PdfContext): Uint8Array {
  return Buffer.from(`${ctx.commands.join("\n")}\n`, "ascii");
}

function assemblePdf(
  report: CanonicalCaseReport,
  fontBytes: Uint8Array,
  metrics: TtfMetrics,
  used: Map<number, number>,
  pages: readonly Uint8Array[],
  jsonSha256: string,
  htmlSha256: string,
): Uint8Array {
  if (pages.length !== HEBREW_REPORT_PAGE_COUNT) throw new Error("HEBREW_REPORT_PAGE_COUNT_INVALID");
  return assemblePdfPages(fontBytes, metrics, used, pages, {
    title: `Tivdoc synthetic Hebrew report ${report.report_id}`,
    subject: `case=${report.case_id};analysis=${report.analysis_result_sha256};json=${jsonSha256};html=${htmlSha256}`,
    fixed_date: report.as_of.replaceAll("-", ""),
  });
}

/**
 * L4-8. The page assembler with nothing case-report-shaped left in it. The
 * font, the glyph subset, the ToUnicode map and the byte serialisation are the
 * ones the case report has always used; only the document metadata differs,
 * and it is an argument now. Nothing about the case-report path changes.
 */
function assemblePdfPages(
  fontBytes: Uint8Array,
  metrics: TtfMetrics,
  used: Map<number, number>,
  pages: readonly Uint8Array[],
  info: Readonly<{ title: string; subject: string; fixed_date: string }>,
): Uint8Array {
  const firstPageObject = 9;
  const firstContentObject = firstPageObject + pages.length;
  const objects = new Map<number, Uint8Array>();
  objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.set(2, ascii(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${firstPageObject + index} 0 R`).join(" ")}] >>`));
  objects.set(3, ascii("<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 7 0 R >>"));
  objects.set(4, ascii(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /CIDToGIDMap /Identity /DW 600 /W ${widthArray(metrics, used)} >>`));
  objects.set(5, ascii(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${metrics.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${metrics.ascent} /Descent ${metrics.descent} /CapHeight ${metrics.capHeight} /StemV 80 /FontFile2 6 0 R >>`));
  objects.set(6, stream({ Length1: fontBytes.byteLength }, fontBytes));
  objects.set(7, stream({}, Buffer.from(toUnicodeCmap(used), "ascii")));
  objects.set(8, ascii(`<< /Title ${pdfUtf16String(info.title)} /Author (Tivdoc deterministic report renderer) /Subject ${pdfLiteral(info.subject)} /Creator (${REPORT_CREATOR}) /Producer (${REPORT_CREATOR}) /CreationDate (D:${info.fixed_date}000000Z) /ModDate (D:${info.fixed_date}000000Z) >>`));
  pages.forEach((page, index) => {
    objects.set(firstPageObject + index, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /CropBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`));
    objects.set(firstContentObject + index, stream({}, page));
  });
  return serializePdf(objects, 1, 8);
}

const REPORT_CREATOR = "tivdoc-rtl-hebrew-report-template-v0.8.0";

// ---------------------------------------------------------------------------
// L4-8. A second entry point on the same machinery.
//
// The sensitivity report is not a case report: it has no case id, no period, no
// subtotal, and mapping it into `CanonicalCaseReport` to reach this renderer
// would have meant filling those fields with something. So the font, the glyph
// subsetting, the RTL text helper and the byte serialiser are shared, and the
// page layout is a small structured document that paginates itself.
//
// Direction is handled the way the case report already handles it rather than
// by guessing: a cell holding Hebrew is drawn right-to-left, a cell holding a
// number or a Latin identifier is drawn left-to-right, and nothing tries to
// reorder a mixed run. That is why the tables below keep their figures in their
// own columns.

export type RtlBlock =
  | Readonly<{ kind: "heading"; text: string; level: 1 | 2 }>
  | Readonly<{ kind: "paragraph"; text: string }>
  | Readonly<{ kind: "rule" }>
  | Readonly<{ kind: "table"; columns: readonly string[]; rows: readonly (readonly string[])[] }>
  | Readonly<{ kind: "hash"; label: string; value: string }>;

export type RtlDocument = Readonly<{
  title: string;
  subject: string;
  /** `YYYYMMDD`. Fixed, so the same content is the same bytes on every run. */
  fixed_date: string;
  blocks: readonly RtlBlock[];
}>;

const HEBREW_CHARACTER = /[֐-׿]/u;
const LINE_HEIGHT = 13;
const BOTTOM = MARGIN + 24;

/** How much vertical room a wrapped paragraph needs at this width. */
function wrap(text: string, perLine: number): readonly string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > perLine && current) { lines.push(current); current = word; } else current = candidate;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/**
 * Split a line into maximal Hebrew and non-Hebrew runs, in logical order, with
 * each run keeping the spaces that follow it.
 */
function directionalRuns(text: string): readonly Readonly<{ text: string; hebrew: boolean }>[] {
  const runs: Array<{ text: string; hebrew: boolean }> = [];
  for (const symbol of text) {
    const hebrew = HEBREW_CHARACTER.test(symbol);
    const last = runs[runs.length - 1];
    // Whitespace and shared punctuation join whichever run they follow, so a
    // space never becomes a run of its own and never flips direction.
    if (last && (/[\s.,:;()[\]"'’“”/-]/u.test(symbol) || last.hebrew === hebrew)) last.text += symbol;
    else runs.push({ text: symbol, hebrew });
  }
  return runs;
}

/**
 * One line, laid out right to left, each run drawn in its own direction.
 *
 * The naive version of this reversed the whole string whenever it contained a
 * single Hebrew character, which rendered the English half of a mixed line
 * backwards — and the three `topics_not_run` details are English sentences
 * behind Hebrew labels, so that was not hypothetical. This is a single-level
 * bidi: runs are placed from the right in logical order, Hebrew runs reversed
 * inside themselves and Latin runs not. It is not the full algorithm and does
 * not claim to be; it is correct for one line with no nesting, which is what
 * this document has.
 */
function drawCell(ctx: PdfContext, text: string, x: number, y: number, size: number, color?: string): void {
  const runs = directionalRuns(text);
  if (runs.length <= 1) {
    if (runs[0]?.hebrew ?? false) rtl(ctx, text, x, y, size, "right", color);
    else ltr(ctx, text, x - measure(ctx, text, size), y, size, "left", color);
    return;
  }
  let right = x;
  for (const run of runs) {
    const width = measure(ctx, run.text, size);
    if (run.hebrew) rtl(ctx, run.text, right, y, size, "right", color);
    else ltr(ctx, run.text, right - width, y, size, "left", color);
    right -= width;
  }
}

function measure(ctx: PdfContext, text: string, size: number): number {
  return encodeRun(ctx, text).width * size / 1000;
}

export function renderDeterministicRtlDocument(document: RtlDocument): Uint8Array {
  const fontBytes = readPinnedFont();
  const metrics = parseTrueType(fontBytes);
  const used = new Map<number, number>();
  const pages: Uint8Array[] = [];
  let ctx: PdfContext = { metrics, used, commands: [] };
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = () => {
    pages.push(finishPage(ctx));
    ctx = { metrics, used, commands: [] };
    y = PAGE_HEIGHT - MARGIN;
  };
  const room = (height: number) => { if (y - height < BOTTOM) newPage(); };

  for (const block of document.blocks) {
    if (block.kind === "rule") {
      room(10);
      line(ctx, MARGIN, y - 4, PAGE_WIDTH - MARGIN, y - 4, "0.86 0.89 0.88", 0.4);
      y -= 14;
      continue;
    }
    if (block.kind === "heading") {
      const size = block.level === 1 ? 15 : 11.5;
      room(size + 12);
      drawCell(ctx, block.text, PAGE_WIDTH - MARGIN, y - size, size, "0.05 0.12 0.20");
      y -= size + 10;
      continue;
    }
    if (block.kind === "paragraph") {
      for (const lineText of wrap(block.text, 92)) {
        room(LINE_HEIGHT);
        drawCell(ctx, lineText, PAGE_WIDTH - MARGIN, y - 9, 9, "0.12 0.18 0.24");
        y -= LINE_HEIGHT;
      }
      y -= 4;
      continue;
    }
    if (block.kind === "hash") {
      room(LINE_HEIGHT);
      hashRow(ctx, y - 9, block.label, block.value);
      y -= LINE_HEIGHT;
      continue;
    }
    // A table. Columns run right to left, because the reader does.
    // A table with no rows is a labelled empty box, which tells a reader
    // nothing and looks like something went missing. Nothing is drawn.
    if (block.rows.length === 0) continue;
    const width = (PAGE_WIDTH - MARGIN * 2) / block.columns.length;
    const header = () => {
      fillRect(ctx, MARGIN, y - 15, PAGE_WIDTH - MARGIN * 2, 15, "0.93 0.95 0.96");
      block.columns.forEach((column, index) => {
        drawCell(ctx, column, PAGE_WIDTH - MARGIN - index * width - 4, y - 11, 8.4, "0.06 0.14 0.22");
      });
      y -= 17;
    };
    room(34);
    header();
    for (const row of block.rows) {
      if (y - 13 < BOTTOM) { newPage(); header(); }
      row.forEach((cell, index) => {
        drawCell(ctx, cell, PAGE_WIDTH - MARGIN - index * width - 4, y - 9, 8.2, "0.12 0.18 0.24");
      });
      line(ctx, MARGIN, y - 12, PAGE_WIDTH - MARGIN, y - 12, "0.90 0.92 0.93", 0.3);
      y -= 13;
    }
    y -= 8;
  }
  pages.push(finishPage(ctx));
  return assemblePdfPages(fontBytes, metrics, used, pages, {
    title: document.title, subject: document.subject, fixed_date: document.fixed_date,
  });
}

function widthArray(metrics: TtfMetrics, used: Map<number, number>): string {
  return `[${[...used.keys()].sort((a, b) => a - b).map((glyph) => `${glyph} [${Math.round(metrics.glyphWidth(glyph) * 1000 / metrics.unitsPerEm)}]`).join(" ")}]`;
}

function toUnicodeCmap(used: Map<number, number>): string {
  const entries = [...used.entries()].sort(([left], [right]) => left - right);
  const chunks: string[] = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    chunks.push(`${chunk.length} beginbfchar\n${chunk.map(([glyph, codePoint]) => `<${glyph.toString(16).padStart(4, "0")}> <${codePointToUtf16Hex(codePoint)}>`).join("\n")}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /TivdocHebrewUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

function serializePdf(objects: Map<number, Uint8Array>, rootObject: number, infoObject: number): Uint8Array {
  const maxObject = Math.max(...objects.keys());
  const parts: Uint8Array[] = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let offset = parts[0].byteLength;
  for (let objectNumber = 1; objectNumber <= maxObject; objectNumber += 1) {
    const body = objects.get(objectNumber);
    if (!body) throw new Error(`HEBREW_REPORT_PDF_OBJECT_MISSING:${objectNumber}`);
    offsets[objectNumber] = offset;
    const prefix = ascii(`${objectNumber} 0 obj\n`);
    const suffix = ascii("\nendobj\n");
    parts.push(prefix, body, suffix);
    offset += prefix.byteLength + body.byteLength + suffix.byteLength;
  }
  const xrefOffset = offset;
  const xref = [`xref\n0 ${maxObject + 1}\n`, "0000000000 65535 f \n"];
  for (let objectNumber = 1; objectNumber <= maxObject; objectNumber += 1) xref.push(`${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`);
  xref.push(`trailer\n<< /Size ${maxObject + 1} /Root ${rootObject} 0 R /Info ${infoObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  parts.push(ascii(xref.join("")));
  return Buffer.concat(parts);
}

function stream(extra: Readonly<Record<string, string | number>>, bytes: Uint8Array): Uint8Array {
  const dictionary = Object.entries({ Length: bytes.byteLength, ...extra }).map(([key, value]) => `/${key} ${value}`).join(" ");
  return Buffer.concat([ascii(`<< ${dictionary} >>\nstream\n`), bytes, ascii("\nendstream")]);
}

function ascii(value: string): Uint8Array {
  return Buffer.from(value, "ascii");
}

function pdfLiteral(value: string): string {
  return `(${value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;
}

function pdfUtf16String(value: string): string {
  return `<FEFF${utf16Hex(value)}>`;
}

function utf16Hex(value: string): string {
  return [...value].map((symbol) => codePointToUtf16Hex(symbol.codePointAt(0) ?? 0)).join("");
}

function codePointToUtf16Hex(codePoint: number): string {
  if (codePoint <= 0xffff) return codePoint.toString(16).padStart(4, "0").toUpperCase();
  const adjusted = codePoint - 0x10000;
  const high = 0xd800 + (adjusted >> 10);
  const low = 0xdc00 + (adjusted & 0x3ff);
  return `${high.toString(16).padStart(4, "0")}${low.toString(16).padStart(4, "0")}`.toUpperCase();
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function parseTrueType(bytes: Uint8Array): TtfMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, Readonly<{ offset: number; length: number }>>();
  const tableCount = view.getUint16(4, false);
  for (let index = 0; index < tableCount; index += 1) {
    const entry = 12 + index * 16;
    const tag = String.fromCharCode(view.getUint8(entry), view.getUint8(entry + 1), view.getUint8(entry + 2), view.getUint8(entry + 3));
    tables.set(tag, { offset: view.getUint32(entry + 8, false), length: view.getUint32(entry + 12, false) });
  }
  const table = (tag: string) => {
    const found = tables.get(tag);
    if (!found) throw new Error(`HEBREW_REPORT_FONT_TABLE_MISSING:${tag}`);
    return found.offset;
  };
  const head = table("head");
  const hhea = table("hhea");
  const maxp = table("maxp");
  const hmtx = table("hmtx");
  const unitsPerEm = view.getUint16(head + 18, false);
  const bbox = [view.getInt16(head + 36, false), view.getInt16(head + 38, false), view.getInt16(head + 40, false), view.getInt16(head + 42, false)] as const;
  const ascent = view.getInt16(hhea + 4, false);
  const descent = view.getInt16(hhea + 6, false);
  const numberOfHMetrics = view.getUint16(hhea + 34, false);
  const numGlyphs = view.getUint16(maxp + 4, false);
  const cmap = parseCmap(view, table("cmap"));
  const glyphWidth = (glyph: number) => {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= numGlyphs) return view.getUint16(hmtx, false);
    const metricIndex = Math.min(glyph, numberOfHMetrics - 1);
    return view.getUint16(hmtx + metricIndex * 4, false);
  };
  return { unitsPerEm, ascent, descent, capHeight: Math.round(ascent * 0.72), bbox, glyphForCodePoint: cmap, glyphWidth };
}

function parseCmap(view: DataView, cmapOffset: number): (codePoint: number) => number {
  const count = view.getUint16(cmapOffset + 2, false);
  const candidates: Array<Readonly<{ score: number; offset: number; format: number }>> = [];
  for (let index = 0; index < count; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    const platform = view.getUint16(record, false);
    const encoding = view.getUint16(record + 2, false);
    const offset = cmapOffset + view.getUint32(record + 4, false);
    const format = view.getUint16(offset, false);
    const score = format === 12 ? 100 : format === 4 ? 50 : 0;
    if (score > 0 && (platform === 0 || platform === 3)) candidates.push({ score: score + (platform === 3 && encoding === 10 ? 10 : 0), offset, format });
  }
  const selected = candidates.sort((left, right) => right.score - left.score)[0];
  if (!selected) throw new Error("HEBREW_REPORT_FONT_CMAP_UNSUPPORTED");
  return selected.format === 12 ? parseCmap12(view, selected.offset) : parseCmap4(view, selected.offset);
}

function parseCmap12(view: DataView, offset: number): (codePoint: number) => number {
  const groups: Array<readonly [number, number, number]> = [];
  const count = view.getUint32(offset + 12, false);
  for (let index = 0; index < count; index += 1) {
    const group = offset + 16 + index * 12;
    groups.push([view.getUint32(group, false), view.getUint32(group + 4, false), view.getUint32(group + 8, false)]);
  }
  return (codePoint) => {
    let low = 0;
    let high = groups.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end, startGlyph] = groups[middle];
      if (codePoint < start) high = middle - 1;
      else if (codePoint > end) low = middle + 1;
      else return startGlyph + codePoint - start;
    }
    return 0;
  };
}

function parseCmap4(view: DataView, offset: number): (codePoint: number) => number {
  const segCount = view.getUint16(offset + 6, false) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let index = 0; index < segCount; index += 1) {
      const end = view.getUint16(endCodes + index * 2, false);
      if (codePoint > end) continue;
      const start = view.getUint16(startCodes + index * 2, false);
      if (codePoint < start) return 0;
      const delta = view.getInt16(idDeltas + index * 2, false);
      const range = view.getUint16(idRangeOffsets + index * 2, false);
      if (range === 0) return (codePoint + delta) & 0xffff;
      const glyphAddress = idRangeOffsets + index * 2 + range + (codePoint - start) * 2;
      const glyph = view.getUint16(glyphAddress, false);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}
