import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import type { ExtractionRequest } from "@/engine/extraction/contracts";
import type { ImmutableDocument } from "@/engine/domain/documents";
import type { PrivateDocumentSource } from "@/engine/extraction/provider";
import { renderedPayslipFixtureSpecs, type RenderedPayslipFixtureSpec } from "./fixtures";

const caseId = "77777777-7777-4777-8777-777777777777";
const runId = "88888888-8888-4888-8888-888888888888";
const timestamp = "2026-08-29T08:00:00.000Z";
const width = 1240;
const height = 1754;

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fixtureSvg(fixture: RenderedPayslipFixtureSpec) {
  const rowHeight = fixture.dense ? 66 : 82;
  const fontSize = fixture.dense ? 22 : 26;
  const startY = 640;
  const rows = fixture.rows.map((row, index) => {
    const y = startY + index * rowHeight;
    const fill = index % 2 === 0 ? "#f7f8fa" : "#ffffff";
    const optional = [row.quantity ? `Qty ${escapeXml(row.quantity)}` : "", row.rate ? `Rate ${escapeXml(row.rate)}` : ""]
      .filter(Boolean)
      .join("  |  ");
    return `
      <rect x="90" y="${y - 42}" width="1060" height="${rowHeight}" fill="${fill}" stroke="#d6dbe3" />
      <text x="430" y="${y}" text-anchor="start" direction="ltr" unicode-bidi="plaintext" font-size="${Math.min(fontSize, 23)}" fill="#1f2937">${escapeXml(row.label)}</text>
      <text x="120" y="${y}" text-anchor="start" font-size="${fontSize}" font-weight="700" fill="#111827">${escapeXml(row.value)}</text>
      ${optional ? `<text x="120" y="${y + 27}" text-anchor="start" font-size="16" fill="#475569">${optional}</text>` : ""}
    `;
  }).join("");
  const complete = fixture.earnings_components_complete ? "All earnings components shown" : "Some earning rows may be absent";
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#ece8df" />
      <rect x="55" y="45" width="1130" height="1664" rx="12" fill="#ffffff" stroke="#9aa3b1" stroke-width="3" />
      <rect x="55" y="45" width="1130" height="105" rx="12" fill="#7f1d1d" />
      <text x="620" y="94" text-anchor="middle" font-family="Arial, sans-serif" font-size="27" font-weight="700" fill="#ffffff">SYNTHETIC TEST DOCUMENT - NOT A REAL PAYSLIP</text>
      <text x="620" y="130" text-anchor="middle" direction="rtl" font-family="Arial, sans-serif" font-size="22" fill="#fee2e2">מסמך בדיקה סינתטי - אינו תלוש שכר אמיתי</text>
      <text x="90" y="220" text-anchor="start" direction="ltr" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#111827">${escapeXml(fixture.title)}</text>
      <text x="90" y="272" text-anchor="start" direction="ltr" font-family="Arial, sans-serif" font-size="23" fill="#334155">Employer / מעסיק: ${escapeXml(fixture.employer_name)}</text>
      <text x="90" y="312" text-anchor="start" direction="ltr" font-family="Arial, sans-serif" font-size="23" fill="#334155">Employee / עובד: ${escapeXml(fixture.employee_name)}</text>
      <text x="90" y="352" text-anchor="start" direction="ltr" font-family="Arial, sans-serif" font-size="23" fill="#334155">Synthetic ID / מזהה: ${escapeXml(fixture.employee_id)}</text>
      <rect x="90" y="395" width="1060" height="145" rx="8" fill="#eef2ff" stroke="#c7d2fe" />
      <text x="120" y="445" text-anchor="start" direction="ltr" font-family="Arial, sans-serif" font-size="27" fill="#1e293b">Salary period / תקופת שכר: ${escapeXml(fixture.salary_period)}</text>
      <text x="120" y="492" text-anchor="start" direction="ltr" font-family="Arial, sans-serif" font-size="27" fill="#1e293b">Salary type / סוג שכר: ${escapeXml(fixture.salary_type)}</text>
      <text x="90" y="572" text-anchor="start" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#64748b">VISIBLE PAYSLIP ROWS</text>
      <g font-family="Arial, sans-serif">${rows}</g>
      <line x1="90" y1="1555" x2="1150" y2="1555" stroke="#cbd5e1" stroke-width="2" />
      <text x="1100" y="1605" text-anchor="end" font-family="Arial, sans-serif" font-size="20" fill="#475569">${complete}</text>
      <text x="1100" y="1645" text-anchor="end" font-family="Arial, sans-serif" font-size="18" fill="#64748b">Fixture: ${escapeXml(fixture.fixture_id)}</text>
    </svg>
  `;
}

async function renderRaster(fixture: RenderedPayslipFixtureSpec) {
  const cleanPng = await sharp(Buffer.from(fixtureSvg(fixture))).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  let image = sharp(cleanPng);
  if (fixture.quality === "low_resolution") image = image.resize({ width: 430 });
  if (fixture.quality === "rotated") image = image.rotate(2, { background: "#d8d2c7" });
  if (fixture.quality === "blurred") image = image.grayscale().blur(1.5).linear(0.82, 18);
  if (fixture.quality === "ambiguous") image = image.grayscale().linear(0.9, 10);
  if (fixture.format === "jpg") {
    return image.jpeg({ quality: fixture.quality === "blurred" ? 42 : 88, chromaSubsampling: "4:2:0" }).toBuffer();
  }
  return image.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function renderPdf(fixture: RenderedPayslipFixtureSpec) {
  const pageImage = await renderRaster({ ...fixture, format: "png" });
  const pdf = await PDFDocument.create();
  const fixedDate = new Date("2026-08-29T00:00:00.000Z");
  pdf.setTitle(`Tivdoc synthetic fixture ${fixture.fixture_id}`);
  pdf.setAuthor("Tivdoc synthetic benchmark");
  pdf.setCreator("Tivdoc deterministic renderer v1");
  pdf.setProducer("Tivdoc deterministic renderer v1");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const page = pdf.addPage([595.28, 841.89]);
  const embedded = await pdf.embedPng(pageImage);
  page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
}

export type RenderedPayslipArtifact = Readonly<{
  fixture_id: string;
  quality: RenderedPayslipFixtureSpec["quality"];
  format: RenderedPayslipFixtureSpec["format"];
  file_path: string;
  sha256: string;
  request: ExtractionRequest;
}>;

export async function renderSyntheticPayslipCorpus(outputDirectory: string): Promise<readonly RenderedPayslipArtifact[]> {
  await mkdir(outputDirectory, { recursive: true });
  const artifacts: RenderedPayslipArtifact[] = [];
  for (const [index, fixture] of renderedPayslipFixtureSpecs.entries()) {
    const bytes = fixture.format === "pdf" ? await renderPdf(fixture) : await renderRaster(fixture);
    const filename = `${fixture.fixture_id}.${fixture.format}`;
    const filePath = path.join(outputDirectory, filename);
    await writeFile(filePath, bytes);
    const documentId = uuid(30_000 + index);
    const extension = fixture.format === "jpg" ? "jpg" : fixture.format;
    const mimeType = fixture.format === "pdf" ? "application/pdf" : fixture.format === "jpg" ? "image/jpeg" : "image/png";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const document: ImmutableDocument = {
      document_id: documentId,
      case_id: caseId,
      document_type: "payslip",
      original_filename: filename,
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
      content_sha256: sha256,
      storage_path: `cases/${caseId}/documents/${documentId}/original.${extension}`,
      document_period: null,
      supersedes_document_id: null,
      created_at: timestamp,
    };
    artifacts.push({
      fixture_id: fixture.fixture_id,
      quality: fixture.quality,
      format: fixture.format,
      file_path: filePath,
      sha256,
      request: {
        case_id: caseId,
        analysis_run_id: runId,
        extraction_id: uuid(40_000 + index),
        document,
        declared_document_type: "payslip",
        requested_at: timestamp,
      },
    });
  }
  const manifest = artifacts.map(({ fixture_id, quality, format, file_path, sha256, request }) => ({
    fixture_id,
    quality,
    format,
    filename: path.basename(file_path),
    mime_type: request.document.mime_type,
    sha256,
    renderer_version: "1.0",
  }));
  await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return artifacts;
}

export class RenderedPayslipDocumentSource implements PrivateDocumentSource {
  private readonly pathByDocumentId: ReadonlyMap<string, string>;

  constructor(artifacts: readonly RenderedPayslipArtifact[]) {
    this.pathByDocumentId = new Map(artifacts.map((artifact) => [artifact.request.document.document_id, artifact.file_path]));
  }

  async read(document: ImmutableDocument) {
    const filePath = this.pathByDocumentId.get(document.document_id);
    if (!filePath) throw new TypeError("Synthetic benchmark document is outside the approved corpus");
    const bytes = await readFile(filePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== document.content_sha256) throw new TypeError("Synthetic benchmark document checksum mismatch");
    return new Uint8Array(bytes);
  }
}
