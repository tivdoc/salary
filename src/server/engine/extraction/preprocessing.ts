import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ExtractionRegion } from "@/engine/extraction/v2";

export const PAYSLIP_PREPROCESSING_VERSION = "payslip-raster-preprocess-1";
export const PAYSLIP_CROP_PLAN_VERSION = "payslip-semantic-bands-1";

export type PreparedImage = Readonly<{
  bytes: Uint8Array;
  mime_type: "image/png";
  width: number;
  height: number;
  sha256: string;
}>;

export type PreparedPayslipDocument = Readonly<{
  original: Readonly<{ bytes: Uint8Array; mime_type: string; sha256: string }>;
  processed_full_page: PreparedImage | null;
  crops: readonly Readonly<{ region: ExtractionRegion; image: PreparedImage }>[];
  metadata: Readonly<{
    preprocessing_version: string;
    crop_plan_version: string;
    applied: boolean;
    source_width: number | null;
    source_height: number | null;
    upscale_factor: 1 | 2 | 3;
    deskew_degrees: number;
    grayscale: boolean;
    contrast_gain: number;
    sharpen_sigma: number;
    reason: "low_resolution_raster" | "not_needed" | "unsupported_source";
  }>;
}>;

type CropBand = Readonly<{ region: ExtractionRegion; top: number; bottom: number }>;

// These are broad, overlapping document bands rather than template coordinates.
// They preserve context across layouts while keeping the number of visual inputs bounded.
export const payslipCropBands: readonly CropBand[] = [
  { region: "header", top: 0, bottom: 0.3 },
  { region: "earnings", top: 0.18, bottom: 0.68 },
  { region: "totals", top: 0.42, bottom: 0.82 },
  { region: "pension", top: 0.58, bottom: 1 },
];

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function upscaleFactor(width: number): 1 | 2 | 3 {
  if (width <= 700) return 3;
  if (width < 1_200) return 2;
  return 1;
}

function projectionScore(pixels: Uint8Array, width: number, height: number, angle: number) {
  const rows = new Float64Array(height + 16);
  const tangent = Math.tan((angle * Math.PI) / 180);
  const centerX = (width - 1) / 2;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const darkness = Math.max(0, 220 - pixels[y * width + x]);
      if (darkness === 0) continue;
      const projected = Math.round(y + (x - centerX) * tangent) + 8;
      if (projected >= 0 && projected < rows.length) rows[projected] += darkness;
    }
  }
  const mean = rows.reduce((sum, value) => sum + value, 0) / rows.length;
  return rows.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rows.length;
}

export function chooseDeskewAngle(scores: readonly Readonly<{ angle: number; score: number }>[]) {
  const zero = scores.find((entry) => entry.angle === 0)?.score ?? 0;
  const best = [...scores].sort((left, right) => right.score - left.score || Math.abs(left.angle) - Math.abs(right.angle))[0];
  if (!best || Math.abs(best.angle) < 0.25 || best.score < zero * 1.03) return 0;
  return -best.angle;
}

async function estimateDeskew(bytes: Uint8Array, width: number) {
  const sample = await sharp(bytes)
    .resize({ width: Math.min(width, 512), withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scores: { angle: number; score: number }[] = [];
  for (let quarterDegrees = -8; quarterDegrees <= 8; quarterDegrees += 1) {
    const angle = quarterDegrees / 4;
    scores.push({
      angle,
      score: projectionScore(sample.data, sample.info.width, sample.info.height, angle),
    });
  }
  return chooseDeskewAngle(scores);
}

async function pngImage(bytes: Buffer): Promise<PreparedImage> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new TypeError("Processed image dimensions are unavailable");
  return {
    bytes: new Uint8Array(bytes),
    mime_type: "image/png",
    width: metadata.width,
    height: metadata.height,
    sha256: digest(bytes),
  };
}

export async function preprocessPayslipDocument(input: {
  bytes: Uint8Array;
  mime_type: string;
  regions?: readonly ExtractionRegion[];
}): Promise<PreparedPayslipDocument> {
  const original = { bytes: input.bytes, mime_type: input.mime_type, sha256: digest(input.bytes) };
  if (!new Set(["image/png", "image/jpeg"]).has(input.mime_type)) {
    return {
      original,
      processed_full_page: null,
      crops: [],
      metadata: {
        preprocessing_version: PAYSLIP_PREPROCESSING_VERSION,
        crop_plan_version: PAYSLIP_CROP_PLAN_VERSION,
        applied: false,
        source_width: null,
        source_height: null,
        upscale_factor: 1,
        deskew_degrees: 0,
        grayscale: false,
        contrast_gain: 1,
        sharpen_sigma: 0,
        reason: "unsupported_source",
      },
    };
  }

  const metadata = await sharp(input.bytes).metadata();
  if (!metadata.width || !metadata.height) throw new TypeError("Source image dimensions are unavailable");
  const factor = upscaleFactor(metadata.width);
  if (factor === 1) {
    return {
      original,
      processed_full_page: null,
      crops: [],
      metadata: {
        preprocessing_version: PAYSLIP_PREPROCESSING_VERSION,
        crop_plan_version: PAYSLIP_CROP_PLAN_VERSION,
        applied: false,
        source_width: metadata.width,
        source_height: metadata.height,
        upscale_factor: 1,
        deskew_degrees: 0,
        grayscale: false,
        contrast_gain: 1,
        sharpen_sigma: 0,
        reason: "not_needed",
      },
    };
  }

  const deskewDegrees = await estimateDeskew(input.bytes, metadata.width);
  const processed = await sharp(input.bytes)
    .rotate(deskewDegrees, { background: "#ffffff" })
    .resize({ width: metadata.width * factor, kernel: sharp.kernel.lanczos3 })
    .grayscale()
    .linear(1.08, -8)
    .sharpen({ sigma: 1 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  const fullPage = await pngImage(processed);
  const selectedRegions = new Set(input.regions ?? payslipCropBands.map((band) => band.region));
  const crops: { region: ExtractionRegion; image: PreparedImage }[] = [];
  for (const band of payslipCropBands) {
    if (!selectedRegions.has(band.region)) continue;
    const top = Math.floor(fullPage.height * band.top);
    const bottom = Math.ceil(fullPage.height * band.bottom);
    const height = Math.max(1, Math.min(fullPage.height - top, bottom - top));
    const crop = await sharp(processed)
      .extract({ left: 0, top, width: fullPage.width, height })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    crops.push({ region: band.region, image: await pngImage(crop) });
  }
  return {
    original,
    processed_full_page: fullPage,
    crops,
    metadata: {
      preprocessing_version: PAYSLIP_PREPROCESSING_VERSION,
      crop_plan_version: PAYSLIP_CROP_PLAN_VERSION,
      applied: true,
      source_width: metadata.width,
      source_height: metadata.height,
      upscale_factor: factor,
      deskew_degrees: deskewDegrees,
      grayscale: true,
      contrast_gain: 1.08,
      sharpen_sigma: 1,
      reason: "low_resolution_raster",
    },
  };
}
