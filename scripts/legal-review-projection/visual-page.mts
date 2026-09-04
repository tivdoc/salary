// L6-2 / D1. Two operations on a stored PDF artifact, both from its bytes and
// nothing else:
//
// - extractPagePdf: one page as a standalone PDF, saved deterministically
//   (fixed dates, fixed producer, no object streams) so its hash is a fact
//   about the page and not about the clock. This is what the review package
//   carries beside a visual citation.
// - renderScanPagePng: the page's scan image, decoded from the artifact's own
//   CCITT stream by wrapping it in a TIFF container and handing it to libvips.
//   No rasteriser is installed on this machine, and none is needed to read a
//   scan: the scan IS the image. This is what the session reads a figure from.
//
// Neither operation reads the text layer, and neither changes the artifact.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync as readFileSyncFs, rmSync, writeFileSync as writeFileSyncFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, PDFNumber, PDFBool } = require("pdf-lib");
const sharp = require("sharp");

export const VISUAL_PAGE_TOOL_VERSION = "tivdoc-visual-page-v1" as const;

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The toolchain a render was made with — what a reviewer needs to reproduce the image hash. */
export function renderToolVersion(): string {
  const versions = sharp.versions as Record<string, string>;
  return `${VISUAL_PAGE_TOOL_VERSION}/sharp@${versions.sharp ?? "unknown"}/vips@${versions.vips ?? "unknown"}`;
}

export async function extractPagePdf(artifactBytes: Uint8Array, pageNumber: number): Promise<Uint8Array> {
  const source = await PDFDocument.load(artifactBytes, { ignoreEncryption: true, updateMetadata: false });
  if (pageNumber < 1 || pageNumber > source.getPageCount()) throw new Error(`VISUAL_PAGE_OUT_OF_RANGE:${pageNumber}/${source.getPageCount()}`);
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(source, [pageNumber - 1]);
  out.addPage(page);
  out.setCreationDate(new Date(0));
  out.setModificationDate(new Date(0));
  out.setProducer(VISUAL_PAGE_TOOL_VERSION);
  out.setCreator(VISUAL_PAGE_TOOL_VERSION);
  out.setTitle("");
  out.setAuthor("");
  out.setSubject("");
  out.setKeywords([]);
  return out.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** The page's media box in PDF user space — what a box region is expressed against. */
export async function pageMediaBox(artifactBytes: Uint8Array, pageNumber: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const source = await PDFDocument.load(artifactBytes, { ignoreEncryption: true, updateMetadata: false });
  const box = source.getPage(pageNumber - 1).getMediaBox();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

type CcittImage = Readonly<{ width: number; height: number; k: number; blackIs1: boolean; byteAlign: boolean; data: Uint8Array }>;

/** The first CCITT image XObject on the page — a scanned page has exactly one. */
async function pageCcittImage(artifactBytes: Uint8Array, pageNumber: number): Promise<CcittImage> {
  const source = await PDFDocument.load(artifactBytes, { ignoreEncryption: true, updateMetadata: false });
  const page = source.getPage(pageNumber - 1);
  const resources = page.node.Resources();
  // A typeset page may have no XObjects at all; that is "no scan stream",
  // not an error, and the caller falls back to the OS rasteriser.
  const xobjectsEntry = resources?.get(PDFName.of("XObject"));
  const xobjects = xobjectsEntry === undefined ? undefined : source.context.lookup(xobjectsEntry);
  if (!(xobjects instanceof PDFDict)) throw new Error("VISUAL_PAGE_NO_CCITT_IMAGE");
  for (const [, ref] of xobjects.entries()) {
    const stream = source.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const dict = stream.dict;
    if (dict.lookup(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    const filterEntry = dict.lookup(PDFName.of("Filter"));
    const filters = filterEntry instanceof PDFArray ? filterEntry.asArray().map((entry: { toString(): string }) => entry.toString()) : [filterEntry?.toString()];
    if (!filters.includes("/CCITTFaxDecode")) continue;
    const parmsEntry = dict.lookup(PDFName.of("DecodeParms"));
    const parms = parmsEntry instanceof PDFArray ? parmsEntry.asArray().map((entry: unknown) => source.context.lookup(entry)).find((entry: unknown) => entry instanceof PDFDict) : parmsEntry;
    const num = (holder: typeof PDFDict | undefined, key: string, fallback: number) => {
      const value = holder?.lookup(PDFName.of(key));
      return value instanceof PDFNumber ? value.asNumber() : fallback;
    };
    const bool = (holder: typeof PDFDict | undefined, key: string, fallback: boolean) => {
      const value = holder?.lookup(PDFName.of(key));
      return value instanceof PDFBool ? value.asBoolean() : fallback;
    };
    let data: Uint8Array = stream.contents;
    if (filters[0] === "/FlateDecode") data = new Uint8Array(inflateSync(Buffer.from(data)));
    return Object.freeze({
      width: num(parms, "Columns", num(dict, "Width", 1728)),
      height: num(parms, "Rows", num(dict, "Height", 0)),
      k: num(parms, "K", 0),
      blackIs1: bool(parms, "BlackIs1", false),
      byteAlign: bool(parms, "EncodedByteAlign", false),
      data,
    });
  }
  throw new Error("VISUAL_PAGE_NO_CCITT_IMAGE");
}

/** A minimal little-endian TIFF around a CCITT stream — what libtiff needs to decode it. */
function ccittToTiff(image: CcittImage): Buffer {
  const entries: Array<[number, number, number, number]> = [];
  const compression = image.k < 0 ? 4 : 3;
  // The CCITT codec itself produces "black" and "white" runs; PDF's BlackIs1
  // says how those are written to bits, and libtiff's fax reader emits them
  // under WhiteIsZero (0) by default. A scan with BlackIs1=false therefore
  // renders right side up as WhiteIsZero and inverted as BlackIsZero — checked
  // by eye on the 1951 page, which is the whole point of this tool.
  const photometric = image.blackIs1 ? 1 : 0;
  const t4Options = (image.k > 0 ? 1 : 0) | (image.byteAlign ? 4 : 0);
  const headerBytes = 8;
  const dataOffset = headerBytes;
  const ifdOffset = dataOffset + image.data.length + (image.data.length % 2);
  entries.push([256, 4, 1, image.width]);
  entries.push([257, 4, 1, image.height]);
  entries.push([258, 3, 1, 1]);
  entries.push([259, 3, 1, compression]);
  entries.push([262, 3, 1, photometric]);
  entries.push([266, 3, 1, 1]);
  entries.push([273, 4, 1, dataOffset]);
  entries.push([277, 3, 1, 1]);
  entries.push([278, 4, 1, image.height]);
  entries.push([279, 4, 1, image.data.length]);
  if (compression === 3) entries.push([292, 4, 1, t4Options]);
  if (compression === 4) entries.push([293, 4, 1, 0]);
  entries.sort((left, right) => left[0] - right[0]);
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
  ifd.writeUInt16LE(entries.length, 0);
  entries.forEach(([tag, type, count, value], index) => {
    const at = 2 + index * 12;
    ifd.writeUInt16LE(tag, at);
    ifd.writeUInt16LE(type, at + 2);
    ifd.writeUInt32LE(count, at + 4);
    if (type === 3) { ifd.writeUInt16LE(value, at + 8); ifd.writeUInt16LE(0, at + 10); } else ifd.writeUInt32LE(value, at + 8);
  });
  ifd.writeUInt32LE(0, 2 + entries.length * 12);
  const header = Buffer.alloc(headerBytes);
  header.write("II", 0, "latin1");
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifdOffset, 4);
  const padding = Buffer.alloc(image.data.length % 2);
  return Buffer.concat([header, Buffer.from(image.data), padding, ifd]);
}

/**
 * A typeset page (no scan stream) rendered by the operating system's own PDF
 * rasteriser — Windows.Data.Pdf through PowerShell; nothing installed. The
 * extracted single page is what is rendered, so the render is of the very
 * bytes the package ships.
 */
export function renderTypesetPagePng(pagePdf: Uint8Array, scale = 3): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tivdoc-visual-"));
  try {
    const pdfPath = path.join(dir, "page.pdf");
    const pngPath = path.join(dir, "page.png");
    writeFileSyncFs(pdfPath, pagePdf);
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "render-page-winrt.ps1");
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, pdfPath, pngPath, String(scale)], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`VISUAL_PAGE_WINRT_RENDER_FAILED:${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    return readFileSyncFs(pngPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the session read a figure from. A scanned page renders from its own
 * CCITT stream through libvips; a typeset page renders through the operating
 * system's rasteriser. The image hash and the tool version say which.
 */
export async function renderPageForReading(artifactBytes: Uint8Array, pageNumber: number, pagePdf: Uint8Array): Promise<{ image_sha256: string; render_tool_version: string; png: Buffer; width: number; height: number }> {
  try {
    const rendered = await renderScanPagePng(artifactBytes, pageNumber);
    return { image_sha256: sha256(rendered.png), render_tool_version: renderToolVersion(), png: rendered.png, width: rendered.width, height: rendered.height };
  } catch (error) {
    if (!(error instanceof Error && error.message === "VISUAL_PAGE_NO_CCITT_IMAGE")) throw error;
    const png = renderTypesetPagePng(pagePdf);
    const box = await pageMediaBox(artifactBytes, pageNumber);
    return { image_sha256: sha256(png), render_tool_version: `${VISUAL_PAGE_TOOL_VERSION}/windows-data-pdf@${os.release()}/scale3`, png, width: Math.round(box.width * 3), height: Math.round(box.height * 3) };
  }
}

export async function renderScanPagePng(artifactBytes: Uint8Array, pageNumber: number): Promise<{ png: Buffer; width: number; height: number; k: number }> {
  const image = await pageCcittImage(artifactBytes, pageNumber);
  const tiff = ccittToTiff(image);
  const png = await sharp(tiff).png().toBuffer();
  return { png, width: image.width, height: image.height, k: image.k };
}

export async function cropPng(png: Buffer, region: { left: number; top: number; width: number; height: number }, scale = 1): Promise<Buffer> {
  let pipeline = sharp(png).extract(region);
  if (scale !== 1) pipeline = pipeline.resize(Math.round(region.width * scale), Math.round(region.height * scale), { kernel: "lanczos3" });
  return pipeline.png().toBuffer();
}

if (process.argv[1] && /visual-page\.mts$/u.test(process.argv[1])) {
  const [artifact, pageText, outBase] = process.argv.slice(2);
  if (!artifact || !pageText || !outBase) throw new Error("usage: visual-page.mts <artifact.pdf> <page> <out-base>");
  const bytes = readFileSync(artifact);
  const page = Number.parseInt(pageText, 10);
  const pdf = await extractPagePdf(bytes, page);
  writeFileSync(`${outBase}.pdf`, pdf);
  const rendered = await renderScanPagePng(bytes, page);
  writeFileSync(`${outBase}.png`, rendered.png);
  console.log(JSON.stringify({ page, page_pdf_sha256: sha256(pdf), page_pdf_bytes: pdf.length, png_bytes: rendered.png.length, width: rendered.width, height: rendered.height, k: rendered.k }));
}
